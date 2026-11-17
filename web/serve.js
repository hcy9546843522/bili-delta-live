#!/usr/bin/env node
'use strict';

/**
 * 本地数据看板服务器（零依赖，只用 Node 内置模块）
 *
 * 用法：
 *   node web/serve.js              # 默认 http://127.0.0.1:7788
 *   node web/serve.js --port 8080
 *
 * 只监听 127.0.0.1，不对外网暴露。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = __dirname;

// ---------------------------------------------------------------- 运行日志

// 日志要尽早建立：后面的 db 打开、调度器初始化都可能出错，
// 那些错误必须能出现在网页上，而不是只留在看不见的终端里。
const { createLogger } = require(path.join(ROOT, 'lib', 'logger.js'));
const logger = createLogger({ file: path.join(ROOT, 'data', 'logs.jsonl') });

let PORT = 7788;
let HOST = '127.0.0.1';
let DB_FILE = path.join(ROOT, 'data', 'live.sqlite');
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port') PORT = Number(process.argv[++i]);
  else if (a === '--host') HOST = String(process.argv[++i]);
  else if (a === '--db') DB_FILE = path.resolve(process.argv[++i]);
  else if (a === '-h' || a === '--help') {
    console.log(`用法: node web/serve.js [--port 7788] [--host 127.0.0.1] [--db ./data/live.sqlite]

  --port N        监听端口（默认 7788）
  --host ADDR     监听地址（默认 127.0.0.1，只允许本机访问）
                  容器部署时需要传 0.0.0.0，否则宿主机映射不进容器
  --db FILE       出勤数据库路径（默认 ./data/live.sqlite）`);
    process.exit(0);
  }
}

// 出勤数据库按需打开：没跑过 collect-track.js 时不影响快照看板
let dbModule = null;
let dbHandle = null;
let dbError = null;

function getDb() {
  if (dbHandle) return dbHandle;
  if (dbError) return null;
  try {
    if (!dbModule) dbModule = require(path.join(ROOT, 'lib', 'db.js'));
    if (!fs.existsSync(DB_FILE)) {
      dbError = `数据库不存在：${DB_FILE}（先跑一次 node collect-track.js）`;
      return null;
    }
    dbHandle = dbModule.openDb(DB_FILE);
    return dbHandle;
  } catch (err) {
    dbError = `打开数据库失败：${err.message}`;
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SOURCE_RE = /^data(-[A-Za-z0-9_-]+)?$/;
const SNAPSHOT_RE = /^[A-Za-z0-9_:.+-]+\.json$/;

// ---------------------------------------------------------------- 采集调度

// 调度器可选：数据库不存在时不影响快照看板
let schedModule = null;
let scheduler = null;

function getScheduler() {
  if (scheduler) return scheduler;
  try {
    if (!schedModule) schedModule = require(path.join(ROOT, 'lib', 'schedule.js'));
    const dbm = require(path.join(ROOT, 'lib', 'db.js'));
    if (!dbModule) dbModule = dbm; // 复用同一个模块实例，避免 dbModule 仍为 null
    scheduler = schedModule.createScheduler({
      getDb,
      dbModule: dbm,
      dbFile: DB_FILE,
      log: (msg) => console.log(msg),
      logger, // 调度事件同时进网页可见的运行日志
    });
    return scheduler;
  } catch (err) {
    console.error(`[调度] 初始化失败：${err.message}`);
    logger.error('sched', '调度器初始化失败', { err: err.message });
    return null;
  }
}

// ---------------------------------------------------------------- 图片代理

/**
 * 为什么要代理 B 站图片：
 *   1. 浏览器直连 i0.hdslb.com 会被 Chromium 的 ORB 策略拦截（实测 ERR_BLOCKED_BY_ORB）
 *   2. 代理后可统一追加图床缩略图参数：头像 95KB → 2.7KB，封面 133KB → 8.5KB
 *
 * 缓存只放内存、绝不落盘 —— 封面是「看的时候有用、过后无价值」的数据。
 * 进程重启即清空，符合「封面不需要长期保存」的要求。
 */

const IMG_HOST_RE = /(^|\.)hdslb\.com$/i;
const IMG_OK_EXT = /\.(jpe?g|png|webp)$/i;
const IMG_TIMEOUT = 15000;
const IMG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const IMG_CACHE_MAX_ITEMS = 800;

const IMG_CACHE = new Map();
let imgCacheBytes = 0;

function imgCacheGet(key) {
  const hit = IMG_CACHE.get(key);
  if (!hit) return null;
  // 命中后重新插入，维持 LRU 顺序
  IMG_CACHE.delete(key);
  IMG_CACHE.set(key, hit);
  return hit;
}

