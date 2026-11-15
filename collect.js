#!/usr/bin/env node
'use strict';

/**
 * 哔哩哔哩直播 · 三角洲行动专区 在播主播采集
 *
 * 为什么要用浏览器？
 *   B 站直播分区接口（second/getList）有 gaia 风控，必须携带网页 JS 现场生成的
 *   `w_webid`（绑定浏览器指纹与 buvid），纯 HTTP 直连一律返回 -352。
 *   所以本程序：用 opencli 驱动你本机的真实 Chrome（正常登录态 + 正常指纹）打开
 *   分区页，由 Node 负责 wbi 签名，再把请求放到页面上下文里发出。
 *
 * 依赖：
 *   - 本机 Chrome + opencli 浏览器桥（`opencli doctor` 显示 connected）
 *   - cookie.txt（登录 Cookie，仅 Node 用来获取 wbi 密钥和写请求头）
 *
 * 用法：
 *   node collect.js                     # 全量采集
 *   node collect.js --max-pages 2       # 只采前 2 页（验证用）
 *   node collect.js --keep-tab          # 采完不关闭浏览器标签
 *   node collect.js --mode http         # 直连模式（仅当 B 站放宽风控时可用）
 *
 * 风控友好：
 *   - 每页之间随机等待 3~5 秒
 *   - 遇到 -352 / -412 / -401 立即停止，不重试
 *   - wbi 密钥缓存 6 小时
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------- 常量

const AREA_ID = '878';
const PARENT_AREA_ID = '2';
const AREA_NAME = '三角洲行动';
const PARENT_AREA_NAME = '网游';
const AREA_PAGE = `https://live.bilibili.com/p/eden/area-tags?parentAreaId=${PARENT_AREA_ID}&areaId=${AREA_ID}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const API_LIST = 'https://api.live.bilibili.com/xlive/web-interface/v1/second/getList';
const API_NAV = 'https://api.bilibili.com/x/web-interface/nav';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LATEST_JSON = path.join(DATA_DIR, 'latest.json');
const LATEST_CSV = path.join(DATA_DIR, 'latest.csv');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const HISTORY_CSV = path.join(DATA_DIR, 'history.csv');
const WBI_CACHE = path.join(ROOT, '.wbi-cache.json');
const COOKIE_FILE = process.env.BILI_COOKIE_FILE || path.join(ROOT, 'cookie.txt');

const WBI_TTL_MS = 6 * 60 * 60 * 1000;
const BLOCK_CODES = new Set([-352, -412, -401]);
const BLOCK_HINT = {
  '-352': '风控校验失败',
  '-412': '请求被拦截',
  '-401': '账号未登录或登录已失效',
};

const DEFAULT_OPENCLI =
  'C:/Users/95468/AppData/Roaming/npm/node_modules/@jackwener/opencli/dist/src/main.js';

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = {
    mode: 'browser',
    session: 'bili',
    maxPages: Infinity,
    minDelay: 3000,
    maxDelay: 5000,
    sort: '',
    quiet: false,
    keepTab: false,
    includeOthers: false,
    opencli: process.env.OPENCLI_MAIN || DEFAULT_OPENCLI,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--max-pages') opts.maxPages = Number(next());
    else if (a === '--delay') {
      const v = Number(next());
      opts.minDelay = v;
      opts.maxDelay = v;
    } else if (a === '--sort') opts.sort = next() || '';
    else if (a === '--session') opts.session = next();
    else if (a === '--opencli') opts.opencli = next();
    else if (a === '--mode') opts.mode = next();
    else if (a === '--keep-tab') opts.keepTab = true;
    else if (a === '--include-others') opts.includeOthers = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(`用法: node collect.js [选项]

  --mode browser|http  浏览器模式（默认，可过风控）或直连模式
  --max-pages N        最多采集 N 页（默认全部）
  --delay MS           每页间隔毫秒数（默认 3000~5000 随机）
  --sort TYPE          排序：空=按人气，live_time=按开播时间
  --session NAME       opencli 浏览器会话名（默认 bili）
  --opencli PATH       opencli 入口 main.js 路径
  --keep-tab           采集完成后不关闭浏览器标签
  --include-others     保留列表里混入的其他分区房间（默认排除）
  --quiet              只写文件，不打印表格`);
      process.exit(0);
    }
  }
  if (opts.maxPages !== Infinity && (!Number.isFinite(opts.maxPages) || opts.maxPages < 1)) {
    throw new Error('--max-pages 必须是正整数');
  }
  if (opts.mode !== 'browser' && opts.mode !== 'http') throw new Error('--mode 只能是 browser 或 http');
  return opts;
}

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCookie() {
  const fromEnv = process.env.BILI_COOKIE && process.env.BILI_COOKIE.trim();
  if (fromEnv) return fromEnv;
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`找不到 Cookie 文件：${COOKIE_FILE}\n请把 live.bilibili.com 的登录 Cookie 写入该文件。`);
  }
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  if (!raw) throw new Error(`Cookie 文件为空：${COOKIE_FILE}`);
  if (!/SESSDATA=/.test(raw)) {
    throw new Error('Cookie 中缺少 SESSDATA，登录态不完整（SESSDATA 是 HttpOnly，需从 DevTools 的 Cookies 面板复制）。');
  }
  return raw;
}

// ---------------------------------------------------------------- wbi 签名

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const getMixinKey = (o) => MIXIN_KEY_ENC_TAB.map((i) => o[i]).join('').slice(0, 32);

function signParams(params, keys) {
  const mixinKey = getMixinKey(keys.imgKey + keys.subKey);
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`
    )
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

async function getWbiKeys(cookie) {
  try {
    const cached = JSON.parse(fs.readFileSync(WBI_CACHE, 'utf8'));
    if (cached.imgKey && cached.subKey && Date.now() - cached.savedAt < WBI_TTL_MS) return cached;
  } catch {
    /* 无缓存 */
  }
  const json = await fetchJsonNode(API_NAV, 'https://www.bilibili.com/', cookie);
  const img = (json.data && json.data.wbi_img && json.data.wbi_img.img_url) || '';
  const sub = (json.data && json.data.wbi_img && json.data.wbi_img.sub_url) || '';
  if (!img || !sub) throw new Error('未能从 nav 接口获取 wbi 密钥');
  const keys = {
    imgKey: img.split('/').pop().split('.')[0],
    subKey: sub.split('/').pop().split('.')[0],
    savedAt: Date.now(),
  };
  fs.writeFileSync(WBI_CACHE, JSON.stringify(keys), 'utf8');
  return keys;
}

