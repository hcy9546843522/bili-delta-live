'use strict';

/* ================================================================ 工具 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 绑定事件；目标元素不存在就跳过。
 *
 * app.js 同时被「实时看板」和「房间明细」两个页面引用，两页的区块并不相同
 * （看板页没有明细表，明细页没有统计卡和图表）。不用这个包装，
 * 少一个元素就会在启动时抛 TypeError，整页的脚本全挂。
 */
const on = (sel, ev, fn, opts) => {
  const el = $(sel);
  if (el) el.addEventListener(ev, fn, opts);
  return el;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const fmt = (n) => (Number.isFinite(n) ? n : 0).toLocaleString('zh-CN');

/** 走本地图片代理：绕开 ORB 拦截，并让图床返回缩略图 */
const imgProxy = (url, size) =>
  url ? `/img?u=${encodeURIComponent(url)}${size ? `&s=${size}` : ''}` : '';

/** 封面格子：懒加载 + 加载失败自动隐藏，避免破图标；data-full 供悬停放大用 */
const coverCell = (r) => {
  const src = imgProxy(r.cover, '320x180');
  if (!src) return '<td class="cover-cell"></td>';
  const full = imgProxy(r.cover, '640x360');
  return `<td class="cover-cell">
    <img class="room-cover" src="${esc(src)}" data-full="${esc(full)}" alt=""
         loading="lazy" onerror="this.classList.add('failed')" />
  </td>`;
};

/** 头像 + 昵称组合（昵称链接到出勤详情） */
const unameCell = (r) => {
  const src = imgProxy(r.face, '36x36');
  const avatar = src
    ? `<img class="avatar" src="${esc(src)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'" />`
    : '<span class="avatar avatar-ph"></span>';
  const href = r.uid ? `/attendance.html?uid=${encodeURIComponent(r.uid)}` : '';
  const name = esc(r.uname || '');
  const label = href
    ? `<a class="uname-link" href="${esc(href)}" target="_blank" rel="noreferrer" title="${name}（在新标签页查看出勤记录）">${name}</a>`
    : `<span class="uname-text" title="${name}">${name}</span>`;
  return `<td class="uname">${avatar}${label}</td>`;
};

const fmtShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/* ================================================================ 状态 */

const state = {
  meta: null,
  rooms: [],
  // 采集趋势：来自 /api/trend（collect_runs 每次 track 落一行）
  trend: [],
  sort: { key: 'online', dir: 'desc' },
  query: '',
  keyword: '',
  minOnline: 0,
  // 直播状态筛选：快照拍下后陆续有人下播，全展示时几百个已下播房间会淹没有效信息。
  // 'all' | 'live' | 'dead' | 'never'，与「直播状态」列同一口径（都走 liveStateOf）。
  liveFilter: 'all',
  // 无限滚动：不翻页。没有「当前页」，只有「已渲染到第几行」。
  // shown 是当前已渲染的行数，滚到接近底部时 appendRows() 再追加一批。
  batchSize: 100,
  shown: 100,
  kwMode: 'count',
  // 趋势图指标：'live' = 在播房间数，'pool' = 主播池规模
  // （collect_runs 不记录合计人气，所以不提供那个选项）
  trendMode: 'live',
  // 直播状态：{ open: {uid: 观测时刻}, seen: [uid], observedAt, now }
  // 来自 /api/live-status，用于把「快照里的人现在还在不在播」标出来
  liveStatus: null,
  // 开播时长筛选：'all' 或分钟数（30/60/120/360），筛出「刚开播」的直播间
  durFilter: 'all',
  // 服务器当前时刻（秒），来自 /api/live-now 的 now。
  // 算「已开播多久」必须用它而不是浏览器本地时间——本机时钟偏几分钟，
  // 就会把刚开播的房间算错，甚至算出负数。
  serverNow: 0,
};

/* ================================================================ 数据访问 */

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

async function loadTrend() {
  try {
    const j = await api('/api/trend?days=7&limit=500');
    state.trend = Array.isArray(j.points) ? j.points : [];
  } catch {
    state.trend = [];
  }
}

async function loadRooms() {
  // 只读数据库里的实时结果。磁盘快照是早期 collect-http.js 的产物，track 之后
  // 再没写过，而且可能已经是十几小时前的切片，拿它当「此刻谁在播」会严重失真。
  return loadRoomsFromDb();
}

/**
 * 此刻在播的房间 —— 来自数据库（track 每小时的落库结果）。
 *
 * 房间明细要回答的是「现在谁在播、标题是什么、ID 多少」，只有 sessions 里
 * ended=0 的那批数据能回答。track 每小时刷新一次它，discover 负责把人捞进池子。
 */
async function loadRoomsFromDb() {
  // 看板页没有明细面板（已拆到 /rooms.html），这里必须容忍元素缺失，
  // 否则 classList 会抛 TypeError 把整个初始化流程打断。
  const panel = $('#rooms-panel');
  if (panel) panel.classList.add('is-loading');
  try {
    // 2000 是接口上限，当前池子远小于它
    const j = await api('/api/live-now?limit=2000');
    if (!j.available) throw new Error(j.error || '数据库不可用');

    let observedAt = 0;
    // 用服务器时间做「已开播多久」的基准，避免浏览器时钟偏差
    state.serverNow = Number(j.now) || Math.floor(Date.now() / 1000);
    const rooms = (j.rooms || []).map((r) => {
      const t = Number(r.last_observed_at) || 0;
      if (t > observedAt) observedAt = t;
      return {
        uid: r.uid,
        uname: r.uname || `UID ${r.uid}`,
        face: r.face || '',
        // 直播封面（这一场直播的画面封面），随 track 落库
        cover: r.cover || '',
        roomid: r.roomid ?? '',
        title: r.title || '',
        area_name: r.area_name || '',
        // 分区口径：开播分区记在 start_*，当前分区可能已经被切走
        area_id: Number(r.area_id) || 0,
        start_area_id: Number(r.start_area_id) || 0,
        start_area_name: r.start_area_name || '',
        last_change_at: Number(r.last_change_at) || 0,
        last_change_from_name: r.last_change_from_name || '',
        last_change_to_name: r.last_change_to_name || '',
        online: Number(r.last_online) || Number(r.online) || 0,
        live_time: r.live_time,
        // 已开播秒数：B 站接口给的 live_time 是本场开播时刻，是真实开播时间，
        // 不受「track 多久查一次」影响。取不到就记 -1（表示未知），
        // 不能记 0——那会在表里显示成「刚开播」，把最该被筛出来的位置占满。
        duration: (() => {
          const lt = Number(r.live_time) || 0;
          if (lt <= 0) return -1;
          return Math.max(0, state.serverNow - lt);
        })(),
        last_observed_at: t,
        url: r.roomid ? `https://live.bilibili.com/${r.roomid}` : '',
      };
    });

    state.meta = {
      live: true,
      generated_at: new Date((j.now || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      source: '数据库 · track 实时结果',
      count: rooms.length,
      observed_at: observedAt || null,
    };
    state.rooms = rooms;
    // 数据整批换了，已渲染行数回到第一批，免得停在上次的「已加载 500 行」
    state.shown = state.batchSize;
    render();
  } catch (err) {
    // 数据库不可用（没跑过 track / 库被删）就如实说明。
    // 以前这里会悄悄退回磁盘快照，让人以为看到的是实时数据，反而更危险。
    renderError(`读取数据库失败：${err.message}（需要先跑一次 track 采集）`);
  } finally {
    if (panel) panel.classList.remove('is-loading');
  }
}

/**
 * 取「现在还在播」的名单。
 *
 * 为什么房间明细需要它：这张表来自专区接口快照，快照只包含生成那一刻在播的房间。
 * 但页面标的是「最新快照」，用户很容易以为表里每一个人此刻都在播 ——
 * 实际上十几分钟后就有人陆续下播了。所以拿 track 的落库结果交叉比对，
 * 把已经下播的、以及从没被 track 到的（无法判断）分别标出来。
 *
 * 拿不到就返回 null，调用方降级为「不显示状态列内容」，不影响表格本身。
 */
async function loadLiveStatus() {
  try {
    state.liveStatus = await api('/api/live-status');
  } catch {
    state.liveStatus = null;
  }
}

/**
 * 房间此刻的直播状态。
 *
 * 三种结论，必须区分开：
 *   live    track 最近一次观测到该房间还开着
 *   dead    有 track 记录，但最近一次已标记结束
 *   never   从没被 track 查到过（多为新进池的冷门主播）——不能算作「已下播」
 *   null    拿不到 track 数据，无法判断
 *
 * 单独抽出来是因为「状态列显示什么」和「只看在播筛掉谁」必须是同一个口径。
 * 两处各写一遍判断，早晚会出现「标着在播却被过滤掉」这种自相矛盾的画面。
 */
function liveStateOf(r) {
  const ls = state.liveStatus;
  if (!ls || !ls.available) return null;

  const uid = String(r.uid ?? '');
  const openAt = ls.open ? ls.open[uid] : null;
  if (openAt) return { state: 'live', openAt };

  const seen = Array.isArray(ls.seen) && ls.seen.includes(Number(r.uid));
  return { state: seen ? 'dead' : 'never', openAt: null };
}

/**
 * 直播状态单元格。
 *
 * 另外标注「多久之前观测」，因为 track 按分层频率跑，冰层主播可能几天没查，
 * 不标时间会让人把这个状态误当成实时。
 */
function statusCell(r) {
  const st = liveStateOf(r);
  if (!st) return '<td class="status-cell">—</td>';

  if (st.state === 'live') {
    const age = state.liveStatus.now ? Math.max(0, state.liveStatus.now - st.openAt) : 0;
    return `<td class="status-cell"><span class="badge live">在播</span> <span class="status-age">${esc(
      fmtAgo(age)
    )}</span></td>`;
  }
  if (st.state === 'dead') return '<td class="status-cell"><span class="badge mute">已下播</span></td>';
  return '<td class="status-cell"><span class="badge warn">未采集</span></td>';
}

/**
 * 开播时长单元格。
 *
 * 依据 sessions.live_time（B 站给的真实开播时刻）与服务器当前时间计算，
 * 不是「track 第一次观测到它的时间」——后者受分层采集频率影响，
 * 冷层主播可能几天才查一次，那样算出来的「刚开播」全是假的。
 *
 * 刚开播的（30 分钟内）额外标绿，因为这一列的主要用途就是快速捞新开的直播间，
 * 需要能一眼扫到；纯数字在几百行里很难抓。
 */
/** 分区：开播分区 → 当前分区；当前不在三角洲时加醒目标记 */
function areaCell(r) {
  const curId = Number(r.area_id) || 0;
  const curName = r.area_name || '未知分区';
  const startId = Number(r.start_area_id) || 0;
  const startName = r.start_area_name || '';
  const changed = startId > 0 && curId > 0 && startId !== curId;
  // 878 = 三角洲行动。当前分区不是它，说明已切走或本来就不是三角洲
  const away = curId > 0 && curId !== 878;

  const tip = [];
  if (startName) tip.push(`开播分区：${startName}`);
  tip.push(`当前分区：${curName}`);
  if (r.last_observed_at && state.serverNow) {
    tip.push(`上次确认：${fmtAgo(Math.max(0, state.serverNow - r.last_observed_at))}`);
  }
  if (r.last_change_at) {
    const ago = state.serverNow
      ? fmtAgo(Math.max(0, state.serverNow - r.last_change_at))
      : '';
    tip.push(
      `最近切换：${r.last_change_from_name || '?'} → ${r.last_change_to_name || '?'}${
        ago ? `（${ago}）` : ''
      }`
    );
  }

  const label = changed
    ? `<span class="area-from">${esc(startName || '未知')}</span><span class="area-arrow">→</span><span class="area-now">${esc(curName)}</span>`
    : `<span class="area-now">${esc(curName)}</span>`;
  const badge = away
    ? `<span class="badge warn area-out">${startId === 878 ? '已切走' : '非三角洲'}</span>`
    : '';
  return `<td class="area-cell" title="${esc(tip.join('\n'))}">${label}${badge}</td>`;
}

function durCell(r) {
  const d = Number(r.duration);
  if (!Number.isFinite(d) || d < 0) return '<td class="dur-cell">—</td>';
  const fresh = d <= 30 * 60 ? ' fresh' : '';
  const tip = r.live_time
    ? `开播于 ${fmtTime(new Date(Number(r.live_time) * 1000).toISOString())}`
    : '';
  return `<td class="dur-cell${fresh}" title="${esc(tip)}">${esc(fmtDur(d))}</td>`;
}

/** 秒 → 人话。仅用于状态新鲜度，不需要精确到分秒 */
function fmtAgo(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/**
 * 已开播时长 → 「3 小时 12 分」这种人话。
 *
 * 与 fmtAgo（多久之前发生的）刻意分开：那是「过去时」，这是「持续了多久」，
 * 混用会让人把「已开播 3 小时」读成「3 小时前开播」。两者数值恰好相同，
 * 但语义相反，展示上必须能一眼区分。
 *
 * 传 -1 表示开播时间未知（库里的 live_time 缺失），显示「—」而不是「0 分钟」，
 * 否则未知会被误读成刚开播。
 */
function fmtDur(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return '刚刚开播';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

/* ================================================================ 过滤与排序 */

function filtered() {
  let rows = state.rooms;

  // 直播状态筛选：判定口径与状态列完全一致（都走 liveStateOf），
  // 否则会出现「表格里标着在播，却被筛选掉」的矛盾。
  // 拿不到 track 状态时不筛（保留全部），而不是把整张表清空 ——
  // 数据没准备好就清空表，看起来像坏了。
  if (state.liveFilter !== 'all' && state.liveStatus && state.liveStatus.available) {
    rows = rows.filter((r) => {
      const st = liveStateOf(r);
      return st && st.state === state.liveFilter;
    });
  }

  if (state.minOnline > 0) {
    rows = rows.filter((r) => (r.online || 0) >= state.minOnline);
  }

  // 开播时长筛选：找刚开播的直播间。
  // 未知时长（duration < 0，live_time 缺失）的不能算「刚开播」——
  // 那是「不知道」，混进来会让人以为有新的开播。所以明确排除。
  if (state.durFilter !== 'all') {
    const maxSec = Number(state.durFilter) * 60;
    rows = rows.filter((r) => {
      const d = Number(r.duration);
      return Number.isFinite(d) && d >= 0 && d <= maxSec;
    });
  }

  if (state.keyword) {
    const kw = state.keyword;
    rows = rows.filter((r) => String(r.title || '').includes(kw));
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => {
      const hay = `${r.uname || ''} ${r.title || ''} ${r.roomid || ''} ${r.uid || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    // 开播时长：未知（<0，live_time 缺失）永远排最后，不参与方向切换。
    // 否则升序时这些「—」会占据最前面，把真正刚开播的挤下去，
    // 而这列的用途恰恰是看最前面那几条。
    if (key === 'duration') {
      const an = Number(av);
      const bn = Number(bv);
      const aBad = !Number.isFinite(an) || an < 0;
      const bBad = !Number.isFinite(bn) || bn < 0;
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return (an - bn) * mul;
    }
    if (key === 'area') {
      // 行的排序键是 'area'，实际比较的是 area_name（表格里显示的分区文字）
      av = String(a.area_name || '');
      bv = String(b.area_name || '');
      return av.localeCompare(bv, 'zh-CN') * mul;
    }
    if (key === 'online' || key === 'roomid' || key === 'uid') {
      av = Number(av) || 0;
      bv = Number(bv) || 0;
      return (av - bv) * mul;
    }
    av = String(av ?? '');
    bv = String(bv ?? '');
    return av.localeCompare(bv, 'zh-CN') * mul;
  });

  return rows;
}

/* ================================================================ 渲染：概览 */

/**
 * 数据新鲜度信息（观测时刻 + 距今多久）。
 *
 * 单独抽出来是因为它有两个展示位：顶栏 #meta-sub 和来源徽章行。
 * 房间明细页为了把顶栏压成一行会用 CSS 隐藏 #meta-sub，
 * 此时必须把这段补到来源徽章行 —— 否则「这批数据有多旧」就彻底看不见了，
 * 很容易把几小时前的结果当成此刻的实况。
 */
function freshnessBits() {
  const m = state.meta;
  if (!m) return [];
  if (!m.observed_at) return ['实时 · 暂无观测记录'];
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - m.observed_at));
  return [`实时 · track ${fmtAgo(ageSec)}观测`];
}

/** 顶栏的 #meta-sub 当前是否真的显示着（被 CSS 隐藏时 offsetParent 为 null） */
function metaSubVisible() {
  const el = $('#meta-sub');
  return !!(el && el.offsetParent !== null);
}

function renderMeta() {
  const el = $('#meta-sub');
  if (!el) return;
  const m = state.meta;
  if (!m) {
    el.textContent = '无数据';
    return;
  }
  const src = m.source || '';
  const area = m.area ? `${m.area.area_name}（${m.area.area_id}）` : '';
  // 实时模式没有 area，空串直接拼会留下「·  ·」这种多余分隔符
  const bits = [freshnessBits().join(''), area, src].filter(Boolean);
  el.textContent = bits.join(' · ');
}

function renderStats() {
  const box = $('#stats');
  if (!box) return;
  const rows = filtered();
  const all = state.rooms;
  const onlines = rows.map((r) => r.online || 0);
  const total = onlines.reduce((a, b) => a + b, 0);

  const sortedDesc = [...onlines].sort((a, b) => b - a);
  const top10 = sortedDesc.slice(0, 10).reduce((a, b) => a + b, 0);
  const share = total > 0 ? (top10 / total) * 100 : 0;

  const over100 = onlines.filter((o) => o >= 100).length;
  const isFiltered = rows.length !== all.length;

  const cards = [
    {
      k: '在播直播间',
      v: fmt(rows.length),
      sub: isFiltered ? `/${fmt(all.length)}` : '个',
    },
    { k: '合计人气', v: fmt(total), sub: '' },
    { k: '人气中位数', v: fmt(median(onlines)), sub: '' },
    { k: '最高人气', v: fmt(sortedDesc[0] || 0), sub: '' },
    { k: 'Top10 人气占比', v: share.toFixed(1), sub: '%' },
    { k: '人气 ≥100', v: fmt(over100), sub: '个' },
  ];

  box.innerHTML = cards
    .map(
      (c) => `<div class="stat">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>
      </div>`
    )
    .join('');
}

/* ================================================================ 渲染：图表 */

function drawTopBars() {
  const svg = $('#chart-top');
  if (!svg) return;
  svg.innerHTML = '';
  const rows = filtered().slice(0, 20);

  if (!rows.length) {
    svg.setAttribute('viewBox', '0 0 620 60');
    const t = svgEl('text', { x: 310, y: 34, 'text-anchor': 'middle' });
    t.textContent = '无数据';
    svg.appendChild(t);
    return;
  }

  const rowH = 25;
  const labelW = 122;
  const valueW = 62;
  const topPad = 6;
  const W = 620;
  const H = topPad + rows.length * rowH + 6;
  const barMax = W - labelW - valueW - 8;
  const maxV = Math.max(...rows.map((r) => r.online || 0), 1);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  rows.forEach((r, i) => {
    const y = topPad + i * rowH;
    const bh = 15;
    const by = y + (rowH - bh) / 2;
    const v = r.online || 0;
    const bw = Math.max(2, (v / maxV) * barMax);

    // 主播名
    const name = String(r.uname || '');
    const shown = name.length > 9 ? name.slice(0, 9) + '…' : name;
    const nameEl = svgEl('text', {
      x: labelW - 8,
      y: by + bh - 4,
      'text-anchor': 'end',
      class: 'name-label',
    });
    nameEl.textContent = shown;
    const nt = svgEl('title');
    nt.textContent = name;
    nameEl.appendChild(nt);
    svg.appendChild(nameEl);

    // 条
    const grad = i < 3 ? '#fb7299' : '#4a5568';
    const bar = svgEl('rect', {
      x: labelW,
      y: by,
      width: bw,
      height: bh,
      rx: 3,
      fill: grad,
      class: 'bar',
    });
    const bt = svgEl('title');
    bt.textContent = `${name}\n人气 ${fmt(v)}\n房间 ${r.roomid}\n${r.title || ''}`;
    bar.appendChild(bt);
    svg.appendChild(bar);

    // 数值
    const val = svgEl('text', {
      x: labelW + bw + 7,
      y: by + bh - 4,
      class: 'val-label',
    });
    val.textContent = fmtShort(v);
    svg.appendChild(val);
  });
}

const HISTORY_BUCKETS = [
  { label: '0', test: (o) => o === 0 },
  { label: '1-5', test: (o) => o >= 1 && o <= 5 },
  { label: '6-10', test: (o) => o >= 6 && o <= 10 },
  { label: '11-20', test: (o) => o >= 11 && o <= 20 },
  { label: '21-50', test: (o) => o >= 21 && o <= 50 },
  { label: '51-100', test: (o) => o >= 51 && o <= 100 },
  { label: '101-200', test: (o) => o >= 101 && o <= 200 },
  { label: '201-500', test: (o) => o >= 201 && o <= 500 },
  { label: '501-1k', test: (o) => o >= 501 && o <= 1000 },
  { label: '1k-2k', test: (o) => o >= 1001 && o <= 2000 },
  { label: '2k-5k', test: (o) => o >= 2001 && o <= 5000 },
  { label: '5k-10k', test: (o) => o >= 5001 && o <= 10000 },
  { label: '10k+', test: (o) => o > 10000 },
];

function drawDistribution() {
  const svg = $('#chart-dist');
  if (!svg) return;
  svg.innerHTML = '';
  const rows = filtered();

  if (!rows.length) {
    svg.setAttribute('viewBox', '0 0 620 60');
    const t = svgEl('text', { x: 310, y: 34, 'text-anchor': 'middle' });
    t.textContent = '无数据';
    svg.appendChild(t);
    return;
  }

  const counts = HISTORY_BUCKETS.map((b) => rows.filter((r) => b.test(r.online || 0)).length);

  const W = 620;
  const H = 236;
  const padL = 38;
  const padR = 8;
  const padT = 12;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxCount = Math.max(...counts, 1);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // y 轴网格
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const val = Math.round((maxCount / yTicks) * i);
    const y = padT + plotH - (plotH / yTicks) * i;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
    const t = svgEl('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' });
    t.textContent = String(val);
    svg.appendChild(t);
  }

  const slot = plotW / HISTORY_BUCKETS.length;
  const bw = Math.min(slot * 0.66, 34);

  HISTORY_BUCKETS.forEach((b, i) => {
    const c = counts[i];
    const bh = maxCount > 0 ? (c / maxCount) * plotH : 0;
    const x = padL + slot * i + (slot - bw) / 2;
    const y = padT + plotH - bh;

    const bar = svgEl('rect', {
      x,
      y,
      width: bw,
      height: Math.max(bh, c > 0 ? 1.5 : 0),
      rx: 2.5,
      fill: i >= 9 ? '#fb7299' : '#4a5568',
      class: 'bar',
    });
    const bt = svgEl('title');
    bt.textContent = `人气 ${b.label}：${fmt(c)} 个房间（${((c / rows.length) * 100).toFixed(1)}%）`;
    bar.appendChild(bt);
    svg.appendChild(bar);

    // 柱顶数值
    if (c > 0) {
      const vt = svgEl('text', {
        x: x + bw / 2,
        y: y - 4,
        'text-anchor': 'middle',
        class: 'val-label',
      });
      vt.textContent = String(c);
      svg.appendChild(vt);
    }

    // x 轴标签
    const lt = svgEl('text', {
      x: x + bw / 2,
      y: padT + plotH + 15,
      'text-anchor': 'end',
      transform: `rotate(-42 ${x + bw / 2} ${padT + plotH + 15})`,
    });
    lt.textContent = b.label;
    svg.appendChild(lt);
  });

  // 轴线
  svg.appendChild(
    svgEl('line', {
      x1: padL,
      y1: padT + plotH,
      x2: W - padR,
      y2: padT + plotH,
      class: 'axis-line',
    })
  );

  // 底部说明
  const note = svgEl('text', { x: padL, y: H - 4 });
  note.textContent = `横轴：人气区间（对数式分桶）　纵轴：房间数　共 ${fmt(rows.length)} 个`;
  svg.appendChild(note);
}

function drawTrend() {
  const svg = $('#chart-trend');
  if (!svg) return;
  svg.innerHTML = '';

  // 来自 /api/trend，即数据库 collect_runs 里每次 track 的记录（已按时间正序）。
  // 不再读磁盘快照：那个目录只有早期 collect-http.js 留下的几个文件，
  // 之后 track 从未写过，几个点互不可比，画出来是假趋势。
  const pts = state.trend || [];

  if (pts.length < 2) {
    svg.setAttribute('viewBox', '0 0 620 80');
    const t = svgEl('text', { x: 310, y: 44, 'text-anchor': 'middle' });
    t.textContent =
      pts.length === 1
        ? '目前只有 1 次采集记录，再跑一次 track 就能看到趋势'
        : '还没有采集记录：开启自动采集或手动跑一次 track 后这里会出现趋势';
    svg.appendChild(t);
    return;
  }

  const W = 620;
  const H = 220;
  const padL = 48;
  const padR = 14;
  const padT = 14;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const isLive = state.trendMode !== 'pool';
  const vals = pts.map((p) => (isLive ? p.live : p.pool) || 0);
  const maxV = Math.max(...vals, 1);
  const minV = Math.min(...vals, 0);
  const span = maxV - minV || 1;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH / 4) * i;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
    const v = minV + (span / 4) * i;
    const t = svgEl('text', { x: padL - 7, y: y + 4, 'text-anchor': 'end' });
    t.textContent = fmtShort(Math.round(v));
    svg.appendChild(t);
  }

  const xFor = (i) => padL + (plotW / Math.max(pts.length - 1, 1)) * i;
  const yFor = (v) => padT + plotH - ((v - minV) / span) * plotH;

  // 折线
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(vals[i]).toFixed(1)}`).join(' ');
  svg.appendChild(
    svgEl('path', { d, fill: 'none', stroke: '#fb7299', 'stroke-width': 2, 'stroke-linejoin': 'round' })
  );

  // 数据点
  pts.forEach((p, i) => {
    const cx = xFor(i);
    const cy = yFor(vals[i]);
    const c = svgEl('circle', { cx, cy, r: 3.5, fill: '#fb7299', class: 'bar' });
    const t = svgEl('title');
    // p.at 是 unix 秒，fmtTime 收 ISO 字符串
    const iso = new Date(p.at * 1000).toISOString();
    t.textContent = `${fmtTime(iso)}\n${isLive ? '在播房间' : '主播池'}：${fmt(vals[i])}`;
    c.appendChild(t);
    svg.appendChild(c);
  });

  // x 轴时间标签（最多 6 个）
  const step = Math.max(1, Math.ceil(pts.length / 6));
  pts.forEach((p, i) => {
    if (i % step !== 0 && i !== pts.length - 1) return;
    const t = svgEl('text', { x: xFor(i), y: padT + plotH + 16, 'text-anchor': 'middle' });
    const dt = new Date(p.at * 1000);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    t.textContent = `${dt.getMonth() + 1}/${dt.getDate()} ${hh}:${mm}`;
    svg.appendChild(t);
  });

  svg.appendChild(
    svgEl('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, class: 'axis-line' })
  );
}

/* ================================================================ 渲染：标题关键词 */

const STOP_WORDS = new Set([
  '什么', '怎么', '然后', '就是', '这个', '那个', '可以', '没有', '一个', '我们',
  '你们', '他们', '自己', '现在', '今天', '晚上', '直播', '主播', '房间', '欢迎',
  '进来', '一下', '真的', '不是', '还是', '这样', '那样', '如果', '因为', '所以',
  '但是', '而且', '已经', '可能', '应该', '知道', '觉得', '时候', '东西', '事情',
  '来看', '看看', '一起', '有人', '没人', '啥的', '什么的',
]);

/**
 * 无词典中文关键词提取：n-gram 统计 + 子串抑制
 * 返回 [{ word, count, online }]
 */
function extractKeywords(rooms, minCount = 3) {
  const countMap = new Map(); // word -> 命中标题数
  const onlineMap = new Map(); // word -> 这些标题的人气合计

  for (const r of rooms) {
    const raw = String(r.title || '');
    const tokens = raw.match(/[\u4e00-\u9fa5]+|[a-zA-Z][a-zA-Z0-9]{1,}/g) || [];
    const seenInTitle = new Set();

    for (const tk of tokens) {
      const isCjk = /[\u4e00-\u9fa5]/.test(tk);
      if (isCjk) {
        const maxN = Math.min(4, tk.length);
        for (let n = 2; n <= maxN; n++) {
          for (let i = 0; i + n <= tk.length; i++) {
            seenInTitle.add(tk.slice(i, i + n));
          }
        }
      } else if (tk.length >= 2) {
        seenInTitle.add(tk.toLowerCase());
      }
    }

    for (const w of seenInTitle) {
      countMap.set(w, (countMap.get(w) || 0) + 1);
      onlineMap.set(w, (onlineMap.get(w) || 0) + (r.online || 0));
    }
  }

  // 过滤低频与停用词
  let cands = [...countMap.entries()].filter(
    ([w, c]) => c >= minCount && !STOP_WORDS.has(w) && w.length >= 2
  );

  // 子串抑制：长词优先，短词若被长词覆盖且频次相近则丢弃
  cands.sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  const kept = [];
  for (const [w, c] of cands) {
    const covered = kept.some(
      ([w2, c2]) => w2.length > w.length && w2.includes(w) && c2 >= c * 0.55
    );
    if (!covered) kept.push([w, c]);
  }

  return kept
    .map(([word, count]) => ({ word, count, online: onlineMap.get(word) || 0 }))
    .sort((a, b) =>
      state.kwMode === 'online' ? b.online - a.online : b.count - a.count
    );
}

function renderKeywords() {
  const box = $('#keywords');
  if (!box) return;
  const rows = filtered();

  if (!rows.length) {
    box.innerHTML = '<div class="empty">无数据</div>';
    return;
  }

  const words = extractKeywords(rows).slice(0, 48);
  if (!words.length) {
    box.innerHTML = '<div class="empty">标题太分散，没有提取到高频关键词</div>';
    return;
  }

  const maxCount = Math.max(...words.map((w) => w.count), 1);

  box.innerHTML = words
    .map((w) => {
      // 字号随频次变化：12 ~ 19px
      const size = 12 + (w.count / maxCount) * 7;
      const active = state.keyword === w.word ? ' style="border-color:var(--accent);color:var(--text)"' : '';
      const tip =
        state.kwMode === 'online'
          ? `覆盖人气 ${fmt(w.online)}（${w.count} 个房间）`
          : `${w.count} 个房间 · 覆盖人气 ${fmt(w.online)}`;
      return `<button class="tag" data-word="${esc(w.word)}" title="${esc(tip)}"${active}>
        <span style="font-size:${size.toFixed(1)}px">${esc(w.word)}</span>
        <span class="n">${state.kwMode === 'online' ? fmtShort(w.online) : w.count}</span>
      </button>`;
    })
    .join('');
}

/* ================================================================ 渲染：表格 */

const COLUMNS = [
  { key: 'rank', label: '#', sortable: false, cls: 'rank' },
  // 封面：track 落库时一并保存（接口本来就返回 cover_from_user，不额外发请求）。
  // 之前只有快照模式才有，是因为当时库里没存；现在实时数据也有封面，常显即可。
  { key: 'cover', label: '封面', sortable: false, cls: 'cover-cell' },
  { key: 'uname', label: '主播', sortable: true, cls: 'uname' },
  // 直播状态：快照只是某一刻的切片，这一列说明「现在还在不在播」
  { key: 'live', label: '直播状态', sortable: false, cls: 'status-cell' },
  // 分区：显示开播分区 → 当前分区。主播可能中途切走，没切走的只显示一个。
  { key: 'area', label: '分区', sortable: true, cls: 'area-cell' },
  // 开播时长：live_time 是 B 站给的真实开播时刻，用它算「已开播多久」，
  // 比「track 第一次看到它的时间」准确——后者受采集频率影响，冰层主播能差几天。
  // 可排序：配合「开播」筛选快速捞刚开播的直播间。
  { key: 'duration', label: '开播', sortable: true, cls: 'dur-cell' },
  { key: 'online', label: '人气', sortable: true, cls: 'num' },
  { key: 'roomid', label: '房间号', sortable: true, cls: 'room' },
  { key: 'uid', label: 'UID', sortable: false, cls: 'room' },
  { key: 'title', label: '标题', sortable: true, cls: 'title-cell' },
];

/** 当前数据源下实际要显示的列 */
function visibleColumns() {
  return COLUMNS;
}

/** 单行 HTML。rank 是过滤后列表里的序号，跨批次连续（不随追加归零） */
function rowHtml(r, rank, showCover) {
  const hot = (r.online || 0) >= 1000 ? ' class="hot"' : '';
  return `<tr>
    <td class="rank">${rank}</td>
    ${showCover ? coverCell(r) : ''}
    ${unameCell(r)}
    ${statusCell(r)}
    ${areaCell(r)}
    ${durCell(r)}
    <td class="num"${hot}>${fmt(r.online || 0)}</td>
    <td class="room"><a href="${esc(
      r.url || `https://live.bilibili.com/${r.roomid}`
    )}" target="_blank" rel="noreferrer">${esc(r.roomid)}</a></td>
    <td class="room"><a href="${esc(
      r.user_url || `https://space.bilibili.com/${r.uid}`
    )}" target="_blank" rel="noreferrer">${esc(r.uid)}</a></td>
    <td class="title-cell" title="${esc(r.title || '')}">${esc(r.title || '')}</td>
  </tr>`;
}

/** 底部那行「已显示 X / 共 Y 条」，顺带提示还能不能继续滚 */
function updateListBar(total, shown) {
  const info = $('#pager-info');
  if (info) {
    info.textContent = total === 0 ? '0 条' : `已显示 ${fmt(shown)} / 共 ${fmt(total)} 条`;
  }
  const st = $('#load-state');
  if (st) {
    if (total === 0) st.textContent = '';
    else st.textContent = shown < total ? '继续向下滚动加载更多' : '已全部加载';
  }
}

function renderTable() {
  const tableEl = $('#rooms-table');
  if (!tableEl) return;
  const rows = filtered();
  const total = rows.length;
  // 无限滚动：只渲染前 shown 行，剩下的等滚到底部再追加。
  // 一次铺满几千行会让首屏变慢（每行两个懒加载图片），也会让表头吸顶滚动发涩。
  // 注意 shown 只作上限用、不回写 state.shown：排序或筛选让行数回升时，
  // 回写会把「已加载 500 行」压成临时结果的行数，再切回来就只剩几十行。
  const shown = Math.min(state.shown, total);
  const slice = rows.slice(0, shown);

  // 表头
  const cols = visibleColumns();
  // 表体和表头必须用同一个决定，否则会出现「表头有封面列、单元格却是空的」
  const showCover = cols.some((c) => c.key === 'cover');
  const thead = $('#rooms-table thead');
  thead.innerHTML =
    '<tr>' +
    cols.map((c) => {
      const active = state.sort.key === c.key;
      const arrow = active ? `<span class="arrow">${state.sort.dir === 'desc' ? '▼' : '▲'}</span>` : '';
      /*
       * 列自带的类必须跟着表头一起输出。
       * 数据格用 td.num / td.rank 右对齐，表头若不带同一个类就留在左侧，
       * 看起来像整列错位；其余类（cover-cell / status-cell 等）虽然规则都写了
       * td 前缀、对 th 无副作用，但保持「表头与数据格同类」更不容易再漏。
       */
      const align = c.cls ? ` ${c.cls}` : '';
      const cls = (c.sortable ? '' : 'no-sort') + align;
      return `<th class="${cls}" data-key="${c.sortable ? c.key : ''}">${esc(
        c.label
      )}${arrow}</th>`;
    }).join('') +
    '</tr>';

  // 表体
  const tbody = $('#rooms-table tbody');
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">没有符合条件的房间</div></td></tr>`;
  } else {
    tbody.innerHTML = slice.map((r, i) => rowHtml(r, i + 1, showCover)).join('');
  }

  updateListBar(total, shown);
}

/**
 * 追加下一批。
 *
 * 不是「重新渲染前 N 行」，而是往现有 tbody 里续写 —— 这样已经加载的封面
 * 不会被重新请求，滚动位置也不会跳。表头不用动，列不随行变。
 */
function appendRows() {
  const tbody = $('#rooms-table tbody');
  if (!tbody) return;
  const rows = filtered();
  const total = rows.length;
  if (state.shown >= total) return;

  const showCover = visibleColumns().some((c) => c.key === 'cover');
  const next = Math.min(state.shown + state.batchSize, total);
  const html = rows
    .slice(state.shown, next)
    .map((r, i) => rowHtml(r, state.shown + i + 1, showCover))
    .join('');

  // 空态占位那行要先踢掉，否则新行会接在「没有符合条件的房间」下面
  const empty = tbody.querySelector('.empty');
  if (empty) tbody.innerHTML = '';
  tbody.insertAdjacentHTML('beforeend', html);

  state.shown = next;
  updateListBar(rows.length, next);
}

/**
 * 是否该再追加一批。
 *
 * 触发条件不是「正好到底」，而是「距底部不足 0.6 屏」—— 提前一点加载，
 * 用户感觉不到停顿。另一个用途是兜底：筛选后行数少、内容撑不满可视区时
 * 根本不会有 scroll 事件，得由渲染流程主动补，否则永远看不到第二批。
 */
function maybeLoadMore() {
  const box = document.querySelector('.table-scroll');
  if (!box) return;

  // 先看几何位置，再碰数据：filtered() 是全量筛选 + 排序，
  // 而 scroll 事件高频触发，绝大多数时候根本不需要加载，
  // 先算它等于每次滚动都把整张表重排一遍。
  const nearBottom = () =>
    box.scrollHeight - box.scrollTop - box.clientHeight <= box.clientHeight * 0.6;
  if (!nearBottom()) return;

  const rows = filtered();
  if (state.shown >= rows.length) return;

  const before = state.shown;
  appendRows();
  if (state.shown === before) return;

  // 追加一批后仍没填满可视区（窗口很高 / 批次很小），下一帧接着补，
  // 直到内容溢出或数据用尽。用 rAF 而不是同步 while，避免被超大数据卡死。
  if (nearBottom()) requestAnimationFrame(maybeLoadMore);
}

/* ================================================================ 渲染总控 */

function renderError(msg) {
  const html = `<div class="error" style="grid-column:1/-1">${esc(msg)}</div>`;
  const stats = $('#stats');
  if (stats) stats.innerHTML = html;
  for (const sel of ['#chart-top', '#chart-dist', '#chart-trend', '#keywords']) {
    const el = $(sel);
    if (el) el.innerHTML = '';
  }
  const tbody = $('#rooms-table tbody');
  if (tbody) tbody.innerHTML = '';
}

let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderMeta();
    renderStats();
    drawTopBars();
    drawDistribution();
    renderKeywords();
    renderTable();
    drawTrend();
    renderSourceInfo();
    // 兜底补填：行数少 / 窗口很高时内容填不满可视区，就永远不会有
    // scroll 事件来触发加载。这里主动检查一次，必要时接着追加。
    maybeLoadMore();
  });
}