function imgCacheSet(key, buf, type) {
  if (buf.length > IMG_CACHE_MAX_BYTES / 4) return; // 超大图不缓存
  if (IMG_CACHE.has(key)) {
    imgCacheBytes -= IMG_CACHE.get(key).buf.length;
    IMG_CACHE.delete(key);
  }
  IMG_CACHE.set(key, { buf, type, at: Date.now() });
  imgCacheBytes += buf.length;

  while (
    (imgCacheBytes > IMG_CACHE_MAX_BYTES || IMG_CACHE.size > IMG_CACHE_MAX_ITEMS) &&
    IMG_CACHE.size > 0
  ) {
    const oldest = IMG_CACHE.keys().next().value;
    imgCacheBytes -= IMG_CACHE.get(oldest).buf.length;
    IMG_CACHE.delete(oldest);
  }
}

/** 给图片 URL 追加图床缩略图后缀，如 @72w_72h.jpg */
function withThumb(url, size) {
  if (!size) return url;
  const m = /^(\d{1,4})x(\d{1,4})$/.exec(size);
  if (!m) return url;
  const [, w, h] = m;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!IMG_OK_EXT.test(parsed.pathname)) return url;
  if (parsed.pathname.includes('@')) return url; // 已有处理后缀，不重复追加
  // 后缀必须接在 pathname 末尾，不能直接拼在整串 URL 后面：
  // 地址若带 ?query，`url + '@72w_72h.jpg'` 会把后缀落进 query（变成 ?a=1@72w_72h.jpg），
  // 上游按错误路径找不到图，返回 404 → 前端碎图。
  parsed.pathname += `@${w}w_${h}h.jpg`;
  return parsed.toString();
}

async function serveImage(res, rawUrl, size) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return sendJson(res, { error: '非法图片地址' }, 400);
  }

  // SSRF 防护：只允许 B 站图床
  if (!/^https?:$/.test(target.protocol) || !IMG_HOST_RE.test(target.hostname)) {
    return sendJson(res, { error: '不允许的图片域名' }, 403);
  }

  let finalUrl;
  try {
    finalUrl = withThumb(target.toString(), size);
  } catch {
    finalUrl = target.toString();
  }

  const cached = imgCacheGet(finalUrl);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': cached.type,
      'Content-Length': cached.buf.length,
      'Cache-Control': 'public, max-age=3600',
      'X-Img-Cache': 'hit',
    });
    return res.end(cached.buf);
  }

  const signal = AbortSignal.timeout(IMG_TIMEOUT);

  let type;
  let buf;
  try {
    const upstream = await fetch(finalUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://live.bilibili.com/',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
      signal,
    });

    if (!upstream.ok) return sendJson(res, { error: `上游返回 ${upstream.status}` }, 502);

    type = upstream.headers.get('content-type') || 'image/jpeg';
    // 上游可能返回 HTML（防盗链/风控页），挡掉，别当图片吐给前端
    if (!/^image\//i.test(type)) {
      return sendJson(res, { error: '上游返回的不是图片' }, 502);
    }

    // 注意：AbortSignal.timeout 对「读响应体」同样生效。这一步的 TimeoutError
    // 必须一起接住 —— 早先只包了 fetch，resulting 一次慢图读取就把整个进程带崩了。
    buf = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    if (res.headersSent || res.writableEnded) return res.destroy();
    return sendJson(res, { error: `取图失败：${err.message}` }, 502);
  }

  imgCacheSet(finalUrl, buf, type);

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=3600',
    'X-Img-Cache': 'miss',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- 工具

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 返回 Promise<{ ok: true, data } | { ok: false, status, error }>，**永不 reject**。
 * 调用方无需 try/catch，只需看 ok。
 *
 * 三个保护（缺一个都可能让进程或连接卡住）：
 *  - 字节上限：用 Buffer 累计真实字节数，不能用 string.length 判——中文一个字 3 字节，
 *    按字符计数会让实际可上传体积超出限额 3 倍。
 *  - 读取超时：客户端连上却不发完（或半开连接）时，'end' 永远不来，请求会一直挂着。
 *  - error/aborted 监听：客户端中途断连时 req 会 emit 'error'，没有监听器
 *    在 Node 里等于 uncaughtException，整个进程会退出。
 */
function readJsonBody(req, { limit = 64 * 1024, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let bytes = 0;
    let timer = null;
    const chunks = [];

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAbort);
      resolve(result);
    };

    const onData = (c) => {
      bytes += c.length;
      if (bytes > limit) {
        // 不能在这里直接 req.destroy()：destroy 会立刻掐断 socket，
        // 调用方随后写的 413 响应发不出去，客户端只看到 "fetch failed"，
        // 拿不到真正原因。先暂停读取、把结果交出去，等调用方写完响应，
        // 再由宏任务去销毁连接（此时微任务链已经跑完）。
        req.pause();
        finish({ ok: false, status: 413, error: `请求体超过 ${limit} 字节` });
        setTimeout(() => req.destroy(), 0);
        return;
      }
      chunks.push(c);
    };

    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return finish({ ok: true, data: {} });
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return finish({ ok: false, status: 400, error: '请求体不是合法 JSON' });
      }
      // 只接受对象：数组/字符串/数字会让后续 payload.xxx 取值变成 undefined 而不报错
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return finish({ ok: false, status: 400, error: '请求体必须是 JSON 对象' });
      }
      finish({ ok: true, data });
    };

    const onError = (err) => {
      finish({ ok: false, status: 400, error: `读取请求体失败：${err.message}` });
    };

    const onAbort = () => {
      finish({ ok: false, status: 400, error: '客户端已断开' });
    };

    timer = setTimeout(() => {
      // 同 413 的理由：先让调用方把 408 写出去，再断开连接
      req.pause();
      finish({ ok: false, status: 408, error: '读取请求体超时' });
      setTimeout(() => req.destroy(), 0);
    }, timeout);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

