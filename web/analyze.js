'use strict';

/**
 * 数据分析页
 *
 * 数据全部来自一个接口 /api/analyze —— 六个图表取自同一份快照，
 * 不会出现「人气图是 12:00 的、时长图是 12:05 的」这种错位。
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  topN: 20,
  loading: false,
};

/* ---------------------------------------------------------------- 工具 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN') : '0');

/** 大数字缩写：人气动辄六位数，表格里全写会挤爆 */
function fmtShort(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + ' 万';
  return fmtNum(v);
}

/** 走本地图片代理，与 app.js / attendance.js 一致 */
const imgProxy = (url, size) =>
  url ? `/img?u=${encodeURIComponent(url)}${size ? `&s=${size}` : ''}` : '';

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 时 ${m} 分`;
  return `${m} 分`;
}

function fmtDateTime(epochSec) {
  if (!epochSec) return '—';
  return new Date(epochSec * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ---------------------------------------------------------------- 图表 */

/**
 * 通用条形图。
 *
 * 不用 SVG/canvas 而用 div 高度百分比：这些图都是「一维计数」，
 * DOM 够用且天然响应式，悬停提示交给 title 属性，零依赖零布局代码。
 *
 * opts.showIndex —— 是否在柱下画序号（时段图要显示 0~23 时）
 */
function renderBars(box, items, opts = {}) {
  /*
   * 取件函数不能叫 valueOf：那会命中 Object.prototype.valueOf，
   * 解构默认值只在属性严格等于 undefined 时才生效，而 opts.valueOf 从原型继承了
   * 一个函数，于是默认值被跳过、实际调用的是 Object.prototype.valueOf(undefined)，
   * 报 "Cannot convert undefined or null to object"。换成 value，无原型冲突。
   */
  const { labelOf = (d) => d.label, value = (d) => d.n, unit = '' } = opts;

  if (!items.length) {
    box.className = 'bar-chart-empty';
    box.textContent = '暂无数据';
    return;
  }

  const max = Math.max(1, ...items.map(value));
  box.className = 'bar-chart' + (opts.extraClass ? ' ' + opts.extraClass : '');

  box.innerHTML = items
    .map((d) => {
      const v = value(d);
      const h = v > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
      const zero = v === 0 ? ' zero' : '';
      const title = `${labelOf(d)}：${fmtNum(v)}${unit}`;
      return `
        <div class="bar-col${zero}" title="${esc(title)}">
          <span class="bar-num">${v > 0 ? fmtShort(v) : ''}</span>
          <span class="bar-fill" style="height:${h}%"></span>
          <span class="bar-label">${esc(labelOf(d))}</span>
        </div>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- 渲染 */

function renderOverview(data) {
  const t = data.totals;
  const box = $('#overview');

  // 采集次数是最重要的元信息：样本不足时所有结论都不成立，
  // 所以把它做成第一张卡片，而不是藏在角落里。
  const cards = [
    { k: '主播池', v: fmtNum(t.streamers), s: '在册 UID 数' },
    { k: '场次总数', v: fmtNum(t.sessions), s: `${fmtNum(t.open_sessions)} 场仍在进行` },
    { k: '已收尾场次', v: fmtNum(t.closed_sessions), s: '有时长数据' },
    {
      k: '采集次数',
      v: fmtNum(t.runs),
      s: t.runs < 24 ? '样本偏少，结论仅供参考' : '样本充足',
      warn: t.runs < 24,
    },
  ];

  box.innerHTML = cards
    .map(
      (c) => `
      <div class="stat${c.warn ? ' warn' : ''}">
        <span class="k">${esc(c.k)}</span>
        <span class="v">${esc(c.v)}</span>
        <span class="s">${esc(c.s)}</span>
      </div>`
    )
    .join('');

  // 覆盖说明
  const note = $('#coverage-note');
  if (t.first_live && t.last_live) {
    const spanH = Math.max(0, (t.last_live - t.first_live) / 3600);
    const hoursCovered = new Set();
    // 用「首次观测落在哪个小时桶」近似覆盖的小时数，避免再发一个请求
    const nd = data.hourDist.filter((x) => x.n > 0).length;
    note.innerHTML =
      `当前库覆盖 <strong>${esc(fmtDateTime(t.first_live))} ~ ${esc(fmtDateTime(t.last_live))}</strong>` +
      `（约 ${spanH.toFixed(1)} 小时），共 <strong>${fmtNum(t.runs)}</strong> 次采集，` +
      `有数据的小时桶 <strong>${nd} / 24</strong>。` +
      (t.runs < 24
        ? ' 采集次数还很少，下面的分布图反映的是"我们什么时候去看的"，不是"主播什么时候开播"。'
        : '')
      .replace(/\s+/g, ' ');
  } else {
    note.textContent = '库里还没有场次数据。';
  }
}