// ---------------------------------------------------------------- HTTP（直连模式 / nav）

class BlockedError extends Error {}

async function fetchJsonNode(url, referer, cookie) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Origin: 'https://live.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 412) throw new BlockedError('HTTP 412（请求被拦截）');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (json.code !== 0) {
    const hint = BLOCK_HINT[String(json.code)] || json.message || '未知错误';
    if (BLOCK_CODES.has(json.code)) throw new BlockedError(`接口返回 ${json.code}（${hint}）`);
    throw new Error(`接口返回 ${json.code}（${hint}）`);
  }
  return json;
}

// ---------------------------------------------------------------- 浏览器桥

function runOpencli(opts, args) {
  try {
    return execFileSync('node', [opts.opencli, 'browser', opts.session, ...args], {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || '').toString().trim() || err.message;
    throw new Error(`opencli 调用失败：${detail.slice(0, 300)}`);
  }
}

function evalInPage(opts, tab, js) {
  return runOpencli(opts, ['eval', '--tab', tab, js]);
}

function extractMarked(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

async function openAreaTab(opts) {
  const out = runOpencli(opts, ['open', AREA_PAGE]);
  const m = out.match(/"page"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`无法从 open 输出解析标签页 ID：${out.slice(0, 200)}`);
  return m[1];
}

async function waitForWebid(opts, tab) {
  const js =
    "(()=>{const u=performance.getEntriesByType('resource').map(e=>e.name)" +
    ".filter(n=>n.includes('second/getList')).pop();" +
    'return u?new URL(u).searchParams.get(\'w_webid\')||\'\':\'\'})()';
  for (let i = 0; i < 30; i++) {
    const out = evalInPage(opts, tab, js);
    const trimmed = out.trim().split('\n')[0].replace(/^"|"$/g, '');
    if (trimmed && trimmed.startsWith('ey')) return trimmed;
    await sleep(1000);
  }
  throw new Error('等待页面生成 w_webid 超时（页面可能被验证码拦截，请在 Chrome 中手动确认分区页能正常显示）');
}

// ---------------------------------------------------------------- 采集

function buildPageUrl(page, { keys, webid, sort }) {
  return (
    `${API_LIST}?` +
    signParams(
      {
        platform: 'web',
        parent_area_id: PARENT_AREA_ID,
        area_id: AREA_ID,
        sort_type: sort,
        page: String(page),
        vajra_business_key: '',
        web_location: '444.253',
        w_webid: webid,
      },
      keys
    )
  );
}

async function fetchPageViaBrowser(opts, tab, url) {
  const js =
    '(async()=>{try{' +
    `const r=await fetch('${url}',{credentials:'include'});` +
    'const j=await r.json();const d=j.data||{};' +
    "return 'BILI_DATA:'+JSON.stringify({code:j.code,message:j.message,count:d.count,has_more:d.has_more,list:d.list||[]});" +
    "}catch(e){return 'BILI_DATA:'+JSON.stringify({code:-9999,message:String(e),list:[]});}})()";
  const out = evalInPage(opts, tab, js);
  const body = extractMarked(out, 'BILI_DATA:');
  if (!body) throw new Error(`页面请求返回异常：${out.slice(0, 200)}`);
  const data = JSON.parse(body);
  if (data.code !== 0) {
    const hint = BLOCK_HINT[String(data.code)] || data.message || '未知错误';
    if (BLOCK_CODES.has(data.code)) throw new BlockedError(`接口返回 ${data.code}（${hint}）`);
    throw new Error(`接口返回 ${data.code}（${hint}）`);
  }
  return data;
}

function normalizeRoom(r) {
  return {
    roomid: r.roomid,
    uid: r.uid,
    uname: r.uname,
    title: r.title,
    area_name: r.area_v2_name || r.area_name || '',
    area_id: r.area_v2_id || r.area_id || '',
    online: r.online,
    live_time: r.live_time || '',
    cover: r.cover || r.user_cover || '',
    url: `https://live.bilibili.com/${r.roomid}`,
    user_url: `https://space.bilibili.com/${r.uid}`,
  };
}

async function collect(opts) {
  const cookie = loadCookie();
  const keys = await getWbiKeys(cookie);

  let tab = null;
  let webid = null;
  if (opts.mode === 'browser') {
    tab = await openAreaTab(opts);
    if (!opts.quiet) console.log(`已在 Chrome 打开分区页（标签 ${tab}），等待页面生成 w_webid…`);
    webid = await waitForWebid(opts, tab);
    if (!opts.quiet) console.log('w_webid 已获取，开始翻页。');
  }

  const rooms = new Map();
  let page = 1;
  let total = null;
  let blocked = null;

  for (; page <= opts.maxPages; page++) {
    let data;
    try {
      if (opts.mode === 'browser') {
        data = await fetchPageViaBrowser(opts, tab, buildPageUrl(page, { keys, webid, sort: opts.sort }));
      } else {
        const url = buildPageUrl(page, { keys, webid: '', sort: opts.sort });
        data = (await fetchJsonNode(url, AREA_PAGE, cookie)).data || {};
        data.list = data.list || [];
      }
    } catch (err) {
      if (err instanceof BlockedError) {
        blocked = err;
        if (rooms.size === 0) throw err;
        console.warn(`\n[警告] 第 ${page} 页被风控（${err.message}），已停止翻页，保留已取到的数据。`);
        break;
      }
      throw err;
    }

    const list = Array.isArray(data.list) ? data.list : [];
    if (total === null && typeof data.count === 'number' && data.count > 0) total = data.count;

    for (const r of list) {
      if (!rooms.has(r.roomid)) rooms.set(r.roomid, normalizeRoom(r));
    }

    if (!opts.quiet) {
      console.log(`第 ${page} 页：${list.length} 条，累计 ${rooms.size} 个直播间`);
    }

    if (list.length === 0) break;
    if (data.has_more === 0 || data.has_more === false) break;
    if (page >= opts.maxPages) break;

    await sleep(opts.minDelay + Math.random() * (opts.maxDelay - opts.minDelay));
  }

  if (tab && !opts.keepTab) {
    try {
      runOpencli(opts, ['tab', 'close', tab]);
    } catch {
      /* 关闭失败不影响结果 */
    }
  }

  const all = [...rooms.values()].sort((a, b) => (b.online || 0) - (a.online || 0));
  const list = opts.includeOthers ? all : all.filter((r) => String(r.area_id) === AREA_ID);
  return {
    generated_at: new Date().toISOString(),
    area: {
      parent_area_id: PARENT_AREA_ID,
      parent_area_name: PARENT_AREA_NAME,
      area_id: AREA_ID,
      area_name: AREA_NAME,
    },
    mode: opts.mode,
    pages_fetched: Math.min(page, opts.maxPages),
    api_reported_total: total,
    blocked: blocked ? blocked.message : null,
    excluded_other_area: all.length - list.length,
    count: list.length,
    total_online: list.reduce((s, r) => s + (r.online || 0), 0),
    rooms: list,
  };
}

// ---------------------------------------------------------------- 输出

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeOutputs(result) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const stamp = result.generated_at.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const snapshotJson = path.join(SNAPSHOT_DIR, `${stamp}.json`);
  const json = JSON.stringify(result, null, 2);
  fs.writeFileSync(snapshotJson, json, 'utf8');
  fs.writeFileSync(LATEST_JSON, json, 'utf8');

  const header = ['roomid', 'uid', 'uname', 'title', 'area_name', 'online', 'live_time', 'url'];
  const lines = [header.join(',')];
  for (const r of result.rooms) lines.push(header.map((k) => csvCell(r[k])).join(','));
  fs.writeFileSync(LATEST_CSV, '\ufeff' + lines.join('\r\n'), 'utf8');

  // 每次运行追加一行汇总，方便看每日趋势
  const isNew = !fs.existsSync(HISTORY_CSV);
  const row = [
    result.generated_at,
    result.count,
    result.total_online,
    result.pages_fetched,
    result.blocked ? 'partial' : 'ok',
  ].join(',');
  fs.writeFileSync(HISTORY_CSV, (isNew ? '\ufeff时间,在播房间数,合计人气,采集页数,状态\r\n' : '') + row + '\r\n', {
    encoding: 'utf8',
    flag: 'a',
  });

  return { snapshotJson };
}

function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

function printTable(result, top = 30) {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)));
  console.log(`\n===== ${AREA_NAME}专区 · 在播直播 =====`);
  console.log(`采集时间：${new Date(result.generated_at).toLocaleString('zh-CN')}`);
  console.log(`在播直播间：${result.count} 个`);
  if (result.excluded_other_area) console.log(`已排除非本区推荐：${result.excluded_other_area} 个`);
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
    const { snapshotJson } = writeOutputs(result);
    if (!opts.quiet) printTable(result);
    console.log(`\n完整列表：${LATEST_JSON}`);
    console.log(`CSV 表格：${LATEST_CSV}`);
    console.log(`本次快照：${snapshotJson}`);
    console.log(`历史汇总：${HISTORY_CSV}`);
    if (result.blocked) {
      console.log(`\n[提示] 本次采集被风控中断：${result.blocked}`);
      process.exitCode = 2;
    }
  } catch (err) {
    const cause = err.cause && (err.cause.message || err.cause.code || String(err.cause));
    console.error(`\n[失败] ${err.message}${cause ? `（${cause}）` : ''}`);
    if (err instanceof BlockedError) {
      console.error('这通常意味着当前网络被 B 站风控。程序已停止，请勿连续重试。');
      console.error('建议：等 30 分钟以上；确认 Chrome 里分区页能正常打开；检查 cookie.txt。');
    }
    process.exitCode = 1;
  }
})();