function renderSourceInfo() {
  const box = $('#source-info');
  if (!box) return;
  const m = state.meta;
  if (!m) {
    box.innerHTML = '';
    return;
  }

  const bits = [];

  // 顶栏那条被 CSS 藏起来时（房间明细页为了把 header 压成一行），
  // 把「观测时刻 + 距今多久」补到这里，别让数据新鲜度凭空消失。
  if (!metaSubVisible()) {
    for (const t of freshnessBits()) bits.push(`<span class="badge">${esc(t)}</span>`);
  }

  bits.push(`<span class="badge">${esc(m.source || '未知来源')}</span>`);

  // 快照才有的元信息；实时模式没这些字段，不该显示「0 页失败」这类假数据
  if (m.live) {
    if (m.observed_at) {
      // observed_at 是 unix 秒，fmtTime 收的是 ISO 字符串，直接传会被当成毫秒
      const iso = new Date(m.observed_at * 1000).toISOString();
      bits.push(`<span class="badge">观测于 ${esc(fmtTime(iso))}</span>`);
    }
  } else {
    if (m.pages_fetched != null) bits.push(`<span class="badge">翻页 ${m.pages_fetched}</span>`);
    if (m.stopped_by) bits.push(`<span class="badge">停止原因 ${esc(m.stopped_by)}</span>`);
    if (m.rooms_fetched != null && m.rooms_fetched !== m.count) {
      bits.push(`<span class="badge">抓取 ${fmt(m.rooms_fetched)} → 保留 ${fmt(m.count)}</span>`);
    }
    if (m.min_online) bits.push(`<span class="badge">人气 ≥ ${m.min_online}</span>`);

    const failed = Array.isArray(m.failed_pages) ? m.failed_pages.length : 0;
    bits.push(
      failed
        ? `<span class="badge warn">${failed} 页失败</span>`
        : `<span class="badge ok">全部页面成功</span>`
    );
  }

  box.innerHTML = bits.join(' ');
}

