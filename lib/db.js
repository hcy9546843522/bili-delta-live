'use strict';

/**
 * SQLite 存储层（零依赖，用 Node 内置 node:sqlite）
 *
 * 设计要点：存「场次」而不是「采样点」。
 * 每场直播一行，开播时刻直接取自 B 站返回的 live_time（精确到秒，
 * 与采集频率无关），因此采样间隔只影响「结束时刻」的精度。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** 东八区偏移（秒）。显式固定，避免服务器时区不同导致日期错位。 */
const TZ_OFFSET = 8 * 3600;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS streamers (
  uid            INTEGER PRIMARY KEY,
  uname          TEXT,
  face           TEXT,
  roomid         INTEGER,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER,
  first_mode     TEXT
);

-- 历史昵称：B 站允许改昵称，但 UID 终身不变。
-- 身份判定的唯一依据永远是 streamers.uid；这张表只用来让旧昵称也能被搜到，
-- 避免改名之后「拿以前的昵称搜不到人」。
CREATE TABLE IF NOT EXISTS streamer_names (
  uid            INTEGER NOT NULL,
  uname          TEXT    NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (uid, uname)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                INTEGER NOT NULL,
  live_time          INTEGER NOT NULL,
  title              TEXT,
  cover              TEXT,
  area_id            INTEGER,
  area_name          TEXT,
  first_observed_at  INTEGER NOT NULL,
  last_observed_at   INTEGER NOT NULL,
  peak_online        INTEGER DEFAULT 0,
  last_online        INTEGER DEFAULT 0,
  ended              INTEGER DEFAULT 0,
  UNIQUE(uid, live_time)
);

