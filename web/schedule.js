'use strict';

/* 采集设置页：读/改调度频率，查看下次执行时间 */

const $ = (sel) => document.querySelector(sel);

const state = {
  status: null,
  dirty: false,
  busy: false,
};

/* ---------------------------------------------------------------- 工具 */

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { error: `HTTP ${res.status}` };
  }
  return { ok: res.ok, status: res.status, data };
}

const pad = (n) => String(n).padStart(2, '0');

/** 东八区格式化：2026-11-15 21:03 */
function fmtTime(epochSec) {
  if (!epochSec) return '—';
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** 相对时间：还有 3 小时 24 分 */
function fmtUntil(target, now) {
  if (!target) return '—';
  let diff = target - (now || Math.floor(Date.now() / 1000));
  if (diff <= 0) return '已到时间（等待下次检查）';
  const d = Math.floor(diff / 86400);
  diff -= d * 86400;
  const h = Math.floor(diff / 3600);
  diff -= h * 3600;
  const m = Math.floor(diff / 60);
  const parts = [];
  if (d > 0) parts.push(`${d} 天`);
  if (h > 0) parts.push(`${h} 小时`);
  if (d === 0 && m > 0) parts.push(`${m} 分`);
  return parts.length ? `还有 ${parts.join(' ')}` : '即将执行';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function setHint(text, kind) {
  const el = $('#save-hint');
  el.textContent = text || '';
  el.className = 'save-hint' + (kind ? ` ${kind}` : '');
}

/* ---------------------------------------------------------------- 渲染 */

function showUnavailable(msg) {
  const box = $('#unavailable');
  box.style.display = 'block';
  box.className = 'notice err';
  box.innerHTML = msg;
}

function renderStatus(st) {
  const cards = [];

  const card = (k, v, small) =>
    `<div class="stat"><div class="k">${escapeHtml(k)}</div>` +
    `<div class="v">${escapeHtml(v)}${small ? `<small>${escapeHtml(small)}</small>` : ''}</div></div>`;

  // 开关状态
  cards.push(card('自动采集', st.enabled ? '已开启' : '已关闭'));

  // 未启用时，nextAt 过了也没人推进，直接显示"未启用"避免误解成"卡住了"
  const untilText = (t) => {
    if (!st.enabled) return '未启用';
    return fmtUntil(t.nextAt, st.now);
  };

  const t = st.track || {};
  const d = st.discover || {};
  cards.push(card('下次 track', untilText(t)));
  cards.push(card('下次 discover', untilText(d)));

  // 上次真实执行
  const lr = t.lastRun;
  const dr = d.lastRun;
  cards.push(card('上次 track', lr ? fmtTime(lr.finished_at || lr.started_at).slice(5) : '无记录'));
  cards.push(card('上次 discover', dr ? fmtTime(dr.finished_at || dr.started_at).slice(5) : '无记录'));

  $('#status-stats').innerHTML = cards.join('');

  // 明细行
  const rows = [];

  const addRow = (k, v) => rows.push(`<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`);

  addRow('track 间隔', `每 ${t.intervalHours ?? '—'} 小时`);
  addRow('track 上次执行', `${fmtTime(t.lastAt)}　<span style="color:var(--text-faint)">${fmtUntil(t.nextAt, st.now)}</span>`);
  addRow('discover 间隔', `每 ${d.intervalHours ?? '—'} 小时`);
  addRow('discover 上次执行', `${fmtTime(d.lastAt)}　<span style="color:var(--text-faint)">${fmtUntil(d.nextAt, st.now)}</span>`);

  // running 是 status() 顶层的对象（st.running.track / st.running.discover），
  // 不是挂在 track/discover 子对象上的。之前读 t.running 恒为 undefined，
  // 所以「正在执行」这一行永远不会出现。
  const running = st.running || {};
  if (running.track || running.discover) {
    const which = [running.track && 'track', running.discover && 'discover'].filter(Boolean).join(' + ');
    addRow('正在执行', `<span style="color:var(--blue)">${escapeHtml(which)} 运行中…</span>`);
  }

  if (lr) {
    const dur = (lr.finished_at || 0) - (lr.started_at || 0);
    // idle = 本轮没有到期的层，什么都没查、零请求。
    // 这时 pool/live/requests 都是「没有值」而不是「真的 0」，
    // 照常渲染成「在播 0」会让人以为采集中断或主播全下播了。
    if (lr.status === 'idle') {
      addRow(
        '上次 track 结果',
        '<span style="color:var(--text-dim)">未查询</span>' +
          '　本轮没有到期的层（各层都还在自己的周期内），没有发出任何请求'
      );
    } else {
      addRow(
        '上次 track 结果',
        `<span style="color:${lr.status === 'ok' ? 'var(--green)' : '#ef6b6b'}">${escapeHtml(lr.status || '—')}</span>` +
          `　池 ${lr.pool_size ?? '—'} 人 · 在播 ${lr.live_count ?? '—'} · ` +
          `${lr.requests ?? '—'} 请求 · 耗时 ${dur > 0 ? `${dur} 秒` : '—'}`
      );
    }
  }

  // discover 的结果原本完全没展示，用户点了「立即 discover 一次」后
  // 刷新页面只看到一片空白，无法判断到底跑了没有、跑了什么。
  if (dr) {
    const dur = (dr.finished_at || 0) - (dr.started_at || 0);
    addRow(
      '上次 discover 结果',
      `<span style="color:${dr.status === 'ok' ? 'var(--green)' : '#ef6b6b'}">${escapeHtml(dr.status || '—')}</span>` +
        `　新增 ${dr.new_streamers ?? '—'} 人 · ` +
        `${dr.requests ?? '—'} 请求 · 耗时 ${dur > 0 ? `${dur} 秒` : '—'}`
    );
  }

  if (st.lastResult && st.lastResult.track && !st.lastResult.track.ok) {
    addRow('上次 track 失败原因', `<span style="color:#ef6b6b">${escapeHtml(st.lastResult.track.error || '')}</span>`);
  }
  if (st.lastResult && st.lastResult.discover && !st.lastResult.discover.ok) {
    addRow('上次 discover 失败原因', `<span style="color:#ef6b6b">${escapeHtml(st.lastResult.discover.error || '')}</span>`);
  }

  $('#status-detail').innerHTML = rows.join('');

  // 顶部副标题
  $('#sched-sub').textContent = st.enabled
    ? `自动采集已开启 · track 每 ${t.intervalHours} 小时 / discover 每 ${d.intervalHours} 小时`
    : '自动采集未开启（不会自动访问 B 站）';
}

/** 填充表单（不覆盖用户正在改的值） */
function fillForm(cfg, force) {
  if (state.dirty && !force) return;
  $('#enabled').checked = !!cfg.enabled;
  $('#track-hours').value = cfg.trackHours;
  $('#discover-hours').value = cfg.discoverHours;
  $('#discover-max-pages').value = cfg.discoverMaxPages;
  $('#track-batch-delay').value = cfg.trackBatchDelay;
  $('#discover-delay').value = cfg.discoverDelay;
  updateSwitchText();
  updatePresetHighlight();
  updateTips(cfg);
  state.dirty = false;
}

function updateSwitchText() {
  const on = $('#enabled').checked;
  $('#enabled-text').textContent = on ? '开启' : '关闭';
  $('#enabled-text').style.color = on ? 'var(--accent)' : 'var(--text-dim)';
  $('#enabled-hint').textContent = on
    ? '到点会自动跑采集（会访问 B 站，请确认没在 crontab 里重复跑）'
    : '关闭时不会自动发起任何请求，但仍可用下方按钮手动跑一次';
}

function updatePresetHighlight() {
  const v = Number($('#discover-hours').value);
  for (const b of document.querySelectorAll('.chip')) {
    b.classList.toggle('on', Number(b.dataset.discover) === v);
  }
}

function updateTips(cfg) {
  const dc = Number($('#discover-hours').value);
  const tip = $('#discover-tip');
  // 关键：间隔与 24 互质才能覆盖全部 24 个钟点，否则永远漏掉某些时段
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(dc), 24);
  const points = 24 / g;

  if (g === 1) {
    const word = dc > 24 ? '推后' : dc < 24 ? '提前' : '滚动';
    tip.innerHTML =
      `<span style="color:var(--green)">✓ 与 24 互质，每次${word} ${Math.abs(24 - dc)} 小时，` +
      `${points} 个钟点全覆盖。</span> 转完一圈需 ${Math.round((24 / g) * dc / 24)} 天。`;
  } else {
    const miss = 24 - points;
    tip.innerHTML =
      `<span style="color:#ef6b6b">✗ 24 ÷ ${g} = ${points}，只覆盖 ${points} 个钟点，` +
      `有 ${miss} 个钟点永远扫不到。</span> 每隔 ${24 / g} 小时的同一钟点会重复落点。`;
  }

  if (dc === 24) {
    tip.innerHTML =
      '<span style="color:#ef6b6b">✗ 固定 24 小时 = 每天同一钟点扫。</span> 其他时段开播的新主播<strong>永远发现不了</strong>，必须改。';
  }

  const th = Number($('#track-hours').value);
  $('#track-tip').textContent =
    th <= 1
      ? '1 小时是推荐值：只查池内已知主播，成本低。'
      : th > 6
        ? '间隔较大时，短于该时长的直播可能漏记。'
        : '只查池内已知主播，间隔影响直播时长的记录精度。';
}

/** 画一个小的漂移示意，让用户直观看到 24 与 23 的差别 */
function renderDriftDemo() {
  const TZ = 8 * 3600;
  const base = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const fmt = (sec) => {
    const d = new Date((sec + TZ) * 1000);
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
  };

  const build = (hours) => {
    let at = base;
    const list = [];
    for (let i = 0; i < 6; i++) {
      list.push(fmt(at));
      at += hours * 3600;
    }
    const hs = new Set(list.map((s) => s.slice(-5, -3)));
    return { list, cover: hs.size };
  };

  const a = build(24);
  const b = build(23);
  const c = build(25);

  const col = (title, data, good) => `
    <div class="drift-col ${good ? 'good' : 'bad'}">
      <div class="t">${title}</div>
      <ol>${data.list.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>
      <div class="cov">6 次只覆盖 ${data.cover} 个钟点${good ? '' : ' ← 漏掉其余时段'}</div>
    </div>`;

  $('#drift-demo').innerHTML =
    col('每隔 <em>24</em> 小时', a, false) +
    col('每隔 <em>23</em> 小时', b, true) +
    col('每隔 <em>25</em> 小时', c, true);
}

/* ---------------------------------------------------------------- 进度 */

/** 正在跟踪的任务与轮询定时器 */
let pollTimer = null;
let pollKind = null;

/** 进度阶段的中文说明 */
const PHASE_TEXT = {
  starting: '正在启动采集进程…',
  start: '已启动，准备批次查询',
  batch: '正在批量查询主播状态',
  page: '正在翻页扫描分区',
  done: '执行完成',
  'rate-limited': '被风控限流，已停止',
  error: '执行失败',
};

/**
 * 渲染进度条。
 * p 为 null 时隐藏；执行结束后保留最后一帧并转成终态（phase=done/error），
 * 让用户知道「跑完了、结果是什么」，而不是一结束就凭空消失。
 */
function renderProgress(p) {
  const box = $('#progress-box');
  if (!p) {
    box.hidden = true;
    return;
  }

  box.hidden = false;

  const total = Number(p.total) || 0;
  const done = Number(p.done) || 0;
  const isDiscover = p.kind === 'discover';
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const title = PHASE_TEXT[p.phase] || p.phase || '执行中';
  $('#progress-title').textContent = `${isDiscover ? 'discover' : 'track'} · ${title}`;
  // discover 的 total 只是「最多翻页数」（100），实际常在十几页就正常收尾。
  // 显示成「14 / 100 批（14%）」会让人误以为没跑完，所以改报绝对页数。
  $('#progress-pct').textContent = isDiscover
    ? done > 0
      ? `已翻 ${done} 页`
      : ''
    : total > 0
      ? `${done} / ${total} 批（${pct}%）`
      : '';

  const fill = $('#progress-fill');
  fill.className = 'progress-fill';
  const finished = p.phase === 'done' || p.phase === 'error' || p.phase === 'rate-limited';
  if (finished) {
    // 终态一律填满：表示「这一轮已经结束」，而不是卡在某个百分比上
    fill.style.width = '100%';
  } else if (isDiscover) {
    // discover 没有可靠的进度分母（翻到空页/无新页就停），
    // 用流动条纹表示「进行中」，而不是一个假的百分比
    fill.style.width = '100%';
    fill.classList.add('indeterminate');
  } else {
    fill.style.width = `${pct}%`;
  }
  if (p.phase === 'done') fill.classList.add('done');
  else if (p.phase === 'error' || p.phase === 'rate-limited') fill.classList.add('error');

  // 明细：discover 只报翻页与新增，track 才报池/在播/场次。
  // discover 的 summary 里 pool/live/newSessions 恒为 0（那是 track 的字段），
  // 一并显示会让人误以为「池子空了」。
  const meta = [];
  if (isDiscover) {
    // 翻页数已经在右上角显示，这里只补充「发现了多少房间」
    if (p.found != null) meta.push(['已发现', `${p.found} 个房间`]);
    if (p.newStreamers != null) meta.push(['新增', `${p.newStreamers} 人`]);
  } else {
    if (p.pool != null) meta.push(['池', `${p.pool} 人`]);
    if (p.live != null) meta.push(['在播', `${p.live} 人`]);
    if (p.newSessions != null) meta.push(['新场次', p.newSessions]);
    if (p.newStreamers != null) meta.push(['新增', `${p.newStreamers} 人`]);
  }

  $('#progress-meta').innerHTML = meta
    .map(([k, v]) => `<span><span class="k">${escapeHtml(k)}</span> <span class="v">${escapeHtml(v)}</span></span>`)
    .join('');
}

/** 停掉轮询 */
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  pollKind = null;
}

