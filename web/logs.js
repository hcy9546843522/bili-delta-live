'use strict';

/*
 * 「运行日志」页
 *
 * 数据来源：GET /api/logs?level=&scope=&q=&limit=
 *   返回 { available, summary, entries, now }
 *   entries 每条形如 { id, t, level, scope, msg, detail?, err?, code? }
 *
 * 关键点：
 *   1. 只读服务内存里的 ring buffer，不每次翻 logs.jsonl，避免频繁磁盘 IO
 *   2. 级别筛选是「不低于」语义：选「警告」会同时看到错误（错误一定也要看）
 *   3. 自动刷新只在页面可见时跑，切到后台就停，省资源也省请求
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  level: 'error',   // 默认就看错误，符合"我不希望出问题找不到原因"的诉求
  scope: '',
  q: '',
  limit: 200,
  entries: [],
  summary: null,
  autoRefresh: true,
  timer: null,
};

const REFRESH_MS = 5000;

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

const pad = (n) => String(n).padStart(2, '0');

/** 时间戳 → "11-15 17:19:03"（东八区） */
function fmtTime(epochSec) {
  if (!epochSec) return '—';
  const d = new Date((epochSec + 8 * 3600) * 1000);
  return (
    `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 */
function fmtAgo(epochSec, now) {
  if (!epochSec) return '';
  const s = Math.max(0, (now || Math.floor(Date.now() / 1000)) - epochSec);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const LEVEL_LABEL = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' };

/* ---------------------------------------------------------------- 概览 */

function renderOverview() {
  const s = state.summary;
  const box = $('#overview');

  if (!s) {
    box.innerHTML = '';
    return;
  }

  const cards = [
    {
      k: '错误',
      v: s.byLevel.error || 0,
      cls: (s.byLevel.error || 0) > 0 ? 'err' : '',
    },
    {
      k: '警告',
      v: s.byLevel.warn || 0,
      cls: (s.byLevel.warn || 0) > 0 ? 'warn' : '',
    },
    { k: '信息', v: s.byLevel.info || 0, cls: '' },
    { k: '调试', v: s.byLevel.debug || 0, cls: '' },
    { k: '内存中总数', v: s.total || 0, cls: '' },
  ];

  box.innerHTML =
    cards
      .map(
        (c) => `
      <div class="stat">
        <div class="k">${escapeHtml(c.k)}</div>
        <div class="v ${c.cls === 'err' ? 'v-err' : c.cls === 'warn' ? 'v-warn' : ''}">${c.v}</div>
      </div>`
      )
      .join('') +
    `
    <div class="stat">
      <div class="k">最近一条</div>
      <div class="v" style="font-size:var(--u-fs-lg)">${s.lastAt ? fmtAgo(s.lastAt) : '—'}</div>
    </div>`;

  // 各来源的条数，放成一行小字，方便判断"是采集没跑还是服务报错"
  const scopes = Object.entries(s.byScope || {}).sort((a, b) => b[1] - a[1]);
  const fileHint = $('#file-hint');
  if (fileHint) {
    fileHint.textContent = scopes.length
      ? `来源分布：${scopes.map(([k, v]) => `${k} ${v}`).join(' · ')}`
      : '';
  }
}

/* ---------------------------------------------------------------- 列表 */

function renderList() {
  const box = $('#log-list');
  const hint = $('#list-hint');

  if (!state.entries.length) {
    const hasFilter = state.level || state.scope || state.q;
    box.innerHTML = hasFilter
      ? `<div class="empty">当前条件下没有日志。

        如果是在找采集失败的原因，试试把级别切到「全部」，或者清空关键词。</div>`
      : `<div class="empty">还没有任何日志。

        日志在采集任务或服务发生事件时才会写入。自动采集关闭时，这里是空的。</div>`;
    hint.textContent = '';
    return;
  }

  hint.textContent = `共 ${state.entries.length} 条`;

  // entries 按时间正序，展示时倒序（最新的在最上面），符合看日志的习惯
  const rows = state.entries.slice().reverse();

  box.innerHTML = rows
    .map((e) => {
      const level = LEVEL_LABEL[e.level] || String(e.level).toUpperCase();

      // 附加信息：优先显示 err（错误根因），其次 detail（stderr 摘要等）
      const extras = [];
      if (e.err) extras.push(`<span class="log-extra-tag">原因</span>${escapeHtml(e.err)}`);
      if (e.detail) extras.push(`<span class="log-extra-tag">详情</span>${escapeHtml(e.detail)}`);
      if (e.code !== undefined && e.code !== null) {
        extras.push(`<span class="log-extra-tag">退出码</span>${escapeHtml(e.code)}`);
      }

      const extra = extras.length
        ? `<div class="log-extra" title="点击展开/收起">${extras.join('<br>')}</div>`
        : '';

      return `
      <div class="log-row ${escapeHtml(e.level)}">
        <span class="log-time" title="${escapeHtml(fmtTime(e.t))}">${escapeHtml(fmtTime(e.t).slice(6))}</span>
        <span class="log-level">${escapeHtml(level)}</span>
        <span class="log-scope" title="${escapeHtml(e.scope)}">${escapeHtml(e.scope)}</span>
        <div class="log-body">
          <div class="log-msg">${escapeHtml(e.msg)}</div>
          ${extra}
        </div>
      </div>`;
    })
    .join('');

  // 附加信息折叠区：点一下展开/收起
  box.querySelectorAll('.log-extra').forEach((el) => {
    el.onclick = () => el.classList.toggle('expanded');
  });
}

/* ---------------------------------------------------------------- 加载 */

function buildUrl() {
  const p = new URLSearchParams();
  if (state.level) p.set('level', state.level);
  if (state.scope) p.set('scope', state.scope);
  if (state.q) p.set('q', state.q);
  p.set('limit', String(state.limit));
  return `/api/logs?${p.toString()}`;
}

async function load() {
  const j = await getJson(buildUrl());
  state.summary = j.summary || null;
  state.entries = j.entries || [];
  renderOverview();
  renderList();

  const sub = $('#log-sub');
  if (sub) {
    const errs = (j.summary && j.summary.errors) || 0;
    const last = j.summary && j.summary.lastAt ? fmtAgo(j.summary.lastAt, j.now) : '无';
    sub.textContent = errs > 0 ? `${errs} 条错误 · 最近 ${last}` : `无错误 · 最近 ${last}`;
  }
}

async function safeLoad() {
  try {
    await load();
  } catch (err) {
    const box = $('#log-list');
    box.innerHTML = `<div class="error">读取日志失败：${escapeHtml(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------- 自动刷新 */

function scheduleRefresh() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (!state.autoRefresh) return;

  state.timer = setInterval(() => {
    // 页面不可见 / 输入框聚焦（正在打字）时不打断用户
    if (document.hidden) return;
    const active = document.activeElement;
    if (active && active.id === 'q-input') return;
    safeLoad();
  }, REFRESH_MS);
}

/* ---------------------------------------------------------------- 复制 */

function copyAll() {
  const lines = state.entries
    .slice()
    .reverse()
    .map((e) => {
      const parts = [`${fmtTime(e.t)} [${(e.level || '').toUpperCase()}] [${e.scope}] ${e.msg}`];
      if (e.err) parts.push(`  原因: ${e.err}`);
      if (e.detail) parts.push(`  详情: ${e.detail}`);
      if (e.code !== undefined && e.code !== null) parts.push(`  退出码: ${e.code}`);
      return parts.join('\n');
    });

  const text = lines.length ? lines.join('\n') : '（当前筛选下没有日志）';

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const btn = $('#copy-btn');
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.textContent = old;
      }, 1500);
    })
    .catch(() => {
      // 剪贴板不可用（比如非 HTTPS 且非 localhost），退化为选中文本
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
}

/* ---------------------------------------------------------------- 事件 */

function bindEvents() {
  // 级别单选
  $('#level-tags').onclick = (e) => {
    const btn = e.target.closest('button[data-level]');
    if (!btn) return;
    state.level = btn.dataset.level;
    $('#level-tags')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('active', b === btn));
    safeLoad();
  };

  // 来源单选
  $('#scope-tags').onclick = (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    state.scope = btn.dataset.scope;
    $('#scope-tags')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('active', b === btn));
    safeLoad();
  };

  // 关键词：输入停止 350ms 再查，避免每敲一个字都发请求
  let qTimer = null;
  $('#q-input').oninput = (e) => {
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      safeLoad();
    }, 350);
  };

  $('#limit-select').onchange = (e) => {
    state.limit = Number(e.target.value);
    safeLoad();
  };

  $('#refresh-btn').onclick = () => {
    const btn = $('#refresh-btn');
    btn.disabled = true;
    safeLoad().finally(() => {
      btn.disabled = false;
    });
  };

  $('#auto-refresh').onchange = (e) => {
    state.autoRefresh = e.target.checked;
    scheduleRefresh();
  };

  $('#copy-btn').onclick = copyAll;

  // 页面从后台回来时立刻刷一次，避免看到过期内容
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh) safeLoad();
  });
}

/* ---------------------------------------------------------------- 启动 */

(async () => {
  bindEvents();

  // 初始级别按钮状态与 state 保持一致（HTML 里默认选中「错误」）
  $('#level-tags')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('active', b.dataset.level === state.level));

  await safeLoad();
  scheduleRefresh();
})();