function renderAll() {
  const data = state.data;
  if (!data) return;

  renderOverview(data);

  renderBars($('#online-chart'), data.onlineDist, { unit: ' 场' });
  $('#online-hint').textContent = `${fmtNum(data.totals.online_samples)} 场有人气数据`;

  renderBars($('#hour-chart'), data.hourDist, {
    labelOf: (d) => String(d.h).padStart(2, '0'),
    unit: ' 场',
    extraClass: 'bar-chart-hours',
  });

  renderBars($('#weekday-chart'), data.weekdayDist, { unit: ' 场' });

  renderBars($('#dur-chart'), data.durDist, { unit: ' 场' });
  $('#dur-hint').textContent = data.durSamples
    ? `${fmtNum(data.durSamples)} 场有收尾记录，中位 ${fmtDuration(data.durMedian)}`
    : '还没有已收尾的场次';

  renderTop(data.top);
  renderWords(data.words);
}

function renderTop(rows) {
  const tbody = $('#top-table tbody');
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="u-dim" style="text-align:center;padding:28px">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((r, i) => {
      const face = r.face
        ? `<img class="avatar" src="${esc(imgProxy(r.face, '36x36'))}" alt="" loading="lazy"
             onerror="this.style.visibility='hidden'" />`
        : '<span class="avatar avatar-ph"></span>';
      const name = esc(r.uname || '(无昵称)');
      const nameCell = r.roomid
        ? `<a href="https://live.bilibili.com/${encodeURIComponent(r.roomid)}" target="_blank"
             rel="noopener noreferrer" title="${name}">${name}</a>`
        : `<span title="${name}">${name}</span>`;
      const avg = r.sessions ? Math.round(r.peak / r.sessions) : 0;
      const att = `/attendance.html?uid=${encodeURIComponent(r.uid)}`;
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="uname">${face}<span class="name-wrap">${nameCell}</span></td>
          <td class="num u-mono">${fmtNum(r.peak)}</td>
          <td class="num">${fmtNum(r.sessions)}</td>
          <td class="num u-mono u-dim">${fmtNum(avg)}</td>
          <td><a class="mini-link" href="${esc(att)}" target="_blank" rel="noreferrer">出勤记录</a></td>
        </tr>`;
    })
    .join('');
}

function renderWords(words) {
  const box = $('#word-cloud');
  if (!words.length) {
    box.innerHTML = '<div class="u-dim">暂无标题数据</div>';
    return;
  }

  const max = Math.max(...words.map((w) => w.n));
  const min = Math.min(...words.map((w) => w.n));

  // 字号按频次线性映射到 3 档区间，视觉上能分出高低但不至于夸张
  box.innerHTML = words
    .map((w) => {
      const ratio = max === min ? 0.5 : (w.n - min) / (max - min);
      const size = 12 + ratio * 12;
      const alpha = 0.55 + ratio * 0.45;
      return `<span class="word" style="font-size:${size.toFixed(
        1
      )}px;opacity:${alpha.toFixed(2)}" title="出现 ${fmtNum(w.n)} 次">${esc(w.w)}</span>`;
    })
    .join('');

  $('#word-hint').textContent = `来自 ${fmtNum(state.data.wordSamples)} 条标题`;
}

/* ---------------------------------------------------------------- 数据 */

async function load() {
  if (state.loading) return;
  state.loading = true;
  $('#refresh-btn').disabled = true;

  try {
    const r = await fetch(`/api/analyze?top=${state.topN}`, { cache: 'no-store' });
    const j = await r.json();

    if (!j.available) {
      const box = $('#unavailable');
      box.style.display = 'block';
      box.innerHTML = `<div class="error">无法读取数据：${esc(j.error || '未知原因')}</div>`;
      $('#overview').innerHTML = '';
      $('#summary-sub').textContent = '不可用';
      return;
    }

    state.data = j;
    renderAll();

    const t = j.totals;
    $('#summary-sub').textContent = `${fmtNum(t.streamers)} 主播 · ${fmtNum(
      t.sessions
    )} 场次 · ${fmtNum(t.runs)} 次采集`;
  } catch (err) {
    $('#summary-sub').textContent = '加载失败';
    const box = $('#unavailable');
    box.style.display = 'block';
    box.innerHTML = `<div class="error">请求失败：${esc(err.message)}</div>`;
  } finally {
    state.loading = false;
    $('#refresh-btn').disabled = false;
  }
}

/* ---------------------------------------------------------------- 导出 */

function exportTop() {
  const rows = state.data && state.data.top;
  if (!rows || !rows.length) return;

  const head = ['排名', 'UID', '昵称', '房间号', '历史峰值', '场次数', '场均峰值'];
  const lines = [head.join(',')];
  rows.forEach((r, i) => {
    const avg = r.sessions ? Math.round(r.peak / r.sessions) : 0;
    lines.push(
      [i + 1, r.uid, r.uname || '', r.roomid || '', r.peak, r.sessions, avg]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
  });

  // BOM 让 Excel 正确识别 UTF-8，否则中文列名乱码
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `人气Top${state.topN}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------------- 启动 */

function boot() {
  $('#refresh-btn').onclick = load;
  $('#top-select').onchange = (e) => {
    state.topN = Number(e.target.value) || 20;
    load();
  };
  $('#export-top-btn').onclick = exportTop;
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}