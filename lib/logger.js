'use strict';

/**
 * 运行日志。
 *
 * 两个去处：
 *   1. 内存 ring buffer —— 供前端 `/api/logs` 立刻读到，进程重启即清空
 *   2. `data/logs.jsonl`  —— 逐行追加，容器重建后依然能查（data/ 是挂载目录）
 *
 * 为什么不用现成的日志库：本项目零依赖，`node:sqlite` 之外不装任何包。
 * 日志量很小（一次 track 十几行，一天几十行），同步 append 完全够用。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 内存里最多保留多少条（前端一次最多看几百条，再多也没意义） */
const MAX_MEMORY = 800;
/** 落盘文件最多保留多少行，超过就截断重写，避免无限增长 */
const MAX_FILE_LINES = 5000;

/**
 * 日志级别。数值越大越严重，用于 `?level=` 过滤（「只看 warn 及以上」）。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({ file = null, maxMemory = MAX_MEMORY, maxFileLines = MAX_FILE_LINES } = {}) {
  /** 时间正序，超出上限从头丢 */
  const buf = [];
  let seq = 0;

  // 启动时统计已有行数，超限就截断——必须在第一次 append 之前做，
  // 否则文件只会一路涨下去。
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n').filter((l) => l.trim());
        if (lines.length > maxFileLines) {
          const keep = lines.slice(-maxFileLines);
          fs.writeFileSync(file, keep.join('\n') + '\n');
          lines.length = 0;
        }
      }
    } catch {
      /* 文件不可用不影响内存日志 */
    }
  }

  function toFile(entry) {
    if (!file) return;
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch {
      /* 磁盘满/只读时静默，内存日志仍然可用 */
    }
  }

  /**
   * 记一条。
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} scope  来源，如 'track' / 'discover' / 'server' / 'sched'
   * @param {string} msg    人话描述，直接展示给用户
   * @param {object} [extra] 附加字段（err / code / detail / summary…），会展开进日志行
   */
  function log(level, scope, msg, extra = {}) {
    const entry = {
      id: ++seq,
      t: Math.floor(Date.now() / 1000),
      level: LEVELS[level] ? level : 'info',
      scope: String(scope || 'app'),
      msg: String(msg == null ? '' : msg),
      ...extra,
    };

    // extra 里的 err（Error 实例）要转成字符串，否则 JSON.stringify 后是 {}
    if (entry.err instanceof Error) entry.err = entry.err.message;

    buf.push(entry);
    while (buf.length > maxMemory) buf.shift();
    toFile(entry);
    return entry;
  }

  const info = (scope, msg, extra) => log('info', scope, msg, extra);
  const warn = (scope, msg, extra) => log('warn', scope, msg, extra);
  const error = (scope, msg, extra) => log('error', scope, msg, extra);

  /**
   * 查内存日志。
   * @param {object} opts
   * @param {string} [opts.level] 最低级别（warn = 只要 warn 和 error）
   * @param {string} [opts.scope] 限定来源
   * @param {string} [opts.q]     关键词（大小写不敏感，匹配 msg/err/detail）
   * @param {number} [opts.limit] 最多返回几条（取最新的）
   */
  function query({ level, scope, q, limit = 200 } = {}) {
    const min = LEVELS[level] || 0;
    let rows = buf;
    if (min) rows = rows.filter((e) => (LEVELS[e.level] || 0) >= min);
    if (scope) rows = rows.filter((e) => e.scope === scope);
    if (q) {
      const kw = String(q).toLowerCase();
      rows = rows.filter((e) =>
        [e.msg, e.detail, e.err, e.summary].some((v) => v && String(v).toLowerCase().includes(kw))
      );
    }
    return rows.slice(-Math.max(1, Math.min(limit, 800)));
  }

  /** 各来源的计数，供前端做筛选器 */
  function summary() {
    const byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
    const byScope = {};
    for (const e of buf) {
      byLevel[e.level] = (byLevel[e.level] || 0) + 1;
      byScope[e.scope] = (byScope[e.scope] || 0) + 1;
    }
    return {
      total: buf.length,
      byLevel,
      byScope,
      errors: byLevel.error || 0,
      lastAt: buf.length ? buf[buf.length - 1].t : null,
      file,
    };
  }

  return { log, info, warn, error, query, summary, size: () => buf.length };
}

module.exports = { createLogger, LEVELS, MAX_MEMORY, MAX_FILE_LINES };