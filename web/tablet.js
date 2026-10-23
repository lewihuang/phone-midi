// MIDI Deck — 平板宿主
//
// 平板把手机上的六页**左右并排**铺在一屏：每页仍是 2 列 × 4 行（和手机一模一样），页与页之间
// 留一道更宽的缝 → 视觉上就是 12 列 × 4 行、每 2 列一组。48 个按钮一个不少，只是不再翻页。
// 这个文件只管"平板这件事"：六个网格的位置与尺寸、视图切换（48 格 / X/Y）、两个视图的自适应、
// 连接。格子本身（建格 / 绘制 / 按下 / 松开 / 离线拒按 / 震动 / 松手痕迹）全在 padgrid.js 里，
// 六个页面各是一个 `createGrid(page = p)` 实例，与手机是同一份实现；X/Y 视图直接用 xy.js
// （它按 id 取元素，tablet.html 里备齐了同样的 id），也是同一份实现。
//
// 触发编号不变：第 p 页第 s 格由 padgrid 自己算 `p × 8 + s` —— 与手机逐格相同，所以 Bridge、
// 协议、DAW 映射一个字都不用改（ADR 0004）。
(() => {
  'use strict';

  const P = window.PhoneMidiPadGrid;
  // 手机误入本页 → 立刻回 /pad.html。这件事由 device.js 按 <html data-route="tablet"> 自动做了
  // （脚本在 <head> 里同步跑，首次绘制之前就完成跳转），这里不用再调一次。

  const RECONNECT_MS = 2000;
  const PAGES = P.PAGES;          // 6 页（D18）；每页 8 格（2 列 × 4 行）由 padgrid 自己建
  const CELL_GAP = 8;             // 与 tablet.html 里 .pgrid 的 gap 一致（算格子尺寸要用）
  const GROUP_RATIO = 0.5;        // 页间距 = 格子边长的一半：一眼看出"这是六页"

  const elGrid = document.getElementById('grid');
  const elConn = document.getElementById('conn');
  const elErr = document.getElementById('err');
  const elViews = document.getElementById('views');
  const elViewPad = document.getElementById('viewPad');
  const elViewXy = document.getElementById('viewXy');
  const elStage = elViewXy.querySelector('.xy-stage');
  const elPlane = document.getElementById('plane');

  let layout = { pages: [] };
  let view = 'pad';
  let ws = null;
  let connected = false;
  let retryTimer = null;
  let wakeLock = null;

  function showError(msg) {
    const text = msg || '';
    if (elErr.textContent !== text) elErr.textContent = text;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  // 六页 = 六个独立的 2×4 网格。页号直接传给 padgrid，编号因此还是 p×8+s。
  // 元素自己留着：算尺寸时要写每个块的宽高（padgrid 的返回值里没有 el）。
  const pageEls = [];
  const pageGrids = [];
  for (let p = 0; p < PAGES; p++) {
    const el = document.createElement('div');
    el.className = 'pgrid';
    elGrid.appendChild(el);
    pageEls.push(el);
    pageGrids.push(P.createGrid(el, {
      page: p,
      isConnected: () => connected,
      send,
      haptic: P.haptic,
      onBlocked: showError,
      onSent: () => showError(''),
    }));
  }

  function setConn(state, text) {
    elConn.className = 'status ' + state;
    elConn.textContent = text;
    // 离线时除了 CSS 让格子变灰，代码里也真的拒按（两边都做，理由同手机）。
    for (const g of pageGrids) g.setOffline(state !== 'on');
  }

  // ── 布局 ────────────────────────────────────────────────────────────────────

  function applyLayout(next) {
    if (!next || !Array.isArray(next.pages) || next.pages.length === 0) return;
    // 页数上限同手机（D18）。缺的页画成空白（paint(undefined)），不留下上一版的残影。
    layout = { pages: next.pages.slice(0, PAGES) };
    for (let p = 0; p < PAGES; p++) pageGrids[p].paint(layout.pages[p]);
    applyTitles();
  }

  /** 悬停提示 = "第几页 · 页标题"。每页 8 格排成 2×4，页标题没有位置常驻；
      想知道某一组是哪一页时，长按/悬停这一格就能看到（PC 浏览器与触屏长按都会显示）。 */
  function applyTitles() {
    for (let p = 0; p < PAGES; p++) {
      const page = layout.pages[p] || null;
      const title = (page && page.title) ? page.title : ('页 ' + (p + 1));
      for (const cell of pageGrids[p].cells) {
        cell.el.title = '第 ' + (p + 1) + ' 页 · ' + title;
      }
    }
  }

  // ── 自适应：48 格始终保持正方形，六个块尽量铺满可用区域 ────────────────────

  function fitPad() {
    const box = elViewPad.getBoundingClientRect();
    if (box.width < 16 || box.height < 16) return;       // 视图被藏起来时量不到，跳过
    // 总宽 = 12 × 格子 + 6 × 页内缝 + 5 × 页间距（页间距 = 0.5 格）
    const denom = PAGES * 2 + (PAGES - 1) * GROUP_RATIO;
    const byWidth = (box.width - PAGES * CELL_GAP) / denom;
    const byHeight = (box.height - 3 * CELL_GAP) / 4;
    // 一格多大由"宽够放几页"和"高够放 4 行"里更小的那个决定 —— 这才是正方形。
    const size = Math.max(18, Math.floor(Math.min(byWidth, byHeight)));
    const groupGap = Math.max(8, Math.round(size * GROUP_RATIO));
    const pageW = size * 2 + CELL_GAP;
    const pageH = size * 4 + CELL_GAP * 3;
    elGrid.style.gap = groupGap + 'px';
    elGrid.style.setProperty('--cell-size', size + 'px');
    for (const el of pageEls) {
      el.style.width = pageW + 'px';
      el.style.height = pageH + 'px';
    }
  }

  /** X/Y：控制面是舞台里最大的正方形（横屏时右栏占 300px，pad 仍能用到几乎整个高度）。 */
  function fitXy() {
    const box = elStage.getBoundingClientRect();
    if (box.width < 16 || box.height < 16) return;
    const size = Math.max(160, Math.floor(Math.min(box.width, box.height)));
    elPlane.style.width = size + 'px';
    elPlane.style.height = size + 'px';
  }

  function refit() {
    if (view === 'xy') fitXy(); else fitPad();
  }

  // 旋转、窗口尺寸变化、分屏都会触发；ResizeObserver 覆盖"父容器自己变了"的情况。
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', () => setTimeout(refit, 120));
  // 字体加载完会把顶栏撑高几像素，首帧量出来的格子尺寸会差一点；load 之后再量一次。
  window.addEventListener('load', refit);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(refit);
    ro.observe(elViewPad);
    ro.observe(elStage);
  }

  // ── 视图切换 ────────────────────────────────────────────────────────────────

  function setView(name) {
    const isXy = name === 'xy';
    view = isXy ? 'xy' : 'pad';
    elViewPad.classList.toggle('hidden', isXy);
    elViewXy.classList.toggle('hidden', !isXy);
    [...elViews.children].forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    // 切走时必须松开按住的键：格子被藏起来后，pointerup 可能根本送不到，
    // DAW 里就会留下一条永远关不掉的 Note（同 pad.js 换页的处理）。
    if (isXy) for (const g of pageGrids) g.releaseAll();
    showError('');
    // 刚从 display:none 变成可见时尺寸还是 0，等一帧再量。
    requestAnimationFrame(refit);
  }

  elViews.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn || !btn.dataset.view) return;
    if (btn.dataset.view === view) return;   // 已经在那个视图 = 什么都没发生
    P.haptic();
    setView(btn.dataset.view);
  });

  /** 深链接：`/tablet.html?view=xy` 或 `#xy` 直接打开 X/Y（截图/收藏用）。 */
  function initialView() {
    let q = null;
    try { q = new URLSearchParams(location.search || '').get('view'); } catch (_) { /* 老浏览器 */ }
    return (q === 'xy' || location.hash === '#xy') ? 'xy' : 'pad';
  }

  // ── websocket（与 pad.js 同一套节奏：2 秒重连、断线只清本地痕迹） ─────────────

  function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pad_layout') { applyLayout(msg.layout); return; }
    // 其余类型一律忽略：Bridge 以后多说一句，不该让整个平板白屏。
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RECONNECT_MS);
  }

  function connect() {
    if (ws) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    setConn('wait', '连接中…');
    try {
      ws = new WebSocket(protocol + '//' + location.host + '/ws');
    } catch (_) {
      ws = null;
      setConn('off', '未连接');
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      connected = true;
      setConn('on', '已连接');
      showError('');
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      connected = false;
      // socket 已关，releaseAll() 一个字节都发不出去；MIDI 那一侧由 Bridge 兜（断连清扫 + 兜底）。
      for (const g of pageGrids) g.dropHeld();
      ws = null;
      setConn('off', '未连接');
      scheduleRetry();
    };
    ws.onerror = () => {};
  }

  // ── 杂项 ────────────────────────────────────────────────────────────────────

  /** 屏幕一睡，这块板就按不动了；醒来后重新申请。 */
  async function keepAwake() {
    if (!navigator.wakeLock || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) {
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    keepAwake();
    if (!connected && !ws) { clearTimeout(retryTimer); connect(); }
  });

  elGrid.addEventListener('contextmenu', (ev) => ev.preventDefault());

  setView(initialView());
  keepAwake();
  connect();
})();
