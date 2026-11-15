'use strict';

/**
 * 采集调度器（可选，替代 crontab）
 *
 * 为什么需要它：
 *   discover（扫专区找新人）如果固定每天同一时刻跑，凌晨开播的新主播会
 *   永远发现不了 —— 因为分区列表接口只返回「此刻在播」的房间，而固定时刻
 *   扫描等于每天只在这个时刻睁一次眼。
 *
 * 解决办法：让间隔不是 24 小时，而是 23 或 25 小时。
 *   这样每天的执行时刻自然往后/往前漂移，长期能覆盖全部 24 个小时。
 *
 * 两种跑法可以共存：
 *   1. crontab（服务器上更稳，进程挂了 cron 还在）
 *   2. 本调度器（在网页里就能改频次，无需登服务器）
 *   建议二选一，不要同时开，否则请求量翻倍。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TZ_OFFSET = 8 * 3600;

/** 配置默认值：宁可保守，也不要一上来就高频请求 */
const DEFAULT_CONFIG = {
  enabled: false, // 默认关闭，必须在网页里显式开启
  trackHours: 1, // track：每隔几小时查一次在播状态
  discoverHours: 23, // discover：每隔几小时扫一次专区（23 而非 24，让时刻漂移）
  discoverMaxPages: 100,
  trackBatchDelay: 1500, // 批量查状态间隔（毫秒），防风控
  discoverDelay: 2000, // 翻页间隔基准（毫秒），实际会在 2~3.5 倍间随机
};

const META_CONFIG = 'sched.config';
const META_STATE = 'sched.state';

/** 单次子任务的超时：track 18 批约 1 分钟，discover 82 页约 4 分钟，留足余量 */
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
/** 调度检查间隔 */
const TICK_MS = 30 * 1000;

/**
 * 「过期」宽限期：超过这个时长还没跑，就认为服务停过，顺延到下一个未来时刻而不是立刻补跑。
 *
 * 取值依据：tick 每 30 秒一次，正常情况下到期后最多落后一个 tick；
 * 即使另一个任务正在跑（track 约 1 分钟、discover 约 4 分钟）而被跳过，
 * 落后也远小于 10 分钟。只有服务真的停止过才会超过这个值。
 */
const OVERDUE_GRACE_SEC = 10 * 60;

/* ---------------------------------------------------------------- 配置 */

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true || c.enabled === 'true',
    // track 最短 1 小时：再密就会明显增加风控风险
    trackHours: clampNumber(c.trackHours, 1, 168, DEFAULT_CONFIG.trackHours),
    // discover 允许 1~168 小时，实际建议 23 或 25
    discoverHours: clampNumber(c.discoverHours, 1, 168, DEFAULT_CONFIG.discoverHours),
    discoverMaxPages: clampNumber(c.discoverMaxPages, 1, 300, DEFAULT_CONFIG.discoverMaxPages),
    trackBatchDelay: clampNumber(c.trackBatchDelay, 500, 10000, DEFAULT_CONFIG.trackBatchDelay),
    discoverDelay: clampNumber(c.discoverDelay, 500, 10000, DEFAULT_CONFIG.discoverDelay),
  };
}

