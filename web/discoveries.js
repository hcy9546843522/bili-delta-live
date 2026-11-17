'use strict';

/*
 * 「新发现」页
 *
 * 数据来源：GET /api/discoveries
 *   不传 day → 返回按天汇总（画柱状图）
 *   传 day   → 返回那一天的主播名单（带分页）
 *
 * 设计取舍：
 *   - 柱状图自己用 flex 画，不引图表库（本项目零依赖）
 *   - 每天都是按钮，点击区域覆盖整列，比只点细柱子好点
 *   - 选中某天后自动滚到名单区，省一次手动滚动
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  rangeDays: 30,
  days: [],           // [{day, n, from_discover, from_track, from_import}]
  selectedDay: null,  // 'YYYY-MM-DD'
  page: 1,
  pageSize: 50,
  total: 0,
  rows: [],
  // 排序状态。必须交给后端排——分页也在后端，前端只有当前页那几十行，
  // 在浏览器里排只会把本页重排，看起来像「点了没反应」。
  sort: { key: 'first_seen_at', dir: 'desc' },
};

/*
 * 明细表列定义。
 *
 * key 同时是后端 SORT_COLUMNS 的白名单键，所以这里加列必须同步 db.js。
 * sortFn 不在这里做——排序统一走后端，见 loadDetail()。
 *
 * cls 是「表头与数据格共用的对齐类」：数据格用了 td.num（右对齐），
 * 表头就必须带同一个类，否则表头贴左、数字贴右，看起来像错位了一列。
 */