/* ================================================================ 导出 */

/**
 * 直播状态 → 纯文本，供 CSV 使用。
 *
 * 必须和页面上 statusCell() 的三种结论保持一致（在播 / 已下播 / 未采集），
 * 否则导出的表格和屏幕上看的口径不同，交叉核对时会以为数据错乱。
 */
function statusText(r) {
  const ls = state.liveStatus;
  if (!ls || !ls.available) return '';
  const uid = String(r.uid ?? '');
  const openAt = ls.open ? ls.open[uid] : null;
  if (openAt) {
    const age = ls.now ? Math.max(0, ls.now - openAt) : 0;
    return `在播（${fmtAgo(age)}）`;
  }
  const seen = Array.isArray(ls.seen) && ls.seen.includes(Number(r.uid));
  return seen ? '已下播' : '未采集';
}

function exportCsv() {
  const rows = filtered();
  // 直播状态紧跟在昵称后：导出后常按状态筛，放前面省得横向拉
  const header = [
    'roomid',
    'uid',
    'uname',
    'live_status',
    // 开播时间与已开播分钟数：导出后常在 Excel 里按「刚开播」排序。
    // 分钟数单独给一列数字，而不是只给「3 小时 12 分」这种字符串，
    // 否则表格软件只能按文本排序（"10 小时" 会排在 "2 小时" 前面）。
    'opened_at',
    'live_minutes',
    'online',
    'title',
    'url',
  ];
  const pick = (r, k) => {
    if (k === 'live_status') return statusText(r);
    if (k === 'opened_at') {
      const lt = Number(r.live_time) || 0;
      return lt > 0 ? fmtTime(new Date(lt * 1000).toISOString()) : '';
    }
    if (k === 'live_minutes') {
      const d = Number(r.duration);
      return Number.isFinite(d) && d >= 0 ? Math.floor(d / 60) : '';
    }
    if (k === 'url') return r.url || `https://live.bilibili.com/${r.roomid}`;
    return r[k] ?? '';
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((k) => csvCell(pick(r, k))).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = fmtTime(state.meta?.generated_at || new Date().toISOString()).replace(/[-: ]/g, '');
  a.href = url;
  a.download = `delta-live-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ================================================================ 事件 */

function bindEvents() {
  on('#refresh-btn', 'click', async () => {
    await Promise.all([loadRooms(), loadTrend(), loadLiveStatus()]);
    render();
  });

  on('#rooms-table thead', 'click', (e) => {
    const th = e.target.closest('th');
    if (!th || th.classList.contains('no-sort')) return;
    const key = th.dataset.key;
    if (!key) return;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sort.key = key;
      state.sort.dir = key === 'online' ? 'desc' : 'asc';
    }
    // 换了排序就是一组新顺序，已展开的行数作废，回到第一批从头看
    state.shown = state.batchSize;
    render();
  });

  let searchTimer;
  on('#search-input', 'input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.query = v;
      state.shown = state.batchSize;
      render();
    }, 160);
  });

  // 筛选条件变了就回到第一批 —— 不重置的话，上一轮已展开的 500 行
  // 会让新结果一次性铺满，筛选等于没生效。
  on('#live-filter', 'change', (e) => {
    state.liveFilter = e.target.value;
    state.shown = state.batchSize;
    render();
  });

  on('#min-online', 'change', (e) => {
    state.minOnline = Number(e.target.value) || 0;
    state.shown = state.batchSize;
    render();
  });

  // 开播时长筛选。选「≤30 分钟」时顺手把排序切成「刚开播的在前」，
  // 否则筛出来的仍是按人气排的，还得再点一次表头才能看到最新的。
  on('#dur-filter', 'change', (e) => {
    state.durFilter = e.target.value;
    if (state.durFilter !== 'all') {
      state.sort = { key: 'duration', dir: 'asc' };
    }
    state.shown = state.batchSize;
    render();
  });

  on('#batch-size', 'change', (e) => {
    state.batchSize = Number(e.target.value) || 100;
    state.shown = state.batchSize;
    render();
  });

  // 滚动加载：表格自己的 .table-scroll 是唯一的滚动容器（页面不滚）。
  // passive 是为了不拖慢滚动本身。
  const scrollBox = document.querySelector('.table-scroll');
  if (scrollBox) scrollBox.addEventListener('scroll', maybeLoadMore, { passive: true });

  on('#keywords', 'click', (e) => {
    const btn = e.target.closest('.tag');
    if (!btn) return;
    const w = btn.dataset.word;
    state.keyword = state.keyword === w ? '' : w;
    state.shown = state.batchSize;
    render();
  });

  on('#kw-mode', 'change', (e) => {
    state.kwMode = e.target.value;
    renderKeywords();
  });

  on('#trend-mode', 'change', (e) => {
    state.trendMode = e.target.value;
    drawTrend();
  });

  on('#btn-export', 'click', exportCsv);

  on('#btn-clear-filter', 'click', () => {
    state.keyword = '';
    state.query = '';
    state.minOnline = 0;
    state.liveFilter = 'all';
    state.durFilter = 'all';
    state.shown = state.batchSize;
    const si = $('#search-input');
    if (si) si.value = '';
    const mo = $('#min-online');
    if (mo) mo.value = '0';
    const lf = $('#live-filter');
    if (lf) lf.value = 'all';
    const df = $('#dur-filter');
    if (df) df.value = 'all';
    render();
  });

  bindCoverPreview();
  bindKwToggle();
}

/**
 * 高频词折叠开关。
 *
 * 默认折叠：这一块按内容撑高，展开时能吃掉近 20% 的屏高，
 * 而用户绝大部分时间在看表格。折叠状态存 localStorage，
 * 让「我习惯展开」的人不必每次进来都点一下。
 */
function bindKwToggle() {
  const bar = $('#kw-bar');
  const btn = $('#kw-toggle');
  if (!bar || !btn) return;

  const KEY = 'rooms.kwCollapsed';
  // 默认 true（折叠）；只有明确存过 '0' 才展开
  let collapsed = localStorage.getItem(KEY) !== '0';

  const apply = () => {
    bar.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? '展开高频词' : '收起高频词';
  };

  apply();

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(KEY, collapsed ? '1' : '0');
    } catch {
      /* 隐私模式下写不进去，不影响本次会话 */
    }
    apply();
  });
}

/* ---------------------------------------------------------------- 封面悬停放大 */

/**
 * 表格在 .table-scroll（overflow:auto）里，直接在格子内放大必被裁切，
 * 所以用一个 position:fixed 的浮层跟随鼠标，并把图换成更大的 640x360 版本。
 */
function bindCoverPreview() {
  const box = $('#cover-preview');
  const img = $('#cover-preview-img');
  if (!box || !img) return;

  const PAD = 14; // 与光标的间距

  /*
   * 已解码完成、可以立刻上屏的图。
   *
   * 直接给 <img> 换一个没加载过的 src，浏览器会先把元素清空 ——
   * 那一帧露出的就是浮层的空背景，也就是「从一张移到另一张时闪一下」。
   * 所以换图前先预加载，确认能画出来再改 src；等待期间浮层保持显示上一张。
   */
  const ready = new Set();
  // 正在等加载的目标；只有它自己回来后才有资格上屏，避免快速划过时旧请求回填
  let pending = null;

  function place(clientX, clientY) {
    // 用实测尺寸，别硬编码：盒子含 4px 内边距 + 1px 边框，实际比图片大一圈，
    // 早先按图片尺寸算高度会让浮层底部溢出视口。
    const w = box.offsetWidth || 400;
    const h = box.offsetHeight || 225;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 默认放右侧，右边放不下就翻到左侧；两边都放不下就贴左边
    let left = clientX + PAD;
    if (left + w > vw - 8) left = clientX - w - PAD;
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);

    // 垂直方向以光标为中心，再收敛到视口内
    let top = clientY - h / 2;
    top = Math.max(8, Math.min(top, vh - h - 8));

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  function show(target, clientX, clientY) {
    const full = target.dataset.full || target.src;
    if (!full) return;

    // 先把浮层摆好（位置跟着鼠标走，切换图不该有任何位移）
    box.hidden = false;
    place(clientX, clientY);

    if (img.getAttribute('src') === full) return; // 已经是这张，什么都不用做

    if (ready.has(full)) {
      // 之前加载过：从缓存换 src 是同步渲染的，不会有空白帧
      img.src = full;
      return;
    }

    // 浮层里还没有任何图（首次悬停）：先用格子里那张已解码的缩略图占位，
    // 否则会看到一块空的 400×225 背景。占位不记入 ready，稍后照样会被大图替换。
    if (!img.getAttribute('src')) {
      const thumb = target.currentSrc || target.src;
      if (thumb) img.src = thumb;
    }

    if (pending === full) return; // 已经在加载这一张，别重复发请求
    pending = full;

    const pre = new Image();
    pre.onload = () => {
      ready.add(full);
      if (pending !== full) return; // 期间用户已划到别的图，这次结果作废
      pending = null;
      img.src = full;
    };
    pre.onerror = () => {
      // 加载失败就保持原样，留着上一张也比换成破图好
      if (pending === full) pending = null;
    };
    pre.src = full;
  }

  function hide() {
    box.hidden = true;
    // 不清 img.src：下次回到同一张图能立刻显示，省一次请求
  }

  // 事件委托：表格会整块重渲染，逐行绑监听会失效
  const table = $('#rooms-table');
  if (!table) return;

  table.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.room-cover');
    if (!t || t.classList.contains('failed')) return;
    show(t, e.clientX, e.clientY);
  });

  table.addEventListener('mousemove', (e) => {
    if (box.hidden) return;
    const t = e.target.closest('.room-cover');
    if (!t) {
      hide();
      return;
    }
    place(e.clientX, e.clientY);
  });

  table.addEventListener('mouseout', (e) => {
    const t = e.target.closest('.room-cover');
    if (!t) return;

    /*
     * 从一张缩略图移到另一张时，浏览器会先发旧图的 mouseout、再发新图的 mouseover。
     * 原来这里无条件 hide()，于是每换一张都要「关掉→再打开」，
     * 画面上就是你说的闪一下。
     *
     * relatedTarget 是鼠标正要去的地方 —— 它仍然是缩略图，说明只是换了张图，
     * 浮层该继续留着，交给随后的 mouseover 直接换图；
     * 只有真的离开了所有缩略图（移到空白、别的列、页面外）才收起。
     */
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.room-cover')) return;

    hide();
  });

  // 滚动、离开窗口时收起，避免浮层滞留
  document.querySelector('.table-scroll')?.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('blur', hide);
}

/* ================================================================ 启动 */

(async () => {
  bindEvents();
  try {
    // 趋势、实时状态与房间列表并行拉，任一失败都不阻断表格渲染
    await Promise.allSettled([loadLiveStatus(), loadTrend()]);
    await loadRooms();
    render();
  } catch (err) {
    renderError(`初始化失败：${err.message}`);
  }
})();