#!/usr/bin/env node
'use strict';

/**
 * 哔哩哔哩直播 · 三角洲行动专区 在播主播采集（纯 HTTP 版 / 服务器用）
 *
 * 与 collect.js 的区别：不需要浏览器、不需要 Cookie、不需要任何签名。
 * 走的是老版分区接口 room/v1/area/getRoomList，它没有 gaia 风控。
 *
 * 用法：
 *   node collect-http.js                 # 全量采集
 *   node collect-http.js --max-pages 3   # 只采前 3 页
 *   node collect-http.js --delay 3000    # 每页间隔（默认 2000~3500 随机）
 *   node collect-http.js --out ./data    # 输出目录
 *   node collect-http.js --json          # stdout 只输出 JSON（便于管道）
 *
 * 无第三方依赖，Node 18+ 即可运行。
 */

const fs = require('node:fs');
const path = require('node:path');

const AREA_ID = '878';
const PARENT_AREA_ID = '2';
const AREA_NAME = '三角洲行动';
const PARENT_AREA_NAME = '网游';

const API = 'https://api.live.bilibili.com/room/v1/area/getRoomList';
const REFERER = `https://live.bilibili.com/p/eden/area-tags?parentAreaId=${PARENT_AREA_ID}&areaId=${AREA_ID}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PAGE_SIZE = 30;
const MAX_PAGES_HARD_CAP = 200;

// 连续这么多页为空/无新增，才认定真正翻到底。
// 实测：偶发空页会出现在中途（第 25 页空、第 26 页仍有 30 条），一遇空页就停会丢掉大半数据。
const EMPTY_TOLERANCE = 3;

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = {
    maxPages: MAX_PAGES_HARD_CAP,
    minDelay: 2000,
    maxDelay: 3500,
    out: path.join(__dirname, 'data'),
    quiet: false,
    json: false,
    retries: 3,
    minOnline: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--max-pages') opts.maxPages = Math.min(Number(next()), MAX_PAGES_HARD_CAP);
    else if (a === '--delay') {
      const v = Number(next());
      opts.minDelay = v;
      opts.maxDelay = v;
    } else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--retries') opts.retries = Number(next());
    else if (a === '--min-online') opts.minOnline = Number(next());
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--json') {
      opts.json = true;
      opts.quiet = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`用法: node collect-http.js [选项]

  --max-pages N   最多采集 N 页（默认自动翻到底）
  --delay MS      每页间隔毫秒数（默认 2000~3500 随机）
  --out DIR       输出目录（默认 ./data）
  --retries N     单页失败重试次数（默认 3）
  --min-online N  只保留人气 ≥ N 的房间（默认 0，即全部）
  --json          stdout 只输出 JSON 结果
  --quiet         只写文件，不打印表格`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(opts.maxPages) || opts.maxPages < 1) throw new Error('--max-pages 必须是正整数');
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP

async function fetchPage(page, { retries, quiet }) {
  const url =
    `${API}?parent_area_id=${PARENT_AREA_ID}&area_id=${AREA_ID}` +
    `&sort_type=online&page=${page}&page_size=${PAGE_SIZE}&platform=web`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 指数退避：2s, 4s, 8s
      const wait = 2000 * 2 ** (attempt - 1);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: REFERER,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 412 || res.status === 429) {
        throw new Error(`HTTP ${res.status}（请求被限流）`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      if (json.code !== 0) throw new Error(`接口返回 ${json.code}（${json.message || '未知'}）`);
      return Array.isArray(json.data) ? json.data : [];
    } catch (err) {
      lastErr = err;
      if (!quiet) process.stderr.write(`  [重试 ${attempt + 1}/${retries}] 第 ${page} 页：${err.message}\n`);
    }
  }
  throw new Error(`第 ${page} 页请求失败：${lastErr.message}`);
}

// ---------------------------------------------------------------- 采集

function normalizeRoom(r) {
  return {
    roomid: r.roomid,
    uid: r.uid,
    uname: r.uname,
    title: r.title,
    area_name: r.area_v2_name || r.area_name || '',
    area_id: r.area_v2_id || r.area_id || '',
    online: r.online ?? 0,
    face: r.face || '',
    cover: r.cover || r.user_cover || '',
    url: `https://live.bilibili.com/${r.roomid}`,
    user_url: `https://space.bilibili.com/${r.uid}`,
  };
}

