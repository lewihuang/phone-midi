// Mode B latency regression: the production chain must add *no lag at all*.
//
// Mode A is a stateless projection (attitude -> anchors -> CC) and feels immediate. Mode B used
// to be the odd one out: it estimated gravity from `accelerationIncludingGravity` and then ran a
// sliding-average window plus a One Euro low-pass over the result. Measured on a model of a real
// flip (hand linear acceleration from the wrist's omega/alpha: |a| 4.8-33 m/s^2), that chain had
// two independent problems that no tuning could fix at once:
//   * hand acceleration corrupts the *direction* by tens of degrees -> 76 CC steps RMS of error
//     on a 300 ms flip, because the contamination sits in the same band as the gesture itself;
//   * the low-pass that tried to hide it cost 20-35 ms of group delay, worst exactly where a
//     fader needs to be exact (slow, careful moves: 53 ms time constant at rest).
//
// Mode B is now built like Mode A: the gravity direction is reconstructed from the device
// attitude (deviceorientation beta/gamma), which carries orientation alone and needs no filter.
// These checks pin that property down, so "let's smooth it a little" cannot sneak back in.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail || ''}`);
}
const close = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

// ── harness: fusion.js with the globals it touches ───────────────────────────
function loadFusionEnv(seed) {
  let clock = 1000;
  const store = new Map(Object.entries(seed || {}));
  const listeners = {};
  const timers = [];
  const win = {
    console,
    performance: { now: () => clock },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f); },
    setTimeout(f) { timers.push(f); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    navigator: {}, document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  ctx.globalThis = win;
  vm.runInContext(fs.readFileSync(web('fusion.js'), 'utf8'), ctx, { filename: 'fusion.js' });
  return {
    F: win.PhoneMidiFusion,
    win,
    store,
    listeners,
    advance(ms) { clock += ms; },
    runTimers() { const t = timers.splice(0); for (const f of t) f(); },
    /** Fire an orientation stream at every registered handler. */
    fireOrientation(pairs) {
      for (const [beta, gamma] of pairs) {
        for (const f of (listeners.deviceorientation || []).slice()) f({ beta, gamma });
      }
    },
  };
}

/** Drives the real capture helper: both anchors, through the orientation stream. */
async function captureFlipAnchors(env, plan) {
  const one = async (pairs) => {
    const p = env.F.captureAnchorSamplesForProfile('flip');
    env.fireOrientation(pairs);
    env.runTimers();
    return p;
  };
  const min = await one(plan.min);
  const max = await one(plan.max);
  return { min, max };
}

const env = loadFusionEnv();
const F = env.F;

check('fusion.js exports the attitude gravity helper',
  typeof F.gravityFromOrientation === 'function' && typeof F.feedFlipOrientation === 'function',
  `gravityFromOrientation=${typeof F.gravityFromOrientation}, feedFlipOrientation=${typeof F.feedFlipOrientation}`);

const gone = ['feedFlipMotion', 'resetFlipMotion', 'flipShouldSendValue', 'getFlipTuning',
  'setFlipTuning', 'resetFlipTuning', 'loadFlipTuning', 'flipTimeConstantMs', 'flipCutoffForSpeed',
  'createFlipStabilizerSession', 'getFlipProductionGravityAvgMs', 'FLIP_STABILIZER_DEFAULTS']
  .filter((k) => F[k] !== undefined);
check('the Mode B filter/tuning API is gone', gone.length === 0,
  gone.length ? `still exported: ${gone.join(', ')}` : 'no filter state left to persist');

const fusionSrc = fs.readFileSync(web('fusion.js'), 'utf8');
check('no persisted Mode B tuning can override the app',
  !/tuning\/flip/.test(fusionSrc) && !/loadFlipTuning/.test(fusionSrc),
  'phone-midi/tuning/flip/v1 is no longer read at startup');

// ── 1. the attitude -> gravity reconstruction ────────────────────────────────
//
// W3C R = Rz(a)Rx(b)Ry(g); gravity in the device frame is R^T * z, which is the third row of R
// and free of alpha. For a phone flat on a table the result must equal what the accelerometer
// reported before ((0,0,1) with the usual "up" convention).
const v0 = F.gravityFromOrientation(0, 0);
check('flat device -> (0,0,1), the accelerometer convention',
  close(v0.x, 0) && close(v0.y, 0) && close(v0.z, 1), `(${v0.x}, ${v0.y}, ${v0.z})`);

