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
(() => {
  'use strict';

  const COLS = 2;
  const ROWS = 4;
  const SLOTS = COLS * ROWS;   // 8 cells per page — the PC editor mirrors exactly this grid
  // Forced reflow to reflect: 2 columns x 4 rows (2026-09-26, was 4x2: the wide short buttons
  // wasted the phone's vertical space). Row-major order is what ties a slot to its trigger id.
  const MAX_PAGES = 8;
  const NOTE_BASE = 36;        // trigger id 0 -> note 36 (channel 16, see the ADR)
  const RECONNECT_MS = 2000;
  const DEFAULT_COLOR = '#1e293b';

  const elTitle = document.getElementById('pageTitle');
  const elGrid = document.getElementById('grid');
  const elTabs = document.getElementById('tabs');
  const elConn = document.getElementById('conn');
  const elErr = document.getElementById('err');

  let layout = { pages: [] };
  let page = 0;
  let ws = null;
  let connected = false;
  let retryTimer = null;
  let wakeLock = null;

  const cells = [];        // the 8 DOM cells, built once and updated in place
  const held = new Map();  // pointerId -> trigger id, so a slide-off releases the right trigger

  const triggerId = (pageIndex, slot) => pageIndex * SLOTS + slot;
  const noteFor = (id) => NOTE_BASE + id;

  function showError(msg) {
    const text = msg || '';
    if (elErr.textContent !== text) elErr.textContent = text;
  }

  function setConn(state, text) {
    elConn.className = 'status ' + state;
    elConn.textContent = text;
    // The offline class is belt *and* braces: presses are also refused in code, because a
    // button that silently does nothing is worse than a button that visibly cannot be pressed.
    elGrid.classList.toggle('offline', state !== 'on');
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  function buildCells() {
    for (let slot = 0; slot < SLOTS; slot++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.slot = String(slot);
      const label = document.createElement('span');
      const note = document.createElement('span');
      note.className = 'note';
      el.appendChild(label);
      el.appendChild(note);
      elGrid.appendChild(el);
      cells.push({ el, label, note });
      bindCell(cells[slot], slot);
    }
  }

  function currentPage() {
    return layout.pages[page] || null;
  }

  function updatePage() {
    const cfg = currentPage();
    elTitle.textContent = (cfg && cfg.title) ? cfg.title : '快捷键面板';
    for (let slot = 0; slot < SLOTS; slot++) {
      const cell = cells[slot];
      const c = (cfg && Array.isArray(cfg.cells)) ? cfg.cells[slot] : null;
      const text = (c && typeof c.text === 'string') ? c.text : '';
      const color = (c && typeof c.color === 'string' && c.color) ? c.color : DEFAULT_COLOR;
      if (cell.label.textContent !== text) cell.label.textContent = text;
      if (cell.el.style.background !== color) cell.el.style.background = color;
      cell.note.textContent = 'N' + noteFor(triggerId(page, slot));
    }
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
          if (page === i) return;
          releaseAll();
          page = i;
          updatePage();
        });
        elTabs.appendChild(b);
      });
    }
    [...elTabs.children].forEach((b, i) => {
      b.textContent = (pages[i] && pages[i].title) ? pages[i].title : ('页 ' + (i + 1));
      b.classList.toggle('active', i === page);
    });
  }

  function applyLayout(next) {
    if (!next || !Array.isArray(next.pages) || next.pages.length === 0) return;
    layout = { pages: next.pages.slice(0, MAX_PAGES) };
    if (page >= layout.pages.length) page = 0;
    updatePage();
  }

  // ── press handling ──────────────────────────────────────────────────────────

  function bindCell(cell, slot) {
    cell.el.addEventListener('pointerdown', (ev) => {
      if (!connected) { showError('未连接 Bridge，按键不会发出'); return; }
      ev.preventDefault();
      const id = triggerId(page, slot);
      held.set(ev.pointerId, id);
      try { cell.el.setPointerCapture(ev.pointerId); } catch (_) { /* not fatal */ }
      cell.el.classList.add('pressed');
      showError('');
      send({ kind: 'trigger', id, phase: 'down' });
    });

    const release = (ev) => {
      const id = held.get(ev.pointerId);
      if (id === undefined) return;
      held.delete(ev.pointerId);
      const c = cells[id % SLOTS];
      if (c) c.el.classList.remove('pressed');
      send({ kind: 'trigger', id, phase: 'up' });
    };
    cell.el.addEventListener('pointerup', release);
    cell.el.addEventListener('pointercancel', release);
    cell.el.addEventListener('lostpointercapture', release);
  }

  /** Drop every held button (page switch, disconnect): never leave a Note On hanging. */
  function releaseAll() {
    for (const [pointerId, id] of held) {
      held.delete(pointerId);
      const c = cells[id % SLOTS];
      if (c) c.el.classList.remove('pressed');
      send({ kind: 'trigger', id, phase: 'up' });
    }
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
      releaseAll();
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

  buildCells();
  updatePage();
  keepAwake();
  connect();
})();
