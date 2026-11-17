'use strict';

/**
 * 顶部选项卡（共享导航）
 *
 * 为什么用 JS 生成而不是每个 HTML 手写一遍：
 *   原来 5 个页面各写一份 <a class="nav-link">，加一个页面就要改 5 处，
 *   而且很容易漏掉某一页。集中在这里，加页面只改 NAV_ITEMS。
 *
 * ⚠ 必须整段包在 IIFE 里。
 *   顶层函数声明会挂到 window 上，而 app.js 里也有一个 `render`，
 *   两者同名会互相覆盖 —— 实测表现就是 tabs 一个子元素都没有
 *   （boot 调用到了 app.js 的 render）。用 IIFE 彻底隔离。
 *
 * 用法：页面里放 <nav class="tabs" id="tabs"></nav>，然后引入本文件。
 */

(function () {
  /** 页面清单。href 与 serve.js 的路由、以及高亮判定都用它 */
  const NAV_ITEMS = [
    { id: 'dashboard', href: '/', label: '实时看板' },
    { id: 'rooms', href: '/rooms.html', label: '房间明细' },
    { id: 'attendance', href: '/attendance.html', label: '主播出勤' },
    { id: 'discoveries', href: '/discoveries.html', label: '新发现' },
    { id: 'pool', href: '/pool.html', label: '主播池' },
    { id: 'analyze', href: '/analyze.html', label: '数据分析' },
    { id: 'logs', href: '/logs.html', label: '运行日志', badge: 'errors' },
    { id: 'schedule', href: '/schedule.html', label: '采集设置' },
  ];

  /**
   * 判断当前路径属于哪一项。
   *
   * 看板的 href 是 '/'，如果直接用 `pathname === href` 判断，
   * 访问 '/index.html' 时就不高亮了，所以单独归一化。
   */
  function currentId(pathname) {
    const p = pathname === '/index.html' ? '/' : pathname;
    if (p === '/') return 'dashboard';
    const hit = NAV_ITEMS.find((it) => it.href !== '/' && p === it.href);
    if (hit) return hit.id;
    // 兜底：带查询串或轻微差异时按前缀匹配
    const loose = NAV_ITEMS.find((it) => it.href !== '/' && p.startsWith(it.href.replace('.html', '')));
    return loose ? loose.id : 'dashboard';
  }

  function paint(container, activeId) {
    container.innerHTML = '';
    for (const it of NAV_ITEMS) {
      const a = document.createElement('a');
      a.className = 'tab' + (it.id === activeId ? ' active' : '');
      a.href = it.href;
      a.textContent = it.label;
      if (it.id === activeId) a.setAttribute('aria-current', 'page');
      if (it.badge) {
        const b = document.createElement('span');
        b.className = 'tab-badge';
        b.dataset.badge = it.badge;
        a.appendChild(b);
      }
      container.appendChild(a);
    }
  }

  /**
   * 把「错误日志数」显示在运行日志的 tab 上。
   *
   * 只在有错误时显示数字，为 0 时留空——不做成 "0" 的噪音。
   */
  async function refreshBadges(container) {
    const target = container.querySelector('.tab-badge[data-badge="errors"]');
    if (!target) return;
    try {
      const r = await fetch('/api/logs?limit=1', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const n = (j && j.summary && j.summary.errors) || 0;
      target.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      target.title = n > 0 ? `${n} 条错误日志` : '没有错误';
    } catch {
      /* 网络抖动不影响导航 */
    }
  }

  function boot() {
    const el = document.getElementById('tabs');
    if (!el) return;
    paint(el, currentId(location.pathname));
    refreshBadges(el);

    // 30 秒刷新一次徽章；页面切到后台时不轮询，省资源
    setInterval(() => {
      if (!document.hidden) refreshBadges(el);
    }, 30000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshBadges(el);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();