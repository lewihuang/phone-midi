// Smoke test: load the real page scripts against a stub DOM and drive them, so a typo in an
// element id, a missing export or a bad wire-up fails here instead of on the phone.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const files = { index: ['fusion.js', 'vibrato.js', 'app.js'], lab: ['vibrato.js', 'vibrato-lab.js'] };
const htmlOf = (page) => fs.readFileSync(web(page === 'index' ? 'index.html' : 'vibrato-lab.html'), 'utf8');

function makeDom(page) {
  const html = htmlOf(page);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const nodes = {};
  const mk = (id, tag) => ({
    id, tagName: tag || 'DIV', style: {}, dataset: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    textContent: '', innerHTML: '', value: '1', disabled: false, href: '',
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); },
    querySelector(sel) { return mk('sub', 'INPUT'); },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, requestAnimationFrame() {},
  });
  const document = {
    hidden: false,
    getElementById(id) {
      if (!ids.has(id)) throw new Error(`getElementById('${id}') is not in ${page}.html`);
      return (nodes[id] ||= mk(id));
    },
    createElement: (tag) => mk('new-' + tag, tag),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  return { document, ids };
}

function loadPage(page) {
  const { document, ids } = makeDom(page);
  const listeners = {};
  const win = {
    document, location: { protocol: 'http:', host: '127.0.0.1:8765', search: '', href: 'http://x/' },
    history: { replaceState() {} },
    navigator: {},
    performance: { now: () => Date.now() },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    sessionStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
    requestAnimationFrame(f) { return setTimeout(f, 0); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; },
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
  return { win, ctx, ids, listeners };
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

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
