#!/usr/bin/env node
'use strict';

/**
 * 小时级出勤追踪采集器
 *
 * 与 collect-http.js 的区别：
 *   collect-http.js  —— 抓「此刻这个分区有哪些房间」（一次性快照）
 *   本脚本           —— 持续维护「主播池」并记录每场直播的起止（历史出勤）
 *
 * 两种模式：
 *   discover  翻页扫全分区，把新主播加入池子（请求多，一天跑一次即可）
 *   track     批量查池中所有主播的状态，记录场次（请求少，每小时跑一次）
 *   auto      discover + track（首次运行或想刷新池子时用）
 *
 * 用法：
 *   node collect-track.js --db ./data/live.sqlite              # auto（默认）
 *   node collect-track.js --mode track                         # 只追踪
 *   node collect-track.js --mode discover                      # 只发现新人
 *   node collect-track.js --mode track --dry-run               # 只看不写
 *
 * 风控友好：每批请求间随机等待，遇 412/429 立即停止不重试。
 */

const path = require('node:path');
const db = require('./lib/db.js');
const bili = require('./lib/bili.js');

const DEFAULTS = {
  dbFile: path.join(__dirname, 'data', 'live.sqlite'),
  mode: 'auto',
  maxPages: 100,
  minDelay: 2000,
  maxDelay: 3500,
  batchDelay: 1500,
  quiet: false,
  dryRun: false,
  importFile: null,
  progress: false,
  tiered: true,
  // radar 专用：扫几页榜、每页几条、什么分区
  radarPages: 2,
  radarPageSize: 50,
  radarAreaId: 878,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') opts.dbFile = path.resolve(next());
    else if (a === '--mode') opts.mode = next();
    else if (a === '--max-pages') opts.maxPages = Number(next());
    else if (a === '--delay') {
      const v = Number(next());
      opts.minDelay = v;
      opts.maxDelay = v;
    } else if (a === '--batch-delay') opts.batchDelay = Number(next());
    else if (a === '--import') opts.importFile = path.resolve(next());
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--progress') opts.progress = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--full') opts.tiered = false;
    else if (a === '--radar-pages') opts.radarPages = Number(next());
    else if (a === '--radar-page-size') opts.radarPageSize = Number(next());
    else if (a === '--radar-area') opts.radarAreaId = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log(`用法: node collect-track.js [选项]

  --db FILE        数据库路径（默认 ./data/live.sqlite）
  --mode MODE      auto | discover | track | radar（默认 auto）
  --max-pages N    discover 时最多翻多少页（默认 100）
  --delay MS       翻页间隔毫秒（默认 2000~3500 随机）
  --batch-delay MS 批量查状态间隔毫秒（默认 1500）
  --import FILE    把已有 latest.json 里的主播导入池子（不发任何请求）
  --dry-run        只统计不写库
  --full           忽略分层，全量查池中所有主播（排障/补数时用）
  --quiet          安静模式
  --radar-pages N      radar 每轮扫几页榜（默认 2）
  --radar-page-size N  radar 每页几条（默认 50，实测上限也是 50）
  --radar-area N       radar 扫哪个分区（默认 878 三角洲行动）

三种采集模式：
  discover  按人气翻页扫全分区，往池子里加新人（请求多，一天一次）
  track     按分层刷池中主播的状态，记录场次起止（每小时一次）
  radar     按**开播时间**扫分区榜前几页，只对**池内**主播补落场次
            （每 5 分钟一次，成本恒定 2 个请求，与池子规模无关）

分层采集（默认开启）：
  热层 7 天内播过 → 每小时    温层 8~30 天  → 每 6 小时
  冷层 31~90 天   → 每天      冰层 90 天以上 → 每天（分摊到 24 个整点）

  冰层为什么不再是每周一次：7 天里只在一个漂移的瞬间扫一次，主播复播
  恰好撞上那一刻是小概率事件，等于基本漏采。现在靠 radar 主动发现复播
  （按开播时间排序，新开播的人必在第 1 页），track 的冰层只做兜底。

定时建议：
  */5 * * * * cd /opt/bili-live && node collect-track.js --mode radar --quiet
  0 * * * *   cd /opt/bili-live && node collect-track.js --mode track --quiet
  30 3 * * *  cd /opt/bili-live && node collect-track.js --mode discover --quiet`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (!['auto', 'discover', 'track', 'radar'].includes(opts.mode)) {
    console.error(`--mode 只能是 auto / discover / track / radar，收到 ${opts.mode}`);
    process.exit(2);
  }
  return opts;
}

