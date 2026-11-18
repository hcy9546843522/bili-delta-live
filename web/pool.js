'use strict';

/*
 * 「主播池」页
 *
 * 数据来源：GET /api/pool
 *   所有筛选 / 排序 / 分页都下推给后端 —— 和「新发现」页同一个理由：
 *   前端只有当前页那几十行，在浏览器里排序只会把本页重排，看起来像「点了没反应」。
 *
 * 这一页想回答三个问题：
 *   1. 池子现在多大、结构怎样（各层多少人）—— 顶部卡片 + 分层条
 *   2. 哪些人其实已经很久没播了（冰层）—— 占比一眼可见
 *   3. 具体某个人在不在池子里、什么时候进来的、播了多少 —— 表格 + 搜索
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  page: 1,
  pageSize: 100,
  tier: '',
  mode: '',
  q: '',
  sort: { key: 'last_active', dir: 'desc' },
  total: 0,      // 池子总人数（不受筛选影响）
  filtered: 0,   // 当前筛选下的人数
  liveNow: 0,
  historyDays: 0, // 库内最早一场直播至今多少天，用于解释「分层堆在一层」
  tiers: { hot: 0, warm: 0, cold: 0, ice: 0 },
  tierMeta: [],
  modes: { discover: 0, track: 0, manual: 0, import: 0 },
  rows: [],
  loading: false,
};

/** 列定义。key 必须同时是后端 SORT 白名单里的键，加列要同步 db.js 的 poolList */
const COLUMNS = [
  // cls 是表头与数据格共用的对齐类，详见 renderHead()
  { key: '', label: '#', sortable: false, cls: 'num' },
  { key: 'uname', label: '主播', sortable: true },
  { key: 'tier', label: '分层', sortable: true },
  { key: 'last_active', label: '上次活跃', sortable: true },
  { key: 'session_count', label: '场次', sortable: true, cls: 'num' },
  { key: 'total_seconds', label: '累计时长', sortable: true, cls: 'num' },
  { key: 'peak_online', label: '峰值人气', sortable: true, cls: 'num' },
  { key: 'first_seen_at', label: '入库时间', sortable: true },
];

/* ---------------------------------------------------------------- 工具 */

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

/** 走本地图片代理，与 app.js / attendance.js / discoveries.js 一致 */
const imgProxy = (url, size) =>
  url ? `/img?u=${encodeURIComponent(url)}${size ? `&s=${size}` : ''}` : '';

const pad = (n) => String(n).padStart(2, '0');

/** 东八区：时间戳 → "11-15 17:19" */
function fmtShort(epochSec) {
  if (!epochSec) return '—';
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}`;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function pct(n, total) {
  if (!total) return 0;
  return (n / total) * 100;
}

/** 秒 → "3 时 20 分" / "25 分" */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 时`;
  if (h > 0) return `${h} 时 ${m} 分`;
  return `${m} 分`;
}

/**
 * 「多久没播了」的人话。
 *
 * 这里刻意不用 fmtAgo(秒) 那套，因为冰层动辄几百天，
 * 「412 天前」比「1 年前」更能说明问题 —— 用户是在判断要不要清理。
 */