/**
 * 轮询进度：只用轻量接口，1 秒一次。
 *
 * 结束判定：running=false 且进度阶段是终态。
 * 注意第一次轮询时子进程可能还没输出任何进度行，此时 progress 为 null 但 running 为 true，
 * 必须继续等，不能当成「已结束」。
 */
async function pollProgress(kind) {
  if (pollKind !== kind) return;
  let delay = 1000;

  try {
    const d = await getJson(`/api/schedule/progress?kind=${encodeURIComponent(kind)}`);

    if (!d.available) {
      stopPolling();
      renderProgress(null);
      setHint(d.error || '调度器不可用', 'err');
      return;
    }

    renderProgress(d.progress);

    if (!d.running) {
      // 已结束：把最后一帧转成终态留在页面上。
      // 原本这里直接 stopPolling()，进度条停在 phase='page' 或干脆消失，
      // 用户只能看到一条一闪而过的提示，刷新后更是什么都没有。
      stopPolling();
      const lr = d.lastResult;
      if (d.progress) {
        const ok = !lr || lr.ok !== false;
        const rateLimited = lr && lr.summary && lr.summary.status === 'rate-limited';
        renderProgress({
          ...d.progress,
          phase: ok ? 'done' : rateLimited ? 'rate-limited' : 'error',
          // discover 的 summary 在 lastResult 里，补进来才能在结果态显示「新增 N 人」
          ...(lr && lr.summary ? { newStreamers: lr.summary.newStreamers } : {}),
        });
      }
      if (lr) {
        if (lr.ok) {
          const s = lr.summary || {};
          setHint(
            kind === 'discover'
              ? `discover 完成 · 新增 ${s.newStreamers ?? '—'} 人 · ${s.requests ?? '—'} 次请求`
              : `${kind} 完成 · 池 ${s.pool ?? '—'} 人 · 在播 ${s.live ?? '—'} 人 · 新场次 ${s.newSessions ?? '—'}`,
            'ok'
          );
        } else {
          setHint(`${kind} 失败：${lr.error || '未知错误'}`, 'err');
        }
      }
      // 结束后刷新一次完整状态，让「运行状态」面板同步
      refresh();
      return;
    }
  } catch (err) {
    // 网络抖动不算失败，放慢重试，避免刷屏
    delay = 3000;
  }

  if (pollKind === kind) {
    pollTimer = setTimeout(() => pollProgress(kind), delay);
  }
}

