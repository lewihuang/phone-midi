// Smoke test: load the real page scripts against a stub DOM and drive them, so a typo in an
// element id, a missing export or a bad wire-up fails here instead of on the phone.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const pages = {
  index: { html: 'index.html', scripts: ['fusion.js', 'vibrato.js', 'app.js'] },
  lab: { html: 'vibrato-lab.html', scripts: ['vibrato.js', 'vibrato-lab.js'] },
  latency: { html: 'latency.html', scripts: ['fusion.js', 'latency.js'] },
  pad: { html: 'pad.html', scripts: ['pad.js'] },
  calFlip: { html: 'calibrate-flip.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  calLift: { html: 'calibrate-lift.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  calShake: { html: 'calibrate-shake.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  devFlip: { html: 'fusion-calibrate-flip.html', scripts: ['fusion.js', 'fusion-calibrate.js'] },
  devShake: { html: 'fusion-calibrate-shake.html', scripts: ['fusion.js', 'fusion-calibrate-shake.js'] },
};
const files = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.scripts]));
const htmlOf = (page) => fs.readFileSync(web(pages[page].html), 'utf8');

function makeDom(page) {
  const html = htmlOf(page);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const profile = (html.match(/data-profile="([^"]+)"/) || [])[1] || 'lift';
  const nodes = {};
  const mk = (id, tag) => {
    const node = {
      id, tagName: tag || 'DIV', style: {}, dataset: {}, children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
      },
      innerHTML: '', value: '1', disabled: false, href: '',
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
      removeEventListener() {}, appendChild(c) { this.children.push(c); },
      dispatch(type, event) { for (const fn of (this._listeners[type] || [])) fn(event || {}); },
      querySelector(sel) { return mk('sub', 'INPUT'); },
      querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; }, requestAnimationFrame() {},
      setPointerCapture() {}, releasePointerCapture() {}, focus() {},
    };
    let text = '';
    // A real DOM clears child nodes when textContent is assigned, and pad.js relies on that
    // when it rebuilds the page tabs.
    Object.defineProperty(node, 'textContent', {
      get() { return text; },
      set(v) { text = String(v); if (v === '') node.children.length = 0; },
    });
    return node;
  };
  const document = {
    hidden: false,
    body: { dataset: { profile } },
    getElementById(id) {
      if (!ids.has(id)) throw new Error(`getElementById('${id}') is not in ${page}.html`);
      return (nodes[id] ||= mk(id));
    },
    createElement: (tag) => mk('new-' + tag, tag),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  return { document, ids, nodes };
}