function fmtIdle(days) {
  if (days == null) return '<span class="u-dim">从未开播</span>';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时前`;
  if (days < 30) return `${Math.round(days)} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

/** 来源 → 徽章 */
function modeBadge(mode) {
  if (mode === 'discover') return '<span class="badge info">discover</span>';
  if (mode === 'track') return '<span class="badge mute">track</span>';
  if (mode === 'manual') return '<span class="badge warn">manual</span>';
  return '<span class="badge mute">import</span>';
}

/** 分层 → 徽章。颜色与分层条保持一致，方便对照 */
function tierBadge(tier, label) {
  return `<span class="badge tier-${escapeHtml(tier)}">${escapeHtml(label || tier)}</span>`;
}

/* -------------------------------------------------------------- 渲染 */

function renderOverview() {
  // 用「有场次的人」做分母讲活跃度：池子里总有一批从没被观测到开播的人，
  // 把他们算进「出勤率」会让比例永远很难看，而那不是用户关心的。
  const cards = [
    { k: '池内主播', v: fmtNum(state.total), s: '在册 UID 数' },
    { k: '此刻在播', v: fmtNum(state.liveNow), s: '上次观测仍在播' },
    {
      k: '近 7 天活跃',
      v: fmtNum(state.tiers.hot),
      s: `占全池 ${pct(state.tiers.hot, state.total).toFixed(0)}%`,
    },
    {
      k: '90 天以上没播',
      v: fmtNum(state.tiers.ice),
      s: `占全池 ${pct(state.tiers.ice, state.total).toFixed(0)}%`,
      warn: pct(state.tiers.ice, state.total) > 50,
    },
    { k: '各层合计', v: fmtNum(state.tiers.hot + state.tiers.warm + state.tiers.cold + state.tiers.ice), s: '应与池内主播相等' },
  ];

  $('#overview').innerHTML = cards
    .map(
      (c) => `
      <div class="stat${c.warn ? ' warn' : ''}">
        <span class="k">${escapeHtml(c.k)}</span>
        <span class="v">${escapeHtml(c.v)}</span>
        <span class="s">${escapeHtml(c.s)}</span>
      </div>`
    )
    .join('');
}

function renderTiers() {
  const list = state.tierMeta;
  const total = state.total || 1;

  // 分层卡：点一下就筛选到那一层，再点一下取消 —— 比下拉框少一步
  $('#tier-grid').innerHTML = list
    .map((t) => {
      const active = state.tier === t.id ? ' active' : '';
      const range =
        t.id === 'hot' ? '7 天内' : t.id === 'ice' ? '90 天以上' : t.max_days ? `≤ ${t.max_days} 天` : '—';
      /*
       * 分摊层（冰层）必须把「周期」和「节律」一起说清楚。
       *
       * 只写「每 7 天查一次」会让看板的人以为调度坏了 —— 实际是每 7 小时
       * 查 1/24 的人，7 天正好轮完全员。这两个说法差 24 倍，不写清楚就会被
       * 当成配置错误。
       *
       * 文案要短：四张卡在同一行等高，某一层写得比别的长两行，
       * 网格就会参差不齐。
       */
      const every = t.every_hours >= 168 ? `每 ${t.every_hours / 24} 天` : `每 ${t.every_hours} 小时`;
      const hours = t.slots > 1 ? `${every}一轮 · 每 ${t.slot_hours}h 查 1/${t.slots}` : every;
      return `
      <button type="button" class="tier-card tier-${escapeHtml(t.id)}${active}" data-tier="${escapeHtml(t.id)}"
              title="点击只看这一层，再点取消">
        <span class="tier-name">${escapeHtml(t.label)}</span>
        <span class="tier-n">${fmtNum(t.n)}</span>
        <span class="tier-pct">${pct(t.n, total).toFixed(1)}% · ${escapeHtml(range)}</span>
        <span class="tier-every">${escapeHtml(hours)}查一次</span>
      </button>`;
    })
    .join('');

  // 一根按比例切分的横条，让「冰层有多大」不用看数字也能感受到
  $('#tier-bar').innerHTML = list
    .filter((t) => t.n > 0)
    .map(
      (t) =>
        `<span class="seg tier-${escapeHtml(t.id)}" style="width:${pct(t.n, total).toFixed(3)}%"
               title="${escapeHtml(t.label)} ${fmtNum(t.n)} 人（${pct(t.n, total).toFixed(1)}%）"></span>`
    )
    .join('');

  $('#tier-hint').textContent =
    `共 ${fmtNum(state.total)} 人 · ${list.length} 层` +
    (state.historyDays ? ` · 库内历史 ${state.historyDays.toFixed(1)} 天` : '');

  /*
   * 「全压在一层」不是分档算错了，而是历史还不够长。
   *
   * 边界是 7 / 30 / 90 天：库里只有 5 天数据时，任何人都必然落在热层，
   * 分层条就会显示成一根满格的红条。不解释的话，这看起来完全像一个 bug，
   * 用户会以为分层功能没生效。所以只要最深的两层是空的、且历史明显不够，
   * 就直接把原因写出来。
   */
  const warn = $('#history-warn');
  if (warn) {
    const needed = 90; // 冷层/冰层分界
    if (state.total > 0 && !state.tiers.cold && !state.tiers.ice && state.historyDays < needed) {
      warn.innerHTML = `<p class="note warn">
        下面四层现在几乎全落在<strong>热层</strong>，不是分层失效：
        分层按「距上次出现多少天」切档（7 / 30 / 90 天），
        而库里最早的一场直播距今只有 <strong>${state.historyDays.toFixed(1)} 天</strong>，
        还没长到能落进冷层和冰层。随着采集天数的累积，这个图会自己长出第二、三、四段。
      </p>`;
    } else {
      warn.innerHTML = '';
    }
  }
}

function renderHead() {
  const thead = $('#pool-table thead');
  if (!thead) return;

  const { key: curKey, dir } = state.sort;
  thead.innerHTML =
    '<tr>' +
    COLUMNS.map((c) => {
      // 列自带的对齐类必须跟着表头一起输出：数据格是 td.num（右对齐），
      // 表头若不带同一个类就留在左边，看起来像错位了一列。
      const align = c.cls ? ` ${c.cls}` : '';
      if (!c.sortable) return `<th class="no-sort${align}">${escapeHtml(c.label)}</th>`;
      const active = curKey === c.key;
      const arrow = active ? `<span class="arrow">${dir === 'desc' ? '▼' : '▲'}</span>` : '';
      const cls = (active ? 'sortable active' : 'sortable') + align;
      const tip = active
        ? `当前按「${c.label}」${dir === 'desc' ? '降序' : '升序'}，点击切换`
        : `按「${c.label}」排序`;
      return `<th class="${cls}" data-key="${c.key}" title="${escapeHtml(tip)}">${escapeHtml(
        c.label
      )}${arrow}</th>`;
    }).join('') +
    '</tr>';
}

function renderRows() {
  const tbody = $('#pool-table tbody');
  renderHead();

  const label = [];
  if (state.tier) label.push(state.tierMeta.find((t) => t.id === state.tier)?.label || state.tier);
  if (state.mode) label.push(state.mode);
  if (state.q) label.push(`搜索「${state.q}」`);
  $('#list-hint').textContent = label.length ? label.join(' · ') : '全部';
  $('#list-title').textContent = '池内主播';

  if (!state.rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="u-dim" style="text-align:center;padding:28px">没有符合条件的成员</td></tr>';
    renderPager();
    return;
  }

  const start = (state.page - 1) * state.pageSize;
  tbody.innerHTML = state.rows
    .map((r, i) => {
      const face = r.face
        ? `<img src="${escapeHtml(imgProxy(r.face, '48x48'))}" alt="" loading="lazy" onerror="this.classList.add('broken')" />`
        : '<span class="ph"></span>';
      const name = r.uname || '(无昵称)';
      const nameLink = r.roomid
        ? `<a href="https://live.bilibili.com/${encodeURIComponent(r.roomid)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`
        : `<a href="https://search.bilibili.com/all?keyword=${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`;

      // 出勤页是本项目的「看这个人」入口，UID 直接跳过去比让人复制强
      const uidCell = `<a class="u-mono" href="/attendance.html?uid=${encodeURIComponent(r.uid)}"
          title="在主播出勤页查看这个人的日历">${escapeHtml(String(r.uid))}</a>`;

      const live = r.is_live ? '<span class="badge live">在播</span> ' : '';

      return `
      <tr>
        <td class="num">${start + i + 1}</td>
        <td>
          <div class="who">
            ${face}
            <span class="name">${live}${nameLink}</span>
          </div>
          <!-- UID 单独占一行：它是出勤页的入口，塞进昵称里会让链接互相嵌套 -->
          <div class="uid-line">${uidCell}</div>
        </td>
        <td>${tierBadge(r.tier, r.tier_label)}</td>
        <td class="nowrap" title="${escapeHtml(r.last_active ? fmtShort(r.last_active) : '库里没有他的场次')}">
          ${fmtIdle(r.idle_days)}
        </td>
        <td class="num">${r.session_count || 0}</td>
        <td class="num">${fmtDuration(r.total_seconds)}</td>
        <td class="num">${r.peak_online ? fmtNum(r.peak_online) : '—'}</td>
        <td class="nowrap">
          ${fmtShort(r.first_seen_at)}
          <div class="sub-mode">${modeBadge(r.first_mode)}</div>
        </td>
      </tr>`;
    })
    .join('');

  renderPager();
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.filtered / state.pageSize));
  const pager = $('#pager');
  pager.innerHTML = `
    <span class="info">第 ${state.page} / ${pages} 页 · 共 ${fmtNum(state.filtered)} 条${
      state.filtered !== state.total ? `（全池 ${fmtNum(state.total)}）` : ''
    }</span>
    <button class="ghost" id="first-page" ${state.page <= 1 ? 'disabled' : ''}>« 首页</button>
    <button class="ghost" id="prev-page" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="ghost" id="next-page" ${state.page >= pages ? 'disabled' : ''}>下一页</button>
    <button class="ghost" id="last-page" ${state.page >= pages ? 'disabled' : ''}>末页 »</button>`;

  const first = $('#first-page');
  const prev = $('#prev-page');
  const next = $('#next-page');
  const last = $('#last-page');
  if (first) first.onclick = () => { state.page = 1; load(); };
  if (prev) prev.onclick = () => { state.page -= 1; load(); };
  if (next) next.onclick = () => { state.page += 1; load(); };
  if (last) last.onclick = () => { state.page = pages; load(); };
}