CREATE INDEX IF NOT EXISTS idx_sessions_uid       ON sessions(uid, live_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_live_time ON sessions(live_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_open      ON sessions(uid) WHERE ended = 0;

CREATE TABLE IF NOT EXISTS collect_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  mode          TEXT,
  pool_size     INTEGER,
  live_count    INTEGER,
  new_streamers INTEGER,
  new_sessions  INTEGER,
  requests      INTEGER,
  status        TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
 * 所以旧库（roomid 之前建的）需要显式 ALTER。
 */
function migrate(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('streamers')").all().map((r) => r.name);
  if (!cols.includes('roomid')) {
    db.exec('ALTER TABLE streamers ADD COLUMN roomid INTEGER');
  }
  // 记录这个主播最早是被哪种采集发现的（discover = 扫分区榜，track = 刷已收录主播时顺带发现）
  if (!cols.includes('first_mode')) {
    db.exec('ALTER TABLE streamers ADD COLUMN first_mode TEXT');
  }

  // 直播封面挂在「场次」上，而不是主播上：同一个人每场直播的封面都不一样。
  // track 调用的 get_status_info_by_uids 一直都返回 cover_from_user，
  // 之前只是没取，所以补齐它不需要任何额外请求，也不增加风控风险。
  const sesCols = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((r) => r.name);
  if (!sesCols.includes('cover')) {
    db.exec('ALTER TABLE sessions ADD COLUMN cover TEXT');
  }

  // 回填历史昵称表：老库里每个主播当前的昵称，就是他们已知的一个名字。
  // 只跑一次（用 meta 标记），避免每次开库都重复插入 2600+ 行。
  const done = (() => {
    try {
      return db.prepare("SELECT v FROM meta WHERE k = 'names_backfilled'").get();
    } catch {
      return null;
    }
  })();
  if (!done) {
    db.exec(
      `INSERT OR IGNORE INTO streamer_names (uid, uname, first_seen_at, last_seen_at)
       SELECT uid, uname, COALESCE(first_seen_at, 0), COALESCE(last_seen_at, 0)
         FROM streamers
        WHERE uname IS NOT NULL AND uname != ''`
    );
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('names_backfilled', '1')").run();
  }

  // 回填 first_mode：first_mode 列是后加的，老数据全为 NULL。
  // 那些主播都是早期用 --import 从快照一次性建池的存量，标成 import 才不会
  // 让他们被误算成「某天 discover 发现的新人」。同样只跑一次。
  const modeDone = (() => {
    try {
      return db.prepare("SELECT v FROM meta WHERE k = 'first_mode_backfilled'").get();
    } catch {
      return null;
    }
  })();
  if (!modeDone) {
    db.prepare("UPDATE streamers SET first_mode = 'import' WHERE first_mode IS NULL").run();
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('first_mode_backfilled', '1')").run();
  }
}

/* ---------------------------------------------------------------- 时间 */

/** 东八区自然日的 key，形如 2026-11-15 */
function dayKey(epochSec) {
  const shifted = (epochSec + TZ_OFFSET) * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** 东八区某天的 00:00:00 对应的时间戳（秒） */
function dayStart(epochSec) {
  return Math.floor((epochSec + TZ_OFFSET) / 86400) * 86400 - TZ_OFFSET;
}

/**
 * 把 [startSec, endSec) 按东八区自然日切分。
 * 跨天的一场直播会拆成多段，用于日历热力图。
 */
function splitByDay(startSec, endSec) {
  const out = [];
  if (!(endSec > startSec)) return out;
  let cur = startSec;
  let guard = 0;
  while (cur < endSec && guard++ < 400) {
    const segEnd = Math.min(endSec, dayStart(cur) + 86400);
    out.push({ day: dayKey(cur), seconds: segEnd - cur });
    cur = segEnd;
  }
  return out;
}

/* ---------------------------------------------------------------- 写入 */

function upsertStreamer(db, { uid, uname, face, roomid, now, mode = null }) {
  const rid = Number(roomid) > 0 ? Number(roomid) : null;
  const existing = db.prepare('SELECT uid, uname, first_seen_at FROM streamers WHERE uid = ?').get(uid);
  if (existing) {
    // 昵称变过就把旧名留在 streamer_names 里，之后用旧名也能搜到这个人。
    // 注意：身份始终由 uid 认定，昵称只是「这个人曾经叫什么」的附属信息。
    if (uname && uname !== existing.uname) {
      rememberName(db, uid, existing.uname, existing.first_seen_at ?? now, now);
    }
    if (uname) rememberName(db, uid, uname, now, now);

    db.prepare(
      `UPDATE streamers
          SET uname = COALESCE(?, uname),
              face  = COALESCE(?, face),
              roomid = COALESCE(?, roomid),
              last_seen_at = ?
        WHERE uid = ?`
    ).run(uname ?? null, face ?? null, rid, now, uid);
    return false;
  }
  db.prepare(
    `INSERT INTO streamers (uid, uname, face, roomid, first_seen_at, last_seen_at, first_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uid, uname ?? null, face ?? null, rid, now, now, mode);
  if (uname) rememberName(db, uid, uname, now, now);
  return true;
}

/**
 * 记录一个 (uid, uname) 组合。
 *
 * 已存在时只推进 last_seen_at，不改 first_seen_at——
 * 这样能知道「这个昵称是哪段时间在用的」。
 */
function rememberName(db, uid, uname, firstSeen, lastSeen) {
  if (!uname) return;
  db.prepare(
    `INSERT INTO streamer_names (uid, uname, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(uid, uname) DO UPDATE SET
       first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
       last_seen_at  = MAX(last_seen_at, excluded.last_seen_at)`
  ).run(uid, uname, firstSeen, lastSeen);
}

/* ---------------------------------------------------------------- meta */

/** 读单个 meta 值，不存在返回 null */
function getMeta(db, key) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(String(key));
  return row ? row.v : null;
}

/** 写单个 meta 值（存在则覆盖） */
function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).run(String(key), value == null ? null : String(value));
}

/** 读全部 meta，返回普通对象 */
function getAllMeta(db) {
  const out = {};
  for (const r of db.prepare('SELECT k, v FROM meta').all()) out[r.k] = r.v;
  return out;
}

/** 关闭某主播所有未结束的场次，last_observed_at 保持最后一次观测时间 */
function closeOpenSessions(db, uid) {
  const stmt = db.prepare(
    'UPDATE sessions SET ended = 1 WHERE uid = ? AND ended = 0'
  );
  const r = stmt.run(uid);
  return Number(r.changes) || 0;
}

/**
 * 主播在播：按 live_time 归并场次。
 * 同一场直播的 live_time 恒定，所以 (uid, live_time) 就是天然主键。
 */
function recordLive(db, { uid, liveTime, title, cover, areaId, areaName, online, now }) {
  const open = db.prepare(
    'SELECT id, live_time FROM sessions WHERE uid = ? AND ended = 0'
  ).all(uid);

  const same = open.find((s) => Number(s.live_time) === Number(liveTime));

  // 其他 live_time 的未结束场次说明主播中间下播又开了一场，先收尾
  let closed = 0;
  for (const s of open) {
    if (Number(s.live_time) !== Number(liveTime)) {
      db.prepare(
        `UPDATE sessions
            SET ended = 1,
                last_observed_at = MAX(last_observed_at, ?)
          WHERE id = ?`
      ).run(now, s.id);
      closed++;
    }
  }

  if (same) {
    db.prepare(
      `UPDATE sessions
          SET title = COALESCE(?, title),
              cover = COALESCE(?, cover),
              area_id = COALESCE(?, area_id),
              area_name = COALESCE(?, area_name),
              last_observed_at = ?,
              last_online = ?,
              peak_online = MAX(peak_online, ?)
        WHERE id = ?`
    ).run(
      title ?? null,
      cover || null,
      areaId ?? null,
      areaName ?? null,
      now,
      online,
      online,
      same.id
    );
    return { created: false, closed };
  }

  db.prepare(
    `INSERT INTO sessions
       (uid, live_time, title, cover, area_id, area_name,
        first_observed_at, last_observed_at, peak_online, last_online, ended)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    uid,
    liveTime,
    title ?? null,
    cover || null,
    areaId ?? null,
    areaName ?? null,
    now,
    now,
    online,
    online
  );

  return { created: true, closed };
}

/* ---------------------------------------------------------------- 查询 */

function searchStreamers(db, q, limit = 30) {
  const kw = String(q || '').trim();
  if (!kw) {
    return db
      .prepare(
        `SELECT s.uid, s.uname, s.face, s.first_seen_at, s.last_seen_at,
                (SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid) AS session_count
           FROM streamers s
          ORDER BY session_count DESC, s.last_seen_at DESC
          LIMIT ?`
      )
      .all(limit);
  }
  const numeric = /^\d+$/.test(kw) ? Number(kw) : -1;
  return db
    .prepare(
      `SELECT s.uid, s.uname, s.face, s.first_seen_at, s.last_seen_at,
              (SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid) AS session_count,
              (
                SELECT n.uname FROM streamer_names n
                 WHERE n.uid = s.uid AND n.uname != COALESCE(s.uname, '') AND n.uname LIKE ?
                 ORDER BY n.last_seen_at DESC LIMIT 1
              ) AS matched_alias
         FROM streamers s
        WHERE s.uid = ?
           OR s.uname LIKE ?
           OR EXISTS (
                SELECT 1 FROM streamer_names n2
                 WHERE n2.uid = s.uid AND n2.uname LIKE ?
              )
        ORDER BY session_count DESC, s.last_seen_at DESC
        LIMIT ?`
    )
    .all(`%${kw}%`, numeric, `%${kw}%`, `%${kw}%`, limit);
}

function getStreamer(db, uid) {
  return db.prepare('SELECT * FROM streamers WHERE uid = ?').get(uid) || null;
}

/**
 * 从一批 uid 里挑出**已经在池子里**的那些。
 *
 * radar 的核心是「扫榜 → 求交 → 只查池内的人」。为什么不来一个查一个：
 * 一页榜 50 人，逐个 SELECT 就是 50 次查询；而这条路径每 5 分钟跑一次，
 * 一天 288 轮，光数据库往返就上万次。一次 IN 查完只花不到 1 毫秒。
 *
 * 参数按 900 个一组切分：SQLite 的变量上限默认是 999，
 * 榜单一轮最多 2 页 100 条，正常远远碰不到，但 radar 的页数可配，
 * 配上 20 页就会超限，必须防住——那种错误只会在改配置之后才炸出来。
 *
 * @returns {Set<number>} 池内 uid 集合
 */
function filterKnownUids(db, uids) {
  const clean = [...new Set(uids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const known = new Set();
  const CHUNK = 900;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const part = clean.slice(i, i + CHUNK);
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`SELECT uid FROM streamers WHERE uid IN (${ph})`).all(...part);
    for (const r of rows) known.add(Number(r.uid));
  }
  return known;
}

/** 该主播的全部场次，附带计算出的时长（秒） */
function listSessions(db, uid, { limit = 500, now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = db
    .prepare(
      `SELECT id, uid, live_time, title, area_id, area_name,
              first_observed_at, last_observed_at, peak_online, last_online, ended
         FROM sessions
        WHERE uid = ?
        ORDER BY live_time DESC
        LIMIT ?`
    )
    .all(uid, limit);

  return rows.map((r) => {
    const end = r.ended ? Number(r.last_observed_at) : now;
    return {
      ...r,
      ended: !!r.ended,
      // 结束时长为「最后观测 - 开播」；未结束则为「此刻 - 开播」
      duration: Math.max(0, end - Number(r.live_time)),
      // 未结束场次的时长会随查询时间增长，标记出来便于前端区分
      estimated: !r.ended,
      day: dayKey(Number(r.live_time)),
    };
  });
}

/**
 * 出勤日历：把场次按东八区自然日展开。
 * 返回 { days: { '2026-11-15': {seconds, sessions, peak_online} }, summary }
 */
function attendanceCalendar(db, uid, { days = 120, now = Math.floor(Date.now() / 1000) } = {}) {
  const since = now - days * 86400;
  const rows = db
    .prepare(
      `SELECT id, live_time, first_observed_at, last_observed_at,
              peak_online, ended, title
         FROM sessions
        WHERE uid = ? AND live_time >= ?
        ORDER BY live_time ASC`
    )
    .all(uid, since);

  const dayMap = new Map();
  let totalSeconds = 0;
  let liveCount = 0;
  let openNow = false;

  for (const r of rows) {
    const start = Number(r.live_time);
    const end = r.ended ? Number(r.last_observed_at) : now;
    if (!r.ended) openNow = true;
    liveCount++;
    totalSeconds += Math.max(0, end - start);

    for (const seg of splitByDay(start, Math.max(start, end))) {
      const cur = dayMap.get(seg.day) || { seconds: 0, sessions: 0, peak_online: 0 };
      cur.seconds += seg.seconds;
      cur.sessions += 1;
      cur.peak_online = Math.max(cur.peak_online, Number(r.peak_online) || 0);
      dayMap.set(seg.day, cur);
    }
  }

  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 86400;
    const key = dayKey(t);
    const v = dayMap.get(key);
    dayList.push({
      day: key,
      seconds: v ? v.seconds : 0,
      sessions: v ? v.sessions : 0,
      peak_online: v ? v.peak_online : 0,
    });
  }

  // 只保留真正有记录的天数做分母，避免把「加入池子之前」算成缺勤。
  //
  // 起点要取 min(入库时刻, 最早有场次那天的 00:00)，不能只用 first_seen_at：
  // 首次采集会把 B 站返回的历史场次一并补录，那些场次的 live_time 早于入库时刻。
  // 若分母从入库日开始、分子却数到了入库之前的日子，就会出现 3 天 / 2 天 = 150%
  // 这种不可能的出勤率（线上实测占 5% 的主播，最多差 3.7 天）。
  const firstSeen = db.prepare('SELECT first_seen_at FROM streamers WHERE uid = ?').get(uid);
  const trackedSince = firstSeen ? Number(firstSeen.first_seen_at) : now;

  const firstActive = dayList.find((d) => d.sessions > 0);
  const firstActiveStart = firstActive
    ? new Date(`${firstActive.day}T00:00:00+08:00`).getTime() / 1000
    : null;
  // rangeStart 之前的天既没有观测也无法补录，才叫「没开始统计」
  const rangeStart = firstActiveStart != null ? Math.min(trackedSince, firstActiveStart) : trackedSince;

  const activeDays = dayList.filter((d) => d.sessions > 0).length;
  const sinceTracking = dayList.filter((d) => {
    const dt = new Date(`${d.day}T00:00:00+08:00`).getTime() / 1000;
    return dt + 86400 > rangeStart;
  });

  return {
    days: dayList,
    summary: {
      tracked_since: trackedSince,
      window_days: days,
      tracked_days: sinceTracking.length,
      active_days: activeDays,
      total_seconds: totalSeconds,
      session_count: liveCount,
      avg_seconds_per_active_day: activeDays ? Math.round(totalSeconds / activeDays) : 0,
      longest_seconds: rows.length
        ? Math.max(...rows.map((r) => Math.max(0, (r.ended ? Number(r.last_observed_at) : now) - Number(r.live_time))))
        : 0,
      live_now: openNow,
    },
  };
}

/**
 * 当前正在直播的场次（ended=0），附带主播昵称、头像、房间号。
 *
 * 「在播」的判定依据是 track 最后一次观测：ended=0 表示该场次尚未收尾。
 * 注意这依赖 track 本身把已下播的主播收尾；若长时间没跑 track，
 * 这里会显示成「仍在播」的旧数据，所以一并返回 last_observed_at 供前端标注。
 */
function liveNow(db, { limit = 500 } = {}) {
  const rows = db
    .prepare(
      `SELECT x.uid, x.live_time, x.title, x.cover, x.area_id, x.area_name,
              x.first_observed_at, x.last_observed_at,
              x.peak_online, x.last_online,
              s.uname, s.face, s.roomid
         FROM sessions x
         LEFT JOIN streamers s ON s.uid = x.uid
        WHERE x.ended = 0
        ORDER BY x.last_online DESC
        LIMIT ?`
    )
    .all(limit);

  return rows.map((r) => ({
    ...r,
    online: Number(r.last_online) || 0,
    peak_online: Number(r.peak_online) || 0,
    duration: Math.max(0, Number(r.last_observed_at) - Number(r.live_time)),
  }));
}

/* ------------------------------------------------------------ 实时状态 */

/**
 * 当前「仍在播」的主播，供房间明细页判断快照里的房间是否已下播。
 *
 * 为什么需要：房间明细的数据来自专区接口的快照（collect-http.js 产出），
 * 那个快照只是某一刻的切片 —— 生成时全是正在直播的，但几分钟后就会有人下播。
 * 用户看到的却是「最新快照」，如果不标状态，会误以为表里的人此刻都在播。
 *
 * 这里用 track 的落库结果做交叉判断：sessions.ended = 0 表示「上次观测时还在播」。
 * 注意这同样是「上次观测」而非此刻，所以一并返回观测时刻，前端要显示多久之前。
 *
 * @returns {{open: Object<string, number>, seen: number[], observedAt: number|null}}
 *   open     uid → 该场次最后观测时间（秒）
 *   seen     有过 track 记录的 uid（用于区分「未采集」和「已下播」）
 *   observedAt 全库最近一次观测时间，即这份状态的「新鲜度」
 */
function liveStatusMap(db) {
  const openRows = db
    .prepare(
      `SELECT uid, MAX(last_observed_at) AS last_observed_at
         FROM sessions
        WHERE ended = 0
        GROUP BY uid`
    )
    .all();

  const open = {};
  let observedAt = 0;
  for (const r of openRows) {
    const t = Number(r.last_observed_at) || 0;
    open[String(r.uid)] = t;
    if (t > observedAt) observedAt = t;
  }

  const seen = db
    .prepare('SELECT DISTINCT uid FROM sessions')
    .all()
    .map((r) => Number(r.uid));

  return { open, seen, observedAt: observedAt || null };
}

/* ------------------------------------------------------------ 新发现 */

/**
 * 每天新发现的主播数量，按东八区自然日分组。
 *
 * 为什么单独统计：discover 每天扫一遍分区榜，它的产出就是「以前没见过的主播」。
 * 这是判断采集是否真的有在发现新人的唯一依据，比看 collect_runs 里的
 * new_streamers 更直观（后者只有单次数字，看不出趋势）。
 *
 * @returns {Array<{day, n, from_discover, from_track, from_import}>} 按日期倒序
 */
function discoveryDays(db, { days = 60, now = Math.floor(Date.now() / 1000) } = {}) {
  // 只查最近 N 个自然日：first_seen_at 是秒，先换算成当天 00:00 再回退
  const since = dayStart(now) - (Math.max(1, days) - 1) * 86400;
  return db
    .prepare(
      `SELECT date(first_seen_at + ${TZ_OFFSET}, 'unixepoch') AS day,
              COUNT(*)                                        AS n,
              SUM(CASE WHEN first_mode = 'discover' THEN 1 ELSE 0 END) AS from_discover,
              SUM(CASE WHEN first_mode = 'track'    THEN 1 ELSE 0 END) AS from_track,
              SUM(CASE WHEN first_mode = 'manual'   THEN 1 ELSE 0 END) AS from_manual,
              SUM(CASE WHEN first_mode = 'import'   THEN 1 ELSE 0 END) AS from_import
         FROM streamers
        WHERE first_seen_at >= ?
        GROUP BY day
        ORDER BY day DESC`
    )
    .all(since)
    .map((r) => ({
      day: r.day,
      n: Number(r.n) || 0,
      from_discover: Number(r.from_discover) || 0,
      from_track: Number(r.from_track) || 0,
      from_manual: Number(r.from_manual) || 0,
      from_import: Number(r.from_import) || 0,
    }));
}

/**
 * 采集趋势：每次 track 落库的在播房间数与主播池规模。
 *
 * 为什么用它替代快照趋势：磁盘上的 snapshots/ 目录只有早期 collect-http.js
 * 留下的几个文件，之后 track 再没写过快照。拿它画趋势等于画三个互不可比的
 * 陈旧点（707 与 2044 差了三倍，是翻页深度不同造成的，不是真实的波动）。
 * collect_runs 是每次采集都写一行的真实记录，横跨昼夜，能看出规律。
 *
 * 注意：这里没有「合计人气」——collect_runs 不记录该指标，所以趋势图只画
 * 房间数与池子规模，不臆造一条看不见来源的曲线。
 */
function trendRuns(db, { days = 7, limit = 500, mode = 'track', now = Math.floor(Date.now() / 1000) } = {}) {
  const since = now - Math.max(1, days) * 86400;
  const rows = db
    .prepare(
      `SELECT id, started_at, pool_size, live_count, status
         FROM collect_runs
        WHERE mode = ? AND started_at >= ? AND status = 'ok'
        ORDER BY started_at DESC
        LIMIT ?`
    )
    .all(mode, since, Math.min(Math.max(Number(limit) || 500, 1), 2000))
    .map((r) => ({
      id: r.id,
      at: Number(r.started_at) || 0,
      pool: Number(r.pool_size) || 0,
      live: Number(r.live_count) || 0,
    }));
  // 反成时间正序，前端拿到就能直接画
  return rows.reverse();
}

/**
 * 某个自然日（不传则全部）新发现的主播明细。
 *
 * @param {object} opts
 * @param {string} [opts.day] 形如 2026-11-15；不传则不限日期
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sort]  排序列：uid|uname|status|first_seen_at|first_mode|session_count|first_title
 * @param {string} [opts.dir]   asc|desc
 */
function discoveryList(
  db,
  {
    day = null,
    limit = 200,
    offset = 0,
    sort = 'first_seen_at',
    dir = 'desc',
    now = Math.floor(Date.now() / 1000),
  } = {}
) {
  const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const off = Math.max(0, Number(offset) || 0);

  let where = '';
  const params = [];
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const start = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000) - TZ_OFFSET;
    where = 'WHERE s.first_seen_at >= ? AND s.first_seen_at < ?';
    params.push(start, start + 86400);
  }

  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM streamers s ${where}`).get(...params).n
  );

  /*
   * 排序必须在这里做，不能在浏览器里排。
   * 因为分页也在后端——前端只有当前页那 50 行，对它排序只会把本页内部重排，
   * 看起来「点了没反应」。要按某列看全局前 N 名，只能全量排序后再切片。
   *
   * 列名走白名单映射，不拼接用户输入，避免 SQL 注入。
   * 值是一个「排序键数组」，这样像「状态」需要两级排序（先是否在播、再观测时间）
   * 时可以直接列出两个键，不用把两个表达式拼成一个字符串再切开。
   */
  const SORT_COLUMNS = {
    uid: ['s.uid'],
    uname: ['s.uname'],
    // 先按是否在播，再按观测时间新的在前
    status: [
      '(CASE WHEN (SELECT x.live_time FROM sessions x WHERE x.uid = s.uid AND x.ended = 0 LIMIT 1) IS NOT NULL THEN 1 ELSE 0 END)',
      '(SELECT MAX(x.last_observed_at) FROM sessions x WHERE x.uid = s.uid)',
    ],
    first_seen_at: ['s.first_seen_at'],
    first_mode: ['s.first_mode'],
    session_count: ['(SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid)'],
    first_title: [
      '(SELECT x.title FROM sessions x WHERE x.uid = s.uid ORDER BY x.live_time ASC LIMIT 1)',
    ],
  };
  const sortKeys = SORT_COLUMNS[sort] || SORT_COLUMNS.first_seen_at;
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortKeys.map((k) => `${k} ${sortDir}`).join(', ');

  const rows = db
    .prepare(
      `SELECT s.uid, s.uname, s.face, s.roomid, s.first_seen_at, s.last_seen_at, s.first_mode,
              (SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid) AS session_count,
              (SELECT x.title FROM sessions x WHERE x.uid = s.uid
                ORDER BY x.live_time ASC LIMIT 1) AS first_title,
              -- 直播状态：取最近一次 track 的结论。
              -- ended = 0 的场次就是「上次观测时还在播」的那一场，没这种场次即视为未在播。
              (SELECT x.live_time FROM sessions x
                WHERE x.uid = s.uid AND x.ended = 0
                ORDER BY x.live_time DESC LIMIT 1) AS open_live_time,
              (SELECT MAX(x.last_observed_at) FROM sessions x
                WHERE x.uid = s.uid) AS last_observed_at
         FROM streamers s
         ${where}
        ORDER BY ${orderBy}, s.uid DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, lim, off);

  // 把原始列整理成前端好用的形状。
  // status_age 是「这条状态有多旧」——冰层主播可能几天没被查过，
  // 前端据此显示「2 天前」而不是让用户误以为这是此刻的实时状态。
  const out = rows.map((r) => {
    const openLiveTime = Number(r.open_live_time) || 0;
    const observed = Number(r.last_observed_at) || 0;
    return {
      ...r,
      open_live_time: openLiveTime || null,
      last_observed_at: observed || null,
      is_live: openLiveTime > 0,
      status_age: observed > 0 ? Math.max(0, now - observed) : null,
    };
  });

  return { total, rows: out };
}

/* ---------------------------------------------------------------- 分层采集 */

/**
 * 活跃度分层。
 *
 * 为什么需要：主播池只增不减，一年后可能几万人。若每轮 track 全量查，
 * 请求量随池子线性上涨（5 万人 ≈ 334 请求/次 × 24 次/天 ≈ 8000 请求/天）。
 * 但绝大多数人早就不播了，每小时查他们纯粹浪费请求，还会抬高风控风险。
 *
 * 所以按「最近一次出现」把池子分四层，各层用不同查询周期：
 *   热层  7 天内播过   → 每小时（在播的人必须密集跟踪，否则场次起止不准）
 *   温层  8~30 天      → 每 6 小时
 *   冷层  31~90 天     → 每天
 *   冰层  90 天以上    → 每 7 天，分摊到 24 个槽（每 7 小时只查 1/24 的人）
 *
 * 冰层为什么是「7 天」而不是「1 天」：定期抽查的命中率上限是
 * 「直播时长 ÷ 抽查周期」，跟抽查得多勤无关。播 3 小时的主播，24 小时
 * 一轮也只有 12.5%，7 天一轮是 1.8% —— 无论哪个都指望不上。
 *
 * 所以冰层的定位**不是发现通道，而是兜底**：
 *   1. radar（见 collect-track.js 的 radar()）：按开播时间倒序扫分区榜，
 *      与池子求交，命中即落场次。成本与池子规模无关，这才是发现主力。
 *   2. 冰层每 7 天全扫一遍，分摊到 24 个槽。只负责 radar 覆盖不到的两件事：
 *      换区复播（实测池内 98.3% 在 878，区外仅 42 人）和 radar 停机期的复播；
 *      顺带收尾残留的未结束场次。
 *
 * slots 的语义：该层每人仍然 everyHours 小时查一次，但请求被摊平——
 * 每 everyHours/slots 小时推进一个槽，只处理 1/slots 的人。
 * slots=1 就是不分摊（热/温/冷三层都是这样）。
 *
 * 摊平必须让**槽号随轮次前进**，这是曾经踩过的坑：早先槽号写成
 * floor(now/3600) % slots，而 due 由「该层的 last_run + everyHours」判定。
 * 当 everyHours 是 slots 的整数倍时（24/24、168/24 都成立），每次到期
 * 回来时 floor(now/3600) 恰好前进了整数倍的 slots，**槽号回到原值**。
 * 结果是每人每天都被查，但永远只在自己那一个固定整点被查——30 天模拟里
 * 每人被查时刻覆盖的整点数是 1.0/24。若某人只在 20 点开播、槽却落在 3 点，
 * 他就永远撞不上，比「7 天扫一次」更糟，是死锁。
 *
 * 现在两处一起改：槽号按槽长（everyHours/slots 小时）推进，槽键再叠加
 * 天序号轮转，保证同一个人会在 24 个不同整点各被查一次。
 */
const TIERS = [
  { id: 'hot', label: '热层', maxDays: 7, everyHours: 1, slots: 1 },
  { id: 'warm', label: '温层', maxDays: 30, everyHours: 6, slots: 1 },
  { id: 'cold', label: '冷层', maxDays: 90, everyHours: 24, slots: 1 },
  { id: 'ice', label: '冰层', maxDays: null, everyHours: 168, slots: 24 },
];

/** 按「距上次出现多少天」判定所属层。取不到时间就按热层算，宁可多查 */
function tierOf(days) {
  if (!(days >= 0)) return 'hot';
  if (days <= TIERS[0].maxDays) return 'hot';
  if (days <= TIERS[1].maxDays) return 'warm';
  if (days <= TIERS[2].maxDays) return 'cold';
  return 'ice';
}

/**
 * 规划这一轮 track 该查哪些主播。
 *
 * lastRuns 是各层上一次真正执行的时间戳（秒），由调用方从 meta 里取出再传回，
 * 存在数据库里而不是内存里，这样进程重启后不会把所有层都当成「从没查过」。
 */
function planTrackPool(db, now = Math.floor(Date.now() / 1000), lastRuns = {}) {
  const rows = db
    .prepare(
      `SELECT s.uid,
              MAX(COALESCE(sess.last_observed_at, sess.live_time)) AS last_active
         FROM streamers s
         LEFT JOIN sessions sess ON sess.uid = s.uid
        GROUP BY s.uid`
    )
    .all();

  const buckets = { hot: [], warm: [], cold: [], ice: [] };
  for (const r of rows) {
    const la = Number(r.last_active) || 0;
    const days = la > 0 ? (now - la) / 86400 : -1;
    buckets[tierOf(days)].push(Number(r.uid));
  }

  const tiers = {};
  const chosenTiers = [];
  const uids = [];
  for (const t of TIERS) {
    const list = buckets[t.id];
    const last = Number(lastRuns[t.id]) || 0;
    const slots = Math.max(1, Math.min(Number(t.slots) || 1, 24));
    /*
     * 分摊的粒度是「槽长」而不是「整层周期」。
     *
     * 冰层 168 小时 ÷ 24 槽 = 每 7 小时推进一格，于是本层的 due 判定也
     * 必须按 7 小时算 —— 每 7 小时查 1/24 的人，7×24 小时正好轮完全员。
     * 若沿用 everyHours 判 due，就会出现「每小时到期、但槽号 7 小时才变一次」
     * 的错配：同一个槽会被连查 7 次，其余 23 个槽干等 7 天。
     */
    const slotHours = slots > 1 ? Math.max(1, t.everyHours / slots) : t.everyHours;
    const isDue = last === 0 || now - last >= slotHours * 3600;

    /*
     * 分摊：把这一层的人切成 slots 份，本次只查落在当前槽里的那一份。
     *
     * 为什么需要：冰层如果整层一次查完，会突然多出几百批请求（冰层可能占
     * 池子一半）。那种「一静一爆」的形状本身就是机器特征，比均匀涓流更
     * 容易被盯上。
     *
     * 槽键 = (uid + 天序号) % slots，两处都不能省：
     *   · 按 uid 取模而不是数组下标：数组顺序来自 SQL 的 GROUP BY，池子增删
     *     会打乱它，同一个人就可能永远轮不到。uid 不变，取模才稳定。
     *   · 再叠加天序号：只按 uid 取模时，一个人所属的槽是**永恒**的。若他
     *     只在 20 点开播、槽却恰好落在 3 点，7 天一轮也永远撞不上。叠加天
     *     序号后，同一个人的槽每天前进一格，24 天内必然把 24 个整点走一遍。
     */
    const curSlot = slots > 1 ? Math.floor(now / (slotHours * 3600)) % slots : 0;
    const dayIdx = Math.floor(now / 86400);
    const picked =
      slots > 1
        ? list.filter((uid) => (uid + dayIdx) % slots === curSlot)
        : list;

    tiers[t.id] = {
      label: t.label,
      total: list.length,
      // 本轮实际要查几个（冰层分摊后不等于 total，前端要能看出差别）
      picked: picked.length,
      slots,
      slot_hours: slotHours,
      every_hours: t.everyHours,
      last_run: last || null,
      due: isDue,
    };
    if (isDue && picked.length) {
      chosenTiers.push(t.id);
      uids.push(...picked);
    }
  }

  return { uids, tiers, chosenTiers, total: rows.length };
}

/**
 * 主播池列表：池子里每个主播 + 所属分层 + 活跃信息。
 *
 * 分层口径必须与 planTrackPool 的调度判定完全一致 —— 两处一旦不一致，
 * 就会出现「页面标着热层、实际按冰层在查」这种自相矛盾的展示。
 * 所以边界仍取同一个 TIERS 常量，只是把 JS 的 tierOf 翻成 SQL 的 CASE。
 *
 * 性能：2979 个主播、约 7000 场次时，四条查询合计十几毫秒。相关子查询
 * 都走 idx_sessions_uid，不用全表扫；分页在 SQL 里做，前端只拿当前页。
 *
 * @returns {{total, filtered, live_now, tiers, tier_meta, modes, rows}}
 *   total     池子总人数（不受筛选影响）
 *   filtered  当前筛选条件下的人数（前端算总页数用）
 *   tiers     各层人数，形如 {hot: 1200, warm: 900, ...}
 *   tier_meta 各层的展示名 / 边界 / 查询周期 / 人数
 */
function poolList(
  db,
  {
    limit = 100,
    offset = 0,
    sort = 'last_active',
    dir = 'desc',
    tier = null,
    mode = null,
    q = '',
    now = Math.floor(Date.now() / 1000),
  } = {}
) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);

  // 分层边界直接内联：都是本函数算出来的整数，没有注入面，
  // 也让 WHERE 的 ? 参数顺序保持简单（CTE 里不再占位）。
  const bHot = now - TIERS[0].maxDays * 86400;
  const bWarm = now - TIERS[1].maxDays * 86400;
  const bCold = now - TIERS[2].maxDays * 86400;

  const CTE = `
    WITH base AS (
      SELECT s.uid, s.uname, s.face, s.roomid,
             s.first_seen_at, s.last_seen_at, s.first_mode,
             -- 最近一次「有动静」的时刻：已收尾场次用最后观测，未收尾用开播时刻兜底
             (SELECT MAX(COALESCE(x.last_observed_at, x.live_time))
                FROM sessions x WHERE x.uid = s.uid) AS last_active,
             (SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid) AS session_count,
             -- 累计时长只算已收尾场次：未收尾的时长会随查询时间增长，混进来会让数字一直变
             (SELECT SUM(x.last_observed_at - x.live_time) FROM sessions x
               WHERE x.uid = s.uid AND x.ended = 1) AS total_seconds,
             (SELECT MAX(x.peak_online) FROM sessions x WHERE x.uid = s.uid) AS peak_online,
             (SELECT COUNT(*) FROM sessions x WHERE x.uid = s.uid AND x.ended = 0) AS open_count
        FROM streamers s
    ),
    tiered AS (
      SELECT base.*, CASE
          -- 没有任何场次：tierOf(-1) 也是热层（宁可多查），这里保持一致
          WHEN last_active IS NULL OR last_active = 0 THEN 'hot'
          WHEN last_active >= ${bHot}  THEN 'hot'
          WHEN last_active >= ${bWarm} THEN 'warm'
          WHEN last_active >= ${bCold} THEN 'cold'
          ELSE 'ice'
        END AS tier
      FROM base
    )`;

  const where = [];
  const params = [];
  if (tier && TIERS.some((t) => t.id === tier)) {
    where.push('tier = ?');
    params.push(tier);
  }
  if (mode && ['discover', 'track', 'manual', 'import'].includes(mode)) {
    where.push("COALESCE(first_mode, 'import') = ?");
    params.push(mode);
  }
  const kw = String(q || '').trim();
  if (kw) {
    const like = `%${kw}%`;
    // 纯数字按 UID 精确匹配，否则只搜昵称
    if (/^\d+$/.test(kw)) {
      where.push('(uid = ? OR uname LIKE ?)');
      params.push(Number(kw), like);
    } else {
      where.push('uname LIKE ?');
      params.push(like);
    }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 排序列走白名单映射，绝不拼接用户输入
  const SORT = {
    last_active: 'COALESCE(last_active, 0)',
    // 按「热→温→冷→冰」的语义顺序排，而不是按字符串字典序
    tier: "(CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END)",
    session_count: 'session_count',
    total_seconds: 'COALESCE(total_seconds, 0)',
    peak_online: 'COALESCE(peak_online, 0)',
    first_seen_at: 'first_seen_at',
    uname: 'uname',
    uid: 'uid',
  };
  const sortExpr = SORT[sort] || SORT.last_active;
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `${CTE}
       SELECT * FROM tiered ${whereSql}
        ORDER BY ${sortExpr} ${sortDir}, uid DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, lim, off);

  const filtered =
    Number(db.prepare(`${CTE} SELECT COUNT(*) AS n FROM tiered ${whereSql}`).get(...params).n) || 0;

  // 分层汇总始终反映整个池子的结构，不随筛选变化 —— 否则点一下「只看热层」，
  // 其他层的人数就会变成 0，看板上什么都读不出来。
  const tiers = Object.fromEntries(TIERS.map((t) => [t.id, 0]));
  for (const r of db.prepare(`${CTE} SELECT tier, COUNT(*) AS n FROM tiered GROUP BY tier`).all()) {
    tiers[r.tier] = Number(r.n) || 0;
  }

  const modes = { discover: 0, track: 0, manual: 0, import: 0 };
  for (const r of db
    .prepare("SELECT COALESCE(first_mode, 'import') AS m, COUNT(*) AS n FROM streamers GROUP BY m")
    .all()) {
    if (r.m in modes) modes[r.m] = Number(r.n) || 0;
  }

  const out = rows.map((r) => {
    const la = Number(r.last_active) || 0;
    return {
      uid: r.uid,
      uname: r.uname || '',
      face: r.face || '',
      roomid: r.roomid || 0,
      first_seen_at: Number(r.first_seen_at) || 0,
      last_seen_at: Number(r.last_seen_at) || 0,
      first_mode: r.first_mode || 'import',
      tier: r.tier,
      tier_label: (TIERS.find((t) => t.id === r.tier) || {}).label || '',
      last_active: la || null,
      // 距上次活跃多少天（小数），前端按需格式化；没有场次为 null
      idle_days: la > 0 ? Math.max(0, (now - la) / 86400) : null,
      session_count: Number(r.session_count) || 0,
      total_seconds: Number(r.total_seconds) || 0,
      peak_online: Number(r.peak_online) || 0,
      is_live: Number(r.open_count) > 0,
    };
  });

  /* 库内历史跨度。
   *
   * 分层边界是 7 / 30 / 90 天，而新库（比如刚建 5 天）里所有人必然都落在热层 ——
   * 页面上就会显示成「一根红条占满 100%」，看起来像分档算错了。
   * 所以把跨度一起返回，让前端能解释「不是坏了，是还没攒够历史」。
   */
  const span = db
    .prepare(
      'SELECT MIN(live_time) AS first, MAX(COALESCE(last_observed_at, live_time)) AS last FROM sessions'
    )
    .get();
  const firstLive = Number(span && span.first) || 0;

  return {
    total: Number(db.prepare('SELECT COUNT(*) AS n FROM streamers').get().n) || 0,
    filtered,
    // 库内最早一场直播至今多少天；库里没有场次时为 0
    history_days: firstLive > 0 ? Math.max(0, (now - firstLive) / 86400) : 0,
    live_now: Number(db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM sessions WHERE ended = 0').get().n) || 0,
    tiers,
    tier_meta: TIERS.map((t) => ({
      id: t.id,
      label: t.label,
      max_days: t.maxDays,
      every_hours: t.everyHours,
      /*
       * slots / slot_hours 要一起给前端，否则卡片只能写「每 7 天查一次」，
       * 而实际节律是「每 7 小时查 1/24 的人」——这两个说法差着 24 倍，
       * 看板上的人会以为调度错了。
       */
      slots: Math.max(1, Number(t.slots) || 1),
      slot_hours: t.slots > 1 ? Math.max(1, t.everyHours / t.slots) : t.everyHours,
      n: tiers[t.id],
    })),
    modes,
    rows: out,
  };
}

/** 读各层上次执行时间；坏数据当作没有 */
function readTierLastRuns(db) {
  try {
    return JSON.parse(getMeta(db, 'track.tier_last_run') || '{}') || {};
  } catch {
    return {};
  }
}

/** 记录本轮查过的层，避免同一周期内重复全量查 */
function saveTierLastRuns(db, chosenTiers, at) {
  const last = readTierLastRuns(db);
  for (const id of chosenTiers) last[id] = at;
  setMeta(db, 'track.tier_last_run', JSON.stringify(last));
}

/**
 * 从标题里抽高频词。
 *
 * 中文没有分词器可用（本项目零依赖），所以用「2-gram + 3-gram 频次」近似：
 * 三角洲行动的标题里，「三角洲」「锦标赛」「摸金」这类 2~4 字词占绝大多数，
 * 滑窗切分再统计足够用。副作用是会切出「洲行」这种无意义片段，靠下面的
 * 子串去重压掉：如果某个 2-gram 的频次基本被包含它的 3-gram 吃掉，就丢弃它。
 *
 * 纯数字 / 单字 / 含虚词的片段一律过滤，否则 top 榜会被「的」「一」占满。
 */
function topWords(titles, limit = 40) {
  // 虚词与无信息高频字：出现即丢弃该片段
  const STOP = /[的了和是在我有就不人都一这那个什么怎么不是可以我们你们他们还也很来去上下啊吧呢吗哦呀哈与跟让把被给对从到说看要会能没好大小多少第次只想个主玩于为而且或者但因为所以如果]|直播|房间|播间/;
  const counts = new Map();

  const add = (w) => {
    if (w.length < 2 || w.length > 6) return;
    if (STOP.test(w)) return;
    // 纯数字（如「33」）和数字为主的片段（如「做3」）没有分析价值，
    // 它们通常来自价格、段位、时间，留在榜上只会挤掉真正的主题词。
    if (/^\d+$/.test(w)) return;
    if (/\d/.test(w) && !/[A-Za-z\u4e00-\u9fa5]/.test(w.replace(/\d/g, ''))) return;
    if ((w.match(/\d/g) || []).length >= w.length - 1) return;
    counts.set(w, (counts.get(w) || 0) + 1);
  };

  for (const t of titles) {
    // 先把标点、表情、符号统一换成空格，切开后再逐段滑窗
    const clean = String(t || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ');
    for (const seg of clean.split(/\s+/)) {
      if (!seg) continue;
      if (/^[\x00-\x7F]+$/.test(seg)) {
        // 纯英文/数字段整体算一个词（如 CS2、FPS）
        if (seg.length >= 2) add(seg.toLowerCase());
        continue;
      }
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) add(seg.slice(i, i + n));
      }
    }
  }

  /*
   * 去重必须对「全部候选」判定，不能只看已入选的词。
   *
   * 初版只检查已入选列表，结果 2-gram 因为频次天然更高而先入榜，
   * 等 3-gram「三角洲」回来时已经没人能吞掉它，于是
   * 「三角 / 角洲 / 三角洲」三条一起上榜 —— 一个主题占了三个位置。
   * 正确做法：只要存在某个更长的词包含自己、且频次不低，就说明自己
   * 只是它的碎片，直接丢弃。
   *
   * ⚠ 但绝不能「每个词遍历全部候选」来实现。那样是 O(候选数²)，
   *   线上 6700 场次时这段要跑 20 秒以上；而它是同步计算，会把 Node
   *   单线程的事件循环整个堵住 —— 用户看到的是「点开数据分析页，
   *   连实时看板、出勤页一起卡死，像网站崩了」。
   *
   *   反过来做：候选词最长 6 个字，它自己的连续子串最多十几个，
   *   于是枚举「长词的所有子串」去反查表，总工作量只与候选词数成正比。
   *   判定条件与原来完全等价：long.includes(short) 等价于 short 是
   *   long 的连续子串。
   */
  const eaten = new Set();
  for (const [other, on] of counts) {
    // 2 字词没有更短的可吞，直接跳过
    if (other.length < 3) continue;
    for (let n = 2; n < other.length; n++) {
      for (let i = 0; i + n <= other.length; i++) {
        const sub = other.slice(i, i + n);
        const subN = counts.get(sub);
        // 长词频次达到短词的 70% 就算「吃掉」，允许一定噪声落差
        if (subN !== undefined && on >= subN * 0.7) eaten.add(sub);
      }
    }
  }

  return [...counts.entries()]
    .filter(([w]) => !eaten.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w, n]) => ({ w, n }));
}

/**
 * 分析页的一次性聚合。
 *
 * 为什么合成一个函数而不是拆 6 个导出：这些都是同一个小库（几千行）上的
 * 聚合查询，分成 6 个 HTTP 请求会让首屏等 6 次往返，收益为零。合成一个
 * 接口后前端只发一次请求，也便于「刷新」一次性拿到一致快照。
 *
 * ⚠ 口径提醒（前端必须显示，否则会被误读）：
 *   - 时段 / 星期分布反映的是「采集时刻」，不是主播真实开播规律。
 *     track 是定时任务，只在配置的时段跑，所以那些桶天然被放大。
 *   - 时长只用 ended = 1 的场次，因为它有确切的收尾观测；
 *     ended = 0 的场次还在进行中，算出来的只会是「至今观测了多久」。
 */
function analyze(db, { topN = 20, wordN = 40 } = {}) {
  const one = (sql, ...p) => db.prepare(sql).get(...p) || {};
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const t = one(`SELECT
      (SELECT COUNT(*) FROM streamers) AS streamers,
      (SELECT COUNT(*) FROM sessions)  AS sessions,
      (SELECT COUNT(*) FROM sessions WHERE ended = 0) AS open_sessions,
      (SELECT COUNT(*) FROM sessions WHERE ended = 1) AS closed_sessions,
      (SELECT COUNT(*) FROM sessions WHERE peak_online > 0) AS online_samples,
      (SELECT MIN(live_time) FROM sessions) AS first_live,
      (SELECT MAX(live_time) FROM sessions) AS last_live,
      (SELECT COUNT(*) FROM collect_runs)   AS runs`);

  // 人气分档：用 JS 分桶而不是 SQL CASE，档位改起来只动一处
  const ONLINE_BUCKETS = [
    ['0-9', 0, 10],
    ['10-49', 10, 50],
    ['50-99', 50, 100],
    ['100-499', 100, 500],
    ['500-999', 500, 1000],
    ['1000-4999', 1000, 5000],
    ['5000+', 5000, Infinity],
  ];
  const onlineVals = all('SELECT peak_online AS v FROM sessions WHERE peak_online > 0').map(
    (r) => Number(r.v) || 0
  );
  const onlineDist = ONLINE_BUCKETS.map(([label, lo, hi]) => ({
    label,
    n: onlineVals.filter((v) => v >= lo && v < hi).length,
  }));

  // 开播时段（东八区）：日历上 24 个桶，缺的补 0，否则前端画不齐
  const rawHours = all(
    `SELECT CAST(strftime('%H', live_time + ${TZ_OFFSET}, 'unixepoch') AS INTEGER) AS h,
            COUNT(*) AS n
       FROM sessions GROUP BY h`
  );
  const hourDist = Array.from({ length: 24 }, (_, h) => ({ h, n: 0 }));
  for (const r of rawHours) {
    const h = Number(r.h);
    if (h >= 0 && h < 24) hourDist[h].n = Number(r.n) || 0;
  }

  // 星期分布
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const rawDow = all(
    `SELECT strftime('%w', live_time + ${TZ_OFFSET}, 'unixepoch') AS w, COUNT(*) AS n
       FROM sessions GROUP BY w`
  );
  const weekdayDist = WD.map((label, i) => {
    const hit = rawDow.find((r) => Number(r.w) === i);
    return { label, n: Number(hit && hit.n) || 0 };
  });

  // 时长分布：只算已收尾场次
  const DUR_BUCKETS = [
    ['<10 分', 0, 600],
    ['10-30 分', 600, 1800],
    ['30-60 分', 1800, 3600],
    ['1-2 时', 3600, 7200],
    ['2-4 时', 7200, 14400],
    ['4 时+', 14400, Infinity],
  ];
  const durVals = all(
    'SELECT (last_observed_at - first_observed_at) AS sec FROM sessions WHERE ended = 1'
  )
    .map((r) => Math.max(0, Number(r.sec) || 0))
    .sort((a, b) => a - b);
  const durDist = DUR_BUCKETS.map(([label, lo, hi]) => ({
    label,
    n: durVals.filter((s) => s >= lo && s < hi).length,
  }));
  const durMedian = durVals.length ? durVals[Math.floor(durVals.length / 2)] : 0;

  // 人气 Top N：按历史峰值排，附场均与场次数
  const top = all(
    `SELECT s.uid, s.uname, s.face, s.roomid,
            MAX(x.peak_online) AS peak,
            COUNT(*)           AS sessions
       FROM streamers s
       JOIN sessions x ON x.uid = s.uid
      GROUP BY s.uid
      ORDER BY peak DESC, sessions DESC
      LIMIT ?`,
    topN
  ).map((r) => ({
    uid: r.uid,
    uname: r.uname || '',
    face: r.face || '',
    roomid: r.roomid || 0,
    peak: Number(r.peak) || 0,
    sessions: Number(r.sessions) || 0,
  }));

  // 标题词频
  const titles = all(
    "SELECT title FROM sessions WHERE title IS NOT NULL AND title <> ''"
  ).map((r) => r.title);
  const words = topWords(titles, wordN);

  return {
    totals: {
      streamers: Number(t.streamers) || 0,
      sessions: Number(t.sessions) || 0,
      open_sessions: Number(t.open_sessions) || 0,
      closed_sessions: Number(t.closed_sessions) || 0,
      online_samples: Number(t.online_samples) || 0,
      runs: Number(t.runs) || 0,
      first_live: Number(t.first_live) || 0,
      last_live: Number(t.last_live) || 0,
    },
    onlineDist,
    hourDist,
    weekdayDist,
    durDist,
    durMedian,
    durSamples: durVals.length,
    top,
    words,
    wordSamples: titles.length,
  };
}

function stats(db, now = Math.floor(Date.now() / 1000)) {
  const s = db.prepare('SELECT COUNT(*) AS n FROM streamers').get();
  const sess = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
  const open = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended = 0').get();
  const last = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1').get();
  const totalSec = db
    .prepare('SELECT SUM(COALESCE(last_observed_at, ?) - live_time) AS s FROM sessions')
    .get(now);
  return {
    streamers: Number(s.n) || 0,
    sessions: Number(sess.n) || 0,
    open_sessions: Number(open.n) || 0,
    total_hours: Math.round(((Number(totalSec.s) || 0) / 3600) * 10) / 10,
    last_run: last || null,
  };
}

module.exports = {
  TZ_OFFSET,
  openDb,
  dayKey,
  dayStart,
  splitByDay,
  getMeta,
  setMeta,
  getAllMeta,
  upsertStreamer,
  closeOpenSessions,
  recordLive,
  searchStreamers,
  getStreamer,
  filterKnownUids,
  listSessions,
  attendanceCalendar,
  liveNow,
  discoveryDays,
  discoveryList,
  trendRuns,
  liveStatusMap,
  stats,
  analyze,
  topWords,
  TIERS,
  tierOf,
  planTrackPool,
  poolList,
  readTierLastRuns,
  saveTierLastRuns,
};