const v30 = F.gravityFromOrientation(30, 0);
check('beta = 30 deg -> (0, sin30, cos30)',
  close(v30.x, 0) && close(v30.y, 0.5, 1e-12) && close(v30.z, Math.cos(Math.PI / 6), 1e-12),
  `(${v30.x.toFixed(4)}, ${v30.y.toFixed(4)}, ${v30.z.toFixed(4)})`);

const vRoll = F.gravityFromOrientation(0, 20);
check('gamma = 20 deg tilts the up-vector toward -x',
  vRoll.x < 0 && close(Math.hypot(vRoll.x, vRoll.y, vRoll.z), 1, 1e-12),
  `(${vRoll.x.toFixed(4)}, ${vRoll.y.toFixed(4)}, ${vRoll.z.toFixed(4)})`);

let worstNorm = 0, worstPole = 0, worstPeriod = 0;
for (let b = -180; b <= 180; b += 7) {
  for (let g = -90; g <= 90; g += 7) {
    const u = F.gravityFromOrientation(b, g);
    worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(u.x, u.y, u.z) - 1));
    if (Math.abs(Math.abs(b) - 90) < 1e-9) {
      const other = F.gravityFromOrientation(b, g + 37);
      worstPole = Math.max(worstPole, Math.abs(u.x - other.x) + Math.abs(u.z - other.z));
    }
    const p = F.gravityFromOrientation(b + 360, g);
    worstPeriod = Math.max(worstPeriod, Math.abs(u.x - p.x) + Math.abs(u.y - p.y) + Math.abs(u.z - p.z));
  }
}
check('unit norm over the whole beta/gamma grid', worstNorm < 1e-12, `max |‖u‖-1| = ${worstNorm.toExponential(1)}`);
check('continuous through beta = +-90 (gamma drops out)', worstPole < 1e-12, `max dependence on gamma = ${worstPole.toExponential(1)}`);
check('360 deg periodicity', worstPeriod < 1e-12, `max |u(b+360) - u(b)| = ${worstPeriod.toExponential(1)}`);
check('invalid input returns null, never NaN',
  F.gravityFromOrientation(null, 0) === null && F.gravityFromOrientation(0, NaN) === null,
  'null / NaN guarded');

// ── 2. calibration and runtime read the same source ──────────────────────────
//
// The endpoint projection (u - u0).(u1 - u0) / |u1 - u0|^2 is NOT invariant under a sign flip of
// the anchors, so a calibration is only meaningful if capture and runtime agree on frame and
// sign. Here they do by construction: both go through gravityFromOrientation. This drives the
// real capture helper with a fake orientation stream, then projects with the runtime path.
const A = { min: { x: 0, y: 0, z: 1 }, max: { x: 0, y: 1, z: 0 } };
{
  const capEnv = loadFusionEnv();
  const captured = await captureFlipAnchors(capEnv, {
    min: [[0, 0], [0, 0], [0.2, 0]],
    max: [[90, 0], [89.8, 0], [90, 0]],
  });
  check('capture uses the attitude source and keeps the stored shape',
    close(captured.min.z, 1, 1e-3) && close(captured.max.y, 1, 1e-3)
    && captured.min.sampleCount > 0 && !!captured.min.raw,
    `min=(${captured.min.x.toFixed(3)}, ${captured.min.y.toFixed(3)}, ${captured.min.z.toFixed(3)}) n=${captured.min.sampleCount}, max=(${captured.max.x.toFixed(3)}, ${captured.max.y.toFixed(3)}, ${captured.max.z.toFixed(3)}) n=${captured.max.sampleCount}`);
  const t0 = F.computeGravityFusedT(captured.min.x, captured.min.y, captured.min.z, captured, F.DEFAULT_FUSION);
  const t1 = F.computeGravityFusedT(captured.max.x, captured.max.y, captured.max.z, captured, F.DEFAULT_FUSION);
  check('what capture stores is exactly what the runtime spans (t = 0 -> 1)',
    t0 < 0.05 && t1 > 0.95, `t(min)=${t0.toFixed(4)}, t(max)=${t1.toFixed(4)}`);
}
const tMin = F.computeGravityFusedT(0, 0, 1, A, F.DEFAULT_FUSION);
const tMax = F.computeGravityFusedT(0, 1, 0, A, F.DEFAULT_FUSION);
check('stored anchors map to t = 0 and t = 1 exactly',
  close(tMin, 0) && close(tMax, 1), `t(min)=${tMin}, t(max)=${tMax}`);