function renderAll() {
  renderOverview();
  renderTiers();
  renderRows();
  $('#summary-sub').textContent = `${fmtNum(state.total)} 主播 · 在播 ${fmtNum(state.liveNow)}`;
}

/* ---------------------------------------------------------------- 数据 */

function buildQuery({ withPaging = true } = {}) {
  const p = new URLSearchParams();
  p.set('sort', state.sort.key);
  p.set('dir', state.sort.dir);
  if (state.tier) p.set('tier', state.tier);
  if (state.mode) p.set('mode', state.mode);
  if (state.q) p.set('q', state.q);
  if (withPaging) {
    p.set('limit', String(state.pageSize));
    p.set('offset', String((state.page - 1) * state.pageSize));
  }
  return p.toString();
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  $('#refresh-btn').disabled = true;

  try {
    const j = await getJson(`/api/pool?${buildQuery()}`);

    if (!j.available) {
      const box = $('#unavailable');
      box.style.display = '';
      box.innerHTML = `<div class="error">无法读取主播池：${escapeHtml(
        j.error || '未知原因'
      )}。先跑一次 <code>node collect-track.js</code> 建库。</div>`;
      $('#overview').innerHTML = '';
      $('#tier-grid').innerHTML = '';
      $('#summary-sub').textContent = '不可用';
      return;
    }

    state.rows = j.rows || [];
    state.total = j.total || 0;
    state.filtered = j.filtered || 0;
    state.liveNow = j.live_now || 0;
    state.historyDays = j.history_days || 0;
    state.tiers = j.tiers || state.tiers;
    state.tierMeta = j.tier_meta || [];
    state.modes = j.modes || state.modes;

    // 筛选后当前页可能越界（比如从第 30 页切到只筛热层），
    // 纠正到最后一页再重拉一次，否则会显示空白页但页码还在
    const pages = Math.max(1, Math.ceil(state.filtered / state.pageSize));
    if (state.page > pages) {
      state.page = pages;
      state.loading = false;
      $('#refresh-btn').disabled = false;
      return load();
    }

    renderAll();
  } catch (err) {
    $('#summary-sub').textContent = '加载失败';
    const box = $('#unavailable');
    box.style.display = '';
    box.innerHTML = `<div class="error">请求失败：${escapeHtml(err.message)}</div>`;
  } finally {
    state.loading = false;
    $('#refresh-btn').disabled = false;
  }
}

