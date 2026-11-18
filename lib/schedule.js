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

  /*
   * radar：按开播时间扫分区榜，找回「冰层复播」的人。
   *
   * 为什么它必须比 track 密得多：track 按分层刷，冰层的每个人 24 小时才轮到
   * 一次；而主播复播后能播多久是不确定的，短播可能只有一两个小时。
   * 靠 track 兜底等于「每天随机抽查一次」，漏采率很高。
   *
   * radar 的间隔是分钟级、且带抖动（见 computeRadarNextAt）。默认 5 分钟，
   * 正好与实测的榜单覆盖密度匹配：page_size=50 时第 1 页覆盖最近约 1~3 分钟，
   * 2 页到 5 分钟左右，所以 5 分钟一轮能接上，不留空窗。
   */
  radarEnabled: true,
  radarMinutes: 5,
  radarPages: 2,
  radarArea: 878,
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
    // radar 的开关单独给出：想彻底静默时可以不关 enabled 而只关它
    radarEnabled: c.radarEnabled === true || c.radarEnabled === 'true' || c.radarEnabled === undefined
      ? c.radarEnabled !== false && c.radarEnabled !== 'false'
      : false,
    // 最短 2 分钟：实测 page_size=50 第 1 页覆盖约 1~3 分钟，
    // 比这更密只是重复扫同一批人，纯浪费请求
    radarMinutes: clampNumber(c.radarMinutes, 2, 120, DEFAULT_CONFIG.radarMinutes),
    radarPages: clampNumber(c.radarPages, 1, 20, DEFAULT_CONFIG.radarPages),
    radarArea: clampNumber(c.radarArea, 1, 99999, DEFAULT_CONFIG.radarArea),
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

/**
 * radar 的下次执行时刻：分钟级间隔 + **随机抖动**。
 *
 * 为什么不直接用 computeNextAt：
 *
 * 1. 它是小时级的，radar 要的是 5 分钟级。
 * 2. 更要紧的是抖动。严格每 300 秒一次，是机器最典型的特征之一——真实用户
 *    不会把翻页精确到秒。抖动把这一层的规律性抹掉，也顺带避免了
 *    「每小时的固定分钟」这种长期累积出来的指纹。
 *
 * 抖动幅度取 ±30 秒而不是按比例放大：基准 5 分钟时，2 页榜单大约覆盖最近
 * 5 分钟的开播，抖动到 6.5 分钟就会漏掉中间一段。±30 秒既打散了节律，
 * 又不至于让扫描窗口断开。
 *
 * 首次（没有 lastAt）留 60 秒，让服务启动后先跑完 track 再扫雷达。
 */