// ── 3. the production chain is the projection, sample for sample ─────────────
{
  const u30 = F.gravityFromOrientation(30, 0);
  const out = F.feedFlipOrientation(30, 0, A, F.DEFAULT_FUSION);
  const direct = F.computeGravityFusedT(u30.x, u30.y, u30.z, A, F.DEFAULT_FUSION);
  // anchors (0,0,1) -> (0,1,0): t = ((u.y - 0) - (u.z - 1)) / 2
  const closed = (u30.y - u30.z + 1) / 2;
  check('feedFlipOrientation IS the projection (no filter in the path)',
    out && close(out.t, direct, 1e-12) && close(out.t, closed, 1e-12),
    `t=${out.t.toFixed(6)}, t_raw=${out.t_raw.toFixed(6)}, expected=${closed.toFixed(6)}`);
  check('t_raw equals t (there is no second, filtered value)',
    out.t === out.t_raw, `t === t_raw: ${out.t === out.t_raw}`);
}

{
  // A step must land on the sample it arrives on. The old chain needed ~5 samples (t63 17 ms,
  // t90 33 ms) before it was anywhere near the new value.
  const step = [];
  for (let i = 0; i < 4; i++) step.push(F.feedFlipOrientation(0, 0, A, F.DEFAULT_FUSION).t);
  for (let i = 0; i < 4; i++) step.push(F.feedFlipOrientation(90, 0, A, F.DEFAULT_FUSION).t);
  check('step response is instant (1st post-step sample is already the full value)',
    close(step[3], 0) && close(step[4], 1), `[${step.map((v) => v.toFixed(2)).join(', ')}]`);

  const a = F.feedFlipOrientation(45, 10, A, F.DEFAULT_FUSION).t;
  const b = F.feedFlipOrientation(45, 10, A, F.DEFAULT_FUSION).t;
  const fwd = [0, 30, 60, 90].map((x) => F.feedFlipOrientation(x, 0, A, F.DEFAULT_FUSION).t);
  const rev = [90, 60, 30, 0].map((x) => F.feedFlipOrientation(x, 0, A, F.DEFAULT_FUSION).t);
  check('stateless: identical sample, identical value; order-independent',
    close(a, b, 0) && fwd.every((v, i) => close(v, rev[rev.length - 1 - i], 1e-12)),
    `t(45,10)=${a.toFixed(6)} twice; forward/reverse mirrored`);

  // Holding still must not drift: the old One Euro kept settling for ~150 ms after the hand
  // stopped, which on a fader reads as "the value keeps creeping after I stop".
  const hold = [];
  for (let i = 0; i < 60; i++) hold.push(F.feedFlipOrientation(45, 0, A, F.DEFAULT_FUSION).t);
  check('holding still produces a constant value (no post-release creep)',
    hold.every((v) => v === hold[0]),
    `spread over 60 samples = ${(Math.max(...hold) - Math.min(...hold)).toExponential(1)}`);

  // The old chain's group delay depended on how fast you moved (53 ms at rest vs 27 ms moving),
  // which is why careful fader moves felt worst. Now there is nothing to be speed dependent.
  const slow = F.feedFlipOrientation(1, 0, A, F.DEFAULT_FUSION).t;
  const fast = F.feedFlipOrientation(89, 0, A, F.DEFAULT_FUSION).t;
  const uSlow = F.gravityFromOrientation(1, 0);
  const uFast = F.gravityFromOrientation(89, 0);
  check('no speed-dependent lag (the value is a pure function of the sample)',
    close(slow, F.computeGravityFusedT(uSlow.x, uSlow.y, uSlow.z, A, F.DEFAULT_FUSION), 1e-12)
    && close(fast, F.computeGravityFusedT(uFast.x, uFast.y, uFast.z, A, F.DEFAULT_FUSION), 1e-12),
    `t(1 deg)=${slow.toFixed(6)}, t(89 deg)=${fast.toFixed(6)}`);
}