function loadConfig(db, dbModule) {
  const raw = dbModule.getMeta(db, META_CONFIG);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(db, dbModule, cfg) {
  const clean = normalizeConfig(cfg);
  dbModule.setMeta(db, META_CONFIG, JSON.stringify(clean));
  return clean;
}

function loadState(db, dbModule) {
  const raw = dbModule.getMeta(db, META_STATE);
  if (!raw) return {};
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveState(db, dbModule, state) {
  dbModule.setMeta(db, META_STATE, JSON.stringify(state));
}

/**
 * 算下一次该跑的时间。
 *
 * 关键：next = last + interval，而不是对齐整点。
 * 这样 23 小时的间隔会每天提前 1 小时，25 小时的会每天推后 1 小时，
 * 长期下来覆盖全天所有时段，凌晨开播的新主播也能被发现。
 *
 * 如果服务停了很久（now 已远超 next），不能补跑一串积压任务，
 * 只顺延到「下一个未来时刻」，否则重启瞬间会连发几十个请求。
 */
function computeNextAt(lastAt, intervalHours, now = Math.floor(Date.now() / 1000)) {
  const step = Math.max(1, Number(intervalHours) || 1) * 3600;
  if (!lastAt || !Number.isFinite(Number(lastAt))) return now + 60; // 首次：1 分钟后跑
  let next = Number(lastAt) + step;
  if (next > now) return next;
  // 已过期：跳到下一个未来时刻，且至少留 60 秒缓冲
  const missed = Math.floor((now - next) / step) + 1;
  next = next + missed * step;
  return Math.max(next, now + 60);
}

/* ---------------------------------------------------------------- 调度器 */

/**
 * 创建一个调度器实例。
 * @param {object} opts
 * @param {function} opts.getDb      返回当前数据库句柄（可能为 null）
 * @param {object}   opts.dbModule   lib/db.js
 * @param {string}   opts.dbFile     数据库路径，传给子进程
 * @param {function} opts.log        日志函数
 */
function createScheduler({ getDb, dbModule, dbFile, log = console.log, logger = null }) {
  /** 正在跑的任务：{ track: bool, discover: bool } */
  const running = { track: false, discover: false };
  /** 内存里保留最近一次结果，供前端展示 */
  const lastResult = { track: null, discover: null };
  /**
   * 正在跑的任务的实时进度，供前端轮询展示。
   * 只在内存里，进程重启即清空——这是「此刻跑到哪」的状态，不是历史数据。
   */
  const progress = { track: null, discover: null };
  let timer = null;
  let stopped = true;

  /**
   * 同时写控制台和运行日志。
   *
   * 为什么要包一层：调度是唯一会在后台自己动起来的部分，
   * 出问题时用户只能看到网页，控制台输出他看不到。
   * logger 未注入时退化为原来的纯 console 行为，不改变既有调用。
   */
  function note(level, scope, msg, extra = {}) {
    log(msg);
    if (!logger) return;
    try {
      logger.log(level, scope, msg, extra);
    } catch {
      /* 日志失败绝不能影响采集本身 */
    }
  }

  function stateOf() {
    const db = getDb();
    return db ? loadState(db, dbModule) : {};
  }

  function patchState(patch) {
    const db = getDb();
    if (!db) return;
    const s = { ...loadState(db, dbModule), ...patch };
    saveState(db, dbModule, s);
  }

  /**
   * 上次真实执行时间，从 collect_runs 兜底查。
   *
   * 为什么需要兜底：sched.state 只是一个 JSON 字段，可能缺失、被清空，
   * 或者随着 data/ 目录一起从别处复制过来而错位。一旦 state 里没有
   * LastAt，plan() 会把它当成「从未跑过」从而立刻补跑一轮。
   * collect_runs 是每次执行都写进去的真实记录，二者不一致时以它为准。
   */
  function lastRunAt(db, kind) {
    if (!db) return 0;
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(finished_at, started_at) AS at FROM collect_runs
            WHERE mode = ? AND status IS NOT NULL AND status != 'running'
            ORDER BY id DESC LIMIT 1`
        )
        .get(kind);
      return Number(row && row.at) || 0;
    } catch {
      return 0;
    }
  }

  /** 当前应跑什么。返回 { track: {due,nextAt}, discover: {...} } */
  function plan(now = Math.floor(Date.now() / 1000)) {
    const db = getDb();
    const cfg = db ? loadConfig(db, dbModule) : { ...DEFAULT_CONFIG };
    const st = stateOf();

    const mk = (key, intervalHours) => {
      // state 优先，缺失时用 collect_runs 的真实记录兜底
      const lastAt = Number(st[`${key}LastAt`]) || lastRunAt(db, key) || 0;
      let nextAt = Number(st[`${key}NextAt`]) || 0;
      // 配置改了间隔之后，旧的 nextAt 就失效了，必须重算
      const intervalChanged = Number(st[`${key}Interval`]) !== Number(intervalHours);
      // 停机期间错过的那次不补跑：tick 每 30 秒检查一次，正常情况下到期后
      // 最多落后一个 tick；超过宽限期说明服务停止过（或 nextAt 是从别处
      // 复制来的陈旧值），此时必须顺延到未来的下一个时刻。
      // 否则重启瞬间会立刻发一轮请求——实测中曾因此误跑了一次 discover。
      const stale = nextAt > 0 && nextAt <= now - OVERDUE_GRACE_SEC;
      if (!nextAt || intervalChanged || stale) {
        nextAt = computeNextAt(lastAt, intervalHours, now);
        patchState({
          [`${key}NextAt`]: nextAt,
          [`${key}Interval`]: intervalHours,
        });
      }
      return { lastAt, nextAt, due: now >= nextAt };
    };

    return {
      enabled: cfg.enabled,
      config: cfg,
      track: mk('track', cfg.trackHours),
      discover: mk('discover', cfg.discoverHours),
    };
  }

  /**
   * 起一个采集子进程。
   *
   * @param {'track'|'discover'} kind
   * @param {object} cfg
   * @param {object} [jobOpts]
   * @param {boolean} [jobOpts.full] track 专用：绕过分层，查池中全部主播。
   *   手动「立即 track 一次」用它——用户点按钮就是想看此刻真实状态，
   *   不该被「本层还没到期」挡在门外。自动调度永远不传，保持省请求。
   */
  function runJob(kind, cfg, jobOpts = {}) {
    if (running[kind]) return { skipped: 'already-running' };
    const db = getDb();
    if (!db) return { skipped: 'no-db' };

    running[kind] = true;
    const startedAt = Math.floor(Date.now() / 1000);
    // 重置上一轮的进度，避免新一轮开始时前端还显示旧的 done 状态
    progress[kind] = { kind, phase: 'starting', done: 0, total: 0, receivedAt: startedAt };

    const args = [path.join(ROOT, 'collect-track.js'), '--db', dbFile, '--mode', kind, '--quiet'];
    args.push('--progress');
    if (kind === 'discover') {
      args.push('--max-pages', String(cfg.discoverMaxPages));
      args.push('--delay', String(cfg.discoverDelay));
    } else {
      args.push('--batch-delay', String(cfg.trackBatchDelay));
      // 手动触发才绕过分层。自动调度不传，靠分层把请求量压住。
      if (jobOpts.full) args.push('--full');
    }

    note('info', kind, `开始 ${kind}`, {
      detail: `上次 ${new Date((Number(stateOf()[`${kind}LastAt`]) || 0) * 1000).toLocaleString('zh-CN')}`,
    });

    let out = '';
    let errOut = '';
    let lineBuf = ''; // stdout 跨 chunk 的行缓冲，用于解析 ##PROGRESS## 行
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      running[kind] = false;
      lastResult[kind] = { at: startedAt, ok: false, error: String(err.message || err) };
      note('error', kind, `${kind} 启动失败`, { err: String(err.message || err) });
      return { error: String(err.message || err) };
    }

    const killTimer = setTimeout(() => {
      note('warn', kind, `${kind} 超时，强制结束`, { detail: `${JOB_TIMEOUT_MS / 60000} 分钟` });
      try {
        child.kill();
      } catch {}
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 8000) out = out.slice(-8000);

      // 按行切分解析进度行。必须缓冲：一个 chunk 可能只含半行，
      // 直接用正则匹配整个 chunk 会把跨 chunk 的进度行漏掉。
      lineBuf += s;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // 末尾可能是半行，留给下一个 chunk
      for (const l of lines) {
        const m = /^##PROGRESS##\s+(.*)$/.exec(l.trim());
        if (!m) continue;
        try {
          progress[kind] = { ...JSON.parse(m[1]), receivedAt: Math.floor(Date.now() / 1000) };
        } catch {
          /* 进度行解析失败忽略，不能影响采集 */
        }
      }
    });
    child.stderr.on('data', (d) => {
      errOut += d.toString();
      if (errOut.length > 4000) errOut = errOut.slice(-4000);
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      running[kind] = false;
      lastResult[kind] = { at: startedAt, ok: false, error: String(err.message || err) };
      note('error', kind, `${kind} 进程错误`, { err: String(err.message || err) });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      running[kind] = false;
      const finishedAt = Math.floor(Date.now() / 1000);
      const ok = code === 0;

      // 无论成功失败都要推进 nextAt，否则失败会每 30 秒重试一次，极易触发风控
      const nextAt = computeNextAt(finishedAt, cfg[`${kind}Hours`], finishedAt);
      patchState({
        [`${kind}LastAt`]: finishedAt,
        [`${kind}NextAt`]: nextAt,
        [`${kind}Interval`]: cfg[`${kind}Hours`],
        [`${kind}LastOk`]: ok,
      });

      // 从 stdout 里抓那行 JSON 汇总结论
      let summary = null;
      const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (line) {
        try {
          summary = JSON.parse(line);
        } catch {}
      }

      lastResult[kind] = {
        at: finishedAt,
        ok,
        code,
        summary,
        error: ok ? null : errOut.trim().slice(-500) || `退出码 ${code}`,
      };

      const secs = finishedAt - startedAt;
      if (ok) {
        note('info', kind, `${kind} 完成`, {
          detail: `耗时 ${secs} 秒`,
          summary: summary ? JSON.stringify(summary) : null,
        });
      } else {
        // 失败原因原样保留：stderr 尾部通常就是「-352 风控」「退出码 1」这类根因
        note('error', kind, `${kind} 失败（退出码 ${code}）`, {
          detail: `耗时 ${secs} 秒；${errOut.trim().slice(-800) || '无 stderr 输出'}`,
          code,
        });
      }
      note('info', kind, `下次 ${kind} 已排定`, {
        detail: new Date(nextAt * 1000).toLocaleString('zh-CN'),
      });
    });

    return { started: true };
  }

  function tick() {
    if (stopped) return;
    let p;
    try {
      p = plan();
    } catch (err) {
      note('error', 'sched', '规划失败', { err: String(err.message || err) });
      return;
    }
    if (!p.enabled) return;
    if (p.track.due) runJob('track', p.config);
    if (p.discover.due) runJob('discover', p.config);
  }

  /** 对外状态：给前端用 */
  function status() {
    const db = getDb();
    if (!db) {
      return { available: false, error: '数据库不可用', running };
    }
    let cfg;
    let p;
    try {
      cfg = loadConfig(db, dbModule);
      p = plan();
    } catch (err) {
      return { available: false, error: `读取配置失败：${err.message}`, running };
    }

    // 从 collect_runs 取最近一次「已完成」的执行记录（重启后依然有）
    // 必须排除 status='running'：那是采集进行中插入的占位行，
    // 各统计列还是空的，拿来当「上次结果」会显示成「池 — 人 · 在播 —」。
    const lastRun = (mode) => {
      try {
        return (
          db
            .prepare(
              `SELECT * FROM collect_runs
                WHERE mode = ? AND status IS NOT NULL AND status != 'running'
                ORDER BY id DESC LIMIT 1`
            )
            .get(mode) || null
        );
      } catch {
        return null;
      }
    };

    return {
      available: true,
      config: cfg,
      enabled: cfg.enabled,
      running,
      // 主播池规模：手动 track 的确认框要按它算「全量查多少人 / 多少批」
      poolSize: (() => {
        try {
          const r = db.prepare('SELECT COUNT(*) AS n FROM streamers').get();
          return Number(r && r.n) || 0;
        } catch {
          return 0;
        }
      })(),
      // 实时进度：只在采集进行中才有值，跑完或未跑为 null
      progress: { track: progress.track, discover: progress.discover },
      track: {
        lastAt: p.track.lastAt || null,
        nextAt: p.track.nextAt || null,
        intervalHours: cfg.trackHours,
        due: p.track.due,
        lastRun: lastRun('track'),
      },
      discover: {
        lastAt: p.discover.lastAt || null,
        nextAt: p.discover.nextAt || null,
        intervalHours: cfg.discoverHours,
        due: p.discover.due,
        lastRun: lastRun('discover'),
      },
      lastResult,
      now: Math.floor(Date.now() / 1000),
      tzOffset: TZ_OFFSET,
    };
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref();
    note('info', 'sched', '调度器已启动', { detail: '每 30 秒检查一次是否到点' });
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 立即跑一次（前端按钮用） */
  function runNow(kind) {
    if (kind !== 'track' && kind !== 'discover') return { error: 'kind 只能是 track / discover' };
    const db = getDb();
    if (!db) return { error: '数据库不可用' };
    const cfg = loadConfig(db, dbModule);
    // 手动触发时不受 enabled 限制，但要有最短间隔保护，避免连点
    const st = stateOf();
    const lastAt = Number(st[`${kind}LastAt`]) || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const minGap = kind === 'track' ? 120 : 600;
    if (lastAt && nowSec - lastAt < minGap) {
      return { error: `距离上次 ${kind} 不足 ${Math.round(minGap / 60)} 分钟，请稍后再试（防风控）` };
    }
    // 手动 track 绕过分层：用户点按钮是要「此刻的真实状态」，
    // 分层会因「本层还没到期」直接空转返回 0，看着像坏了（实测已发生）。
    // discover 没有分层概念，不需要这个开关。
    return runJob(kind, cfg, { full: kind === 'track' });
  }

  return { start, stop, tick, status, runNow, plan, computeNextAt };
}

module.exports = {
  DEFAULT_CONFIG,
  JOB_TIMEOUT_MS,
  normalizeConfig,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  computeNextAt,
  createScheduler,
};