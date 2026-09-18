// P3 verification: 6-channel source/axis selection + P1/P2 regression, numerically.
// Node-only, DOM-free: web/vibrato.js is pure DSP.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

vm.runInThisContext(fs.readFileSync(web('vibrato.js'), 'utf8'), { filename: 'vibrato.js' });
const V = globalThis.PhoneMidiVibrato;
const IDS = V.CHANNEL_IDS;
const META = Object.fromEntries(V.CHANNELS.map((c) => [c.id, c]));
const allGains = (g) => Object.fromEntries(IDS.map((id) => [id, g]));
const TAU = 2 * Math.PI;

// ── helpers ───────────────────────────────────────────────────────────────────

function mkInput(vals) {
  const g = [0, 0, 0], a = [0, 0, 0];
  let hg = 0, ha = 0;
  for (const k of Object.keys(vals)) {
    const m = META[k];
    if (!m || vals[k] == null) continue;
    if (m.src === 'gyro') { g[m.index] = vals[k]; hg = 1; } else { a[m.index] = vals[k]; ha = 1; }
  }
  return { gyro: hg ? g : null, accel: ha ? a : null };
}

/** Least-squares sine fit at frequency f over [tFrom,tTo]: {amp, rmsErr}. */
function fit(ts, cs, f, tFrom, tTo) {
  let Sss = 0, Scc = 0, Ssc = 0, Sys = 0, Syc = 0, Syy = 0, n = 0;
  const w = TAU * f;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < tFrom || ts[i] > tTo) continue;
    const s = Math.sin(w * ts[i]), c = Math.cos(w * ts[i]), y = cs[i];
    Sss += s * s; Scc += c * c; Ssc += s * c; Sys += y * s; Syc += y * c; Syy += y * y; n++;
  }
  if (n < 8) return { amp: NaN, rmsErr: NaN, n };
  const det = Sss * Scc - Ssc * Ssc;
  const A = (Sys * Scc - Syc * Ssc) / det;
  const B = (Syc * Sss - Sys * Ssc) / det;
  const amp = Math.hypot(A, B);
  const resid = Syy - (A * Sys + B * Syc);
  return { amp, rmsErr: Math.sqrt(Math.max(0, resid) / n), n, A, B };
}

function peakAbs(cs, ts, tFrom, tTo) {
  let m = 0;
  for (let i = 0; i < cs.length; i++) if (ts[i] >= tFrom && ts[i] <= tTo) m = Math.max(m, Math.abs(cs[i]));
  return m;
}

/**
 * Instantaneous amplitude envelope for a signal known to be sinusoidal at f, via a
 * quarter-period quadrature delay: env(t) = hypot(x(t), x(t - T/4)). Exact for a steady
 * sine, and far sharper than a sliding RMS bin (a 20 ms RMS window of a 6 Hz sine swings
 * with the sampling phase and fakes dropouts that are not there).
 */
function ampEnv(ts, cs, f) {
  const q = 1 / (4 * f);
  let j = 0;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    while (j + 1 < ts.length && ts[j + 1] <= ts[i] - q) j++;
    out.push({ t: ts[i], a: Math.hypot(cs[i], cs[j]) });
  }
  return out;
}
const dipIn = (e, from, to) => {
  let m = Infinity, mt = null;
  for (const b of e) if (b.t >= from && b.t <= to && b.a < m) { m = b.a; mt = b.t; }
  return { min: m, t: mt };
};
/** Longest stretch (seconds) with |signal| below `level` inside [from,to] — time-domain,
 *  so it stays sharp during a handover where the signal is no longer a clean 6 Hz sine. */
function notchSec(ts, cs, from, to, level) {
  let run = 0, worst = 0, prev = null;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < from || ts[i] > to) continue;
    if (Math.abs(cs[i]) < level) { run += prev == null ? 0 : ts[i] - prev; worst = Math.max(worst, run); }
    else run = 0;
    prev = ts[i];
  }
  return worst;
}

// ── simulation ────────────────────────────────────────────────────────────────