const now = () => Math.floor(Date.now() / 1000);
const log = (opts, ...a) => {
  if (!opts.quiet) console.log(...a);
};

/**
 * 输出一行结构化进度，供调度器/前端实时解析。
 *
 * 用独立前缀 `##PROGRESS##` 而不是直接打 JSON：
 * 结束时那行汇总是裸 JSON，两者混在一起会让「取最后一个 { 开头的行」误判。
 * 前缀行只走 stdout，不影响 --quiet 的汇总输出。
 */
function emitProgress(opts, payload) {
  if (!opts.progress) return;
  try {
    process.stdout.write(`##PROGRESS## ${JSON.stringify({ t: now(), ...payload })}\n`);
  } catch {
    /* 输出进度失败不能影响采集本身 */
  }
}

/* ---------------------------------------------------------------- discover */

/**
 * 翻页扫全分区，把新主播加入池子。
 * 返回本次发现的房间数、新增主播数。
 */
async function discover(database, opts) {
  const seen = new Map();
  let page = 1;
  let stopReason = 'max-pages';
  // 补场次阶段也可能被限流，与翻页阶段共用这个标记
  let rateLimited = false;
  const startedAt = now();

  /*
   * 连续这么多页「空」或「无新增」，才认定真正翻到底。
   *
   * 实测 getRoomList 会在翻页中途偶发返空：第 25 页可能是空数组，第 26 页仍有 30 条。
   * 早先 collect-http.js 一遇空页就 break，结果 2092 条只采到 707 条。
   * discover 当时照抄了那个写法，同样有漏采风险（表现为某天新发现人数莫名偏少）。
   *
   * 但限流（-352/-412）与请求失败**仍然立即停**——容忍只用于「接口正常返回空」，
   * 不能拿重试去试探风控边界，那正是要把 IP 搞进小黑屋的做法。
   */
  const EMPTY_TOLERANCE = 3;
  let emptyStreak = 0;
  let dupStreak = 0;

  for (; page <= opts.maxPages; page++) {
    let list;
    try {
      list = await bili.fetchAreaPage({ page });
    } catch (err) {
      if (err.rateLimited) {
        // 走 stderr 而不是 log()：quiet 模式下 log 会被吞掉，
        // 而限流恰恰是最需要留证据的失败原因，必须让调度器捕获到。
        console.error(`[限流] 第 ${page} 页被限流，停止翻页。已拿到 ${seen.size} 个房间。`);
        stopReason = 'rate-limited';
        break;
      }
      console.warn(`[警告] 第 ${page} 页失败：${err.message}`);
      stopReason = 'request-failed';
      break;
    }

    if (!list.length) {
      emptyStreak++;
      log(
        opts,
        `  [discover] 第 ${page} 页空（连续 ${emptyStreak}/${EMPTY_TOLERANCE}），累计 ${seen.size}`
      );
      if (emptyStreak >= EMPTY_TOLERANCE) {
        stopReason = 'empty-page';
        break;
      }
      // 容忍偶发空页往后翻。间隔照旧——不能因为「这页反正是空的」就加速，
      // 请求密度是风控的敏感点，与内容无关。
      await bili.sleep(bili.randomBetween(opts.minDelay, opts.maxDelay));
      continue;
    }
    emptyStreak = 0;

    let added = 0;
    for (const r of list) {
      if (/^\d+$/.test(String(r.uid)) === false) continue;
      const uid = Number(r.uid);
      if (uid <= 0) continue;
      if (!seen.has(uid)) {
        seen.set(uid, r);
        added++;
      }
    }
    log(opts, `  [discover] 第 ${page} 页 ${list.length} 条，新 ${added}，累计 ${seen.size}`);

    emitProgress(opts, {
      kind: 'discover',
      phase: 'page',
      done: page,
      total: opts.maxPages,
      found: seen.size,
    });

    if (added === 0) {
      dupStreak++;
      if (dupStreak >= EMPTY_TOLERANCE) {
        stopReason = 'no-new';
        break;
      }
      // 只是这一页没新面孔，可能下一页又有了（热门前几页反复重叠是常态）。
      // 要求连续多页都无新增才收工，避免第 2 页一次重叠就提前结束。
      log(
        opts,
        `  [discover] 第 ${page} 页无新增（连续 ${dupStreak}/${EMPTY_TOLERANCE}），累计 ${seen.size}`
      );
      await bili.sleep(bili.randomBetween(opts.minDelay, opts.maxDelay));
      continue;
    }
    dupStreak = 0;
    await bili.sleep(bili.randomBetween(opts.minDelay, opts.maxDelay));
  }

  // 落库
  let newStreamers = 0;
  const newUids = [];
  if (!opts.dryRun) {
    database.exec('BEGIN');
    try {
      for (const r of seen.values()) {
        const isNew = db.upsertStreamer(database, {
          uid: r.uid,
          uname: r.uname,
          face: r.face,
          roomid: r.roomid,
          now: startedAt,
          mode: 'discover',
        });
        if (isNew) {
          newStreamers++;
          newUids.push(Number(r.uid));
        }
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  } else {
    for (const r of seen.values()) {
      if (!db.getStreamer(database, r.uid)) newStreamers++;
    }
  }

  /*
   * 补写场次：这一步以前是缺的，直接造成了页面上的「未采集」。
   *
   * 为什么必须在 discover 里补，而不是等下一轮 track：
   *   · 榜上这些人**此刻确实在播**，但我们只 upsert 了人、没落场次。
   *   · 而「未采集」的判定是 sessions 里查不到 last_observed_at，于是他明明
   *     刚被我们发现、正在直播，页面上却显示「未采集」，看着像采集坏了。
   *   · 等 track 来补也不可靠：track 按分层刷，若这一小时他没到点，等轮到
   *     他时人可能已经下播，那场直播就永久丢了。
   *
   * 只补「本次新增的人」而不是榜上全部 2000 人：老主播的场次由 track 维护，
   * 重复补只会让请求量翻倍，而能修好的「未采集」一个也不会多。
   * 实测今天 1874 个新发现全部显示未采集，正是这批人。
   */
  let liveSessions = 0;
  let liveNew = 0;
  let statusRequests = 0;
  if (newUids.length) {
    log(opts, `  [discover] 为 ${newUids.length} 个新主播补查状态，落场次`);
    for (let i = 0; i < newUids.length; i += bili.BATCH_LIMIT) {
      const chunk = newUids.slice(i, i + bili.BATCH_LIMIT);
      const batchNo = Math.floor(i / bili.BATCH_LIMIT) + 1;
      const totalBatch = Math.ceil(newUids.length / bili.BATCH_LIMIT);
      let status;
      try {
        status = await bili.fetchStatusByUids(chunk);
        statusRequests++;
      } catch (err) {
        if (err.rateLimited) {
          // 限流立刻停：这一步是「顺手补全」，不值得为它冒风控风险。
          // 已落库的主播不受影响，只是场次要等 track 补。
          console.error(`[限流] discover 补场次第 ${batchNo} 批被限流，停止补全。`);
          rateLimited = true;
          break;
        }
        console.warn(`[警告] discover 补场次第 ${batchNo} 批失败：${err.message}`);
        continue;
      }
      const applied = applyLiveStatus(database, chunk, status, {
        t: now(),
        dryRun: opts.dryRun,
        // 昵称/头像刚落库过，不必再刷一遍
        refreshProfile: false,
      });
      liveNew += applied.live;
      liveSessions += applied.newSessions;
      log(
        opts,
        `  [discover] 补场次 ${batchNo}/${totalBatch}：在播 ${liveNew}，新落场次 ${liveSessions}`
      );
      if (i + bili.BATCH_LIMIT < newUids.length) {
        await bili.sleep(bili.randomBetween(opts.minDelay, opts.maxDelay));
      }
    }
  }

  return {
    rooms: seen.size,
    newStreamers,
    pages: page,
    stopReason,
    // 补场次只补了新增的人，这里如实分开计数，避免和 discover 的翻页请求混淆
    requests: page + statusRequests,
    pageRequests: page,
    statusRequests,
    liveNew,
    liveSessions,
    rateLimited,
  };
}

/**
 * 把已有 latest.json 里的主播批量导入池子（不发任何请求）。
 * 用于首次建池时不额外翻页，直接复用 collector 已经拿到的数据。
 */
function importFromSnapshot(database, file, opts = {}) {
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const t = now();

  let newStreamers = 0;
  let skipped = 0;

  if (!opts.dryRun) database.exec('BEGIN');
  try {
    for (const r of rooms) {
      const uid = Number(r.uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        skipped++;
        continue;
      }
      if (opts.dryRun) {
        if (!db.getStreamer(database, uid)) newStreamers++;
        continue;
      }
      const isNew = db.upsertStreamer(database, {
        uid,
        uname: r.uname,
        face: r.face,
        roomid: r.roomid,
        now: t,
        // 从快照导入既不是 discover 也不是 track，单独标记，避免把
        // 导入的存量主播算成「今天发现的新人」
        mode: 'import',
      });
      if (isNew) newStreamers++;
    }
    if (!opts.dryRun) database.exec('COMMIT');
  } catch (err) {
    if (!opts.dryRun) database.exec('ROLLBACK');
    throw err;
  }

  return { rooms: rooms.length, newStreamers, skipped, requests: 0 };
}

/* ---------------------------------------------------------------- track */

/**
 * 批量查池中所有主播状态，记录场次。
 *
 * 核心逻辑：
 *   - live_status=1 → 按 live_time 归并场次（同一场不重复建行）
 *   - live_status≠1 → 关闭该主播所有未结束场次
 *   - live_time=0 但 live_status=1 异常情况 → 跳过，避免建出脏场次
 */
async function track(database, opts) {
  // 分层：只查「到期」的层。池子只增不减，全量查会让请求量随规模线性膨胀。
  let plan;
  if (opts.tiered === false) {
    const all = database.prepare('SELECT uid FROM streamers').all().map((r) => Number(r.uid));
    plan = { uids: all, tiers: null, chosenTiers: null, total: all.length };
    log(opts, `  [track] --full：忽略分层，全量查询 ${all.length} 个主播`);
  } else {
    plan = db.planTrackPool(database, now(), db.readTierLastRuns(database));
  }

  const pool = plan.uids;
  if (!pool.length) {
    log(opts, '  [track] 本轮没有到期的层，跳过（各层都还在各自周期内）');
    // 空转：什么都没查，也没发请求。
    // 这里必须显式标记 idle，否则主流程会把它记成 status='ok'，
    // 而趋势图只取 status='ok' 的点——空转那次的 pool/live 全是 0，
    // 画出来就是"主播和观众突然归零"，看着像采集中断（实测已发生）。
    // pool 用 plan.total 而不是 0：池子规模没变，记 0 同样会污染趋势。
    return {
      pool: plan.total,
      poolTotal: plan.total,
      tiers: plan.tiers,
      live: 0,
      newSessions: 0,
      newStreamers: 0,
      closed: 0,
      requests: 0,
      skipped: 0,
      rateLimited: false,
      idle: true,
    };
  }

  const tierNote = plan.chosenTiers
    ? `（${plan.chosenTiers.map((id) => `${plan.tiers[id].label} ${plan.tiers[id].total}`).join(' / ')}）`
    : '';
  log(
    opts,
    `  [track] 池中 ${plan.total} 个主播，本轮查 ${pool.length} 个${tierNote}，` +
      `分 ${Math.ceil(pool.length / bili.BATCH_LIMIT)} 批`
  );

  const totalBatches = Math.ceil(pool.length / bili.BATCH_LIMIT);
  emitProgress(opts, {
    kind: 'track',
    phase: 'start',
    done: 0,
    total: totalBatches,
    pool: pool.length,
    live: 0,
    newSessions: 0,
  });

  let live = 0;
  let newSessions = 0;
  let closed = 0;
  let skipped = 0;
  let requests = 0;
  // track 刷池时也可能撞见从没见过的人（discover 漏掉的），要如实计数。
  // 之前这里没有这个变量，upsertStreamer 的返回值被直接丢弃，
  // 导致前端永远显示「新增 0 人」——那不是没发现新人，是根本没统计。
  let newStreamers = 0;
  let rateLimited = false;

  for (let i = 0; i < pool.length; i += bili.BATCH_LIMIT) {
    const chunk = pool.slice(i, i + bili.BATCH_LIMIT);
    const batchNo = Math.floor(i / bili.BATCH_LIMIT) + 1;

    let status;
    try {
      status = await bili.fetchStatusByUids(chunk);
      requests++;
    } catch (err) {
      if (err.rateLimited) {
        // 同 discover：quiet 模式下 log() 会静默，必须走 stderr 留下证据
        console.error(`[限流] 第 ${batchNo} 批被限流，停止。已完成 ${batchNo - 1}/${totalBatches} 批。`);
        rateLimited = true;
        break;
      }
      console.warn(`[警告] 第 ${batchNo} 批失败：${err.message}`);
      continue;
    }

    const t = now();

    if (!opts.dryRun) database.exec('BEGIN');
    try {
      for (const uid of chunk) {
        const st = status.get(Number(uid));

        // 接口没返回这个 UID：不臆测状态，跳过（不能当成下播，否则会误关场次）
        if (!st) {
          skipped++;
          continue;
        }

        if (st.live_status === 1 && st.live_time > 0) {
          live++;
          if (!opts.dryRun) {
            // 注意：这里查的 uid 全部来自 streamers 表（见 planTrackPool
            // 和上面的 --full 分支），所以 upsertStreamer 对本轮每个 uid
            // 都必然返回 false，isNew 恒为假。保留这段计数是为了语义完整，
            // 但「track 不产生新增」是结构性的，不是漏统计——真正发现新人
            // 的是 discover，它扫专区榜、会遇到池外的 uid。
            const isNew = db.upsertStreamer(database, {
              uid,
              uname: st.uname,
              face: st.face,
              roomid: st.roomid,
              now: t,
              mode: 'track',
            });
            if (isNew) newStreamers++;
            const r = db.recordLive(database, {
              uid,
              liveTime: st.live_time,
              title: st.title,
              // 封面随场次落库：接口本来就返回，不额外发请求
              cover: st.cover,
              areaId: st.area_id,
              areaName: st.area_name,
              online: st.online,
              now: t,
            });
            if (r.created) newSessions++;
            closed += r.closed;
          }
        } else {
          // 确认不在播 → 收尾所有未结束场次
          if (!opts.dryRun) {
            closed += db.closeOpenSessions(database, uid);
          }
        }
      }
      if (!opts.dryRun) database.exec('COMMIT');
    } catch (err) {
      if (!opts.dryRun) database.exec('ROLLBACK');
      throw err;
    }

    log(opts, `  [track] 批 ${batchNo}/${totalBatches}：在播 ${live}，新场次 ${newSessions}，收尾 ${closed}`);

    emitProgress(opts, {
      kind: 'track',
      phase: 'batch',
      done: batchNo,
      total: totalBatches,
      pool: pool.length,
      live,
      newSessions,
      closed,
    });

    if (i + bili.BATCH_LIMIT < pool.length) {
      await bili.sleep(opts.batchDelay);
    }
  }

  // 只有真正跑完（没被限流打断）才记这一层「已执行」，
  // 否则被限流的那次会让整层以为查过了，白白等一个周期。
  if (!rateLimited && !opts.dryRun && plan.chosenTiers) {
    db.saveTierLastRuns(database, plan.chosenTiers, now());
  }

  emitProgress(opts, {
    kind: 'track',
    phase: rateLimited ? 'rate-limited' : 'done',
    done: rateLimited ? requests : totalBatches,
    total: totalBatches,
    pool: plan.total,
    checked: pool.length,
    live,
    newSessions,
    newStreamers,
    closed,
    rateLimited,
  });

  return {
    pool: plan.total,
    checked: pool.length,
    tiers: plan.tiers,
    live,
    newSessions,
    newStreamers,
    closed,
    requests,
    skipped,
    rateLimited,
  };
}

/* ---------------------------------------------------------------- radar */

/**
 * 把一批「刚查过状态」的 UID 落成场次。
 *
 * radar 和 discover 都要做同一件事：拿到 statusMap 后，把其中**确认在播**的
 * 人写成一场直播。抽成函数是为了让两边口径永远一致 —— 之前 discover 就是
 * 漏了这一步，只登记了人没登记场次，导致页面上成片显示「未采集」。
 *
 * 三条不可动摇的约定：
 *   1. 没返回这个 UID → 跳过。不臆测状态，更不能当成下播。
 *   2. live_status ≠ 1 → 跳过。**绝不在这里收尾场次**，收尾只归 track 管。
 *      否则 radar 每小时扫 12 次，任何一次榜单没覆盖到他就会误关正在播的场次。
 *   3. live_time = 0 但有 live_status = 1（接口偶发的脏数据）→ 跳过，
 *      否则会建出 live_time=0 的幽灵场次。
 *
 * @param {boolean} refreshProfile 顺手刷新昵称/头像/房间号。
 *   radar 要开（复播的人常改过名），discover 刚 upsert 过所以不用重复。
 */
function applyLiveStatus(database, uids, statusMap, { t, dryRun, refreshProfile = false }) {
  const out = { live: 0, newSessions: 0, closed: 0, skipped: 0, hitUids: [] };

  if (!dryRun) database.exec('BEGIN');
  try {
    for (const uid of uids) {
      const st = statusMap.get(Number(uid));
      if (!st) {
        out.skipped++;
        continue;
      }
      if (st.live_status !== 1 || !(st.live_time > 0)) {
        out.skipped++;
        continue;
      }

      out.live++;
      out.hitUids.push(uid);
      if (dryRun) continue;

      if (refreshProfile) {
        db.upsertStreamer(database, {
          uid,
          uname: st.uname,
          face: st.face,
          roomid: st.roomid,
          now: t,
          // mode 传 null：不改 first_mode。它记录的是「这个人是怎么进来的」，
          // 被 radar 刷新一次昵称不该改变这个事实。
          mode: null,
        });
      }

      const r = db.recordLive(database, {
        uid,
        liveTime: st.live_time,
        title: st.title,
        // 封面随场次落库：接口本来就返回，不额外发请求
        cover: st.cover,
        areaId: st.area_id,
        areaName: st.area_name,
        online: st.online,
        now: t,
      });
      if (r.created) out.newSessions++;
      out.closed += r.closed;
    }
    if (!dryRun) database.exec('COMMIT');
  } catch (err) {
    if (!dryRun) database.exec('ROLLBACK');
    throw err;
  }

  return out;
}

/**
 * 开播雷达：按**开播时间**扫分区榜前几页，只对**池内**主播补落场次。
 *
 * 为什么需要它（这是整个分层方案能不能成立的关键）：
 *
 * 分层的核心假设原本是「休眠主播复播时，discover 会重新发现他」。实测下来
 * 这个闭环对冰层基本不成立，两条原因：
 *   1. discover 按 sort_type=online（人气）排序，冰层主播人气低，排在最末尾；
 *   2. 更致命的是 discover 的有效页数极不稳定——实测晚高峰能翻到 80 页以上，
 *      凌晨十几页就空。低人气主播能不能被扫到，取决于当时榜单有多长。
 *
 * 而 getRoomList 支持 sort_type=live_time，实测**严格**按开播时间倒序
 * （45 对相邻项、0 违反）。也就是说：任何人只要刚开播，他就必然出现在第 1 页。
 * 这是一个「时间维度」的入口，和 discover 的「人气维度」入口互补。
 *
 * 两个必须知道的实测事实：
 *   · 榜单记录里**没有 live_time 字段**，只有 online / 房间信息。所以想拿到
 *     场次需要的 live_time，必须再调一次 get_status_info_by_uids。
 *   · page_size 上限是 50：传 100 只会返回 20 条（参数被截断）。所以固定 50。
 *
 * 成本模型：每轮 = radarPages 次榜单请求 + ceil(命中人数/150) 次状态请求。
 * 第 1 页覆盖最近约 1~3 分钟的开播，第 2 页到 5 分钟左右。默认 2 页，
 * 每 5 分钟一轮 → 每天约 288×2=576 次榜单请求，加上少量状态请求。
 * 对比热层 track 每小时 33 批的突发，radar 是更平缓的涓流。
 *
 * 只处理「确认在播」的人，**绝不因为没看到就关闭场次**：radar 只看得到榜上
 * 前几页的人，没看到某人不代表他下播了。收尾一律交给 track，否则会误关。
 */
async function radar(database, opts) {
  const pages = Math.max(1, Math.min(Number(opts.radarPages) || 2, 20));
  const pageSize = Math.max(1, Math.min(Number(opts.radarPageSize) || 50, 50));
  const areaId = Number(opts.radarAreaId) || 878;

  // 榜上所有房间，按 uid 去重（相邻两页会有重叠，实测常见）
  const rooms = new Map();
  let requests = 0;
  let stopReason = 'max-pages';
  let rateLimited = false;

  for (let page = 1; page <= pages; page++) {
    let list;
    try {
      list = await bili.fetchAreaPage({ areaId, page, pageSize, sortType: 'live_time' });
      requests++;
    } catch (err) {
      if (err.rateLimited) {
        // 与 discover/track 一致：限流立刻停，不重试试探边界
        console.error(`[限流] radar 第 ${page} 页被限流，停止。已拿到 ${rooms.size} 个房间。`);
        rateLimited = true;
        stopReason = 'rate-limited';
        break;
      }
      console.warn(`[警告] radar 第 ${page} 页失败：${err.message}`);
      stopReason = 'request-failed';
      break;
    }

    if (!list.length) {
      stopReason = 'empty-page';
      break;
    }
    for (const r of list) {
      if (r.uid > 0 && !rooms.has(r.uid)) rooms.set(r.uid, r);
    }

    emitProgress(opts, {
      kind: 'radar',
      phase: 'page',
      done: page,
      total: pages,
      found: rooms.size,
    });

    if (page < pages) await bili.sleep(bili.randomBetween(opts.minDelay, opts.maxDelay));
  }

  const scanned = [...rooms.keys()];

  // 求交：只关心池内的人。池外新人交给 discover，radar 不越界——
  // 否则每轮都会往池子里塞几十个“路过的人”，池子会被噪声灌满。
  const known = db.filterKnownUids(database, scanned);
  const targets = scanned.filter((uid) => known.has(uid));

  if (!targets.length) {
    return {
      scanned: scanned.length,
      known: 0,
      live: 0,
      newSessions: 0,
      closed: 0,
      requests,
      skipped: 0,
      rateLimited,
      stopReason,
    };
  }

  // 补状态：榜单没有 live_time，必须再查一次才能落场次
  let status;
  try {
    status = await bili.fetchStatusByUids(targets);
    requests++;
  } catch (err) {
    if (err.rateLimited) {
      console.error('[限流] radar 状态查询被限流，本轮放弃。');
      rateLimited = true;
    } else {
      console.warn(`[警告] radar 状态查询失败：${err.message}`);
    }
    return {
      scanned: scanned.length,
      known: targets.length,
      live: 0,
      newSessions: 0,
      closed: 0,
      requests,
      skipped: targets.length,
      rateLimited,
      stopReason: 'request-failed',
    };
  }

  const t = now();
  const applied = applyLiveStatus(database, targets, status, {
    t,
    dryRun: opts.dryRun,
    // 复播的人很可能改过名或换过封面，顺手刷新
    refreshProfile: true,
  });
  const { live, newSessions, closed, skipped } = applied;

  log(
    opts,
    `  [radar] 扫 ${pages} 页 ${scanned.length} 个房间，池内 ${targets.length}，` +
      `在播 ${live}，新场次 ${newSessions}`
  );

  emitProgress(opts, {
    kind: 'radar',
    phase: 'done',
    done: pages,
    total: pages,
    scanned: scanned.length,
    known: targets.length,
    live,
    newSessions,
  });

  return {
    scanned: scanned.length,
    known: targets.length,
    live,
    newSessions,
    closed,
    requests,
    skipped,
    rateLimited,
    stopReason,
    // 复播名单落日志：这是「冰层主播回来了」的直接证据，排查漏采时最有用
    hitUids: applied.hitUids.slice(0, 50),
  };
}

/* ---------------------------------------------------------------- 主流程 */

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const database = db.openDb(opts.dbFile);
  const startedAt = now();

  if (opts.dryRun) log(opts, '【dry-run】只统计，不写数据库\n');

  const runId = opts.dryRun
    ? null
    : Number(
        database
          .prepare(
            'INSERT INTO collect_runs (started_at, mode, status) VALUES (?, ?, ?)'
          )
          .run(startedAt, opts.mode, 'running').lastInsertRowid
      );

  let result = { pool: 0, live: 0, newStreamers: 0, newSessions: 0, closed: 0, requests: 0, skipped: 0 };
  let status = 'ok';

  try {
    if (opts.importFile) {
      log(opts, `▶ import：从 ${opts.importFile} 导入主播（不发请求）`);
      const im = importFromSnapshot(database, opts.importFile, opts);
      log(
        opts,
        `  完成：${im.rooms} 条房间，新增 ${im.newStreamers} 个主播` +
          (im.skipped ? `，跳过 ${im.skipped} 条无效` : '') +
          '\n'
      );
      result.newStreamers += im.newStreamers;
    }

    if (opts.mode === 'radar') {
      log(opts, '▶ radar：按开播时间扫榜，为池内复播者补落场次');
      const r = await radar(database, opts);
      log(
        opts,
        `  完成：扫 ${r.scanned} 个房间，池内 ${r.known}，在播 ${r.live}，` +
          `新场次 ${r.newSessions}，${r.requests} 次请求，停止原因 ${r.stopReason || '—'}\n`
      );
      result.pool = r.known;
      result.live = r.live;
      result.newSessions = r.newSessions;
      result.closed = r.closed;
      result.skipped = r.skipped;
      result.requests += r.requests;
      if (r.rateLimited) status = 'rate-limited';
      // 扫了一轮但榜上前几页没有池内的人：这是完全正常的（池子只有几千人，
      // 而全站每分钟开播几百个）。标记 idle，别让它污染趋势图。
      else if (r.known === 0) status = 'idle';
    }

    if (opts.mode === 'auto' || opts.mode === 'discover') {
      log(opts, '▶ discover：扫描分区，更新主播池');
      const d = await discover(database, opts);
      log(
        opts,
        `  完成：${d.rooms} 个房间，新增 ${d.newStreamers} 个主播，` +
          `${d.pageRequests || d.pages} 页，停止原因 ${d.stopReason}` +
          (d.statusRequests
            ? `；补场次 ${d.statusRequests} 批，在播 ${d.liveNew}，落场次 ${d.liveSessions}`
            : '') +
          '\n'
      );
      result.newStreamers = d.newStreamers;
      result.newSessions += d.liveSessions || 0;
      result.requests += d.requests;
      if (d.rateLimited || d.stopReason === 'rate-limited') status = 'rate-limited';
    }

    if (opts.mode === 'auto' || opts.mode === 'track') {
      log(opts, '▶ track：刷新全部主播状态');
      const t = await track(database, opts);
      log(
        opts,
        `  完成：池中 ${t.pool}，在播 ${t.live}，新场次 ${t.newSessions}，` +
          `新增 ${t.newStreamers || 0} 人，收尾 ${t.closed}\n`
      );
      Object.assign(result, {
        pool: t.pool,
        live: t.live,
        newSessions: t.newSessions,
        closed: t.closed,
        skipped: t.skipped,
      });
      // 用 += 而不是写进 Object.assign：auto 模式下 discover 已经算过新增，
      // 若在这里直接赋值会把 discover 的成果覆盖成 track 的 0（实测会从
      // 347 掉到 0）。叠加才是对的：auto = discover 发现 + track 发现。
      result.newStreamers += t.newStreamers || 0;
      result.requests += t.requests;
      if (t.rateLimited) status = 'rate-limited';
      // 空转（没有到期的层）不算一次有效采集：标记 idle，
      // 让趋势图（只取 status='ok'）跳过这个点。auto 模式下若 discover
      // 真的跑过，则保持 ok——那次确实干了活。
      else if (t.idle && opts.mode === 'track') status = 'idle';
    }
  } catch (err) {
    status = 'error';
    console.error(`\n[失败] ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (runId !== null) {
      database
        .prepare(
          `UPDATE collect_runs
              SET finished_at = ?, pool_size = ?, live_count = ?,
                  new_streamers = ?, new_sessions = ?, requests = ?, status = ?
            WHERE id = ?`
        )
        .run(
          now(),
          result.pool,
          result.live,
          result.newStreamers,
          result.newSessions,
          result.requests,
          status,
          runId
        );
    }

    if (!opts.dryRun) {
      const s = db.stats(database);
      log(opts, '──── 当前库状态 ────');
      log(opts, `  主播总数    ${s.streamers}`);
      log(opts, `  累计场次    ${s.sessions}`);
      log(opts, `  进行中      ${s.open_sessions}`);
      log(opts, `  累计时长    ${s.total_hours} 小时`);
      log(opts, `  数据库      ${opts.dbFile}`);
    }
    database.close();
  }

  if (opts.quiet && !process.exitCode) {
    // 安静模式下用一行 JSON 汇总，方便 cron 日志留痕
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        mode: opts.mode,
        status,
        ...result,
      })
    );
  }
})();