function sendFile(res, filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return sendJson(res, { error: '文件不存在' }, 404);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

/** 解析 CSV（支持引号转义与 BOM） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- 数据源

function readLatestMeta(dir) {
  const p = path.join(dir, 'latest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      generated_at: j.generated_at || null,
      source: j.source || '',
      count: j.count ?? (Array.isArray(j.rooms) ? j.rooms.length : 0),
      total_online: j.total_online ?? 0,
      pages_fetched: j.pages_fetched ?? null,
      rooms_fetched: j.rooms_fetched ?? null,
      stopped_by: j.stopped_by || null,
      area: j.area || null,
    };
  } catch {
    return null;
  }
}

function readSnapshots(dir) {
  const sd = path.join(dir, 'snapshots');
  if (!fs.existsSync(sd)) return [];
  return fs
    .readdirSync(sd)
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort()
    .reverse()
    .map((f) => {
      let meta = {};
      try {
        const j = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8'));
        meta = {
          generated_at: j.generated_at || null,
          count: j.count ?? 0,
          total_online: j.total_online ?? 0,
        };
      } catch {
        /* 损坏的快照照样列出，只缺摘要 */
      }
      return { file: f, ...meta };
    });
}

function listSources() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SOURCE_RE.test(d.name))
    .map((d) => {
      const dir = path.join(ROOT, d.name);
      return {
        name: d.name,
        latest: readLatestMeta(dir),
        snapshot_count: readSnapshots(dir).length,
        has_history: fs.existsSync(path.join(dir, 'history.csv')),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- 路由

/**
 * 从用户输入里取出 B 站数字 ID。
 *
 * 接受这些写法：3546618353682597 / UID 3546618353682597 /
 * https://live.bilibili.com/12345?xxx / live.bilibili.com/12345。
 * 只取数字，其余字符忽略——用户从哪复制来的都能用。
 */
function parseBiliId(raw) {
  const s = String(raw || '').trim();

  // 优先取地址路径里的数字：
  //   live.bilibili.com/30188072      → 房间号
  //   live.bilibili.com/blanc/30188072 → 房间号
  //   space.bilibili.com/345725015    → UID（个人空间，数字就是 UID）
  // 必须先看路径，否则 query 里的 spm_id_from=333.1387、is_room_feed=1
  // 这类数字可能被误当成 ID（尤其是短房间号 <100 被 \d{3,} 跳过时）。
  const inUrl = s.match(/bilibili\.com\/(?:blanc\/)?(\d+)/i);
  if (inUrl) {
    const n = Number(inUrl[1]);
    if (Number.isSafeInteger(n) && n > 0) {
      // 个人空间链接里的数字本身就是 UID；只有直播间链接里的才是房间号。
      // 调用方靠这个标记决定「换算不到 UID 时能否直接入库」。
      const isSpace = /space\.bilibili\.com/i.test(s);
      return { id: n, fromUrl: !isSpace, kind: isSpace ? 'uid' : 'roomid' };
    }
  }

  // 不是地址就按纯数字处理（用户直接粘 UID / 房间号）
  const m = s.match(/(\d{3,})/);
  if (!m) return { id: 0, fromUrl: false, kind: 'uid' };
  const n = Number(m[1]);
  return {
    id: Number.isSafeInteger(n) && n > 0 ? n : 0,
    fromUrl: false,
    kind: 'uid',
  };
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return sendJson(res, { error: 'bad url' }, 400);
  }
  const p = u.pathname;

  if (p === '/' || p === '/index.html') return sendFile(res, path.join(WEB, 'index.html'));
  if (p === '/app.js') return sendFile(res, path.join(WEB, 'app.js'));
  if (p === '/style.css') return sendFile(res, path.join(WEB, 'style.css'));
  if (p === '/attendance.css') return sendFile(res, path.join(WEB, 'attendance.css'));
  if (p === '/attendance.html') return sendFile(res, path.join(WEB, 'attendance.html'));
  if (p === '/attendance.js') return sendFile(res, path.join(WEB, 'attendance.js'));
  if (p === '/schedule.html') return sendFile(res, path.join(WEB, 'schedule.html'));
  if (p === '/schedule.js') return sendFile(res, path.join(WEB, 'schedule.js'));
  if (p === '/schedule.css') return sendFile(res, path.join(WEB, 'schedule.css'));
  // 统一设计系统与新页面
  if (p === '/ui.css') return sendFile(res, path.join(WEB, 'ui.css'));
  if (p === '/nav.js') return sendFile(res, path.join(WEB, 'nav.js'));
  if (p === '/rooms.html') return sendFile(res, path.join(WEB, 'rooms.html'));
  if (p === '/rooms.css') return sendFile(res, path.join(WEB, 'rooms.css'));
  if (p === '/discoveries.html') return sendFile(res, path.join(WEB, 'discoveries.html'));
  if (p === '/discoveries.js') return sendFile(res, path.join(WEB, 'discoveries.js'));
  if (p === '/discoveries.css') return sendFile(res, path.join(WEB, 'discoveries.css'));
  if (p === '/logs.html') return sendFile(res, path.join(WEB, 'logs.html'));
  if (p === '/logs.js') return sendFile(res, path.join(WEB, 'logs.js'));
  if (p === '/logs.css') return sendFile(res, path.join(WEB, 'logs.css'));
  if (p === '/analyze.html') return sendFile(res, path.join(WEB, 'analyze.html'));
  if (p === '/analyze.js') return sendFile(res, path.join(WEB, 'analyze.js'));
  if (p === '/analyze.css') return sendFile(res, path.join(WEB, 'analyze.css'));
  if (p === '/pool.html') return sendFile(res, path.join(WEB, 'pool.html'));
  if (p === '/pool.js') return sendFile(res, path.join(WEB, 'pool.js'));
  if (p === '/pool.css') return sendFile(res, path.join(WEB, 'pool.css'));

  if (p === '/api/sources') return sendJson(res, listSources());

  // ------------------------------------------------------------ 运行日志 API

  // GET /api/logs?level=warn&scope=track&q=风控&limit=200
  // 前端「运行日志」页轮询这个接口；只读内存，不产生额外磁盘压力。
  if (p === '/api/logs') {
    const level = u.searchParams.get('level') || '';
    const scope = u.searchParams.get('scope') || '';
    const q = u.searchParams.get('q') || '';
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 200, 1), 800);
    return sendJson(res, {
      available: true,
      summary: logger.summary(),
      entries: logger.query({ level, scope, q, limit }),
      now: Math.floor(Date.now() / 1000),
    });
  }

  // ------------------------------------------------------------ 房间明细 API

  // GET /api/live-status
  // 房间明细页用：快照是某一刻的切片，里面的人现在可能已经下播。
  // 这里返回 track 落库的「仍开着」名单，让前端标出谁还在播。
  // 只读本地库，不发任何外部请求，可以随便调用。
  if (p === '/api/live-status') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError }, 200);
    try {
      const m = dbModule.liveStatusMap(d);
      return sendJson(res, {
        available: true,
        open: m.open,
        seen: m.seen,
        observedAt: m.observedAt,
        now: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      logger.error('server', '查询实时状态失败', { err: err.message });
      return sendJson(res, { available: false, error: `查询失败：${err.message}` }, 200);
    }
  }

  // ------------------------------------------------------------ 新发现 API

  // GET /api/discoveries?days=60          → 每天新发现的人数
  // GET /api/discoveries?day=2026-11-15   → 当天明细（支持 sort/dir 全量排序）
  if (p === '/api/discoveries') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError, days: [], rows: [] }, 200);

    const day = u.searchParams.get('day') || '';
    try {
      if (day) {
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 200, 1), 1000);
        const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
        const sort = u.searchParams.get('sort') || 'first_seen_at';
        const dir = u.searchParams.get('dir') || 'desc';
        const r = dbModule.discoveryList(d, { day, limit, offset, sort, dir });
        return sendJson(res, { available: true, day, total: r.total, rows: r.rows });
      }
      const days = Math.min(Math.max(Number(u.searchParams.get('days')) || 60, 1), 730);
      return sendJson(res, {
        available: true,
        days: dbModule.discoveryDays(d, { days }),
        now: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      logger.error('server', '查询新发现失败', { err: err.message });
      return sendJson(res, { available: false, error: `查询失败：${err.message}`, days: [], rows: [] }, 200);
    }
  }

  // -------------------------------------------------------- 采集调度 API

  if (p === '/api/schedule') {
    if (req.method === 'POST') {
      // 保存配置：只接受 config 字段，其余忽略
      readJsonBody(req, { limit: 64 * 1024 }).then((r) => {
        if (!r.ok) return sendJson(res, { error: r.error }, r.status);
        const sc = getScheduler();
        const d = getDb();
        if (!sc || !d) return sendJson(res, { error: '调度器或数据库不可用' }, 503);
        const payload = r.data;
        try {
          const cfg = schedModule.saveConfig(d, dbModule, payload.config || payload);
          // 不清空 state：plan() 会检测到间隔变化（keyInterval 对不上）并自动重算 nextAt，
          // 同时保留 lastAt，避免下次执行时间被重置成一个不准确的时刻。
          if (sc.tick) sc.tick();
          sendJson(res, { ok: true, config: cfg, status: sc.status() });
        } catch (err) {
          sendJson(res, { error: `保存失败：${err.message}` }, 500);
        }
      });
      return;
    }
    const sc = getScheduler();
    if (!sc) return sendJson(res, { available: false, error: '调度器不可用' }, 200);
    return sendJson(res, sc.status());
  }

  // 立即跑一次：POST /api/schedule/run?kind=track|discover
  if (p === '/api/schedule/run') {
    if (req.method !== 'POST') return sendJson(res, { error: '只接受 POST' }, 405);
    const sc = getScheduler();
    if (!sc) return sendJson(res, { error: '调度器不可用' }, 503);
    const kind = u.searchParams.get('kind') || 'track';
    const r = sc.runNow(kind);
    return sendJson(res, r, r.error ? 400 : 200);
  }

  // 轻量进度查询：GET /api/schedule/progress?kind=track
  // 前端每隔 1 秒轮询一次，所以这里只读内存里的进度与 running 标志，
  // 不走 plan()、不查 collect_runs，避免把轮询变成数据库压力。
  if (p === '/api/schedule/progress') {
    const sc = getScheduler();
    if (!sc) return sendJson(res, { available: false, error: '调度器不可用' }, 200);
    const kind = u.searchParams.get('kind') || 'track';
    if (kind !== 'track' && kind !== 'discover') {
      return sendJson(res, { error: 'kind 只能是 track / discover' }, 400);
    }
    const st = sc.status();
    return sendJson(res, {
      available: true,
      kind,
      running: Boolean(st.running && st.running[kind]),
      progress: (st.progress && st.progress[kind]) || null,
      lastResult: (st.lastResult && st.lastResult[kind]) || null,
      now: Math.floor(Date.now() / 1000),
    });
  }

  // 图片代理：/img?u=<原始URL>&s=72x72
  if (p === '/img') {
    const rawImg = u.searchParams.get('u') || '';
    const imgSize = u.searchParams.get('s') || '';
    if (!rawImg) return sendJson(res, { error: '缺少 u 参数' }, 400);
    return serveImage(res, rawImg, imgSize);
  }

  // ------------------------------------------------------------ 出勤 API

  if (p === '/api/attendance/stats') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError }, 200);
    return sendJson(res, { available: true, db: DB_FILE, ...dbModule.stats(d) });
  }

  // 当前在播列表（来自数据库，即 track 采集到的结果）
  // 与看板页不同：看板读的是 JSON 快照，这里读的是 SQLite 里尚未收尾的场次。
  if (p === '/api/live-now') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError, rooms: [] }, 200);
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 500, 1), 2000);
    let rooms = [];
    try {
      rooms = dbModule.liveNow(d, { limit });
    } catch (err) {
      return sendJson(res, { available: false, error: `查询失败：${err.message}`, rooms: [] }, 200);
    }
    return sendJson(res, {
      available: true,
      count: rooms.length,
      rooms,
      now: Math.floor(Date.now() / 1000),
    });
  }

  // 采集趋势（来自数据库的 collect_runs，每次 track 落一行）
  //
  // 替代原先读 snapshots/ 目录的做法：那个目录只有早期 collect-http.js 留下的
  // 几个文件，track 之后从未写过，拿它画趋势等于画几个互不可比的陈旧点。
  if (p === '/api/trend') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError, points: [] }, 200);
    const days = Math.min(Math.max(Number(u.searchParams.get('days')) || 7, 1), 90);
    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 500, 1), 2000);
    let points = [];
    try {
      points = dbModule.trendRuns(d, { days, limit });
    } catch (err) {
      return sendJson(res, { available: false, error: `查询失败：${err.message}`, points: [] }, 200);
    }
    return sendJson(res, { available: true, days, points });
  }

  // 分析页聚合：GET /api/analyze?top=20&words=40
  //
  // 为什么是一个接口而不是六个：这些都是同一个小库（几千行）上的聚合，
  // 拆成多个请求只会让首屏等多次往返，还会让几个图表的快照来自不同时刻。
  if (p === '/api/analyze') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError }, 200);
    const topN = Math.min(Math.max(Number(u.searchParams.get('top')) || 20, 1), 100);
    const wordN = Math.min(Math.max(Number(u.searchParams.get('words')) || 40, 1), 120);
    try {
      return sendJson(res, { available: true, ...dbModule.analyze(d, { topN, wordN }) });
    } catch (err) {
      return sendJson(res, { available: false, error: `聚合失败：${err.message}` }, 200);
    }
  }

  // 主播池：GET /api/pool?limit=100&offset=0&sort=last_active&dir=desc&tier=hot&mode=discover&q=关键词
  //
  // 与 /api/analyze 分开的原因：那个接口是六张图的整体快照，重算一次要重新
  // 聚合全库；而主播池是「翻页 + 筛选」的高频交互，每次都全量重算会让翻页很卡。
  // 这里所有筛选和分页都下推到 SQL，一次只取当前页那一百行。
  if (p === '/api/pool') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError, rows: [] }, 200);

    const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
    const sort = u.searchParams.get('sort') || 'last_active';
    const dir = u.searchParams.get('dir') || 'desc';
    const tier = u.searchParams.get('tier') || null;
    const mode = u.searchParams.get('mode') || null;
    const q = u.searchParams.get('q') || '';

    try {
      return sendJson(res, { available: true, limit, offset, ...dbModule.poolList(d, { limit, offset, sort, dir, tier, mode, q }) });
    } catch (err) {
      return sendJson(res, { available: false, error: `查询失败：${err.message}`, rows: [] }, 200);
    }
  }

  // 手动添加主播：POST /api/attendance/add
  //
  // 为什么需要：常规路径只有 discover（扫专区榜）和 track（刷已有池子）两种入池方式，
  // discover 只收「此刻正在播」的人。想追踪一个没在播、或榜上没出现的主播就没有入口。
  // 这个接口让人用 UID / 直播间链接直接把人塞进池子，之后 track 自然会每小时刷他。
  //
  // 防风的要点：最多发 2 个请求，且被限流就立刻停手，绝不再补第二个。
  if (p === '/api/attendance/add') {
    if (req.method !== 'POST') return sendJson(res, { error: '只接受 POST' }, 405);
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError }, 200);

    readJsonBody(req, { limit: 8192 }).then(async (r) => {
      if (!r.ok) return sendJson(res, { ok: false, error: r.error }, r.status);
      const payload = r.data;

      const parsed = parseBiliId(payload.raw ?? payload.uid ?? payload.id);
      const rawId = parsed.id;
      if (!rawId) return sendJson(res, { ok: false, error: '没识别出数字 ID' }, 400);
      // 用户粘的是直播间链接 → 这个数字只可能是房间号，不可能是 UID。
      // 记录下来，后面换算失败时不能退化成「就当 UID 入库」。
      const inputWasUrl = parsed.fromUrl;

      const notes = [];
      let uid = rawId;
      let info = null;
      let resolvedFrom = inputWasUrl ? 'roomid' : 'uid';
      // 是否拿到过 B 站的明确答复（查到了人，或明确回「没这个房间」）。
      // 只有网络层面全挂了才算没确认——那时 rawId 到底该当 UID 还是当房间号
      // 是未知的，硬写进去就会把房间号存成 UID，之后 track 永远查不到这个人。
      let confirmed = false;
      // 是否真的把房间号换成了 UID。粘链接的情况下只有它为 true 才允许入库，
      // 否则 uid 列里存的就是房间号，track 永远刷不到这个人。
      let roomResolved = false;

      const existing = dbModule.getStreamer(d, rawId);
      if (existing) {
        // 已经在池子里，不再打扰 B 站——手动添加不是刷新按钮。
        notes.push('这位主播已在库中，本次未请求 B 站');
      } else {
        let bili = null;
        try {
          bili = require(path.join(ROOT, 'lib', 'bili.js'));
        } catch (err) {
          notes.push(`B 站模块加载失败：${err.message}`);
        }

        if (bili) {
          // 第一步：当 UID 试。不在播的主播这里也会返回资料（live_status=0），
          // 所以能查到人就算成功。
          //
          // 但用户粘的是直播间链接时跳过这一步：链接里的数字是房间号，
          // 拿它当 UID 查很可能命中「另一个人的 UID」，把不相干的主播加进池子。
          // 跳过还顺带少发一个请求，对防风控更有利。
          if (!inputWasUrl) {
            try {
              const map = await bili.fetchStatusByUids([rawId]);
              info = map.get(rawId) || null;
              // 接口正常返回了（哪怕里面没有这个人），这就算明确答复
              confirmed = true;
              if (!info) notes.push('按 UID 未查到');
            } catch (err) {
              notes.push(`按 UID 查询失败：${err.message}`);
              // 被限流/风控就到此为止，不再发第二个请求
              if (err.rateLimited) {
                return sendJson(
                  res,
                  { ok: false, error: 'B 站限流，已中止（未写入任何数据）', notes },
                  429
                );
              }
            }
          }

          // 第二步：仍查不到，说明用户给的可能是直播间号（链接里那个数字是 room_id，
          // 与 uid 通常不相等）。换算一次再定稿。
          if (!info) {
            try {
              const room = await bili.fetchRoomInfo(rawId);
              // 房间接口正常答复了（查到或明确说没这个房间）都算明确答复
              confirmed = true;
              if (room.uid > 0) {
                uid = room.uid;
                roomResolved = true;
                resolvedFrom = uid === rawId ? 'uid' : 'roomid';
                info = room;
                if (resolvedFrom === 'roomid') {
                  notes.push(`输入的是直播间号，已换算为 UID ${uid}`);
                }
                // get_info 不返回昵称和头像，拿换算出的 uid 再查一次状态补上。
                // 这一步失败不算错——主播资料照旧入库，只是没有昵称。
                try {
                  const map2 = await bili.fetchStatusByUids([uid]);
                  const extra = map2.get(uid);
                  if (extra) {
                    info = {
                      ...room,
                      uname: extra.uname || '',
                      face: extra.face || '',
                      live_status: extra.live_status,
                      // live_time 优先用状态接口的 unix 秒，比 get_info 的字符串可靠
                      live_time: Number(extra.live_time) || room.live_time,
                      online: extra.online || room.online,
                      title: extra.title || room.title,
                      area_id: extra.area_id || room.area_id,
                      area_name: extra.area_name || room.area_name,
                      roomid: extra.roomid || room.roomid,
                    };
                  }
                } catch (err) {
                  notes.push(`补查昵称失败：${err.message}`);
                }
              }
            } catch (err) {
              notes.push(`按直播间号查询失败：${err.message}`);
              // B 站带着答复码回来的（例如「未找到该房间」）说明网络是通的，
              // 这是明确答复，不是连不上。别把两者混为一谈误导用户。
              if (err.biliCode) confirmed = true;
            }
          }
        }
      }

      // 两次查询都在网络层面失败（没拿到 B 站任何明确答复）时，rawId 到底是 UID
      // 还是房间号就说不准了。此时写库会把房间号存成 UID，track 以后永远查不到
      // 这个人——看着「添加成功」，实际是条死记录。宁可报错让用户重试。
      if (!existing && !confirmed && !info) {
        return sendJson(
          res,
          {
            ok: false,
            error: '连不上 B 站，无法确认这个 ID 是 UID 还是直播间号（未写入，请稍后重试）',
            notes,
          },
          502
        );
      }

      // 用户粘的是直播间链接：那个数字铁定是房间号，没有得到换算后的真实 UID
      // 就绝不能写库，否则 uid 列里存的是房间号，track 永远刷不到人。
      // 注意用 roomResolved 判断，不能用 uid === rawId——极少数主播的房间号
      // 恰好等于 UID，那样会把正常的换算结果误判成失败。
      if (!existing && inputWasUrl && !roomResolved) {
        return sendJson(
          res,
          {
            ok: false,
            error: '没能把直播间号换算成 UID（未写入，请稍后重试，或直接填 UID）',
            notes,
          },
          502
        );
      }

      const now = Math.floor(Date.now() / 1000);
      let created = false;
      try {
        created = dbModule.upsertStreamer(d, {
          uid,
          uname: info && info.uname ? info.uname : null,
          face: info && info.face ? info.face : null,
          roomid: info && info.roomid ? info.roomid : null,
          now,
          mode: 'manual',
        });
      } catch (err) {
        return sendJson(res, { ok: false, error: `写入数据库失败：${err.message}` }, 500);
      }

      // 查到的这一刻他正在播，就顺手记一场，让出勤页立刻有内容可看。
      let recorded = false;
      if (info && Number(info.live_status) === 1 && Number(info.live_time) > 0) {
        try {
          dbModule.recordLive(d, {
            uid,
            liveTime: Number(info.live_time),
            title: info.title || null,
            // 封面：接口本来就返回（见 lib/bili.js 的 cover_from_user || keyframe），
            // 只是这里之前漏传。不传的话手动添加的在播主播会在房间明细里缺封面，
            // 而自动 track 的同一个人却有——同一个页面出现两种表现。
            cover: info.cover || null,
            areaId: Number(info.area_id) || null,
            areaName: info.area_name || null,
            online: Number(info.online) || 0,
            now,
          });
          recorded = true;
        } catch (err) {
          notes.push(`场次记录失败：${err.message}`);
        }
      }

      let streamer = null;
      try {
        streamer = dbModule.getStreamer(d, uid);
      } catch (err) {
        notes.push(`回读失败：${err.message}`);
      }

      return sendJson(res, {
        ok: true,
        created,
        uid,
        inputId: rawId,
        resolvedFrom,
        streamer,
        found: Boolean(info),
        live: info
          ? {
              live_status: Number(info.live_status) || 0,
              title: info.title || '',
              online: Number(info.online) || 0,
              area_name: info.area_name || '',
              live_time: Number(info.live_time) || 0,
            }
          : null,
        recorded,
        notes,
      });
    });
    return;
  }

  if (p === '/api/attendance/search') {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError, results: [] }, 200);
    const q = u.searchParams.get('q') || '';
    const limit = Math.min(Number(u.searchParams.get('limit')) || 30, 200);
    return sendJson(res, {
      available: true,
      query: q,
      results: dbModule.searchStreamers(d, q, limit),
    });
  }

  const att = p.match(/^\/api\/attendance\/streamer\/(\d+)(?:\/(sessions))?$/);
  if (att) {
    const d = getDb();
    if (!d) return sendJson(res, { available: false, error: dbError }, 200);

    const uid = Number(att[1]);
    if (!uid) return sendJson(res, { error: '非法 UID' }, 400);

    const streamer = dbModule.getStreamer(d, uid);
    if (!streamer) return sendJson(res, { error: '该主播不在库中' }, 404);

    if (att[2] === 'sessions') {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 500, 2000);
      return sendJson(res, { available: true, streamer, sessions: dbModule.listSessions(d, uid, { limit }) });
    }

    const days = Math.min(Math.max(Number(u.searchParams.get('days')) || 120, 7), 730);
    const cal = dbModule.attendanceCalendar(d, uid, { days });
    return sendJson(res, {
      available: true,
      streamer,
      ...cal,
      sessions: dbModule.listSessions(d, uid, { limit: 100 }),
    });
  }

  const m = p.match(/^\/api\/source\/([^/]+)\/(latest|history|snapshots|snapshot)$/);
  if (!m) return sendJson(res, { error: '未知路径' }, 404);

  const name = decodeURIComponent(m[1]);
  if (!SOURCE_RE.test(name)) return sendJson(res, { error: '非法数据源' }, 400);

  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) return sendJson(res, { error: '数据源不存在' }, 404);

  if (m[2] === 'latest') {
    const lp = path.join(dir, 'latest.json');
    if (!fs.existsSync(lp)) return sendJson(res, { error: '该数据源没有 latest.json' }, 404);
    return sendFile(res, lp);
  }

  if (m[2] === 'history') {
    const hp = path.join(dir, 'history.csv');
    if (!fs.existsSync(hp)) return sendJson(res, { header: [], rows: [] });
    const rows = parseCsv(fs.readFileSync(hp, 'utf8'));
    if (!rows.length) return sendJson(res, { header: [], rows: [] });
    const [header, ...data] = rows;
    return sendJson(res, { header, rows: data });
  }

  if (m[2] === 'snapshots') return sendJson(res, readSnapshots(dir));

  // snapshot?file=xxx.json
  const file = u.searchParams.get('file') || '';
  if (!SNAPSHOT_RE.test(file) || file.includes('..')) return sendJson(res, { error: '非法文件名' }, 400);
  const sd = path.join(dir, 'snapshots');
  const fp = path.join(sd, file);
  if (path.dirname(fp) !== path.resolve(sd)) return sendJson(res, { error: '非法路径' }, 400);
  return sendFile(res, fp);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[失败] 端口 ${PORT} 已被占用，换一个：node web/serve.js --port 8080\n`);
    logger.error('server', `端口 ${PORT} 已被占用`, { detail: '换一个端口：node web/serve.js --port 8080' });
  } else {
    console.error(`\n[失败] ${err.message}\n`);
    logger.error('server', '服务启动失败', { err: err.message });
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const sources = listSources();
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('');
  console.log('  三角洲行动 · 直播数据看板');
  console.log(`  监听 ${HOST}:${PORT}`);
  console.log(`  http://${shown}:${PORT}`);
  console.log('');
  if (!sources.length) {
    console.log('  ⚠ 没找到任何数据目录，先跑一次 node collect-http.js');
  }
  for (const s of sources) {
    const l = s.latest;
    const when = l && l.generated_at ? new Date(l.generated_at).toLocaleString('zh-CN') : '无 latest.json';
    const cnt = l ? `${l.count} 条 / 人气 ${l.total_online.toLocaleString()}` : '无数据';
    // 不再报「N 个快照」：track 从不写快照，那个目录已清理，
    // 计数恒为 0 只会让人以为哪里坏了。
    console.log(`  · ${s.name.padEnd(10)} ${cnt.padEnd(28)} ${when}`);
  }
  console.log('');
  console.log('  Ctrl+C 停止');
  console.log('');
  logger.info('server', '看板服务已启动', {
    detail: `监听 ${HOST}:${PORT}；数据源 ${sources.length} 个`,
  });

  // 调度器默认关闭：只有在网页里显式开启后才会自动跑采集。
  // 这样"顺手起个看板"不会意外触发对 B 站的请求。
  //
  // 注意顺序：必须先取 status() 再 start()。
  // start() 内部会立刻执行一次 tick()，若此时配置因故读取不到，
  // 就会按默认值判断并可能立刻发请求（实测中曾因此误跑一次 discover）。
  try {
    const sc = getScheduler();
    if (sc) {
      const st = sc.status();
      if (!st.available) {
        // 读不到数据库时必须如实报告并拒绝启动，否则「未开启」的日志会
        // 掩盖真实的开启状态，是最容易造成误发请求的组合。
        console.log(`  自动采集：无法启动 —— ${st.error || '数据库不可用'}`);
        console.log('  调度器已跳过，不会发出任何请求。');
      } else if (st.enabled) {
        const cnt = (k) => (k === 'track' ? `每 ${st.config.trackHours} 小时` : `每 ${st.config.discoverHours} 小时`);
        const next = (k) => {
          const at = st[k] && st[k].nextAt;
          return at ? new Date(at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
        };
        console.log(`  自动采集：已开启（track ${cnt('track')} / discover ${cnt('discover')}）`);
        console.log(`  下次 track：${next('track')}　下次 discover：${next('discover')}`);
        console.log(`  设置页：http://127.0.0.1:${PORT}/schedule.html`);
        sc.start();
      } else {
        console.log('  自动采集：未开启（如需自动跑，打开 /schedule.html 开启）');
        // 仍然启动定时器：用户在网页里打开开关后无需重启进程即可生效
        sc.start();
      }
      console.log('');
    }
  } catch (err) {
    console.error(`  [调度] 启动失败：${err.message}\n`);
  }
});