async function collect(opts) {
  const rooms = new Map();
  const stalePages = [];
  let page = 1;
  let stoppedBy = 'max-pages';

  // 偶发空页 ≠ 翻到底。实测同一时刻拉第 25 页返回空数组，紧接着第 26 页仍有 30 条；
  // 真正到底是在第 80 页。早先「一遇空页就 break」正是 2092 → 707 那次提前收工的原因。
  let emptyStreak = 0;
  let dupStreak = 0;

  for (; page <= opts.maxPages; page++) {
    let list;
    try {
      list = await fetchPage(page, opts);
    } catch (err) {
      // 单页彻底失败：不中断整体，记录后跳过
      console.warn(`[警告] ${err.message}，跳过该页。`);
      stalePages.push({ page, error: err.message });
      if (stalePages.length >= 3) {
        stoppedBy = 'consecutive-failures';
        break;
      }
      await sleep(opts.minDelay);
      continue;
    }

    if (list.length === 0) {
      emptyStreak++;
      if (!opts.quiet) {
        console.log(`第 ${page} 页：空（连续 ${emptyStreak}/${EMPTY_TOLERANCE}），累计 ${rooms.size}`);
      }
      if (emptyStreak >= EMPTY_TOLERANCE) {
        stoppedBy = 'empty-page';
        break;
      }
      // 容忍偶发空页，继续往后翻
      await sleep(opts.minDelay + Math.random() * (opts.maxDelay - opts.minDelay));
      continue;
    }
    emptyStreak = 0;

    let added = 0;
    for (const r of list) {
      if (r.roomid && !rooms.has(r.roomid)) {
        rooms.set(r.roomid, normalizeRoom(r));
        added++;
      }
    }

    if (!opts.quiet) console.log(`第 ${page} 页：${list.length} 条，新增 ${added}，累计 ${rooms.size}`);

    // 整页都是见过的房间：可能是排序抖动造成的重复，也可能是真到底了。
    // 同样要求连续多页才认定结束，避免中途一次重复就收工。
    if (added === 0) {
      dupStreak++;
      if (dupStreak >= EMPTY_TOLERANCE) {
        stoppedBy = 'no-new-rooms';
        break;
      }
    } else {
      dupStreak = 0;
    }

    await sleep(opts.minDelay + Math.random() * (opts.maxDelay - opts.minDelay));
  }

  const all = [...rooms.values()].filter((r) => String(r.area_id) === AREA_ID);
  all.sort((a, b) => (b.online || 0) - (a.online || 0));
  const kept = opts.minOnline > 0 ? all.filter((r) => (r.online || 0) >= opts.minOnline) : all;

  return {
    generated_at: new Date().toISOString(),
    source: 'room/v1/area/getRoomList (pure http)',
    area: {
      parent_area_id: PARENT_AREA_ID,
      parent_area_name: PARENT_AREA_NAME,
      area_id: AREA_ID,
      area_name: AREA_NAME,
    },
    pages_fetched: Math.min(page, opts.maxPages),
    stopped_by: stoppedBy,
    failed_pages: stalePages,
    min_online: opts.minOnline,
    rooms_fetched: all.length,
    count: kept.length,
    total_online: kept.reduce((s, r) => s + (r.online || 0), 0),
    rooms: kept,
  };
}

// ---------------------------------------------------------------- 输出

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeOutputs(result, outDir) {
  const snapshotDir = path.join(outDir, 'snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });

  const stamp = result.generated_at.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const json = JSON.stringify(result, null, 2);

  const snapshotJson = path.join(snapshotDir, `${stamp}.json`);
  fs.writeFileSync(snapshotJson, json, 'utf8');
  fs.writeFileSync(path.join(outDir, 'latest.json'), json, 'utf8');

  const header = ['roomid', 'uid', 'uname', 'title', 'area_name', 'online', 'url'];
  const lines = [header.join(',')];
  for (const r of result.rooms) lines.push(header.map((k) => csvCell(r[k])).join(','));
  fs.writeFileSync(path.join(outDir, 'latest.csv'), '\ufeff' + lines.join('\r\n'), 'utf8');

  const historyCsv = path.join(outDir, 'history.csv');
  const isNew = !fs.existsSync(historyCsv);
  const row = [
    result.generated_at,
    result.count,
    result.total_online,
    result.pages_fetched,
    result.failed_pages.length ? 'partial' : 'ok',
  ].join(',');
  fs.appendFileSync(
    historyCsv,
    (isNew ? '\ufeff时间,在播房间数,合计人气,采集页数,状态\r\n' : '') + row + '\r\n',
    'utf8'
  );

  return { snapshotJson };
}

function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function printTable(result, top = 30) {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)));
  console.log(`\n===== ${AREA_NAME}专区 · 在播直播 =====`);
  console.log(`采集时间：${new Date(result.generated_at).toLocaleString('zh-CN')}`);
  console.log(`在播直播间：${result.count} 个（翻页 ${result.pages_fetched} 页，${result.stopped_by}）`);
  if (result.min_online > 0) {
    console.log(`已按人气 ≥ ${result.min_online} 过滤：${result.rooms_fetched} → ${result.count}`);
  }
  console.log(`合计人气值：${result.total_online.toLocaleString()}`);
  console.log('');
  console.log(`${pad('#', 4)}${pad('主播', 18)}${pad('人气', 9)}${pad('房间号', 11)}${pad('UID', 11)}标题`);
  console.log('-'.repeat(100));
  result.rooms.slice(0, top).forEach((r, i) => {
    console.log(
      `${pad(String(i + 1), 4)}${pad(r.uname || '', 18)}${pad(String(r.online ?? ''), 9)}` +
        `${pad(String(r.roomid), 11)}${pad(String(r.uid), 11)}${r.title || ''}`
    );
  });
  if (result.rooms.length > top) console.log(`… 其余 ${result.rooms.length - top} 个见完整列表文件`);
}

// ---------------------------------------------------------------- 主流程

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = await collect(opts);

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    const { snapshotJson } = writeOutputs(result, opts.out);
    if (!opts.quiet) printTable(result);
    console.log(`\n完整列表：${path.join(opts.out, 'latest.json')}`);
    console.log(`CSV 表格：${path.join(opts.out, 'latest.csv')}`);
    console.log(`本次快照：${snapshotJson}`);
    console.log(`历史汇总：${path.join(opts.out, 'history.csv')}`);
  } catch (err) {
    console.error(`\n[失败] ${err.message}`);
    process.exitCode = 1;
  }
})();