// ── 4. end to end: the page sends the current sample, and only from the attitude ─────────────
function loadPage(mode) {
  const html = fs.readFileSync(web('index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const nodes = {};
  const mk = (id, tag) => ({
    id, tagName: tag || 'DIV', style: {}, dataset: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} },
    textContent: '', innerHTML: '', value: 'A', disabled: false, href: '',
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); },
    querySelector() { return mk('sub', 'INPUT'); }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, requestAnimationFrame() {},
  });
  const document = {
    hidden: false,
    getElementById(id) {
      if (!ids.has(id)) throw new Error(`getElementById('${id}') is not in index.html`);
      return (nodes[id] ||= mk(id));
    },
    createElement: (tag) => mk('new-' + tag, tag),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const listeners = {};
  const sent = [];
  const perms = [];
  let clock = 1000;
  const store = new Map([
    ['phone-midi/calibration/flip/v1', JSON.stringify({
      schema: 'phone-midi/calibration/flip/v1', profile: 'flip', input: 'gravity',
      anchors: A, fusion: { mode: 'endpoint_projection', reverse: false },
    })],
    ['phone-midi/calibration/lift/v1', JSON.stringify({
      schema: 'phone-midi/calibration/lift/v1', profile: 'lift', input: 'orientation',
      anchors: { min: { beta: 0, gamma: 0 }, max: { beta: 0, gamma: 90 } },
      fusion: { mode: 'endpoint_projection', reverse: false },
    })],
  ]);
  const win = {
    document,
    location: { protocol: 'http:', host: '127.0.0.1:8765', search: '?mode=' + mode, href: 'http://x/?mode=' + mode },
    history: { replaceState() {} },
    navigator: {},
    performance: { now: () => clock },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f); },
    requestAnimationFrame(f) { return setTimeout(f, 0); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: function () { this.readyState = 1; this.send = (s) => sent.push(JSON.parse(s)); this.close = () => {}; },
    PhoneMidiFusion: null,
    URLSearchParams, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 2,
    screen: { width: 390, height: 844, orientation: { angle: 0, type: 'portrait-primary' } },
    alert() {}, console,
  };
  win.window = win;
  win.WebSocket.OPEN = 1;
  win.DeviceMotionEvent = function () {};
  win.DeviceMotionEvent.requestPermission = async () => { perms.push('motion'); return 'granted'; };
  const ctx = vm.createContext(win);
  ctx.globalThis = win;
  for (const f of ['fusion.js', 'vibrato.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(web(f), 'utf8'), ctx, { filename: f });
  }
  // One sensor sample every 16.7 ms, like a real phone.
  const sample = (handler, event) => { clock += 16.7; handler(event); };
  return { win, listeners, sent, perms, sample };
}

{
  const page = loadPage('B');
  await page.win.start();
  const onOri = (page.listeners.deviceorientation || [])[0];
  const onMot = (page.listeners.devicemotion || [])[0];
  check('mode B is driven by deviceorientation, like mode A',
    typeof onOri === 'function' && typeof onMot === 'function',
    `${(page.listeners.deviceorientation || []).length} orientation / ${(page.listeners.devicemotion || []).length} motion listeners`);
  check('mode B no longer asks for the motion sensor', !page.perms.includes('motion'),
    `permission calls: [${page.perms.join(', ') || 'none'}]`);

  page.sample(onOri, { beta: 30, gamma: 0 });
  const first = page.sent[0];
  const expect = F.feedFlipOrientation(30, 0, A, F.DEFAULT_FUSION).t;
  check('sent CC value equals the current sample\'s projection (zero added lag)',
    first && first.axis === 'fused_flip' && close(first.value, expect, 1e-12) && first.kind === 'cc',
    first ? `value=${first.value.toFixed(6)} expected=${expect.toFixed(6)} axis=${first.axis} kind=${first.kind}` : 'no message sent');

  page.sample(onOri, { beta: 45, gamma: 0 });
  check('a moved sample sends exactly its own value',
    page.sent.length === 2 && close(page.sent[1].value, 0.5, 1e-12),
    `messages=${page.sent.length}, value=${page.sent[1] ? page.sent[1].value.toFixed(6) : '—'}`);

  page.sample(onOri, { beta: 45.001, gamma: 0 });
  check('sub-threshold jitter is not sent (the send gate is the only conditioning)',
    page.sent.length === 2, `messages after a +0.0005 move = ${page.sent.length}`);

  page.sample(onMot, { accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 } });
  page.sample(onMot, { accelerationIncludingGravity: { x: 0, y: -9.81, z: 0 } });
  check('devicemotion can no longer move the Mode B fader', page.sent.length === 2,
    `${page.sent.length} messages after two extreme accelerometer samples`);
}

{
  // Parity: mode A and mode B must behave the same way, through the same code path.
  const page = loadPage('A');
  await page.win.start();
  const onOri = (page.listeners.deviceorientation || [])[0];
  page.sample(onOri, { beta: 0, gamma: 45 });
  check('mode A sends its own projection through the same path',
    page.sent.length === 1 && page.sent[0].axis === 'fused_lift' && close(page.sent[0].value, 0.5, 1e-9),
    page.sent[0] ? `axis=${page.sent[0].axis}, value=${page.sent[0].value.toFixed(6)}` : 'no message sent');
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
