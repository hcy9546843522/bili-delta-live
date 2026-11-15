'use strict';

/* 主播出勤页：搜索主播 → 看日历热力图 + 场次明细 */

const $ = (sel) => document.querySelector(sel);

const state = {
  uid: null,
  streamer: null,
  days: 120,
  calendar: null,
  sessions: [],
  activeResult: null,
};

/* ---------------------------------------------------------------- 工具 */

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `服务端返回了非 JSON（HTTP ${res.status}）` };
  }
  return data;
}

const pad = (n) => String(n).padStart(2, '0');

/** 秒 → "3小时24分" / "42分" */
function humanDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

/** 小时数，保留一位小数 */
function hours(sec) {
  return Math.round((sec / 3600) * 10) / 10;
}

/** 东八区格式化：2026-11-15 21:03 */
function fmtTime(epochSec) {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

function fmtDay(dayStr) {
  const [, m, d] = dayStr.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function shortNum(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
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

/* ---------------------------------------------------------------- 未就绪 */

/** 走本地图片代理：绕开 Chromium ORB 拦截，并让图床返回缩略图 */
function imgProxy(url, size) {
  return url ? `/img?u=${encodeURIComponent(url)}${size ? `&s=${size}` : ''}` : '';
}

function showUnavailable(msg) {
  const box = $('#unavailable');
  box.style.display = 'block';
  box.innerHTML = `<div class="error-box">
    <strong>出勤数据还没准备好</strong><br />
    ${escapeHtml(msg)}<br /><br />
    先跑一次采集：
    <code>node collect-track.js --mode auto</code><br />
    之后每小时跑 <code>node collect-track.js --mode track</code> 就能积累出勤记录。
  </div>`;
}

/* ---------------------------------------------------------------- 搜索 */

async function doSearch() {
  const q = $('#streamer-search').value.trim();
  const data = await getJson(`/api/attendance/search?q=${encodeURIComponent(q)}&limit=50`);
  if (!data.available) {
    showUnavailable(data.error || '数据库不可用');
    return;
  }

  const box = $('#search-results');
  if (!data.results.length) {
    box.innerHTML = `<div class="loading">没找到匹配的主播</div>`;
    return;
  }

  box.innerHTML = data.results
    .map(
      (s) => `<div class="result-item" data-uid="${s.uid}">
        <img class="face" src="${escapeHtml(imgProxy(s.face, '48x48'))}" alt="" loading="lazy"
             onerror="this.style.visibility='hidden'" />
        <span class="r-name">${escapeHtml(s.uname || '(未知)')}</span>
        <span class="r-uid">UID ${s.uid}</span>
        <span class="r-count">${s.session_count} 场</span>
      </div>`
    )
    .join('');

  for (const el of box.querySelectorAll('.result-item')) {
    el.addEventListener('click', () => selectStreamer(Number(el.dataset.uid)));
  }
}

/* ---------------------------------------------------------------- 详情 */

async function selectStreamer(uid) {
  state.uid = uid;
  for (const el of document.querySelectorAll('.result-item')) {
    el.classList.toggle('active', Number(el.dataset.uid) === uid);
  }
  await loadDetail();
}

async function loadDetail() {
  if (!state.uid) return;
  $('#detail').style.display = 'block';

  const data = await getJson(
    `/api/attendance/streamer/${state.uid}?days=${state.days}`
  );
  if (!data.available || data.error) {
    showUnavailable(data.error || '加载失败');
    return;
  }

  state.streamer = data.streamer;
  state.calendar = data;
  state.sessions = data.sessions || [];

  renderHeader();
  renderStats();
  renderCalendar();
  renderSessions();
}

function renderHeader() {
  const s = state.streamer;
  $('#streamer-name').textContent = s.uname || '(未知)';
  $('#face').src = imgProxy(s.face, '96x96');
  $('#face').style.visibility = s.face ? 'visible' : 'hidden';

  // 直播间地址必须用 roomid：https://live.bilibili.com/<uid> 对绝大多数主播是 404。
  // 老库里可能有主播还没回填到 roomid，此时退回按昵称搜索，别给一个必然 404 的链接。
  const roomUrl = s.roomid
    ? `https://live.bilibili.com/${s.roomid}`
    : `https://search.bilibili.com/live?keyword=${encodeURIComponent(s.uname || s.uid)}`;
  const roomText = s.roomid ? '直播间 ↗' : '在 B 站搜索 ↗';

  $('#streamer-meta').innerHTML =
    `UID ${s.uid} · 收录于 ${fmtTime(s.first_seen_at)} · ` +
    `<a href="${escapeHtml(roomUrl)}" target="_blank" rel="noreferrer" style="color:var(--blue)">${roomText}</a>`;
}

function renderStats() {
  const sum = state.calendar.summary;
  const items = [
    ['活跃天数', `${sum.active_days} 天`, `统计窗口 ${sum.tracked_days} 天内`],
    ['累计直播', `${hours(sum.total_seconds)} 小时`, `${sum.session_count} 场`],
    ['日均时长', humanDuration(sum.avg_seconds_per_active_day), '仅算有直播的天'],
    ['最长一场', humanDuration(sum.longest_seconds), ''] ,
    [
      '当前状态',
      sum.live_now ? '直播中' : '未开播',
      sum.live_now ? '正在进行' : '最近一次见下方',
    ],
  ];

  $('#detail-stats').innerHTML = items
    .map(
      ([label, value, sub]) => `<div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-sub">${escapeHtml(sub)}</div>
      </div>`
    )
    .join('');
}

/* ---------------------------------------------------------------- 日历 */

function renderCalendar() {
  const days = state.calendar.days;
  if (!days.length) {
    $('#calendar').innerHTML = `<div class="loading">暂无数据</div>`;
    return;
  }

  // 分档：按当天时长相对最大值取 4 档，避免个别超长直播压平其余
  // realMax 单独保留：maxSec 的兜底值 1 只用于避免除零，
  // 但图例要说人话——一个没有任何记录的主播不该显示「最长一天 1秒」。
  const realMax = Math.max(0, ...days.map((d) => d.seconds));
  const maxSec = Math.max(realMax, 1);
  const levelOf = (sec) => {
    if (!sec) return 0;
    const r = sec / maxSec;
    if (r > 0.66) return 4;
    if (r > 0.4) return 3;
    if (r > 0.15) return 2;
    return 1;
  };

  // 网格按周排布：每列一周，行 = 周一..周日
  // 先算出首日的星期偏移，用空白格补齐
  const first = days[0].day;
  const firstDow = (new Date(`${first}T00:00:00+08:00`).getDay() + 6) % 7; // 周一=0

  let cells = '';
  for (let i = 0; i < firstDow; i++) {
    cells += '<div class="cal-cell future" style="visibility:hidden"></div>';
  }

  const todayKey = days[days.length - 1].day;

  for (const d of days) {
    const lv = levelOf(d.seconds);
    const tip = d.seconds
      ? `${fmtDay(d.day)} · 直播 ${humanDuration(d.seconds)}（${d.sessions} 场，峰值 ${shortNum(d.peak_online)}）`
      : `${fmtDay(d.day)} · 未开播`;
    cells += `<div class="cal-cell lv${lv}" data-day="${d.day}" title="${escapeHtml(tip)}"></div>`;
  }

  // 月份标签：找出每月第一天所在的列
  const monthLabels = [];
  let lastMonth = null;
  days.forEach((d, i) => {
    const month = d.day.slice(0, 7);
    if (month !== lastMonth) {
      const col = Math.floor((firstDow + i) / 7);
      monthLabels.push({ col, label: `${Number(month.slice(5, 7))}月` });
      lastMonth = month;
    }
  });

  const monthBar = monthLabels
    .map((m) => `<span class="cal-month-label" style="margin-left:${m.col * 16}px">${m.label}</span>`)
    .join('');

  const legend = `
    <div class="cal-legend">
      <span>少</span>
      <div class="cal-cell lv0"></div>
      <div class="cal-cell lv1"></div>
      <div class="cal-cell lv2"></div>
      <div class="cal-cell lv3"></div>
      <div class="cal-cell lv4"></div>
      <span>多</span>
      <span style="margin-left:14px">${
        realMax > 0 ? `最长一天 ${humanDuration(realMax)}` : '暂无直播记录'
      }</span>
      <span style="margin-left:14px">今天 ${fmtDay(todayKey)}</span>
    </div>`;

  $('#calendar').innerHTML = `
    <div style="min-width:max-content">
      <div class="cal-months">${monthBar}</div>
      <div class="cal-grid">${cells}</div>
      ${legend}
    </div>`;
}

/* ---------------------------------------------------------------- 场次表 */

function renderSessions() {
  const rows = state.sessions;
  $('#session-hint').textContent = rows.length ? `最近 ${rows.length} 场` : '';

  const tbody = $('#sessions-table tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading">还没有场次记录</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((s) => {
      const dur = s.estimated
        ? `≥ ${humanDuration(s.duration)}`
        : humanDuration(s.duration);
      const pill = s.ended
        ? '<span class="pill ended">已结束</span>'
        : '<span class="pill live">直播中</span>';
      return `<tr>
        <td class="num">${fmtTime(s.live_time)}</td>
        <td class="num">${dur}</td>
        <td class="num">${shortNum(s.peak_online)}</td>
        <td>${pill}</td>
        <td>${escapeHtml(s.title || '')}</td>
      </tr>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- 导出 */

function exportSessions() {
  if (!state.sessions.length) return;
  const header = ['开播时刻', '时长(秒)', '时长', '峰值人气', '状态', '标题'];
  const lines = state.sessions.map((s) =>
    [
      fmtTime(s.live_time),
      s.duration,
      humanDuration(s.duration),
      s.peak_online,
      s.ended ? '已结束' : '直播中',
      s.title || '',
    ]
      .map((v) => {
        const t = String(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      })
      .join(',')
  );

  const csv = `\uFEFF${[header.join(','), ...lines].join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.streamer.uname || state.streamer.uid}-场次.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------------- 初始化 */

async function init() {
  const stats = await getJson('/api/attendance/stats');

  if (!stats.available) {
    $('#db-sub').textContent = '数据库不可用';
    $('#pool-hint').textContent = '';
    showUnavailable(stats.error || '数据库不可用');
    return;
  }

  $('#db-sub').textContent =
    `${stats.streamers} 位主播 · ${stats.sessions} 场记录 · ${stats.total_hours} 小时`;
  $('#pool-hint').textContent = `池中共 ${stats.streamers} 位主播`;

  if (stats.last_run && stats.last_run.finished_at) {
    $('#pool-hint').textContent += ` · 上次采集 ${fmtTime(stats.last_run.finished_at)}`;
  }

  // 支持从看板直接跳进来：/attendance.html?uid=12345
  const params = new URLSearchParams(location.search);
  const uidParam = Number(params.get('uid'));
  if (Number.isFinite(uidParam) && uidParam > 0) {
    // 搜索框填上 UID，并跑一次搜索，让左侧列表也有内容且能高亮当前项
    $('#streamer-search').value = String(uidParam);
    await doSearch();
    await selectStreamer(uidParam);
    return;
  }

  await doSearch();
}

let searchTimer = null;
$('#streamer-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 220);
});

/* ---------------------------------------------------------------- 手动添加 */

/**
 * 把主播按 UID / 直播间链接写进池子。
 *
 * 关键点：不管 B 站有没有查到资料，只要写库成功就必须给出明确回执。
 * 否则用户会以为失败了、反复点，白消耗请求。
 */
async function addStreamer() {
  const input = $('#add-input');
  const btn = $('#btn-add');
  const box = $('#add-result');
  const raw = input.value.trim();

  const show = (html, cls) => {
    box.style.display = 'block';
    box.className = `add-result ${cls || ''}`;
    box.innerHTML = html;
  };

  if (!raw) {
    show('<span class="ar-err">先填 UID 或直播间链接</span>', 'err');
    return;
  }
  // 数字至少要 3 位，纯文字说明用户填的是昵称——那应该用上面的搜索框
  if (!/\d{3,}/.test(raw)) {
    show('<span class="ar-err">没识别出数字 ID。昵称请用上面的搜索框</span>', 'err');
    return;
  }

  btn.disabled = true;
  btn.textContent = '查询中…';
  show('<span class="ar-dim">正在向 B 站查询（最多 2 个请求）…</span>');

  let data;
  try {
    data = await postJson('/api/attendance/add', { raw });
  } catch (err) {
    show(`<span class="ar-err">请求失败：${escapeHtml(err.message)}</span>`, 'err');
    btn.disabled = false;
    btn.textContent = '写入池子';
    return;
  }

  btn.disabled = false;
  btn.textContent = '写入池子';

  if (!data.ok) {
    const notes = (data.notes || []).map((n) => escapeHtml(n)).join('；');
    show(
      `<span class="ar-err">✗ 添加失败：${escapeHtml(data.error || '未知原因')}</span>` +
        (notes ? `<div class="ar-notes">${notes}</div>` : ''),
      'err'
    );
    return;
  }

  const s = data.streamer || {};
  const name = s.uname || '(未取到昵称)';
  const liveTag = data.found
    ? data.live && data.live.live_status === 1
      ? '<span class="badge live">正在直播</span>'
      : '<span class="badge mute">未开播</span>'
    : '<span class="badge warn">B 站未返回资料</span>';

  // 头像用本地代理，避免图床的 ORB 拦截
  const face = s.face
    ? `<img class="face" src="${escapeHtml(imgProxy(s.face, '48x48'))}" alt=""
         onerror="this.style.visibility='hidden'" />`
    : '<img class="face" alt="" style="visibility:hidden" />';

  const lines = [
    `<div class="ar-row">
       ${face}
       <strong class="ar-name">${escapeHtml(name)}</strong>
       ${liveTag}
       <span class="badge ${data.created ? 'ok' : 'mute'}">${data.created ? '已写入' : '已在库中'}</span>
     </div>`,
    `<div class="ar-meta">
       UID ${s.uid || data.uid}` +
      (data.resolvedFrom === 'roomid'
        ? ` · 由直播间号 ${data.inputId} 换算`
        : '') +
      ` · 来源 <code>manual</code>` +
      (s.roomid
        ? ` · <a href="https://live.bilibili.com/${s.roomid}" target="_blank" rel="noreferrer">直播间 ↗</a>`
        : '') +
      `</div>`,
  ];

  if (data.found && data.live) {
    const bits = [];
    if (data.live.title) bits.push(`标题：${escapeHtml(data.live.title)}`);
    if (data.live.online) bits.push(`人气：${shortNum(data.live.online)}`);
    if (data.live.area_name) bits.push(`分区：${escapeHtml(data.live.area_name)}`);
    if (bits.length) lines.push(`<div class="ar-meta">${bits.join(' · ')}</div>`);
  }

  if (!data.found) {
    lines.push(
      `<div class="ar-notes">UID 已入库，但 B 站没有返回这位主播的资料` +
        `（可能是 UID 不对，或该账号已注销）。库里会保留这条记录，` +
        `下次 track 采集时仍会尝试查询。</div>`
    );
  }

  if (data.recorded) {
    lines.push(
      `<div class="ar-notes ar-ok">查到此刻正在直播，已一并记入一场出勤</div>`
    );
  } else if (data.found && (!data.live || data.live.live_status !== 1)) {
    lines.push(
      `<div class="ar-notes">当前未开播，所以暂时没有场次；` +
        `之后每小时 track 会自动补上他的开播记录。</div>`
    );
  }

  if (data.notes && data.notes.length) {
    lines.push(
      `<div class="ar-notes">${data.notes.map((n) => escapeHtml(n)).join('；')}</div>`
    );
  }

  show(lines.join(''), 'ok');
  input.value = '';

  // 加入后立刻展开详情：即使一场都没有，也要能看到「已收录」这个事实
  const uid = Number(s.uid || data.uid);
  if (uid > 0) {
    $('#streamer-search').value = String(uid);
    await doSearch();
    await selectStreamer(uid);
    await init();
  }
}

$('#btn-add').addEventListener('click', addStreamer);
$('#add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addStreamer();
  }
});

$('#window-days').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  loadDetail();
});

$('#btn-export-sessions').addEventListener('click', exportSessions);

init();