/** 开始跟踪某个任务的进度 */
function startPolling(kind) {
  stopPolling();
  pollKind = kind;
  renderProgress({ kind, phase: 'starting', done: 0, total: 0 });
  pollTimer = setTimeout(() => pollProgress(kind), 600);
}

/**
 * 页面打开时把进度区接到服务端的真实状态。
 *
 * 两种情况都要管：
 *   1. 任务正在跑 —— 接上轮询，实时显示；
 *   2. 刚跑完就刷新了页面 —— 原实现只在 running 时做事，跑完就什么都不显示，
 *      进度条凭空消失，用户根本不知道「点了到底跑了没有、结果是什么」。
 *      现在用 lastResult 渲染一帧终态，把结果留在页面上。
 *
 * lastResult 只在内存里，服务重启后会丢；那种情况请看「运行状态」面板里
 * 来自 collect_runs 的记录（不受重启影响）。
 */
async function resumeProgress() {
  const finishedRuns = [];
  for (const kind of ['track', 'discover']) {
    try {
      const d = await getJson(`/api/schedule/progress?kind=${encodeURIComponent(kind)}`);
      if (!d.available) continue;
      if (d.running) {
        startPolling(kind);
        return;
      }
      if (d.lastResult && d.lastResult.at) finishedRuns.push({ kind, lr: d.lastResult });
    } catch {
      /* 查不到就跳过，不影响页面其他功能 */
    }
  }

  if (!finishedRuns.length) return;

  // 只展示最近的一次，避免两条互相矛盾的结果同时挂在页面上
  finishedRuns.sort((a, b) => (b.lr.at || 0) - (a.lr.at || 0));
  const { kind, lr } = finishedRuns[0];
  const s = lr.summary || {};
  const isDiscover = kind === 'discover';

  renderProgress({
    kind,
    phase: lr.ok ? 'done' : s.status === 'rate-limited' ? 'rate-limited' : 'error',
    done: isDiscover ? Number(s.requests) || 0 : 0,
    total: 0,
    newStreamers: s.newStreamers,
    pool: s.pool,
    live: s.live,
    newSessions: s.newSessions,
  });
  $('#progress-title').textContent =
    `${isDiscover ? 'discover' : 'track'} · 上次执行结果 · ${fmtTime(lr.at)}`;
  setHint(
    lr.ok
      ? isDiscover
        ? `上次 discover 完成 · 新增 ${s.newStreamers ?? '—'} 人 · ${s.requests ?? '—'} 次请求`
        : `上次 track 完成 · 池 ${s.pool ?? '—'} 人 · 在播 ${s.live ?? '—'} 人`
      : `上次 ${kind} 失败：${lr.error || '未知错误'}`,
    lr.ok ? 'ok' : 'err'
  );
}