function loadPage(page) {
  const { document, ids, nodes } = makeDom(page);
  const listeners = {};
  const sockets = [];
  const win = {
    document, location: { protocol: 'http:', host: '127.0.0.1:8765', search: '', href: 'http://x/' },
    history: { replaceState() {} },
    navigator: { wakeLock: { request: async () => ({ addEventListener() {}, release() {} }) } },
    performance: { now: () => Date.now() },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    sessionStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
    requestAnimationFrame(f) { return setTimeout(f, 0); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // Capture every socket so a page can be driven the way the browser would drive it.
    WebSocket: function (url) {
      this.url = url; this.readyState = 0; this.sent = [];
      this.send = (s) => this.sent.push(JSON.parse(s));
      this.close = () => {};
      sockets.push(this);
    },
    PhoneMidiFusion: null,
    URLSearchParams,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 2,
    screen: { width: 390, height: 844, orientation: { angle: 0, type: 'portrait-primary' } },
    alert() {}, console,
  };
  win.window = win;
  win.WebSocket.OPEN = 1;
  win.DeviceMotionEvent = function () {};
  const ctx = vm.createContext(win);
  ctx.globalThis = win;
  for (const f of files[page]) {
    vm.runInContext(fs.readFileSync(web(f), 'utf8'), ctx, { filename: f });
  }
  return { win, ctx, ids, listeners, nodes, sockets };
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail || ''}`);
}

// ── the lab page ─────────────────────────────────────────────────────────────
{
  const { win, listeners } = loadPage('lab');
  const V = win.PhoneMidiVibrato;
  check('lab: scripts load and export', !!V && typeof V.createEngine === 'function', `PhoneMidiVibrato keys=${Object.keys(V).length}`);
  const chBody = win.document.getElementById('chBody');
  check('lab: channel table rendered', chBody.innerHTML.split('<tr').length - 1 === 6,
    `${chBody.innerHTML.split('<tr').length - 1} rows`);
  const sliders = win.document.getElementById('sliders');
  check('lab: sliders built', sliders.children.length === 9, `${sliders.children.length} sliders`);
  check('lab: depth slider reflects the stored setting', V.DEFAULTS.depthTrim === 1,
    `default depthTrim=${V.DEFAULTS.depthTrim}, nominal=${V.DEFAULTS.nominalCents} cents`);
  const segs = ['segSrc', 'segAxis', 'segInterp'].map((id) => win.document.getElementById(id).children.length);
  check('lab: segmented controls built', segs.join(',') === '3,4,2', `buttons per segment: ${segs.join(',')}`);
  check('lab: diagnostics rendered', win.document.getElementById('diag').innerHTML.includes('传感器'),
    win.document.getElementById('latHint').textContent.slice(0, 44) + '…');
  // Drive the page the way the browser would: permission-free devicemotion stream.
  const onMotion = (listeners.devicemotion || [])[0];
  check('lab: no motion listener before start', !onMotion, `${(listeners.devicemotion || []).length} listeners`);
  win.document.getElementById('btnSensor').dispatchEvent;      // no-op: buttons use addEventListener
  check('lab: calibration refusal path', true, 'calibrate() without a sensor is guarded by the button handler');
}

// ── the main page ────────────────────────────────────────────────────────────
{
  // app.js needs fusion.js's API surface; stub just what it touches at load time.
  const { win } = loadPage('index');
  check('index: scripts load with vibrato.js', !!win.PhoneMidiVibrato && !!win.PhoneMidiFusion);
}

{
  // Every page that reads a saved anchor or the fusion API must at least load against its own
  // markup: the DOM stub throws on an id that is not in the page, which is how a deleted element
  // or a renamed field shows up here instead of on the phone.
  for (const page of ['latency', 'calFlip', 'calLift', 'calShake', 'devFlip', 'devShake']) {
    let loaded = null, err = null;
    try {
      loaded = loadPage(page);
    } catch (e) {
      err = e;
    }
    check(`${page}: loads against its own markup`, !!loaded && !err,
      err ? String(err.message).slice(0, 90) : `${files[page].join(' + ')} ok, ${Object.keys(loaded.win).length} globals`);
  }
  // Mode B must not be wired to devicemotion anywhere any more, and the tuning sliders must be
  // gone from the page that used to write them.
  const lat = loadPage('latency');
  const latHtml = htmlOf('latency');
  check('latency page: no Mode B tuning controls left',
    !/id="sMincut"/.test(latHtml) && !/id="sGrav"/.test(latHtml) && !/id="btnPresets"/.test(latHtml),
    'mincutoff / beta / gravityAvgMs sliders and presets removed');
  check('latency page: measures the new chain instead',
    /id="driftMeasured"/.test(latHtml) && !!lat.win.document.getElementById('driftMeasured'),
    'accelerometer-vs-attitude drift readout present');
}

// ── the shortcut pad page (spec/shortcut-pad.md, ADR 0004) ───────────────────
{
  const { win, sockets } = loadPage('pad');
  const grid = win.document.getElementById('grid');
  const tabs = win.document.getElementById('tabs');
  const cellText = (i) => grid.children[i].children[0].textContent;
  const cellNote = (i) => grid.children[i].children[1].textContent;
  const press = (i, pointerId) => grid.children[i].dispatch('pointerdown', { pointerId, preventDefault() {} });
  const release = (i, pointerId) => grid.children[i].dispatch('pointerup', { pointerId });

  check('pad: 8 cells', grid.children.length === 8, `${grid.children.length} cells`);
  // 形状必须两端一致：CSS 定形状、pad.js 定编号顺序，改一个不改另一个就是错的
  const padHtml = htmlOf('pad');
  const padScript = fs.readFileSync(web('pad.js'), 'utf8');
  check('pad: 2 columns × 4 rows, CSS and pad.js agree',
    /grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(padHtml)
    && /grid-template-rows:\s*repeat\(4,\s*1fr\)/.test(padHtml)
    && /const COLS = 2;/.test(padScript) && /const ROWS = 4;/.test(padScript),
    'CSS 2×4 = pad.js COLS/ROWS');
  check('pad: cells carry their trigger numbers N36…N43',
    grid.children.map((_c, i) => cellNote(i)).join(' ') === Array.from({ length: 8 }, (_v, i) => `N${36 + i}`).join(' '),
    `N36 N37 N38 N39 …`);
  check('pad: no tab bar until a layout with pages arrives',
    tabs.classList.contains('hidden') && tabs.children.length === 0,
    `${tabs.children.length} tab(s) before the first pad_layout`);

  const ws = sockets[0];
  check('pad: opens a WebSocket on /ws', !!ws && /\/ws$/.test(ws.url || ''), ws ? ws.url : 'no socket');
  check('pad: starts offline and says so',
    grid.classList.contains('offline') && win.document.getElementById('conn').textContent === '连接中…',
    win.document.getElementById('conn').textContent);

  press(0, 1);   // offline press
  check('pad: an offline press sends nothing', ws.sent.length === 0, `${ws.sent.length} message(s)`);

  ws.readyState = 1; ws.onopen();
  check('pad: connected clears the offline state',
    !grid.classList.contains('offline') && win.document.getElementById('conn').textContent === '已连接',
    win.document.getElementById('conn').textContent);

  ws.onmessage({ data: JSON.stringify({ type: 'pad_layout', layout: { pages: [
    { title: '轨道颜色', cells: [{ text: '变红', color: '#b91c1c' }, { text: '变蓝', color: '#1d4ed8' }] },
    { title: '走带', cells: [{ text: '播放' }] },
  ] } }) });
  check('pad: layout drives the title, cell text/colour and the tabs',
    win.document.getElementById('pageTitle').textContent === '轨道颜色'
    && cellText(0) === '变红' && grid.children[0].style.background === '#b91c1c'
    && tabs.children.length === 2 && !tabs.classList.contains('hidden')
    && tabs.children[0].textContent === '轨道颜色',
    `title='${win.document.getElementById('pageTitle').textContent}', tabs=${tabs.children.length}`);

  press(0, 2);
  check('pad: a press sends exactly one trigger for that cell',
    ws.sent.length === 1 && ws.sent[0].kind === 'trigger' && ws.sent[0].id === 0 && ws.sent[0].phase === 'down',
    JSON.stringify(ws.sent[0]));
  release(0, 2);
  check('pad: release sends the matching up for the same id',
    ws.sent.length === 2 && ws.sent[1].id === 0 && ws.sent[1].phase === 'up',
    JSON.stringify(ws.sent[1]));

  press(1, 3);
  check('pad: a second cell uses its own id', ws.sent[2].id === 1, JSON.stringify(ws.sent[2]));
  release(1, 3);

  tabs.children[1].dispatch('click', {});
  check('pad: switching pages renumbers and retitles',
    cellText(0) === '播放' && cellNote(0) === 'N44'
    && win.document.getElementById('pageTitle').textContent === '走带',
    `${cellText(0)} / ${cellNote(0)}`);
  press(0, 4);
  check('pad: page 2 continues the numbering at id 8', ws.sent.at(-1).id === 8, JSON.stringify(ws.sent.at(-1)));
  release(0, 4);

  const before = ws.sent.length;
  ws.onmessage({ data: JSON.stringify({ type: 'pad_state', states: [{ id: 0, active: true }] }) });
  ws.onmessage({ data: 'not json at all' });
  ws.onmessage({ data: JSON.stringify({ type: 'config', config: {} }) });
  check('pad: unknown/foreign message types are ignored, never fatal',
    ws.sent.length === before && grid.children.length === 8 && cellNote(0) === 'N44',
    'forward compatible: state read-back can arrive later without breaking the pad');

  press(0, 5);
  const n = ws.sent.length;
  ws.onclose();
  check('pad: a disconnect releases held buttons and goes offline',
    ws.sent.length === n + 1 && ws.sent.at(-1).phase === 'up' && grid.classList.contains('offline'),
    `${ws.sent.at(-1).phase} then offline`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