/* ---------------------------------------------------------------- 导出 */

/**
 * 导出当前筛选结果（全部页，不只当前页）。
 *
 * 走和 load() 完全相同的筛选与排序参数，否则导出的顺序会和屏幕上的对不上 ——
 * 跨页拼接时尤其明显。
 */
async function exportCsv() {
  const btn = $('#export-btn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';

  try {
    const pageSize = 500; // 后端上限
    const all = [];
    for (let offset = 0; ; offset += pageSize) {
      const p = new URLSearchParams(buildQuery({ withPaging: false }));
      p.set('limit', String(pageSize));
      p.set('offset', String(offset));
      const j = await getJson(`/api/pool?${p.toString()}`);
      const rows = j.rows || [];
      all.push(...rows);
      // 一次没拿满就说明到底了；也防住 filtered 与实际不符时死循环
      if (rows.length < pageSize || all.length >= (j.filtered || 0)) break;
      if (all.length > 200000) break;
    }

    if (!all.length) {
      btn.textContent = '没有可导出的数据';
      setTimeout(() => { btn.textContent = old; }, 1500);
      return;
    }

    const head = ['排名', 'UID', '昵称', '房间号', '分层', '上次活跃', '场次', '累计时长(小时)', '峰值人气', '入库时间', '来源'];
    const lines = [head.join(',')];
    all.forEach((r, i) => {
      const idle = r.last_active ? fmtShort(r.last_active) : '';
      lines.push(
        [
          i + 1,
          r.uid,
          r.uname || '',
          r.roomid || '',
          r.tier_label || r.tier,
          idle,
          r.session_count || 0,
          (Number(r.total_seconds) / 3600).toFixed(1),
          r.peak_online || 0,
          fmtShort(r.first_seen_at),
          r.first_mode || '',
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      );
    });

    // BOM 让 Excel 正确识别 UTF-8，否则中文列名乱码
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `主播池_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    btn.textContent = '导出失败';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = old; }, 800);
  }
}

/* ---------------------------------------------------------------- 事件 */

/** 搜索防抖：每敲一个字就查一次会把后端打满，也没必要 */
let qTimer = null;
function onSearchInput(e) {
  const v = e.target.value.trim();
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    if (v === state.q) return;
    state.q = v;
    state.page = 1;
    load();
  }, 280);
}

function bind() {
  $('#refresh-btn').onclick = load;
  $('#export-btn').onclick = exportCsv;
  $('#q-input').addEventListener('input', onSearchInput);

  $('#tier-select').onchange = (e) => {
    state.tier = e.target.value;
    state.page = 1;
    load();
  };
  $('#mode-select').onchange = (e) => {
    state.mode = e.target.value;
    state.page = 1;
    load();
  };
  $('#page-size').onchange = (e) => {
    state.pageSize = Number(e.target.value) || 100;
    state.page = 1;
    load();
  };

  // 点分层卡片 = 快捷筛选，与下拉框双向同步
  $('#tier-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.tier-card');
    if (!card) return;
    const next = card.dataset.tier;
    state.tier = state.tier === next ? '' : next;
    $('#tier-select').value = state.tier;
    state.page = 1;
    load();
  });

  // 表头排序：点同一列切方向，换列则默认降序
  $('#pool-table').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.key;
    if (!key) return;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sort.key = key;
      state.sort.dir = 'desc';
    }
    state.page = 1;
    load();
  });
}

function boot() {
  bind();
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}