/* ---------------------------------------------------------------- 数据 */

async function refresh() {
  try {
    const st = await getJson('/api/schedule');
    if (!st.available) {
      showUnavailable(
        `调度器不可用：${escapeHtml(st.error || '未知原因')}<br>` +
          '请确认数据库已存在（先跑一次 <code>node collect-track.js</code>），然后重启服务。'
      );
      return;
    }
    $('#unavailable').style.display = 'none';
    state.status = st;
    renderStatus(st);
    fillForm(st.config, !state.dirty);
  } catch (err) {
    showUnavailable(`读取状态失败：${escapeHtml(err.message)}`);
  }
}

async function save() {
  const btn = $('#btn-save');
  btn.disabled = true;
  setHint('保存中…');

  const config = {
    enabled: $('#enabled').checked,
    trackHours: Number($('#track-hours').value),
    discoverHours: Number($('#discover-hours').value),
    discoverMaxPages: Number($('#discover-max-pages').value),
    trackBatchDelay: Number($('#track-batch-delay').value),
    discoverDelay: Number($('#discover-delay').value),
  };

  try {
    const r = await postJson('/api/schedule', { config });
    if (!r.ok) {
      setHint(r.data.error || `保存失败（HTTP ${r.status}）`, 'err');
      return;
    }
    state.dirty = false;
    state.status = r.data.status;
    // 用服务端夹取后的值回填，让用户看到真实生效值
    fillForm(r.data.config, true);
    renderStatus(r.data.status);
    setHint('已保存，立即生效', 'ok');
    setTimeout(() => setHint(''), 4000);
  } catch (err) {
    setHint(`保存失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

/** 手动 track 前的确认文案：把请求量说清楚，让用户自己决定要不要发这波请求 */
function buildTrackConfirmText() {
  const st = state.status || {};
  const pool = Number(st.poolSize) || 0;
  const BATCH = 150; // 与 lib/bili.js 的 BATCH_LIMIT 保持一致
  const batches = Math.max(1, Math.ceil(pool / BATCH));
  // 每批之间要等 trackBatchDelay（默认 1500ms），加上单次请求耗时，约 2.5 秒/批
  const delayMs = Number(($('#track-batch-delay') || {}).value) || 1500;
  const seconds = Math.round((batches * (delayMs + 1000)) / 1000);

  return (
    `「立即 track 一次」会绕过分层，全量核对池中所有主播的实时状态：\n\n` +
    `  · 主播池：${pool.toLocaleString()} 人\n` +
    `  · 请求量：约 ${batches} 批（每批 150 人）\n` +
    `  · 预计耗时：约 ${seconds} 秒\n\n` +
    `这会真实访问 B 站接口。如果你只是想看看自动调度跑得怎么样，\n` +
    `不必手动触发——自动采集会按分层节奏自己跑。\n\n` +
    `确定现在全量查一次？`
  );
}

async function runNow(kind) {
  // 手动 track 默认全量（绕过分层）。这个动作会连发几十批请求，
  // 发之前必须让用户知道代价，而不是点一下就悄悄跑。
  // discover 本身就是全量扫专区，没有这个必要。
  if (kind === 'track' && !window.confirm(buildTrackConfirmText())) return;

  const btn = kind === 'track' ? $('#btn-run-track') : $('#btn-run-discover');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';

  try {
    const r = await postJson(`/api/schedule/run?kind=${kind}`);
    if (!r.ok) {
      setHint(r.data.error || `触发失败（HTTP ${r.status}）`, 'err');
    } else {
      setHint(`${kind} 已启动，正在执行…`, 'ok');
      // 开始轮询，进度条会实时更新
      startPolling(kind);
    }
  } catch (err) {
    setHint(`触发失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------------------------------------------------------- 事件 */

function bindEvents() {
  $('#enabled').addEventListener('change', () => {
    state.dirty = true;
    updateSwitchText();
  });

  for (const id of ['#track-hours', '#discover-hours', '#discover-max-pages', '#track-batch-delay', '#discover-delay']) {
    $(id).addEventListener('input', () => {
      state.dirty = true;
      updatePresetHighlight();
      updateTips();
    });
  }

  for (const b of document.querySelectorAll('.chip')) {
    b.addEventListener('click', () => {
      $('#discover-hours').value = b.dataset.discover;
      state.dirty = true;
      updatePresetHighlight();
      updateTips();
    });
  }

  $('#btn-save').addEventListener('click', save);
  $('#btn-run-track').addEventListener('click', () => runNow('track'));
  $('#btn-run-discover').addEventListener('click', () => runNow('discover'));

  // 离开前提醒未保存
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ---------------------------------------------------------------- 启动 */

(async () => {
  bindEvents();
  renderDriftDemo();
  await refresh();
  // 页面刷新后：在跑就接上实时进度，刚跑完就把上次结果显示出来
  await resumeProgress();
  // 每 20 秒刷新一次状态（不覆盖正在编辑的表单）
  setInterval(refresh, 20000);
})();