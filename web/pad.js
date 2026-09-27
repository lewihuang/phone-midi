// Phone MIDI CC — Shortcut Pad
//
// A page of buttons that each fire one trigger, for driving DAW macros (designed after Stream
// Deck, but the "actions" all live inside the DAW). Design: docs/spec/shortcut-pad.md,
// docs/adr/0004-midi-note-triggers.md.
//
// The phone is deliberately dumb here:
//   * the Bridge owns the layout and pushes it (Layout Push) — the phone never edits it;
//   * a press reports one trigger id, nothing more; the Bridge turns that into a MIDI Note and
//     the DAW turns that Note into a macro.
// No sensors, no calibration, no filtering, no throttling: a press must leave the phone on the
// same tick, because the whole point is "press here, DAW reacts now".
//
// 格子本身（建格 / 绘制 / 按下 / 松开 / 离线拒按 / 震动 / 松手痕迹）在 padgrid.js 里，
// 推子页底部的"第 4 页"条用的是**同一份实现**；这个文件只管"面板这件事"：
// 6 页、页签、布局下发、断线重连。
(() => {
  'use strict';

  const P = window.PhoneMidiPadGrid;
  const RECONNECT_MS = 2000;

  const elTitle = document.getElementById('pageTitle');
  const elGrid = document.getElementById('grid');
  const elTabs = document.getElementById('tabs');
  const elConn = document.getElementById('conn');
  const elErr = document.getElementById('err');

  let layout = { pages: [] };
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

  const grid = P.createGrid(elGrid, {
    isConnected: () => connected,
    send,
    haptic: P.haptic,
    onBlocked: showError,
    onSent: () => showError(''),
  });

  function setConn(state, text) {
    elConn.className = 'status ' + state;
    elConn.textContent = text;
    // The offline class is belt *and* braces: presses are also refused in code, because a
    // button that silently does nothing is worse than a button that visibly cannot be pressed.
    grid.setOffline(state !== 'on');
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  function currentPage() {
    return layout.pages[grid.page] || null;
  }

  function updatePage() {
    const cfg = currentPage();
    elTitle.textContent = (cfg && cfg.title) ? cfg.title : '快捷键面板';
    grid.paint(cfg);
    renderTabs();
  }

  function renderTabs() {
    const pages = layout.pages;
    elTabs.classList.toggle('hidden', pages.length <= 1);
    if (elTabs.children.length !== pages.length) {
      elTabs.textContent = '';
      pages.forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab';
        b.addEventListener('click', () => {
          if (!grid.setPage(i)) return;   // 已经在那一页 = 什么都没发生 = 不给手感
          P.haptic();                     // 翻页也要有"按到了"的确认（用户要求）
          updatePage();
        });
        elTabs.appendChild(b);
      });
    }
    [...elTabs.children].forEach((b, i) => {
      b.textContent = (pages[i] && pages[i].title) ? pages[i].title : ('页 ' + (i + 1));
      b.classList.toggle('active', i === grid.page);
    });
  }

  function applyLayout(next) {
    if (!next || !Array.isArray(next.pages) || next.pages.length === 0) return;
    layout = { pages: next.pages.slice(0, P.PAGES) };
    if (grid.page >= layout.pages.length) grid.setPage(0);
    updatePage();
  }

  // ── websocket ───────────────────────────────────────────────────────────────

  function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pad_layout') { applyLayout(msg.layout); return; }
    // Anything else is ignored on purpose. The Bridge already sends `config`, and state
    // read-back is planned (spec §"状态回读"): a pad that threw on an unknown type would
    // break the day the Bridge learns to say something new.
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
      // Tell the Bridge we let go *before* dropping the socket reference: `send()` refuses to
      // work without an open socket, so nulling first silently loses the "up" and leaves a
      // hanging Note On for the Bridge's 1 s guard to clean up (found by tests/pages_smoke.mjs).
      grid.releaseAll();
      ws = null;
      setConn('off', '未连接');
      scheduleRetry();
    };
    ws.onerror = () => {};
  }

  // ── misc ────────────────────────────────────────────────────────────────────

  /** A pad whose screen sleeps is a pad you cannot press; re-acquire after every wake. */
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
    // Coming back should reconnect at once rather than wait out the retry timer.
    if (!connected && !ws) { clearTimeout(retryTimer); connect(); }
  });

  elGrid.addEventListener('contextmenu', (ev) => ev.preventDefault());

  updatePage();
  keepAwake();
  connect();
})();