/** Drive the engine on a merged timeline: sensor samples at `fs`, output ticks at `outputHz`. */
function sim(o) {
  const cfg = Object.assign({}, o.cfg);
  const eng = V.createEngine(Object.assign({ gains: o.gains, usable: o.usable }, cfg));
  const fs = o.fs || 60, outHz = o.outputHz || 250, dur = o.dur;
  const jitter = o.jitter || 0, rnd = o.rnd || Math.random;
  const outT = [], outC = [], outPb = [], switchLog = [], sendLog = [];
  let sent = 0, firstSendT = null, nowT = 0;
  let firstFallbackT = null, lastFallbacks = 0;
  eng.onSwitch((from, to) => switchLog.push({ t: nowT, from, to }));

  const nIn = Math.round(dur * fs);
  let nextIn = 0;
  for (let k = 1; ; k++) {
    const tOut = k / outHz;
    if (tOut > dur + 1e-12) break;
    while (nextIn < nIn && nextIn / fs <= tOut + 1e-12) {
      const t = nextIn / fs; nowT = t;
      // The *value* is sampled at the true time; only the reported timestamp is noisy.
      const ts = t + jitter * (rnd() - 0.5) * 2 / fs;
      const d = o.drive(t, nextIn);
      eng.feed(ts, o.rawInput ? d : mkInput(d));
      nextIn++;
    }
    const r = eng.tick(tOut);
    if (r) {
      outT.push(tOut); outC.push(r.cents); outPb.push(r.pb);
      if (r.shouldSend) { sent++; sendLog.push({ t: tOut, pb: r.pb }); if (firstSendT == null) firstSendT = tOut; }
    }
    const fb = eng.output.diagnostics().linearFallbacks;
    if (fb !== lastFallbacks) { if (firstFallbackT == null) firstFallbackT = tOut; lastFallbacks = fb; }
  }
  const d = eng.diagnostics();
  let maxStep = 0, maxStepT = null;
  for (let i = 1; i < outC.length; i++) {
    const st = Math.abs(outC[i] - outC[i - 1]);
    if (st > maxStep) { maxStep = st; maxStepT = outT[i]; }
  }
  return {
    eng, outT, outC, outPb, sent, firstSendT, switchLog, sendLog, diag: d, maxStep, maxStepT,
    firstFallbackT, fallbacks: lastFallbacks, holds: d.holdFallbacks, levels: eng.levels(),
    rate: outT.length > 1 ? (outT.length - 1) / (outT[outT.length - 1] - outT[0]) : 0,
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} ${detail}`);
}
const note = (s) => console.log(`      ${s}`);
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

function sine(chan, f, amp, phase) {
  const ph = phase || 0;
  return (t) => ({ [chan]: amp * Math.sin(TAU * f * t + ph) });
}
function mix(...fns) { return (t) => Object.assign({}, ...fns.map((g) => g(t))); }
const ZERO = () => ({});
const AMP = 20;                                  // deg/s of a "normal vibrato" reference

// ── a phone that is held STILL must sit at exactly 8192 ─────────────────────
// The case the earlier tests never modelled: "silence" was always *perfectly* zero. A real
// phone reports noise on every axis, and with the wrong gains a noisy axis can be louder
// than the vibrato — which is how it showed up on the real device as "after I stop shaking
// the bend never returns to centre".
function noiseRun(o) {
  let seed = o.seed || 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  const gn = o.gyroNoise == null ? 0.5 : o.gyroNoise;      // deg/s
  const an = o.accelNoise == null ? 0.08 : o.accelNoise;   // m/s^2
  return sim({
    gains: o.gains, usable: o.usable, cfg: o.cfg, dur: o.dur || 4,
    rawInput: true,                                   // drive() already returns {gyro, accel}
    drive: () => ({
      gyro: o.noGyro ? null : [2 * gn * rnd(), 2 * gn * rnd(), 2 * gn * rnd()],
      accel: o.noAccel ? null : [2 * an * rnd(), 9.81 + 2 * an * rnd(), 2 * an * rnd()],
    }),
  });
}
{
  const gyroOnly = noiseRun({ gains: V.defaultGains(), usable: V.allUsable(), cfg: { sourceMode: 'gyro' } });
  check('still: noise, gyro channels only', gyroOnly.sent === 0 && gyroOnly.outC.every((c) => c === 0),
    `sent=${gyroOnly.sent}, max|cents|=${peakAbs(gyroOnly.outC, gyroOnly.outT, 0, 4).toFixed(3)}`);
  const auto = noiseRun({ gains: V.defaultGains(), usable: V.allUsable() });
  check('still: noise, automatic source picks the gyro', auto.sent === 0 && auto.outC.every((c) => c === 0)
    && auto.diag.source === 'gyro',
    `source=${auto.diag.source} selected=${auto.diag.channel}, sent=${auto.sent}, `
    + `levels=${JSON.stringify(Object.fromEntries(Object.entries(auto.levels).map(([k, v]) => [k, +v.toFixed(2)])))}`);
}
{
  // Design decision (2026-09-19, after real-device use): this instrument does NOT try to
  // decide which movements are "real vibrato". Every hand movement is mapped faithfully —
  // a slow tilt is a slow pitch movement — because the ordinary vibrato case is already
  // covered by the string library's own vibrato control; what is played here is the gesture.
  // So the guarantees are: (1) a hand at REST gives exactly 0 / 8192, and (2) a moving hand
  // is followed proportionally, at whatever rate it moves.
  const gains = allGains(1);
  const cfg = { nominalCents: 15, depthTrim: 1 };
  // (1) rest → exact centre, after any amount of prior slow movement
  const rest = sim({
    gains, cfg, dur: 4,
    drive: (t) => ({ 'gyro.y': t < 2 ? 25 * Math.sin(TAU * 2 * t) : 0 }),   // shake, then dead still
  });
  const tail = rest.outC.filter((c, i) => rest.outT[i] > 2.6);
  check('rest: a hand that stops ends at exactly 0', tail.length > 50 && tail.every((c) => c === 0),
    `2 Hz sway for 2 s, then still -> ${tail.length} ticks all exactly 0 `
    + `(last centred ${f2(rest.outT[rest.outC.findLastIndex?.((c) => c !== 0) ?? 0])} s)`);
  // (2) faithfulness: same motion amplitude at different rates -> the bandpass's own curve,
  //     i.e. slow motion is followed, just attenuated by the highpass alone.
  const amp = (f, dur) => fit.apply(null, (() => {
    const s = sim({ gains, cfg, dur, drive: (t) => ({ 'gyro.y': 20 * Math.sin(TAU * f * t) }) });
    return [s.outT, s.outC, f, 0.5, dur - 0.1];
  })()).amp;
  const slow = amp(2, 2.5), fast = amp(6, 2.5);
  check('faithful: slow motion is followed, not muted', slow > 15 && Math.abs(slow / fast - 0.92) < 0.05,
    `2 Hz -> ${f2(slow)} cents vs 6 Hz ${f2(fast)} (${(slow / fast * 100).toFixed(0)}% = the highpass `
    + `leak of the filter itself, not a gate decision)`);
  const verySlow = amp(0.9, 6);
  check('faithful: even 0.9 Hz follows', verySlow > 5 && verySlow < 0.6 * fast,
    `0.9 Hz -> ${f2(verySlow)} cents (${(verySlow / fast * 100).toFixed(0)}%: the highpass is the only `
    + `thing shaping how slow a movement still shows up)`);
  // (3) the rate measurement is informational and never gates the output
  const probe = sim({ gains, cfg, dur: 2.5, drive: (t) => ({ 'gyro.y': 20 * Math.sin(TAU * 5 * t) }) });
  check('rate is measured but never gates', Math.abs(probe.diag.oscHz - 5) < 0.4 && probe.sent > 0,
    `${f2(probe.diag.oscHz)} Hz measured, ${probe.sent} messages sent (no gating in the path)`);
}

// ── silence and gating ────────────────────────────────────────────────────────
{
  const s = sim({ gains: allGains(1), dur: 2, drive: ZERO });
  check('silence: 0 messages', s.sent === 0, `sent=${s.sent}`);
  check('silence: cents exactly 0', s.outC.every((c) => c === 0), `max=${peakAbs(s.outC, s.outT, 0, 9)}`);
  check('silence: pb stays 8192', s.outPb.every((p) => p === 8192), `uniq=${[...new Set(s.outPb)].join(',')}`);
}
{
  const quiet = sim({ gains: allGains(1), dur: 2, drive: sine('gyro.y', 6, 2) });
  check('gate: sub-threshold muted', quiet.sent === 0 && quiet.outC.every((c) => c === 0),
    `amp=${f2(quiet.diag.amplitudeCents)} cents over ${quiet.outT.length} ticks`);
}

// ── depth: proportional, and capped ───────────────────────────────────────────
{
  const cfg = { kneeCents: 500, capCents: 500 };
  const amp = [10, 20, 40].map((a) => {
    const s = sim({ gains: allGains(1), cfg, dur: 2.5, drive: sine('gyro.y', 6, a) });
    return fit(s.outT, s.outC, 6, 1.0, 2.4).amp;
  });
  check('linearity: x2', Math.abs(amp[1] / amp[0] - 2) < 0.005, `${f2(amp[0])} -> ${f2(amp[1])} ratio=${(amp[1] / amp[0]).toFixed(3)}`);
  check('linearity: x4', Math.abs(amp[2] / amp[0] - 4) < 0.02, `${f2(amp[0])} -> ${f2(amp[2])} ratio=${(amp[2] / amp[0]).toFixed(3)}`);
}
{
  const s = sim({ gains: allGains(1), dur: 1.5, drive: sine('gyro.y', 8, 300) });
  const p = peakAbs(s.outC, s.outT, 1.0, 1.45);
  check('cap: never exceeds 50 cents', p <= 50 + 1e-9, `peak=${p.toFixed(4)}`);
  check('cap: actually reaches cap', p > 49.9, `peak=${p.toFixed(4)}`);
}

// ── rejection: DC, gyro bias, gravity, slow tilt ──────────────────────────────
{
  const s = sim({
    gains: allGains(1), dur: 2,
    drive: () => ({ 'gyro.x': 50, 'gyro.y': -20, 'accel.x': 5, 'accel.y': 9.81, 'accel.z': -3 }),
  });
  check('reject: constant input -> 0', s.outC.every((c) => c === 0), `amp=${f2(s.diag.amplitudeCents)} cents`);
}
{
  // 0.2 Hz slow sway, +/-50 deg/s. Steady state is |H|~1.8% = 0.9 cents, under the gate.
  const withWarm = sim({ gains: allGains(1), dur: 8, drive: sine('gyro.x', 0.2, 50) });
  const noWarm = sim({ gains: allGains(1), cfg: { warmupSec: 0 }, dur: 8, drive: sine('gyro.x', 0.2, 50) });
  check('reject: 0.2 Hz sway -> muted', withWarm.sent === 0 && withWarm.outC.every((c) => c === 0),
    `sent=${withWarm.sent}, exactly 0 for all 8 s`);
  note(`without warmupSec the same sway blips to ${f2(peakAbs(noWarm.outC, noWarm.outT, 0, 8))} cents `
    + `(${noWarm.sent} messages) in the first ${f2(noWarm.firstSendT)} s — that is what warmupSec removes`);
}
{
  // The slow-motion leak is a property of the 1.5 Hz corner, independent of calibration:
  // cascade |H| relative to the 6 Hz design point for the same raw input. Measured with the
  // oscillation gate disabled, because the gate (not the filter) is what stops a slow sway
  // from reaching the output — see the checks above.
  const cfg = { kneeCents: 500, capCents: 500, vibratoOnly: false };
  const h = (f) => fit.apply(null, (() => {
    const s = sim({ gains: allGains(1), cfg, dur: 2.5, drive: sine('gyro.x', f, AMP) });
    return [s.outT, s.outC, f, 1.0, 2.4];
  })()).amp / AMP;
  const table = [1, 1.5, 2, 3, 4, 5, 6, 7, 8].map((f) => `${f}:${(h(f) / h(6) * 100).toFixed(0)}%`);
  check('leak: 2 Hz passes ~93% of 6 Hz (filter)', Math.abs(h(2) / h(6) - 0.93) < 0.04, `1-8 Hz -> ${table.join(' ')}`);
}

// ── startup and note onset ───────────────────────────────────────────────────
{
  const s = sim({ gains: allGains(1), dur: 2, drive: sine('gyro.y', 6, AMP) });
  const steady = fit(s.outT, s.outC, 6, 1.4, 1.95).amp;
  let tOpen = null, tFull = null;
  for (let i = 0; i < s.outT.length; i++) {
    if (tOpen == null && Math.abs(s.outC[i]) > 0.01) tOpen = s.outT[i];
    if (tFull == null && Math.abs(s.outC[i]) > 0.9 * steady) tFull = s.outT[i];
  }
  check('startup: live within 0.9 s (once)', tFull != null && tFull < 0.9,
    `gate opens ${f2(tOpen * 1000)} ms, full depth ${f2(tFull * 1000)} ms after sensor start`);
}
{
  // Musically what matters: vibrating *again* after a rest must not wait for the warm-up.
  const s = sim({
    gains: allGains(1), dur: 2.5,
    drive: (t) => (t < 1.0 ? {} : { 'gyro.y': AMP * Math.sin(TAU * 6 * (t - 1.0)) }),
  });
  const steady = fit(s.outT, s.outC, 6, 1.8, 2.45).amp;
  let t90 = null;
  for (let i = 0; i < s.outT.length; i++) {
    if (s.outT[i] > 1.0 && Math.abs(s.outC[i]) > 0.9 * steady) { t90 = s.outT[i]; break; }
  }
  check('onset: 90% depth < 200 ms after rest', t90 != null && t90 - 1.0 < 0.2,
    `${f2((t90 - 1.0) * 1000)} ms (depth ${f2(steady)} cents)`);
}

// ── channel selection ────────────────────────────────────────────────────────
{
  const s = sim({
    gains: allGains(1), dur: 2,
    drive: mix(sine('gyro.y', 6, AMP), sine('gyro.x', 6, 10), sine('accel.x', 6, 5), sine('accel.z', 6, 2)),
  });
  check('select: picks strongest channel', s.diag.channel === 'gyro.y', `channel=${s.diag.channel} switches=${s.diag.switches}`);
  check('select: no spurious switching', s.diag.switches === 1, `switches=${s.diag.switches}`);
  const L = s.levels;
  check('select: levels are cents-comparable', Math.abs(L['gyro.y'] - 2 * L['gyro.x']) < 0.5,
    `gyro.y=${f2(L['gyro.y'])} gyro.x=${f2(L['gyro.x'])} accel.x=${f2(L['accel.x'])} accel.z=${f2(L['accel.z'])}`);
}
{
  const cfg = { sourceMode: 'accel' };
  const s = sim({ gains: allGains(1), cfg, dur: 1.5, drive: mix(sine('gyro.y', 6, 40), sine('accel.x', 6, 10)) });
  check('mode: source=accel only', s.diag.channel === 'accel.x', `channel=${s.diag.channel}`);
  const s2 = sim({ gains: allGains(1), cfg: { axisMode: 'z' }, dur: 1.5, drive: mix(sine('gyro.y', 6, 40), sine('gyro.z', 6, 10), sine('accel.z', 6, 5)) });
  check('mode: axis=z only', s2.diag.channel === 'gyro.z', `channel=${s2.diag.channel}`);
}

// ── handover: axis dominance changes while playing ───────────────────────────
/** Metrics only (no assertions) so the tuning sweep can reuse it. */
function handoverRun(cfgExtra, secondSign, tapered) {
  const PH = 25;
  const dur = 2.6;
  const TAP = 0.06;                                       // a grip change takes ~60 ms
  const w = (t) => Math.max(0, Math.min(1, (t - (1.2 - TAP / 2)) / TAP));
  const s = sim({
    gains: allGains(1), cfg: cfgExtra, dur,
    drive: (t) => {
      const a = PH * Math.sin(TAU * 6 * t);
      // Realistic: the rotation keeps going, it just projects onto another axis, so the two
      // raw signals cross over. Stress: the old axis dies in one sample (a 1500 deg/s^2
      // step that no hand produces) while the new one appears at full size.
      return tapered
        ? { 'gyro.x': a * (1 - w(t)), 'gyro.y': secondSign * a * w(t) }
        : (t < 1.2 ? { 'gyro.x': a } : { 'gyro.y': secondSign * a });
    },
  });
  const steady = fit(s.outT, s.outC, 6, 1.7, 2.5).amp;
  const e = ampEnv(s.outT, s.outC, 6);
  const full = Math.max(...e.filter((b) => b.t > 1.7).map((b) => b.a));
  const sw = s.switchLog.find((x) => x.to === 'gyro.y');
  const dip = dipIn(e, (sw ? sw.t : 1.2) - 0.05, (sw ? sw.t : 1.2) + 0.4);
  // How long the pitch excursion stops reaching 40% of its full size — the audible
  // question at a handover. (The geometric dip to ~50% at the crossover is unavoidable
  // for a selector that follows one axis at a time.)
  const notch = sw ? notchSec(s.outT, s.outC, sw.t - 0.05, sw.t + 0.4, 0.4 * full) : 0;
  let recoverT = null;
  if (sw) {
    for (let i = 0; i < s.outT.length; i++) {
      if (s.outT[i] > sw.t && Math.abs(s.outC[i]) > 0.9 * full) { recoverT = s.outT[i] - sw.t; break; }
    }
  }
  return {
    s, e, steady, full, sw: sw ? sw.t : null, dip: dip.min, notch, recoverT,
    nSwitch: s.switchLog.filter((x) => x.to === 'gyro.y').length, realigns: s.diag.realigns,
  };
}
function handoverTest(label, secondSign, tapered) {
  const r = handoverRun(undefined, secondSign, tapered);
  const { s, steady, full, dip, notch } = r;
  const shape = `switch ${f2(r.sw)} s, depth ${f2(steady)}/${f2(25 * 0.954)} c, realigns=${s.diag.realigns}`
    + `, step ${f2(s.maxStep)} c@${f2(s.maxStepT)} s, notch ${f2(notch * 1000)} ms (${f2(dip)} c)`;
  if (!tapered) { note(`stress(${label}, axis dies in one sample): ${shape}`); return r; }
  check(`handover(${label}): one switch, depth restored`,
    r.nSwitch === 1 && steady > 0.9 * 25 * 0.954, shape);
  // A hard selector follows one axis, so at the crossover each axis is only
  // 25*cos/sin(theta) deg/s: the depth dip to ~half is geometry, not a defect. What must not
  // happen is a *pitch* jump, a long dropout, or a lost direction.
  check(`handover(${label}): no pitch jump, quick recovery`,
    s.maxStep < 4.5 && s.fallbacks === 0 && notch < 0.12 && r.recoverT != null && r.recoverT < 0.25,
    `max step ${f2(s.maxStep)} c (natural slope 3.6), interpolation fallbacks=${s.fallbacks}, `
    + `below 40% depth for ${f2(notch * 1000)} ms, back to 90% ${f2(r.recoverT * 1000)} ms after the switch`);
  return r;
}
/** Two steady comparable channels (ratio wanders 1.06x..1.24x) must never flicker. */
function comparableRun(cfgExtra) {
  const dur = 3.0;
  const s = sim({
    gains: allGains(1), cfg: cfgExtra, dur,
    drive: (t) => ({
      'gyro.x': 20 * Math.sin(TAU * 6 * t),
      'gyro.y': 23 * (1 + 0.08 * Math.sin(TAU * 0.7 * t)) * Math.sin(TAU * 6 * t),
    }),
  });
  return { switches: s.switchLog.filter((x) => x.from !== null).length, s };
}
{
  const r = handoverTest('in-phase', +1, true);
  note('depth envelope @40 ms: ' + r.e.filter((b) => b.t >= 1.05 && b.t <= 1.55 && Math.round(b.t * 1000) % 40 < 4)
    .map((b) => `${(b.t * 1000).toFixed(0)}:${b.a.toFixed(1)}`).join(' '));
  handoverTest('anti-phase', -1, true);
  handoverTest('in-phase', +1, false);
  handoverTest('anti-phase', -1, false);
  const c = comparableRun(undefined);
  check('select: comparable channels do not flicker', c.switches === 0,
    `${c.switches} switches with a 0.87x..1.15x challenger over 3 s (channel=${c.s.diag.channel})`);
}
{
  note('levelWindowSec sweep (60 ms crossover, 25 deg/s 6 Hz) — why 0.15 is the default:');
  for (const lw of [0.15, 0.10, 0.06]) {
    const a = handoverRun({ levelWindowSec: lw }, +1, true);
    const b = handoverRun({ levelWindowSec: lw }, -1, true);
    const c = comparableRun({ levelWindowSec: lw });
    const h = (() => {
      const s = sim({
        gains: allGains(1), cfg: { levelWindowSec: lw }, dur: 2.2,
        drive: (t) => ({ 'gyro.x': AMP * Math.sin(TAU * 6 * t), 'gyro.y': (t >= 1.0 ? 24 : 0) * Math.sin(TAU * 6 * t) }),
      });
      return s.switchLog.filter((x) => x.to === 'gyro.y').length;
    })();
    note(`  lw=${lw.toFixed(2)}: switch ${f2(a.sw)} s, notch ${f2(a.notch * 1000)} ms, dip ${f2(a.dip)}/${f2(a.full)}`
      + `, step ${f2(a.s.maxStep)}, anti-phase realigns=${b.realigns} notch ${f2(b.notch * 1000)}`
      + `, 1.2x challenger switches=${h}, comparable switches=${c.switches}`);
  }
}
{
  // Hysteresis: a marginal challenger is ignored, a strong one wins after the hold.
  const s = sim({
    gains: allGains(1), dur: 3.4,
    drive: (t) => {
      const x = { 'gyro.x': AMP * Math.sin(TAU * 6 * t) };
      if (t >= 1.0) x['gyro.y'] = 24 * Math.sin(TAU * 6 * t);
      if (t >= 2.0) x['gyro.y'] = 34 * Math.sin(TAU * 6 * t);
      return x;
    },
  });
  const toY = s.switchLog.filter((x) => x.to === 'gyro.y');
  check('hysteresis: 1.2x blocked, 1.7x wins', toY.length === 1 && toY[0].t > 2.1,
    `log=${s.switchLog.map((x) => `${f2(x.t)}->${x.to}`).join(' ')} (1.7x from t=2.0 + 150 ms hold)`);
}
{
  const s = sim({
    gains: allGains(1), dur: 2.4,
    drive: (t) => (t < 1.2
      ? { 'gyro.x': AMP * Math.sin(TAU * 6 * t) }
      : {}),
  });
  const e = ampEnv(s.outT, s.outC, 6);
  const last = e.filter((b) => b.t > 2.2).reduce((a, b) => Math.max(a, b.a), 0);
  check('rescue: silence -> exact 0, no residue', s.sent > 0 && last === 0 && s.outPb[s.outPb.length - 1] === 8192,
    `tail |cents|=${last}, final pb=${s.outPb[s.outPb.length - 1]} after ${s.sent} messages`);
}

// ── usability and calibration defaults ───────────────────────────────────────
{
  const s = sim({ gains: allGains(1), usable: { 'gyro.y': false }, dur: 2, drive: mix(sine('gyro.y', 6, 40), sine('gyro.x', 6, 8)) });
  check('unusable: skipped when loudest', s.diag.channel === 'gyro.x',
    `channel=${s.diag.channel} (gyro.y level ${f2(s.levels['gyro.y'])} > gyro.x ${f2(s.levels['gyro.x'])})`);
}
{
  const s = sim({ gains: allGains(1), usable: Object.fromEntries(IDS.map((id) => [id, false])), dur: 1.5, drive: sine('gyro.y', 6, 40) });
  check('unusable: all-false is silent', s.sent === 0 && s.outC.every((c) => c === 0), `sent=${s.sent}`);
}
{
  const s = sim({ gains: allGains(0), dur: 1.5, drive: sine('gyro.y', 6, 40) });
  check('zero gain: silent by default', s.sent === 0 && s.outC.every((c) => c === 0), `sent=${s.sent}`);
}

// ── output stage ─────────────────────────────────────────────────────────────
{
  const s = sim({ gains: allGains(1), dur: 2, drive: sine('gyro.y', 6, AMP) });
  const d = s.eng.output.diagnostics();
  check('rate: output ~250 Hz', Math.abs(s.rate - 250) < 5, `${f2(s.rate)} Hz (sensor ${f2(d.inputRateHz)} Hz)`);
  check('rate: no interpolation failure', s.fallbacks === 0,
    `linear fallbacks=${s.fallbacks}, zero-order holds=${s.holds} (${(s.holds / s.outT.length * 100).toFixed(1)}% of ticks)`);
  const amp = fit(s.outT, s.outC, 6, 1.0, 1.95).amp;
  const analytic = amp * TAU * 6 / 250;
  check('rate: step matches analytic slope', Math.abs(d.p95StepCents / analytic - 1) < 0.25,
    `p95=${f2(d.p95StepCents)} cents/tick vs analytic ${f2(analytic)} (=${f2(d.p95StepCents * 40.96)} counts)`);
  // What actually matters about minStepCounts: the DAW only ever sees the *sent* values, so
  // reconstruct its view as a zero-order hold and compare with the ideal waveform.
  let j = 0, sum = 0, n = 0, worst = 0;
  for (let i = 0; i < s.outT.length; i++) {
    const t = s.outT[i];
    if (t < 1.0 || t > 1.95) continue;
    while (j + 1 < s.sendLog.length && s.sendLog[j + 1].t <= t) j++;
    const errCents = (s.sendLog[j].pb - s.outPb[i]) / 40.96;
    sum += errCents * errCents; n++; worst = Math.max(worst, Math.abs(errCents));
  }
  check('rate: dedup leaves no staircase', Math.sqrt(sum / n) < 0.2,
    `sent ${s.sent}/${s.outT.length} ticks; held-value error ${Math.sqrt(sum / n).toFixed(3)} cents RMS, worst ${worst.toFixed(3)}`);
}
{
  const amps = [60, 100, 200].map((fs) => fit.apply(null, (() => {
    const s = sim({ gains: allGains(1), fs, dur: 2, drive: sine('gyro.y', 6, AMP) });
    return [s.outT, s.outC, 6, 1.0, 1.95];
  })()).amp);
  const spread = (Math.max(...amps) - Math.min(...amps)) / amps[0];
  check('rate: sensor 60/100/200 Hz agree', spread < 0.03, `${amps.map(f2).join(' / ')} cents (spread ${(spread * 100).toFixed(1)}%)`);
}
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [0, 0.1, 0.3].map((j) => {
    const s = sim({
      gains: allGains(1), dur: 2, fs: 60,
      drive: (t) => ({ 'gyro.y': AMP * Math.sin(TAU * 6 * t) }),
      jitter: j, rnd,
    });
    return fit(s.outT, s.outC, 6, 1.0, 1.95).rmsErr;
  });
  check('jitter: shape error stays small', out[0] < 0.15 && out[1] < 1.2 && out[2] < 2.5,
    `${out.map((x) => x.toFixed(3)).join(' / ')} cents RMS @0/10/30% timestamp jitter`);
}

// ── protocol: Bridge value and DAW readout ───────────────────────────────────
{
  const s = sim({ gains: allGains(1), cfg: { kneeCents: 500, capCents: 500 }, dur: 1.5, drive: sine('gyro.y', 6, 31.4) });
  const a = fit(s.outT, s.outC, 6, 1.0, 1.45).amp;
  const win = s.outT.map((t, i) => ({ t, c: s.outC[i], pb: s.outPb[i] })).filter((x) => x.t >= 1.0);
  const hi = win.reduce((p, q) => (q.c > p.c ? q : p));
  const lo = win.reduce((p, q) => (q.c < p.c ? q : p));
  check('pb: 30 cents -> 1229 counts / +-15 display (conversion only)',
    a > 28.5 && a < 31.5 && Math.abs(hi.pb - 8192 - 1229) < 25 && Math.abs(8192 - lo.pb - 1229) < 25,
    `amp=${f2(a)} c: peak pb ${hi.pb} (+${hi.pb - 8192}, display ${f2(V.centsToDawDisplay(hi.c, 2))}), `
    + `valley pb ${lo.pb} (-${8192 - lo.pb}); the calibrated nominal is `
    + `${V.DEFAULTS.nominalCents} cents, this drives the gain-1 chain directly`);
  check('pb: t round-trip', Math.abs(V.tToCents(V.centsToT(30, 2), 2) - 30) < 1e-9 && V.centsToT(0, 2) === 0.5,
    `t(30c)=${V.centsToT(30, 2)} t(0c)=${V.centsToT(0, 2)}`);
}

// ── P4: one-time calibration ─────────────────────────────────────────────────
function capture(o) {
  const fs = o.fs || 60, dur = o.dur || 5;
  const out = [];
  for (let k = 0; k < Math.round(dur * fs); k++) {
    const t = k / fs;
    const v = o.vibrato || {};
    const g = [o.gyroZ ? o.gyroZ(t) : 0, 0, 0], a = [0, 0, 0];
    for (const id of Object.keys(v)) {
      const val = v[id](t);
      if (id.startsWith('gyro')) g[META[id].index] = val; else a[META[id].index] = val;
    }
    // `acceleration` is gravity-removed in the design, but a device that only exposes
    // accelerationIncludingGravity still works because the bandpass kills the constant.
    if (o.accelGravity) a[2] = 9.81;
    out.push({ t, gyro: o.noGyro ? null : g, accel: a });
  }
  return out;
}
/** Run the engine over a capture with the given gains/usable, in the sim's tick cadence. */
function runCapture(cap, gains, usable, cfgExtra) {
  const fs = (cap.length - 1) / (cap[cap.length - 1].t - cap[0].t);
  return sim({
    gains, usable, cfg: cfgExtra, dur: cap[cap.length - 1].t, fs: Math.round(fs),
    rawInput: true, drive: (t, k) => cap[Math.min(k, cap.length - 1)],
  });
}
{
  const VIB = 22, VIBX = 8, VIBACC = 1.2;
  const cap = capture({
    vibrato: {
      'gyro.y': (t) => VIB * Math.sin(TAU * 6 * t),
      'gyro.x': (t) => VIBX * Math.sin(TAU * 6 * t),
      'accel.y': (t) => VIBACC * Math.sin(TAU * 6 * t),
    },
    gyroZ: (t) => 15 * Math.sin(TAU * 0.3 * t),          // slow sway: must not be calibrated
    accelGravity: true,
    noGyro: false,
  });
  const cal = V.calibrate(cap);
  check('calib: ok, gyro source, strongest channel', cal.ok && cal.source === 'gyro' && cal.primary === 'gyro.y',
    `primary=${cal.primary} source=${cal.source} rate=${f2(cal.rateHz)} Hz fs=${f2(cal.fs)} Hz over ${f2(cal.spanSec)} s`);
  check('calib: rate measured from the capture', Math.abs(cal.rateHz - 6) < 0.25, `${f2(cal.rateHz)} Hz (true 6.00)`);
  check('calib: levels are post-bandpass cents',
    Math.abs(cal.levels['gyro.y'] / (VIB * 0.954) - 0.98) < 0.03,
    `gyro.y=${f2(cal.levels['gyro.y'])} (${(cal.levels['gyro.y'] / (VIB * 0.954) * 100).toFixed(1)}% of the sine `
    + `amplitude ${f2(VIB * 0.954)}: the window-peak statistic reads ~2% low, and the gain absorbs it), `
    + `gyro.x=${f2(cal.levels['gyro.x'])}, gyro.z=${f2(cal.levels['gyro.z'])} (0.3 Hz sway -> filtered), accel.y=${f2(cal.levels['accel.y'])}`);
  check('calib: usable within 20 dB, others rejected',
    cal.usable['gyro.y'] && cal.usable['gyro.x'] && !cal.usable['gyro.z'] && !cal.usable['accel.y'] && !cal.usable['accel.z'],
    `usable=${IDS.filter((id) => cal.usable[id]).join(',')}`);
  check('calib: gains target nominalCents on every usable channel',
    Math.abs(cal.gains['gyro.y'] * cal.levels['gyro.y'] - 15) < 0.01 && Math.abs(cal.gains['gyro.x'] * cal.levels['gyro.x'] - 15) < 0.01,
    `gyro.y gain=${cal.gains['gyro.y'].toFixed(4)}, gyro.x gain=${cal.gains['gyro.x'].toFixed(4)} (unusable -> ${cal.gains['gyro.z'].toFixed(4)})`);
  // End to end: the engine, fed the calibration, must produce a 15 cent vibrato.
  const s = runCapture(cap, cal.gains, cal.usable, { nominalFs: Math.round(cal.fs) });
  const amp = fit(s.outT, s.outC, 6, 3.0, 4.9).amp;
  check('calib: end-to-end depth is 15 cents', Math.abs(amp - 15) < 0.5,
    `fitted ${f2(amp)} cents through the full chain (target 15, cap 50)`);
}
{
  // The depth trim scales the *output*, ceiling included, without touching the gate.
  const cap = capture({ vibrato: { 'gyro.y': (t) => 22 * Math.sin(TAU * 6 * t) }, accelGravity: true });
  const cal = V.calibrate(cap);
  const at = (trim) => fit.apply(null, (() => {
    const s = runCapture(cap, cal.gains, cal.usable, { nominalFs: Math.round(cal.fs), depthTrim: trim });
    return [s.outT, s.outC, 6, 3.0, 4.9];
  })()).amp;
  const half = at(0.5), full = at(1), double = at(2);
  check('depth trim: 0.5 halves the mapped value', Math.abs(full / 2 - half) < 0.15,
    `${f2(full)} cents at x1 -> ${f2(half)} at x0.5, ${f2(double)} at x2`);
  const loud = sim({ gains: allGains(1), cfg: { depthTrim: 0.5 }, dur: 1.5, drive: sine('gyro.y', 8, 300) });
  const pk = peakAbs(loud.outC, loud.outT, 1.0, 1.45);
  check('depth trim: cap scales down too', Math.abs(pk - 25) < 0.05, `x0.5 -> peak ${pk.toFixed(2)} cents (cap 50 x 0.5)`);
  const loud2 = sim({ gains: allGains(1), cfg: { depthTrim: 2 }, dur: 1.5, drive: sine('gyro.y', 8, 300) });
  check('depth trim: the hard cap still holds above x1', peakAbs(loud2.outC, loud2.outT, 1.0, 1.45) <= 50 + 1e-9,
    `x2 -> peak ${peakAbs(loud2.outC, loud2.outT, 1.0, 1.45).toFixed(2)} cents (never past cap 50)`);
  const still = sim({ gains: allGains(1), cfg: { depthTrim: 0.5 }, dur: 2, drive: ZERO });
  check('depth trim: silence stays silent', still.sent === 0 && still.outC.every((c) => c === 0), `sent=${still.sent}`);
  const quiet = sim({ gains: allGains(1), cfg: { depthTrim: 0.5 }, dur: 2, drive: sine('gyro.y', 6, 2) });
  check('depth trim: the gate still tracks the hand', quiet.sent === 0,
    `2 deg/s stays muted at x0.5 (effort ${f2(quiet.diag.effortCents)} cents vs gate 3)`);
}
{
  // An older calibration (fitted for 30 cents) must rescale itself on load, not double up.
  const store = new Map();
  const win = global.window;
  global.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  const old = {
    v: 1, ok: true, source: 'gyro', primary: 'gyro.y', rateHz: 6, fs: 60,
    levels: { 'gyro.y': 21 }, gains: Object.fromEntries(IDS.map((id) => [id, id === 'gyro.y' ? 30 / 21 : 0])),
    usable: Object.fromEntries(IDS.map((id) => [id, id === 'gyro.y'])), spanSec: 5, samples: 300,
  };
  store.set('pm.vibrato.cal.v1', JSON.stringify(old));
  const loaded = V.loadCalibration();
  global.window = win;
  check('legacy cal: rescales 30 -> 15 on load',
    loaded && Math.abs(loaded.gains['gyro.y'] - 15 / 21) < 1e-9 && loaded.rescaledFrom === 30,
    `stored ${(30 / 21).toFixed(4)} -> loaded ${loaded.gains['gyro.y'].toFixed(4)} `
    + `(nominal ${loaded.nominalCents}, rescaledFrom ${loaded.rescaledFrom})`);
}
{
  // A quiet phone on the x axis only: the calibration must follow the axis dominance.
  const cap = capture({ vibrato: { 'gyro.x': (t) => 9 * Math.sin(TAU * 5.5 * t) }, accelGravity: true });
  const cal = V.calibrate(cap);
  const s = runCapture(cap, cal.gains, cal.usable);
  const amp = fit(s.outT, s.outC, 5.5, 3.0, 4.9).amp;
  check('calib: follows the dominant axis', cal.primary === 'gyro.x' && Math.abs(amp - 15) < 0.5,
    `primary=${cal.primary}, ${f2(amp)} cents at 5.5 Hz, usable=${IDS.filter((id) => cal.usable[id]).join(',') || 'none'}`);
}
{
  // No gyro at all: linear acceleration must take over.
  const cap = capture({ vibrato: { 'accel.y': (t) => 2.5 * Math.sin(TAU * 6.5 * t) }, noGyro: true, accelGravity: true });
  const cal = V.calibrate(cap);
  check('calib: accel fallback when no gyro', cal.ok && cal.source === 'accel' && cal.primary === 'accel.y',
    `source=${cal.source} primary=${cal.primary} level=${f2(cal.levels['accel.y'])} rate=${f2(cal.rateHz)} Hz`);
}
{
  const silent = V.calibrate(capture({ accelGravity: true }));
  const short = V.calibrate(capture({ vibrato: { 'gyro.y': (t) => 20 * Math.sin(TAU * 6 * t) }, dur: 1.0, accelGravity: true }));
  const fast = V.calibrate(capture({ vibrato: { 'gyro.y': (t) => 20 * Math.sin(TAU * 16 * t) }, accelGravity: true }));
  const slow = V.calibrate(capture({ vibrato: { 'gyro.y': (t) => 20 * Math.sin(TAU * 1.5 * t) }, accelGravity: true }));
  check('calib: rejects silence / short / wrong rate',
    silent.reason === 'too_quiet' && short.reason === 'too_short' && fast.reason === 'rate' && slow.reason === 'rate',
    `silence=${silent.reason}, 1 s=${short.reason}, 16 Hz=${fast.reason} (${f2(fast.rateHz)}), 1.5 Hz=${slow.reason} (${f2(slow.rateHz)})`);
  check('calib: rejected captures set no gains', IDS.every((id) => fast.gains[id] === 0 && !fast.usable[id]),
    `gains all 0 after a rejected capture`);
}

// ── latency: measured, not assumed ──────────────────────────────────────────
/** RBJ highpass phase at f (degrees), same coefficients the code builds. */
function hpPhaseDeg(f, fc, q, dt) {
  const w0 = TAU * Math.min(fc, 0.45 / dt) * dt;
  const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * q), a0 = 1 + alpha;
  const b = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0];
  const a = [1, -2 * cw / a0, (1 - alpha) / a0];
  const w = TAU * f * dt;
  let nr = 0, ni = 0, dr = 0, di = 0;
  for (let k = 0; k < 3; k++) {
    nr += b[k] * Math.cos(-k * w); ni += b[k] * Math.sin(-k * w);
    dr += a[k] * Math.cos(-k * w); di += a[k] * Math.sin(-k * w);
  }
  return (Math.atan2(ni, nr) - Math.atan2(di, dr)) * 180 / Math.PI;
}
/** One-pole lowpass phase at f. */
function lpPhaseDeg(f, fc, dt) {
  const a = 1 - Math.exp(-TAU * Math.min(fc, 0.45 / dt) * dt);
  const w = TAU * f * dt;
  const dr = 1 - (1 - a) * Math.cos(-w), di = -(1 - a) * Math.sin(-w);
  return (0 - Math.atan2(di, dr)) * 180 / Math.PI;
}
/** Phase delay of the cascade, in ms (a phase advance gives a negative delay). */
function bandpassPhaseMs(f, cfg) {
  const c = Object.assign({}, V.DEFAULTS, cfg);
  const dt = 1 / c.nominalFs;
  const deg = hpPhaseDeg(f, c.hpHz, c.hpQ, dt) + lpPhaseDeg(f, c.lpHz, dt);
  return -deg / (360 * f) * 1000;
}
/** Group delay (what a change of *depth* experiences) by numerical differentiation. */
function bandpassGroupMs(f, cfg) {
  const h = f * 1e-3;
  const phi = (x) => -TAU * x * bandpassPhaseMs(x, cfg) / 1000;   // radians
  return -(phi(f + h) - phi(f - h)) / (2 * h) / TAU * 1000;
}
{
  // 1. Validate the estimator on a synthetic signal with a known delay (no engine in the way).
  const ts = [], cs = [];
  for (let k = 1; k <= 500; k++) { const t = k / 250; ts.push(t); cs.push(AMP * Math.sin(TAU * 6 * (t - 0.02))); }
  const r0 = fit(ts, cs, 6, 0.5, 1.9);
  const known = -Math.atan2(r0.B, r0.A) / TAU / 6 * 1000;
  check('latency: estimator recovers a known 20 ms', Math.abs(known - 20) < 0.5, `measured ${known.toFixed(2)} ms`);

  // 2. Measure the chain, and check every term against its analytic value.
  const meas = (cfgExtra) => {
    const s = sim({ gains: allGains(1), cfg: cfgExtra, dur: 2.5, drive: sine('gyro.y', 6, AMP) });
    const r = fit(s.outT, s.outC, 6, 1.0, 2.4);
    return { tau: -Math.atan2(r.B, r.A) / TAU / 6 * 1000, err: r.rmsErr, amp: r.amp };
  };
  const on = meas(undefined);
  const off = meas({ interpolate: false });
  const predFilter = bandpassPhaseMs(6, {});
  const sampleMs = 1000 / 60;
  check('latency: bandpass phase delay matches theory',
    Math.abs((on.tau - predFilter) - sampleMs) < 1.0,
    `total ${on.tau.toFixed(1)} ms = interpolation point ${sampleMs.toFixed(1)} + cascade ${predFilter.toFixed(1)} `
    + `(analytic; the 1.5 Hz highpass advances the phase more than the 15 Hz lowpass lags it)`);
  check('latency: a held sample is half a sample cheaper',
    Math.abs(off.tau - (sampleMs / 2 + predFilter)) < 1.0,
    `held ${off.tau.toFixed(1)} ms = half a sample ${(sampleMs / 2).toFixed(1)} + cascade ${predFilter.toFixed(1)}`);
  check('latency: interpolation buys waveform accuracy', on.err < 0.2 && off.err > 2 && off.err < 12,
    `shape error ${on.err.toFixed(2)} cents interpolated vs ${off.err.toFixed(2)} cents held`);
  check('latency: same depth either way', Math.abs(on.amp - off.amp) < 0.5,
    `amplitude ${f2(on.amp)} vs ${f2(off.amp)} cents`);
  note(`latency budget at 6 Hz: sample interval +${sampleMs.toFixed(1)} ms, cascade phase `
    + `${predFilter.toFixed(1)} ms (group ${bandpassGroupMs(6, {}).toFixed(1)} ms — what a depth change feels), `
    + `WiFi/Bridge ~2 ms, DAW block ~1.3 ms`);
}

// ── note onset vs the gate ramp ─────────────────────────────────────────────
{
  // The ramp is the dominant *perceived* lag (a constant phase delay of a periodic vibrato
  // is inaudible; how fast the depth blooms is not). It is quantised at the sensor rate, so
  // fewer steps means a faster onset but a coarser amplitude stair.
  note('gateMinSteps trade-off (silence → 6 Hz vibrato, 18.8 cents):');
  for (const gms of [6, 5, 4, 3, 2]) {
    const s = sim({
      gains: allGains(1), cfg: { gateMinSteps: gms }, dur: 2.5,
      drive: (t) => (t < 1.0 ? {} : { 'gyro.y': AMP * Math.sin(TAU * 6 * (t - 1.0)) }),
    });
    const steady = fit(s.outT, s.outC, 6, 1.8, 2.45).amp;
    let t90 = null, stepOn = 0;
    for (let i = 0; i < s.outT.length; i++) {
      if (s.outT[i] > 1.0 && s.outT[i] < 1.4 && i > 0) stepOn = Math.max(stepOn, Math.abs(s.outC[i] - s.outC[i - 1]));
      if (t90 == null && s.outT[i] > 1.0 && Math.abs(s.outC[i]) > 0.9 * steady) t90 = s.outT[i] - 1.0;
    }
    note(`  steps=${gms}: onset to 90% ${f2(t90 * 1000)} ms, worst step during onset ${f2(stepOn)} cents `
      + `(natural slope ${f2(steady * TAU * 6 / 250)})`);
  }
}

// ── safety: a stalled sensor must not leave the DAW bent ────────────────────
{
  const eng = V.createEngine({ gains: allGains(1) });
  let now = 0;
  const sentLog = [];
  let stopFeedAt = 1.0;
  for (let k = 1; k / 250 <= 2.0; k++) {
    const tOut = k / 250;
    while (now <= tOut && now <= stopFeedAt) { eng.feed(now, { gyro: [0, AMP * Math.sin(TAU * 6 * now), 0] }); now += 1 / 60; }
    const r = eng.tick(tOut);
    if (r && r.shouldSend) sentLog.push({ t: tOut, pb: r.pb, cents: r.cents });
  }
  const after = sentLog.filter((s) => s.t > 1.2);
  const first = after[0];
  check('stall: sensor stops -> exactly one centring message',
    first && first.pb === 8192 && after.length === 1 && first.t - stopFeedAt < 0.4,
    `centred at +${f2((first.t - stopFeedAt) * 1000)} ms with pb=${first.pb}, ${after.length} message(s) after 1.2 s`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) { console.log('FAILED: ' + bad.map((b) => b.name).join(', ')); process.exit(1); }