function computeRadarNextAt(lastAt, intervalMinutes, now = Math.floor(Date.now() / 1000)) {
  const base = Math.max(2, Number(intervalMinutes) || 5) * 60;
  const jitter = () => Math.round((Math.random() * 2 - 1) * 30);
  if (!lastAt || !Number.isFinite(Number(lastAt))) return now + 60;
  let next = Number(lastAt) + base + jitter();
  if (next > now) return next;
  // 停机期间错过的不补跑：只顺延到下一个未来时刻
  const missed = Math.floor((now - next) / base) + 1;
  next = next + missed * base + jitter();
  return Math.max(next, now + 30);
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
  /** 正在跑的任务：{ track: bool, discover: bool, radar: bool } */
  const running = { track: false, discover: false, radar: false };
  /** 内存里保留最近一次结果，供前端展示 */
  const lastResult = { track: null, discover: null, radar: null };
  /**
   * 正在跑的任务的实时进度，供前端轮询展示。
   * 只在内存里，进程重启即清空——这是「此刻跑到哪」的状态，不是历史数据。
   */
  const progress = { track: null, discover: null, radar: null };
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

    /*
     * radar 是分钟级的，宽限期必须另算。
     *
     * 沿用上面那套 10 分钟的 OVERDUE_GRACE_SEC 会出大问题：radar 每 5 分钟一轮，
     * 服务只要停过十几分钟，`nextAt <= now - 600` 就成立，于是每 tick 都判成
     * 「stale」并重算一个未来时刻 —— 结果是 radar 永远不跑。
     * 这里改成「错过不超过 2 个周期才算补跑」，贴合分钟级语义。
     */
    const mkRadar = () => {
      if (!cfg.radarEnabled) return { lastAt: 0, nextAt: 0, due: false, disabled: true };
      const lastAt = Number(st.radarLastAt) || lastRunAt(db, 'radar') || 0;
      let nextAt = Number(st.radarNextAt) || 0;
      const intervalChanged = Number(st.radarInterval) !== Number(cfg.radarMinutes);
      const step = Math.max(2, Number(cfg.radarMinutes) || 5) * 60;
      const stale = nextAt > 0 && nextAt <= now - step * 2;
      if (!nextAt || intervalChanged || stale) {
        nextAt = computeRadarNextAt(lastAt, cfg.radarMinutes, now);
        patchState({ radarNextAt: nextAt, radarInterval: cfg.radarMinutes });
      }
      return { lastAt, nextAt, due: now >= nextAt };
    };

    return {
      enabled: cfg.enabled,
      config: cfg,
      track: mk('track', cfg.trackHours),
      discover: mk('discover', cfg.discoverHours),
      radar: mkRadar(),
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
    } else if (kind === 'radar') {
      args.push('--radar-pages', String(cfg.radarPages));
      args.push('--radar-area', String(cfg.radarArea));
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
      let nextAt;
      if (kind === 'radar') {
        // radar 是分钟级 + 抖动，不能套小时级的 computeNextAt
        nextAt = computeRadarNextAt(finishedAt, cfg.radarMinutes, finishedAt);
        patchState({
          radarLastAt: finishedAt,
          radarNextAt: nextAt,
          radarInterval: cfg.radarMinutes,
          radarLastOk: ok,
        });
      } else {
        nextAt = computeNextAt(finishedAt, cfg[`${kind}Hours`], finishedAt);
        patchState({
          [`${kind}LastAt`]: finishedAt,
          [`${kind}NextAt`]: nextAt,
          [`${kind}Interval`]: cfg[`${kind}Hours`],
          [`${kind}LastOk`]: ok,
        });
      }

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
    // radar 放最后：它是分钟级的，优先级低于每小时的数据刷新，
    // 且 track 跑起来时有几十批请求要排队，不该被 5 分钟一轮的雷达插队。
    if (p.radar && p.radar.due) runJob('radar', p.config);
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
      progress: { track: progress.track, discover: progress.discover, radar: progress.radar },
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
      radar: {
        enabled: cfg.radarEnabled,
        lastAt: p.radar.lastAt || null,
        nextAt: p.radar.nextAt || null,
        intervalMinutes: cfg.radarMinutes,
        pages: cfg.radarPages,
        area: cfg.radarArea,
        due: p.radar.due,
        lastRun: lastRun('radar'),
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
    if (kind !== 'track' && kind !== 'discover' && kind !== 'radar') {
      return { error: 'kind 只能是 track / discover / radar' };
    }
    const db = getDb();
    if (!db) return { error: '数据库不可用' };
    const cfg = loadConfig(db, dbModule);
    // 手动触发时不受 enabled 限制，但要有最短间隔保护，避免连点
    const st = stateOf();
    const lastAt = kind === 'radar'
      ? Number(st.radarLastAt) || 0
      : Number(st[`${kind}LastAt`]) || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    // radar 轮得快，最短间隔取它自己的周期，否则手点一下就把节奏打乱
    const minGap = kind === 'track' ? 120 : kind === 'radar' ? 60 : 600;
    if (lastAt && nowSec - lastAt < minGap) {
      return { error: `距离上次 ${kind} 不足 ${Math.round(minGap / 60)} 分钟，请稍后再试（防风控）` };
    }
    // 手动 track 绕过分层：用户点按钮是要「此刻的真实状态」，
    // 分层会因「本层还没到期」直接空转返回 0，看着像坏了（实测已发生）。
    // discover / radar 没有分层概念，不需要这个开关。
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
  computeRadarNextAt,
  createScheduler,
};