const COLUMNS = [
  { key: '', label: '#', sortable: false, cls: 'num' },
  { key: 'uname', label: '主播', sortable: true },
  { key: 'uid', label: 'UID', sortable: true },
  { key: 'status', label: '直播状态', sortable: true },
  { key: 'first_seen_at', label: '发现时间', sortable: true, cls: 'num' },
  { key: 'first_mode', label: '来源', sortable: true },
  { key: 'session_count', label: '场次', sortable: true, cls: 'num' },
  { key: 'first_title', label: '首个标题', sortable: true },
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

/**
 * 走本地图片代理：绕开 Chromium 的 ORB 拦截，并让图床直接返回缩略图。
 * app.js 与 attendance.js 的头像都是这么走的，这里之前漏了直接引外链，
 * 表现为本页头像比别的页面更容易裂图（尤其 Edge/Chrome 严格模式下）。
 */
function imgProxy(url, size) {
  return url ? `/img?u=${encodeURIComponent(url)}${size ? `&s=${size}` : ''}` : '';
}

const pad = (n) => String(n).padStart(2, '0');

/** 东八区：时间戳 → "11-15 17:19" */
function fmtShort(epochSec) {
  if (!epochSec) return '—';
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 东八区：时间戳 → "17:19" */
function fmtClock(epochSec) {
  if (!epochSec) return '—';
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 'YYYY-MM-DD' → "11-15 周六" */
function fmtDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getUTCDay()];
  return `${pad(m)}-${pad(d)} ${wd}`;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

/** 来源 → 徽章 */
function modeBadge(mode) {
  if (mode === 'discover') return '<span class="badge info">discover</span>';
  if (mode === 'track') return '<span class="badge mute">track</span>';
  if (mode === 'manual') return '<span class="badge warn">manual</span>';
  return '<span class="badge mute">import</span>';
}

/** 「多久以前」的人话描述，用于说明直播状态有多新 */
function fmtAgo(sec) {
  if (sec == null) return '';
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/**
 * 直播状态 → 徽章。
 *
 * 状态来自最近一次 track，不是此刻的实时值：冰层主播可能几天没被查过，
 * 所以必须把「多久前观测的」一并显示，否则会让人误以为这是实时状态。
 */
function statusBadge(r) {
  if (r.is_live) {
    const ago = fmtAgo(r.status_age);
    return `<span class="badge live">在播</span>${ago ? `<span class="u-dim" style="margin-left:6px">${escapeHtml(ago)}</span>` : ''}`;
  }
  if (r.status_age == null) return '<span class="badge mute">未采集</span>';
  const ago = fmtAgo(r.status_age);
  return `<span class="badge mute">未在播</span>${ago ? `<span class="u-dim" style="margin-left:6px">${escapeHtml(ago)}</span>` : ''}`;
}

/* ---------------------------------------------------------------- 概览 */

function renderOverview(container) {
  const daysWithData = state.days.filter((d) => d.n > 0);
  const totalNew = state.days.reduce((s, d) => s + d.n, 0);
  const realNew = state.days.reduce((s, d) => s + (d.n - (d.from_import || 0)), 0);
  const fromDiscover = state.days.reduce((s, d) => s + (d.from_discover || 0), 0);
  const fromTrack = state.days.reduce((s, d) => s + (d.from_track || 0), 0);
  const fromImport = state.days.reduce((s, d) => s + (d.from_import || 0), 0);

  const best = daysWithData.slice().sort((a, b) => b.n - a.n)[0];

  const cards = [
    { k: `近 ${state.rangeDays} 天新增`, v: fmtNum(realNew), sub: '不含历史导入' },
    { k: 'discover 发现', v: fmtNum(fromDiscover), sub: '扫专区榜' },
    { k: 'track 顺带发现', v: fmtNum(fromTrack), sub: '刷熟人时遇到' },
    { k: '历史导入', v: fmtNum(fromImport), sub: '首次建池，不算发现' },
    {
      k: '最高单日',
      v: best ? fmtNum(best.n) : '0',
      sub: best ? best.day.slice(5) : '—',
    },
    { k: '有新增的天数', v: fmtNum(daysWithData.length), sub: `共 ${state.days.length} 天` },
  ];

  container.innerHTML = cards
    .map(
      (c) => `
      <div class="stat">
        <div class="k">${escapeHtml(c.k)}</div>
        <div class="v">${c.v}<small> ${escapeHtml(c.sub)}</small></div>
      </div>`
    )
    .join('');
}

/* -------------------------------------------------------------- 柱状图 */

function renderChart() {
  const box = $('#day-chart');
  const hint = $('#chart-hint');

  if (!state.days.length) {
    box.className = 'day-chart-empty';
    box.textContent = '还没有数据';
    hint.textContent = '';
    return;
  }

  box.className = 'day-chart';

  // 按日期正序（旧 → 新），左边过去右边现在，符合直觉
  const days = state.days.slice().sort((a, b) => (a.day < b.day ? -1 : 1));
  const max = Math.max(1, ...days.map((d) => d.n));

  // 日期太多时只让每隔 step 根显示日期标签，否则文字会叠在一起
  const step = Math.ceil(days.length / 15);

  box.innerHTML = days
    .map((d, i) => {
      const h = d.n > 0 ? Math.max(3, Math.round((d.n / max) * 100)) : 0;
      const sel = d.day === state.selectedDay ? ' selected' : '';
      const zero = d.n === 0 ? ' zero' : '';
      const show = i % step === 0 || i === days.length - 1 ? ' show' : '';
      const title = `${fmtDayLabel(d.day)}\n新增 ${d.n} 人（discover ${d.from_discover} · track ${d.from_track}${
        d.from_import ? ` · 导入 ${d.from_import}` : ''
      }）`;
      return `
        <button class="day-col${sel}${zero}" data-day="${d.day}" title="${escapeHtml(title)}">
          <span class="day-num">${d.n || ''}</span>
          <span class="day-bar" style="height:${h}%"></span>
          <span class="day-label${show}">${d.day.slice(5)}</span>
        </button>`;
    })
    .join('');

  const spanDays = days.length;
  const first = days[0].day.slice(5);
  const last = days[days.length - 1].day.slice(5);
  hint.textContent = `${first} ~ ${last}（${spanDays} 天，峰值 ${max}）`;

  // 事件委托，避免为几百根柱子逐个绑监听
  box.onclick = (e) => {
    const btn = e.target.closest('.day-col');
    if (!btn) return;
    selectDay(btn.dataset.day);
  };
}

/* -------------------------------------------------------------- 明细表 */

/**
 * 渲染表头。
 *
 * 所有列都做成可点的排序按钮（用户要求「给所有标题添加按钮」）。
 * 注意 sortable 列走的是后端全量排序，理由见 state.sort 的注释。
 */
function renderHead() {
  const thead = $('#detail-table thead');
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
      return `<th class="${cls}" data-key="${c.key}" title="${escapeHtml(tip)}">${escapeHtml(c.label)}${arrow}</th>`;
    }).join('') +
    '</tr>';
}

function renderDetail() {
  const tbody = $('#detail-table tbody');
  const title = $('#detail-title');
  const hint = $('#detail-hint');
  const pager = $('#pager');

  renderHead();

  if (!state.selectedDay) {
    title.textContent = '当天新发现的主播';
    hint.textContent = '选一天查看明细';
    tbody.innerHTML =
      '<tr><td colspan="8" class="u-dim" style="text-align:center;padding:28px">点上方柱状图选一天</td></tr>';
    pager.innerHTML = '';
    return;
  }

  title.textContent = `${fmtDayLabel(state.selectedDay)} 新发现的主播`;
  hint.textContent = `共 ${fmtNum(state.total)} 人`;

  if (!state.rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="u-dim" style="text-align:center;padding:28px">这一天没有新发现的主播</td></tr>';
  } else {
    const start = (state.page - 1) * state.pageSize;
    tbody.innerHTML = state.rows
      .map((r, i) => {
        const face = r.face
          ? `<img src="${escapeHtml(imgProxy(r.face, '48x48'))}" alt="" loading="lazy" onerror="this.classList.add('broken')" />`
          : '<span class="ph"></span>';
        const nameLink = r.roomid
          ? `<a href="https://live.bilibili.com/${encodeURIComponent(r.roomid)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.uname || '(无昵称)')}</a>`
          : `<a href="https://search.bilibili.com/all?keyword=${encodeURIComponent(r.uname || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.uname || '(无昵称)')}</a>`;
        return `
        <tr>
          <td class="num">${start + i + 1}</td>
          <td>
            <div class="who">
              ${face}
              <span class="name">${nameLink}</span>
            </div>
          </td>
          <td class="uid-cell">${escapeHtml(r.uid)}</td>
          <td class="status-cell">${statusBadge(r)}</td>
          <td class="num">${fmtShort(r.first_seen_at)}</td>
          <td>${modeBadge(r.first_mode)}</td>
          <td class="num">${r.session_count || 0}</td>
          <td class="title-cell" title="${escapeHtml(r.first_title || '')}">${escapeHtml(r.first_title || '—')}</td>
        </tr>`;
      })
      .join('');
  }

  // 分页
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  pager.innerHTML = `
    <span class="info">第 ${state.page} / ${pages} 页 · 共 ${fmtNum(state.total)} 条</span>
    <button class="ghost" id="prev-page" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="ghost" id="next-page" ${state.page >= pages ? 'disabled' : ''}>下一页</button>`;

  const prev = $('#prev-page');
  const next = $('#next-page');
  if (prev) prev.onclick = () => { state.page -= 1; loadDetail(); };
  if (next) next.onclick = () => { state.page += 1; loadDetail(); };
}

/* ---------------------------------------------------------------- 数据 */

async function loadDays() {
  const j = await getJson(`/api/discoveries?days=${state.rangeDays}`);

  if (!j.available) {
    const box = $('#unavailable');
    box.style.display = '';
    box.innerHTML =
      '<div class="error">数据库还没准备好。先跑一次 <code>node collect-track.js --import data/latest.json</code> 建池。</div>';
    $('#overview').innerHTML = '';
    $('#day-chart').className = 'day-chart-empty';
    $('#day-chart').textContent = '无数据';
    return false;
  }

  state.days = j.days || [];
  return true;
}

async function loadDetail() {
  if (!state.selectedDay) return;
  // 后端契约是 limit/offset（不是 page/pageSize）——传错了会被夹成默认 200 条，
  // 表现为「每页选 25 却显示 200 行」。这里按契约拼。
  // sort/dir 也交给后端：分页在后端，排序必须一起在后端做才能排全量。
  const offset = (state.page - 1) * state.pageSize;
  const j = await getJson(
    `/api/discoveries?day=${encodeURIComponent(state.selectedDay)}` +
      `&limit=${state.pageSize}&offset=${offset}` +
      `&sort=${encodeURIComponent(state.sort.key)}&dir=${state.sort.dir}`
  );
  state.rows = j.rows || [];
  state.total = j.total || 0;
  renderDetail();
}

function selectDay(day) {
  state.selectedDay = day;
  state.page = 1;
  renderChart();       // 重画以更新选中高亮
  loadDetail();
}

/* ---------------------------------------------------------------- 导出 */

function exportCsv() {
  if (!state.selectedDay || !state.total) return;

  // 导出全天，而不只是当前页：分页拉全（后端单次上限 1000，所以循环拉）
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  let total = Infinity;

  (async () => {
    // 排序参数必须带上，否则导出顺序和页面上看到的对不上：
    // 后端默认按 first_seen_at desc 排，用户切到「场次」排序后再导出，
    // 拿到的却是另一套顺序。分页拉全时尤其要一致，否则跨页拼接会乱。
    const sortQ = `&sort=${encodeURIComponent(state.sort.key)}&dir=${state.sort.dir}`;

    // 先取一页拿到 total，再顺序拉完剩余
    while (offset < total) {
      const j = await getJson(
        `/api/discoveries?day=${encodeURIComponent(state.selectedDay)}&limit=${pageSize}&offset=${offset}${sortQ}`
      );
      total = j.total || 0;
      const rows = j.rows || [];
      if (!rows.length) break;
      all.push(...rows);
      offset += pageSize;
    }

    const head = ['UID', '昵称', '房间号', '直播状态', '状态观测时间', '发现时间', '来源', '场次', '首个标题'];
    const lines = [head.join(',')];
    for (const r of all) {
      const cells = [
        r.uid,
        r.uname || '',
        r.roomid || '',
        r.is_live ? '在播' : r.status_age == null ? '未采集' : '未在播',
        r.last_observed_at ? fmtShort(r.last_observed_at) : '',
        fmtShort(r.first_seen_at),
        r.first_mode || '',
        r.session_count || 0,
        r.first_title || '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    }
    // 加 BOM，Excel 打开中文才不乱码
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `新发现_${state.selectedDay}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ---------------------------------------------------------------- 启动 */

async function reload() {
  const ok = await loadDays();
  if (!ok) return;

  // 默认选中最近一个「有新增」的日子；全都没有就选最新一天
  const withData = state.days.filter((d) => d.n > 0);
  const target = withData.length ? withData[0].day : state.days.length ? state.days[0].day : null;

  if (!state.selectedDay || !state.days.some((d) => d.day === state.selectedDay)) {
    state.selectedDay = target;
    state.page = 1;
  }

  renderOverview($('#overview'));
  renderChart();

  const sub = $('#summary-sub');
  const realNew = state.days.reduce((s, d) => s + (d.n - (d.from_import || 0)), 0);
  sub.textContent = `近 ${state.rangeDays} 天新增 ${fmtNum(realNew)} 人`;

  if (state.selectedDay) await loadDetail();
  else renderDetail();
}

function bindEvents() {
  $('#range-select').onchange = (e) => {
    state.rangeDays = Number(e.target.value);
    state.selectedDay = null;
    reload();
  };

  // 点表头排序：始终走后端，并回到第 1 页
  // （不重置页码的话，第 5 页在换了排序后可能已越界，会看到空白）
  $('#detail-table thead').onclick = (e) => {
    const th = e.target.closest('th');
    if (!th || !th.dataset.key) return;
    const key = th.dataset.key;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sort.key = key;
      // 时间/场次类默认降序（先看最大/最新），文本类默认升序
      state.sort.dir = key === 'first_seen_at' || key === 'session_count' ? 'desc' : 'asc';
    }
    state.page = 1;
    loadDetail();
  };

  $('#page-size').onchange = (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    loadDetail();
  };

  $('#refresh-btn').onclick = () => {
    const btn = $('#refresh-btn');
    btn.disabled = true;
    reload().finally(() => {
      btn.disabled = false;
    });
  };

  $('#export-btn').onclick = exportCsv;
}

(async () => {
  bindEvents();
  try {
    await reload();
  } catch (err) {
    const box = $('#unavailable');
    box.style.display = '';
    box.innerHTML = `<div class="error">加载失败：${escapeHtml(err.message)}</div>`;
  }
})();