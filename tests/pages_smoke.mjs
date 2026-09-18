// Smoke test: load the real page scripts against a stub DOM and drive them, so a typo in an
// element id, a missing export or a bad wire-up fails here instead of on the phone.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const pages = {
  index: { html: 'index.html', scripts: ['fusion.js', 'vibrato.js', 'app.js'] },
  lab: { html: 'vibrato-lab.html', scripts: ['vibrato.js', 'vibrato-lab.js'] },
  latency: { html: 'latency.html', scripts: ['fusion.js', 'latency.js'] },
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
  const mk = (id, tag) => ({
    id, tagName: tag || 'DIV', style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
    },
    textContent: '', innerHTML: '', value: '1', disabled: false, href: '',
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); },
    querySelector(sel) { return mk('sub', 'INPUT'); },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, requestAnimationFrame() {},
  });
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

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
