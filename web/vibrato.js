// Phone MIDI — Mode C vibrato engine
// ===================================
// Simulates a violin vibrato from the phone's 6-axis IMU (gyroscope + linear acceleration).
//
//   devicemotion
//     → 6 channels (gyro x/y/z, accel x/y/z)
//     → per channel: bandpass (HP2 hpHz + LP1 lpHz) → × gain_i   [cents]
//     → select the strongest channel (hysteresis + crossfade)
//     → soft limit (linear ≤ kneeCents, asymptote capCents)
//     → amplitude gate (exact 0 when not shaking)
//     → 250 Hz quadratic interpolation (1 sample causal delay), clamped to ±capCents
//     → t ∈ [0,1] → Bridge → 14-bit pitch bend
//
// Design: docs/spec/mode-c-vibrato.md.
//
// Why per-channel gains: a gyroscope reads °/s and an accelerometer reads m/s²; the two
// cannot be compared. Calibrating each channel to "normal vibrato = nominalCents" puts
// every channel in the same unit, so picking the strongest one is meaningful and
// switching between them does not change the depth.
//
// Why no runtime adaptation: an estimator that normalises to the player's habitual effort
// severs the link between how hard you shake and how far the pitch moves. Gains are
// calibrated once and then constant.
//
// No DOM, no globals: the whole chain is unit-testable on a computer with synthetic input.

(function (global) {
  'use strict';

  const DEFAULTS = {
    // ── per-channel bandpass ─────────────────────────────────────────────────
    hpHz: 1.5,            // removes gravity, gyro bias and slow tilt. DC gain is 0,
                          // which is what makes centring automatic.
    hpQ: Math.SQRT1_2,
    lpHz: 15.0,           // band-limits the signal for the interpolator

    // ── depth / limiting (all in cents) ──────────────────────────────────────
    // Violin-family vibrato is ±10–25 cents in practice; ±30 (the first estimate) played
    // as too wide a swing in the DAW, so the calibration target is ±15.
    nominalCents: 15,     // calibration target: "normal vibrato effort" → this depth
    kneeCents: 35,        // linear up to here…
    capCents: 50,         // …asymptotic to here, and hard-clamped after interpolation
    depthTrim: 1.0,       // runtime scale on the OUTPUT (after limiting): 0.5 halves the
                          // whole mapping, ceiling included, without re-calibrating

    // The gate is a REST detector, not a gesture classifier. This instrument maps every hand
    // movement faithfully — slow tilts included — because the ordinary vibrato case is
    // already covered by the string library's own vibrato control; what is being played here
    // is the gesture itself. Below gateCents the hand is at rest: output exactly 0 (the DAW
    // sits at centre). Above it, whatever the hand does is sent as pitch.
    gateCents: 3,
    gateWindowSec: 0.15,  // …judged over a sliding window peak (frequency-independent)
    gateRampSec: 0.04,    // then ramp to exactly 0 over this
    gateMinSteps: 5,      // …but never fewer than this many ramp quanta. The ramp advances
                          // once per SENSOR sample: at 60 Hz a 40 ms ramp is only 2.4 steps,
                          // i.e. a 42% amplitude step, and the quadratic interpolator turns
                          // such a corner into an overshoot (measured 9.7 cents vs a 2.9
                          // cent natural step). 5 steps caps the jump at 20% of depth.

    // ── motion rate measurement (diagnostics only, never gates anything) ─────
    oscWindowSec: 0.5,    // no crossing for this long ⇒ the hand stopped
    oscCents: 0.5,        // hysteresis floor for counting a crossing (cents)…
    oscRatio: 0.25,       // …and relative to the current amplitude, so noise cannot fake it

    // ── channel selection ───────────────────────────────────────────────────
    levelWindowSec: 0.15, // per-channel level window (peak of |cents|)
    switchMargin: 1.3,    // the challenger must be this much stronger…
    switchHoldSec: 0.15,  // …for this long before a switch starts
    crossfadeSec: 0.06,   // linear crossfade between channels (sign-aligned, see below)
    peakHoldSec: 1.0,     // decay of each channel's own-strength reference
    dyingRatio: 0.5,      // −6 dB below its own recent peak ⇒ losing it: skip the hold
    sourceMode: 'auto',   // 'auto' | 'gyro' | 'accel'
    axisMode: 'auto',     // 'auto' | 'x' | 'y' | 'z'

    // ── engine startup ──────────────────────────────────────────────────────
    warmupSec: 0.3,       // The highpass is primed for a *constant* input, but its
                          // zero-state response to a slowly changing one starts at full
                          // passband gain and only settles with the 1.5 Hz time constant —
                          // a 50 °/s slow sway produced a measured 2.6 cent blip in the
                          // first 200 ms. Mute the output for this long once per enable
                          // (not per note: the gate handles silence) and the blip is gone.

    // ── one-time calibration ────────────────────────────────────────────────
    calibSec: 5,          // how much "normal vibrato" the UI asks the player for
    calibMinSec: 2.5,     // …and the shortest capture that can be trusted
    calibTrimHeadSec: 0.4,// the bandpass needs a moment; ignore the head of the capture
    calibTrimTailSec: 0.1,
    calibMinLevelCents: 1.5, // at unity gain, so it works in any unit: a still phone stays
                          // below this on every channel, a real vibrato clears it by 10x
    calibRateMinHz: 3,    // a vibrato outside this range means the capture is unusable
    calibRateMaxHz: 11,
    calibUsableDb: 20,    // channels more than this below the best are not trusted: their
                          // gain would amplify sensor noise as much as the vibrato

    // ── output stage ────────────────────────────────────────────────────────
    nominalFs: 60,        // nominal sensor rate (first dt, and the interpolation delay)
    outputHz: 250,        // browser timer floor is 4 ms
    interpolate: true,    // quadratic resampling at one sample of delay. Off = zero-order
                          // hold of the newest sample: 16.7 ms less latency at 60 Hz, paid
                          // for with a staircased pitch curve (measured below in the tests)
    minStepCounts: 4,     // 14-bit counts; below this a new value is not worth sending
    stallSec: 0.25,       // no sensor sample for this long ⇒ output the centre. A locked
                          // screen or a WiFi hiccup must never leave the DAW bent; the
                          // one centring message is sent, then the stream goes quiet.
    dawBendSemitones: 2,  // Nuendo default: ±100 display == ±2 semitones == ±200 cents
  };

  // DeviceMotionEvent axis mapping: rotationRate.alpha is about Z, beta about X, gamma
  // about Y (per the spec — easy to get wrong).
  const CHANNELS = [
    { id: 'gyro.x', src: 'gyro', index: 1, api: 'rotationRate.beta' },
    { id: 'gyro.y', src: 'gyro', index: 2, api: 'rotationRate.gamma' },
    { id: 'gyro.z', src: 'gyro', index: 0, api: 'rotationRate.alpha' },
    { id: 'accel.x', src: 'accel', index: 0, api: 'acceleration.x' },
    { id: 'accel.y', src: 'accel', index: 1, api: 'acceleration.y' },
    { id: 'accel.z', src: 'accel', index: 2, api: 'acceleration.z' },
  ];
  const CHANNEL_IDS = CHANNELS.map((c) => c.id);

  /**
   * Accepts {gyro:[x,y,z], accel:[x,y,z]} (nulls where a sensor is unavailable) or a bare
   * number, and returns {channelId: rawValue|null} with the alpha→z / beta→x / gamma→y
   * mapping applied.
   */
  function normaliseInput(input) {
    const out = {};
    if (typeof input === 'number') {
      for (const id of CHANNEL_IDS) out[id] = 0;
      out['gyro.x'] = input;
      return out;
    }
    const g = input && input.gyro;
    const a = input && input.accel;
    out['gyro.x'] = (g && g[1] != null) ? g[1] : null;   // alpha is about z, beta about x
    out['gyro.y'] = (g && g[2] != null) ? g[2] : null;
    out['gyro.z'] = (g && g[0] != null) ? g[0] : null;
    out['accel.x'] = (a && a[0] != null) ? a[0] : null;
    out['accel.y'] = (a && a[1] != null) ? a[1] : null;
    out['accel.z'] = (a && a[2] != null) ? a[2] : null;
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ── pure helpers ───────────────────────────────────────────────────────────

  /** cents → Bridge value t∈[0,1]. ±(100·semitones) cents spans the full 14-bit bend. */
  function centsToT(cents, semitones) {
    const span = 100 * (semitones || DEFAULTS.dawBendSemitones);
    return 0.5 + Math.max(-span, Math.min(span, cents)) / (2 * span);
  }

  function tToCents(t, semitones) {
    const span = 100 * (semitones || DEFAULTS.dawBendSemitones);
    return (t - 0.5) * 2 * span;
  }

  /** cents → Nuendo's bend-lane readout (±100 display == ±2 semitones by default). */
  function centsToDawDisplay(cents, semitones) {
    return cents / (100 * (semitones || DEFAULTS.dawBendSemitones)) * 100;
  }

  /** Mirror of what the Bridge emits, for on-screen readout and tests. */
  function centsToPb(cents, semitones) {
    return 8192 + Math.round((2 * centsToT(cents, semitones) - 1) * 8192);
  }

  /**
   * Soft limiter: exactly linear up to `knee`, then an exponential approach to `cap`.
   * The calibration point (nominalCents) sits inside the linear region, so depth stays
   * literally proportional; a violent shake is compressed smoothly instead of being
   * clipped into a square-edged pitch curve, and the cap can never be exceeded.
   */
  function softLimit(cents, cfg) {
    const c = cfg || DEFAULTS;
    const knee = c.kneeCents;
    const cap = c.capCents;
    const a = Math.abs(cents);
    if (!(a > knee)) return cents;
    const range = Math.max(1e-6, cap - knee);
    const y = knee + range * (1 - Math.exp(-(a - knee) / range));
    return (cents < 0 ? -1 : 1) * Math.min(y, cap);
  }

  /** 2nd-order RBJ highpass; coefficients recomputed per sample so jittered dt is exact. */
  function createBiquadHighpass(fc, q) {
    let z1 = 0;
    let z2 = 0;
    const Q = q || Math.SQRT1_2;
    function coeffs(dt) {
      const f = Math.min(fc, 0.45 / dt);
      const w0 = 2 * Math.PI * f * dt;
      const cw = Math.cos(w0);
      const sw = Math.sin(w0);
      const alpha = sw / (2 * Q);
      const a0 = 1 + alpha;
      return {
        b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0,
        a1: -2 * cw / a0, a2: (1 - alpha) / a0,
      };
    }
    return {
      process(x, dt) {
        const c = coeffs(dt);
        const y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        return y;
      },
      /**
       * Start already settled for a constant input, so the first sample (a step from 0 to
       * gravity / gyro bias on a real phone) produces no startup transient instead of a
       * half-second pitch blip.
       */
      prime(x, dt) {
        const c = coeffs(dt);
        z1 = -c.b0 * x;
        z2 = c.b2 * x;
        return 0;
      },
      reset() { z1 = 0; z2 = 0; },
    };
  }

  /** One-pole lowpass, dt-exact. */
  function createOnePoleLowpass(fc) {
    let y = 0;
    return {
      process(x, dt) {
        const f = Math.min(fc, 0.45 / dt);
        const a = 1 - Math.exp(-2 * Math.PI * f * dt);
        y += a * (x - y);
        return y;
      },
      prime(x) { y = x; return x; },
      reset() { y = 0; },
      get value() { return y; },
    };
  }

  // ── channel: raw sensor axis → cents ───────────────────────────────────────

  function createChannel(cfg, id) {
    const hp = createBiquadHighpass(cfg.hpHz, cfg.hpQ);
    const lp = createOnePoleLowpass(cfg.lpHz);
    let gain = 0;              // cents per raw unit; 0 = not usable (no calibration yet)
    let primed = false;
    let cents = 0;

    return {
      id,
      get gain() { return gain; },
      setGain(g) { gain = g; },
      get cents() { return cents; },
      process(raw, dt) {
        let bp;
        if (!primed) {
          primed = true;
          bp = lp.prime(hp.prime(raw, dt));    // settles both stages: no startup transient
        } else {
          bp = lp.process(hp.process(raw, dt), dt);
        }
        cents = gain * bp;
        return cents;
      },
      reset() { hp.reset(); lp.reset(); primed = false; cents = 0; },
    };
  }

  // ── core: cents → gated, limited cents ─────────────────────────────────────

  function createCore(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const refWindow = [];       // gate reference (may include a stronger *other* channel)
    const intervals = [];       // recent half-periods between crossings, newest last
    let oscSign = 0;            // -1 = below −h, +1 = above +h, 0 = inside the band
    let lastCrossT = null;
    let gate = 0;
    let effort = 0;             // window peak of the gate reference, before depthTrim
    let amplitude = 0;          // effort × depthTrim = what the DAW receives
    let rateHz = 0;             // measured rate of the hand's motion — reported, not judged
    let lastCents = 0;

    /** Sliding window peak, newest sample pushed and stale ones dropped. */
    function peak(window, t, v) {
      window.push({ t, v });
      const cut = t - cfg.gateWindowSec;
      while (window.length && window[0].t < cut) window.shift();
      let m = 0;
      for (let i = 0; i < window.length; i++) if (window[i].v > m) m = window[i].v;
      return m;
    }

    /**
     * Measures the rate of the hand's motion (median of the recent half-periods) purely for
     * display/diagnostics. **It deliberately does not gate anything**: this instrument maps
     * *every* hand movement faithfully — a slow tilt is a slow pitch movement — because the
     * ordinary vibrato case is already covered by the string library's own vibrato control.
     * What is being played here is the gesture, not a "correct" vibrato.
     */
    function measureRate(t, cents, amp) {
      const h = Math.max(cfg.oscCents, cfg.oscRatio * amp);
      let crossed = false;
      if (cents > h) { if (oscSign <= 0) crossed = true; oscSign = 1; }
      else if (cents < -h) { if (oscSign >= 0) crossed = true; oscSign = -1; }
      if (crossed) {
        if (lastCrossT != null) {
          intervals.push(t - lastCrossT);
          while (intervals.length > 5) intervals.shift();
        }
        lastCrossT = t;
      }
      if (lastCrossT == null || (t - lastCrossT) > cfg.oscWindowSec) {
        intervals.length = 0;      // the hand stopped: the old rate is meaningless
        rateHz = 0;
        return;
      }
      const s = intervals.slice().sort((a, b) => a - b);
      const m = s.length ? s[s.length >> 1] : 0;
      rateHz = m > 0 ? 1 / (2 * m) : 0;
    }

    return {
      /**
       * @param t      sample time
       * @param cents  the blended (pre-gate) pitch offset
       * @param dt     sensor interval — the ramp is quantised at the sensor rate
       * @param ref    gate reference amplitude. Normally |cents|, but the selector can
       *               pass a stronger *other* channel so that a handover does not get
       *               mistaken for the player stopping (see createEngine.feed).
       */
      process(t, cents, dt, ref) {
        effort = peak(refWindow, t, ref == null ? Math.abs(cents) : Math.abs(ref));
        amplitude = effort * cfg.depthTrim;
        measureRate(t, cents, effort);

        // The gate is a *rest* detector, not a gesture classifier: below gateCents the hand
        // is not moving, the output is exactly 0 and the DAW sits at centre. Anything above
        // it is sent through unchanged — slowly or quickly, in time or not.
        const wantGate = effort >= cfg.gateCents ? 1 : 0;

        const rampSec = Math.max(cfg.gateRampSec, cfg.gateMinSteps * (dt || 1 / Math.max(1, cfg.nominalFs)));
        const step = (dt || 1 / Math.max(1, cfg.nominalFs)) / rampSec;
        gate += Math.max(-step, Math.min(step, wantGate - gate));
        if (gate < 1e-4) gate = 0;
        else if (gate > 1 - 1e-4) gate = 1;

        lastCents = gate === 0 ? 0 : gate * softLimit(cents, cfg) * cfg.depthTrim;
        if (lastCents === 0) lastCents = 0;      // normalise -0
        return lastCents;
      },
      setConfig(o) { Object.assign(cfg, o); },
      getConfig() { return Object.assign({}, cfg); },
      reset() {
        refWindow.length = 0; intervals.length = 0;
        oscSign = 0; lastCrossT = null; gate = 0;
        effort = 0; amplitude = 0; rateHz = 0; lastCents = 0;
      },
      get gate() { return gate; },
      get effortCents() { return effort; },
      get amplitude() { return amplitude; },
      /** Measured rate of the hand's motion — informational only (see measureRate). */
      get rateHz() { return rateHz; },
      get cents() { return lastCents; },
    };
  }

  // ── selector: channel levels, hysteresis, crossfade ────────────────────────

  function createSelector(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const levels = {};                        // id → window peak of |cents|
    const windows = {};                       // id → [{t, v, a}] signed samples, newest last
    const flips = {};                         // id → ±1, phase alignment across handovers
    const peakHold = {};                      // id → its own recent strength, decaying
    for (const id of CHANNEL_IDS) { windows[id] = []; flips[id] = 1; peakHold[id] = 0; }
    let current = null;
    let challenger = null;
    let challengerSince = null;
    let fade = null;                          // { from, to, t0, sfrom, sto }
    // Which sensor kind is actually usable, resolved by the engine from the incoming data.
    // 'auto' means "prefer the rotation sensor": a gyro measures the hand's rotation
    // directly, while linear acceleration also carries the gravity vector, whose slow
    // redistribution during a tilt is not hand movement at all.
    let source = cfg.sourceMode && cfg.sourceMode !== 'auto' ? cfg.sourceMode : null;
    const stats = { switches: 0, blocked: {}, realigns: 0, urgent: 0 };

    function allowedIds() {
      const src = source || (cfg.sourceMode !== 'auto' ? cfg.sourceMode : null);
      return CHANNEL_IDS.filter((id) => {
        const [s, axis] = id.split('.');
        if (src && s !== src) return false;
        if (cfg.axisMode !== 'auto' && cfg.axisMode !== axis) return false;
        return true;
      });
    }

    /**
     * Vibrato phase itself is imperceptible, but its *sign* is not: a different rotation
     * axis can run the opposite way, so handing over without realigning would silently
     * invert the player's bend direction — and crossfading +A into −A cancels to zero
     * depth. Decide once per handover from the dot product of the outgoing and incoming
     * sample windows (raw, unflipped). dot == 0 carries no information (e.g. a handover
     * that happens while silent), so the stored alignment is kept.
     */
    function alignSign(from, to) {
      const wf = windows[from], wt = windows[to];
      const n = Math.min(wf.length, wt.length);
      let dot = 0, ef = 0, et = 0;
      for (let i = 1; i <= n; i++) {
        const a = wf[wf.length - i].v, b = wt[wt.length - i].v;
        dot += a * b; ef += a * a; et += b * b;
      }
      // Require a real anti-correlation (|r| > 0.25); a near-zero dot product means the
      // outgoing channel is already silent and carries no phase information to align to.
      const norm = Math.sqrt(ef * et);
      if (norm <= 0 || Math.abs(dot) / norm < 0.25) return false;
      const want = dot < 0 ? -flips[from] : flips[from];
      if (want === flips[to]) return false;
      flips[to] = want;
      stats.realigns++;
      return true;
    }

    /**
     * Update the per-channel level windows and return { selected, level, blended } for this
     * sample. `cents` maps id → this sample's cents value.
     */
    function select(t, cents, usable, dt) {
      const allowed = allowedIds();
      let best = null;
      let bestLevel = -1;
      const decay = Math.exp(-(dt || 1 / Math.max(1, cfg.nominalFs)) / Math.max(1e-3, cfg.peakHoldSec));
      for (const id of allowed) {
        const w = windows[id];
        const c = cents[id] || 0;
        w.push({ t, v: c, a: Math.abs(c) });
        while (w.length && w[0].t < t - cfg.levelWindowSec) w.shift();
        let m = 0;
        for (let i = 0; i < w.length; i++) if (w[i].a > m) m = w[i].a;
        levels[id] = m;
        peakHold[id] = Math.max(m, peakHold[id] * decay);
        if (usable[id] && m > bestLevel) { bestLevel = m; best = id; }
      }
      if (bestLevel < 0) bestLevel = 0;

      if (current == null && best != null) {
        current = best;                       // first pick: no fade, nothing to fade from
      } else if (best != null && best !== current) {
        const curLevel = levels[current] || 0;
        const strong = bestLevel >= cfg.switchMargin * Math.max(curLevel, 1e-6);
        const rescue = curLevel < cfg.gateCents && bestLevel >= cfg.gateCents;
        // A channel that has lost most of its own strength is the one the phone rotated away
        // from: its axis projection is shrinking, and holding on to it means following it
        // down to zero before the handover — a depth dropout at a grip change. For that case
        // only, a challenger that is merely *as strong* is enough, and the hold is skipped.
        //
        // The margin still guards the case it exists for: two steady channels of comparable
        // size (a stroke that projects onto two axes), where neither is dying and 1.3x +
        // switchHoldSec keeps the selection from flickering. A general decay — the player
        // simply easing off — can momentarily satisfy "dying and comparable", but both
        // candidates are then near-identical and in phase, so the crossfade between them is
        // silent, and alignSign composes consistently instead of oscillating.
        const dying = curLevel < cfg.dyingRatio * (peakHold[current] || 0);
        const enough = strong || rescue || (dying && bestLevel >= curLevel);
        if (enough) {
          if (challenger !== best) { challenger = best; challengerSince = t; }
          else if (t - challengerSince >= ((rescue || dying) ? 0 : cfg.switchHoldSec)) {
            if (dying && !rescue) stats.urgent++;
            alignSign(current, best);
            fade = { from: current, to: best, t0: t, sfrom: flips[current], sto: flips[best] };
            current = best;
            challenger = null;
            challengerSince = null;
            stats.switches++;
          }
        } else {
          challenger = null;
          challengerSince = null;
          stats.blocked[best] = (stats.blocked[best] || 0) + 1;
        }
      } else {
        challenger = null;
        challengerSince = null;
      }

      let blended = current ? flips[current] * (cents[current] || 0) : 0;
      if (fade) {
        const a = Math.min(1, Math.max(0, (t - fade.t0) / Math.max(1e-4, cfg.crossfadeSec)));
        const from = fade.sfrom * (cents[fade.from] || 0);
        const to = fade.sto * (cents[fade.to] || 0);
        blended = from + (to - from) * a;
        if (a >= 1) fade = null;
      }
      return { selected: current, level: current ? (levels[current] || 0) : 0, bestLevel, blended };
    }

    return {
      select,
      setConfig(o) { Object.assign(cfg, o); },
      getConfig() { return Object.assign({}, cfg); },
      /** Engine-resolved sensor kind ('gyro' | 'accel'), or null when nothing has arrived. */
      setSource(s) { source = s; },
      get source() { return source || (cfg.sourceMode !== 'auto' ? cfg.sourceMode : null); },
      reset() {
        for (const id of CHANNEL_IDS) { windows[id].length = 0; flips[id] = 1; peakHold[id] = 0; }
        current = null; challenger = null; challengerSince = null; fade = null;
        stats.switches = 0; stats.realigns = 0; stats.urgent = 0;
      },
      get current() { return current; },
      get fading() { return fade != null; },
      get levels() { return Object.assign({}, levels); },
      get flips() { return Object.assign({}, flips); },
      get switches() { return stats.switches; },
      get realigns() { return stats.realigns; },
      get urgent() { return stats.urgent; },
    };
  }

  // ── output stage: cents stream → interpolated 250 Hz output ────────────────

  /**
   * Quadratic (3-point) interpolation at ONE sample of causal delay.
   *
   * The interpolation point always sits one nominal sample in the past, so the three
   * samples it needs are already buffered — which is why quadratic costs no more latency
   * than linear while being ~3x more accurate (0.10 vs 1.03 cents RMS at 6 Hz).
   */
  function createOutputStage(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const buf = [];
    let inCount = 0, inFirstT = null, inLastT = null;
    let outCount = 0, outFirstT = null, outLastT = null;
    let holdFallbacks = 0;    // zero-order holds: the sensor had no newer sample
    let linearFallbacks = 0;  // the quadratic was impossible: a real interpolation failure
    const steps = [];
    let lastOut = null;
    // Seeded at the centre so a closed gate (cents exactly 0) sends *nothing* on a silent
    // start — the resting bend position of a freshly connected DAW is already 8192. After
    // vibrato stops, the ramp to 0 sends exactly one centring message and then goes quiet.
    let lastSentPb = 8192;

    function push(t, cents) {
      buf.push({ t, c: cents });
      while (buf.length > 32) buf.shift();
      inCount++;
      if (inFirstT == null) inFirstT = t;
      inLastT = t;
    }

    /**
     * The ceiling the output may not cross. Trimming the depth scales the ceiling with it
     * (0.5 ⇒ ±25 cents); a trim above 1 cannot raise it, so the promised hard cap holds.
     * Applied after interpolation, because interpolating a near-square limited waveform
     * overshoots at the corners — measured 62 cents against a 50-cent cap.
     */
    function clampCap() {
      return cfg.capCents * Math.min(1, Math.max(0, cfg.depthTrim));
    }

    /** Interpolated cents at wall-clock time tNow, clamped to the cap. */
    function valueAt(tNow) {
      if (buf.length < 3) return null;
      const cap = clampCap();
      if (!cfg.interpolate) {
        // Deliberately no interpolation: hold the newest sample. This also drops the
        // one-sample delay, which is the whole point of the switch — it trades 16.7 ms
        // (at 60 Hz) for a staircased pitch curve.
        let held = buf[buf.length - 1].c;
        if (held > cap) held = cap;
        else if (held < -cap) held = -cap;
        return held;
      }
      const delay = 1 / Math.max(1, cfg.nominalFs);
      const tSig = tNow - delay;
      let j = -1;
      for (let k = buf.length - 1; k >= 1; k--) {
        if (buf[k - 1].t <= tSig && tSig < buf[k].t) { j = k; break; }
      }
      let v;
      if (j >= 2) {
        const t0 = buf[j - 2].t, t1 = buf[j - 1].t, t2 = buf[j].t;
        const y0 = buf[j - 2].c, y1 = buf[j - 1].c, y2 = buf[j].c;
        const L0 = ((tSig - t1) * (tSig - t2)) / ((t0 - t1) * (t0 - t2));
        const L1 = ((tSig - t0) * (tSig - t2)) / ((t1 - t0) * (t1 - t2));
        const L2 = ((tSig - t0) * (tSig - t1)) / ((t2 - t0) * (t2 - t1));
        v = y0 * L0 + y1 * L1 + y2 * L2;
      } else if (j >= 1) {
        const t0 = buf[j - 1].t, t1 = buf[j].t;
        const y0 = buf[j - 1].c, y1 = buf[j].c;
        const f = (tSig - t0) / Math.max(1e-9, t1 - t0);
        linearFallbacks++;
        v = y0 + (y1 - y0) * Math.max(0, Math.min(1, f));
      } else if (tSig >= buf[buf.length - 1].t) {
        // The newest buffered sample is the one tSig asks for (the output tick coincided
        // with it), or the sensor is late by more than the interpolation delay. A zero-order
        // hold of the newest sample is then the correct answer, not a failure — so it is
        // counted separately from a real interpolation fallback.
        holdFallbacks++;
        v = buf[buf.length - 1].c;
      } else {
        // tSig precedes every buffered sample: the first ticks of the warm-up, or a clock
        // rewind. Hold the oldest.
        linearFallbacks++;
        v = buf[0].c;
      }
      // The soft limiter bounds the *pre-interpolation* signal, but interpolating a
      // near-square (deeply limited) waveform overshoots at the corners — measured
      // 62 cents against a 50-cent cap. Clamp here so the promised cap always holds.
      if (v > cap) v = cap;
      else if (v < -cap) v = -cap;
      return v;
    }

    /** Run one output update. Returns {cents, t, pb, dawDisplay, stepCounts, shouldSend}. */
    function tick(tNow) {
      const stalled = inLastT != null && (tNow - inLastT) > cfg.stallSec;
      const v = stalled ? 0 : valueAt(tNow);
      if (v == null) return null;
      outCount++;
      if (outFirstT == null) outFirstT = tNow;
      outLastT = tNow;
      if (lastOut != null) {
        steps.push(Math.abs(v - lastOut));
        if (steps.length > 4096) steps.shift();
      }
      lastOut = v;

      const t = centsToT(v, cfg.dawBendSemitones);
      const pb = centsToPb(v, cfg.dawBendSemitones);
      const stepCounts = Math.abs(pb - lastSentPb);
      const shouldSend = stepCounts >= cfg.minStepCounts;
      if (shouldSend) lastSentPb = pb;
      return {
        cents: v,
        t,
        pb,
        dawDisplay: centsToDawDisplay(v, cfg.dawBendSemitones),
        stepCounts,
        shouldSend,
      };
    }

    function percentile(arr, p) {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
    }

    return {
      push, tick,
      reset() {
        buf.length = 0; inCount = 0; inFirstT = null; inLastT = null;
        outCount = 0; outFirstT = null; outLastT = null;
        holdFallbacks = 0; linearFallbacks = 0; steps.length = 0; lastOut = null; lastSentPb = 8192;
      },
      setConfig(o) { Object.assign(cfg, o); },
      getConfig() { return Object.assign({}, cfg); },
      get last() { return lastOut; },
      diagnostics() {
        const inSpan = (inFirstT != null && inLastT != null) ? inLastT - inFirstT : 0;
        const outSpan = (outFirstT != null && outLastT != null) ? outLastT - outFirstT : 0;
        return {
          inputSamples: inCount,
          inputRateHz: inSpan > 0 ? inCount / inSpan : null,
          outputUpdates: outCount,
          outputRateHz: outSpan > 0 ? outCount / outSpan : null,
          maxStepCents: steps.length ? Math.max.apply(null, steps) : null,
          p95StepCents: percentile(steps, 0.95),
          holdFallbacks,
          linearFallbacks,
        };
      },
    };
  }

  // ── engine: channels → selector → core → output (still DOM-free) ───────────

  /**
   * @param opts  DEFAULTS overrides plus:
   *   gains   { [channelId]: cents-per-raw-unit }   from calibration
   *   usable  { [channelId]: boolean }              channels trusted (above noise floor)
   *   primary channelId                             preferred channel when all else equal
   */
  function createEngine(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const channels = {};
    for (const c of CHANNELS) channels[c.id] = createChannel(cfg, c.id);
    const selector = createSelector(cfg);
    const core = createCore(cfg);
    const output = createOutputStage(cfg);

    const usable = Object.assign({}, opts && opts.usable);
    if (opts && opts.gains) {
      for (const id of Object.keys(opts.gains)) {
        if (channels[id]) channels[id].setGain(opts.gains[id]);
      }
    }
    // Gains start at 0 (untrusted until P4 calibration), so silence is guaranteed out of
    // the box. `usable` is an exclusion list: only an explicit `false` marks a channel
    // unusable, anything unlisted is allowed. Depth safety comes from the gains (0 ⇒
    // silent), so a partial map is not a hazard, and an all-false map — nothing calibrated
    // yet — degrades to silence rather than to noise.
    for (const id of CHANNEL_IDS) if (!(id in usable)) usable[id] = true;

    let lastT = null;
    let firstT = null;
    let last = null;
    let callbacks = { onSwitch: null };

    function feed(tSec, input) {
      const dt = lastT == null
        ? 1 / Math.max(1, cfg.nominalFs)
        : Math.max(1e-4, Math.min(0.1, tSec - lastT));
      lastT = tSec;
      if (firstT == null) firstT = tSec;
      const warming = (tSec - firstT) < cfg.warmupSec;

      const raw = normaliseInput(input);
      // Resolve 'auto' from the data: a rotation sensor measures the hand's rotation
      // directly, so it wins whenever the device reports one. Linear acceleration is only
      // used on devices with no usable gyro — otherwise the gravity vector's slow
      // redistribution during a tilt (which is not hand movement) would be mapped to pitch.
      // Cheap: two booleans from the same loop that feeds the channels.
      if (cfg.sourceMode === 'auto') {
        let hasGyro = false, hasAccel = false;
        for (const id of CHANNEL_IDS) {
          if (raw[id] == null) continue;
          if (id.startsWith('gyro.')) hasGyro = true; else hasAccel = true;
        }
        const src = hasGyro ? 'gyro' : (hasAccel ? 'accel' : null);
        if (src !== null && src !== selector.source) selector.setSource(src);
      }
      const cents = {};
      for (const id of CHANNEL_IDS) {
        const r = raw[id];
        cents[id] = r == null ? 0 : channels[id].process(r, dt);
      }
      const before = selector.current;
      const sel = selector.select(tSec, cents, usable, dt);
      if (selector.current !== before && callbacks.onSwitch) {
        callbacks.onSwitch(before, selector.current);
      }
      // The gate asks "is the hand moving at all?"; during a handover the answer is in the
      // *challenger*, not in the fading channel we are still outputting. Referencing the
      // strongest usable level keeps the gate open across the crossfade; the gate can only
      // ever multiply the blended value, so a loud-but-unselected channel cannot make
      // silence audible.
      const ref = warming ? 0 : Math.max(Math.abs(sel.blended), sel.bestLevel);
      const out = core.process(tSec, sel.blended, dt, ref);
      output.push(tSec, out);
      last = {
        cents: out, channel: sel.selected, level: sel.level,
        bestLevel: sel.bestLevel, blending: sel.blended, warming,
      };
      return last;
    }

    return {
      feed,
      tick(tNowSec) { return output.tick(tNowSec); },
      reset() {
        for (const id of CHANNEL_IDS) channels[id].reset();
        selector.reset(); core.reset(); output.reset(); lastT = null; firstT = null; last = null;
      },
      setConfig(o) { Object.assign(cfg, o); selector.setConfig(o); core.setConfig(o); output.setConfig(o); },
      getConfig() { return Object.assign({}, cfg); },
      setGains(map, usableMap) {
        for (const id of Object.keys(map || {})) {
          if (channels[id]) channels[id].setGain(map[id]);
        }
        if (usableMap) for (const id of CHANNEL_IDS) usable[id] = !!usableMap[id];
      },
      getGains() {
        const g = {};
        for (const id of CHANNEL_IDS) g[id] = channels[id].gain;
        return g;
      },
      /** Per-channel level in cents (post-gain), i.e. directly comparable across units. */
      levels() { return selector.levels; },
      onSwitch(fn) { callbacks.onSwitch = fn; },
      diagnostics() {
        return Object.assign({
          channel: selector.current,
          source: selector.source,
          fading: selector.fading,
          switches: selector.switches,
          realigns: selector.realigns,
          urgent: selector.urgent,
          flips: selector.flips,
          gate: core.gate,
          amplitudeCents: core.amplitude,
          effortCents: core.effortCents,
          selfPeakCents: core.effortCents,
          oscHz: core.rateHz,
          depthTrim: cfg.depthTrim,
        }, output.diagnostics());
      },
      channels, selector, core, output,
      get last() { return last; },
    };
  }

  // ── one-time calibration ──────────────────────────────────────────────────

  /**
   * Turn a capture of the player's *normal* vibrato into per-channel gains.
   *
   * The levels are measured **on the same bandpass chain the engine runs** and with the same
   * sliding-window statistic the selector uses, so the gain absorbs the in-band attenuation
   * (0.5 dB of spread across 5-8 Hz) instead of approximating it: after calibration a normal
   * vibrato is `nominalCents` deep, on whichever channel is selected.
   *
   * @param samples [{t, gyro:[x,y,z], accel:[x,y,z]}] exactly what the sensor produced
   * @returns {{ok, reason, gains, usable, levels, rateHz, fs, primary, source, spanSec, samples}}
   *   `gains` in cents per raw unit, `levels` in cents at unity gain, 0 for unusable channels.
   */
  function calibrate(samples, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const list = (samples || []).filter((s) => s && Number.isFinite(s.t));
    const out = {
      ok: false, reason: null, gains: {}, usable: {}, levels: {}, measured: {},
      rateHz: null, fs: null, primary: null, source: null,
      spanSec: 0, samples: list.length, cfg,
    };
    for (const id of CHANNEL_IDS) { out.gains[id] = 0; out.usable[id] = false; out.levels[id] = 0; }

    if (list.length < 20) { out.reason = 'too_short'; return out; }
    const t0 = list[0].t, t1 = list[list.length - 1].t;
    const span = t1 - t0;
    out.spanSec = span;
    out.fs = span > 0 ? (list.length - 1) / span : null;
    if (!(span >= cfg.calibMinSec)) { out.reason = 'too_short'; return out; }

    // 1. Run every channel through the real chain at unity gain.
    const chans = {}, series = {};
    for (const c of CHANNELS) {
      chans[c.id] = createChannel(cfg, c.id);
      chans[c.id].setGain(1);           // measure raw cents; the fitted gain absorbs the unit
      series[c.id] = [];
    }
    let lastT = null;
    for (const s of list) {
      const dt = lastT == null
        ? 1 / Math.max(1, out.fs || cfg.nominalFs)
        : Math.max(1e-4, Math.min(0.1, s.t - lastT));
      lastT = s.t;
      const raw = normaliseInput(s);
      for (const id of CHANNEL_IDS) {
        const r = raw[id];
        series[id].push(r == null ? 0 : chans[id].process(r, dt));
      }
    }

    // 2. Robust level per channel: median of the selector's own sliding window peak, over
    //    the trimmed middle of the capture (median, not mean, so one big sway cannot
    //    inflate the calibration and quietly halve the vibrato depth).
    const a = t0 + cfg.calibTrimHeadSec, b = t1 - cfg.calibTrimTailSec;
    for (const id of CHANNEL_IDS) {
      const win = [], peaks = [];
      for (let k = 0; k < list.length; k++) {
        const t = list[k].t;
        win.push({ t, v: Math.abs(series[id][k]) });
        while (win.length && win[0].t < t - cfg.levelWindowSec) win.shift();
        if (t < a || t > b) continue;
        let m = 0;
        for (let i = 0; i < win.length; i++) if (win[i].v > m) m = win[i].v;
        peaks.push(m);
      }
      out.levels[id] = median(peaks);
    }

    // 3. Pick the source. A rotation sensor measures the vibrato directly; linear
    //    acceleration is the fallback for devices that report no rotationRate at all.
    //    Comparing cents levels across the two units would silently always prefer the gyro
    //    (deg/s and m/s2 are not commensurate), so decide it explicitly.
    const best = (src) => CHANNEL_IDS.filter((id) => id.startsWith(src + '.'))
      .reduce((m, id) => Math.max(m, out.levels[id]), 0);
    const gyroBest = best('gyro'), accelBest = best('accel');
    out.measured = { gyroBest, accelBest };
    out.source = gyroBest >= cfg.calibMinLevelCents ? 'gyro'
      : (accelBest >= cfg.calibMinLevelCents ? 'accel' : null);
    if (out.source == null) { out.reason = 'too_quiet'; return out; }

    const srcBest = out.source === 'gyro' ? gyroBest : accelBest;
    const floor = srcBest * Math.pow(10, -cfg.calibUsableDb / 20);
    for (const id of CHANNEL_IDS) {
      const same = id.startsWith(out.source + '.');
      const ok = same && out.levels[id] >= floor;
      out.usable[id] = ok;
      out.gains[id] = ok ? cfg.nominalCents / Math.max(1e-9, out.levels[id]) : 0;
    }
    out.primary = CHANNEL_IDS.filter((id) => out.usable[id])
      .reduce((m, id) => (out.levels[id] > out.levels[m] ? id : m), 'gyro.x');

    // 4. Measured vibrato rate from the primary channel's upward zero crossings (one per
    //    cycle), using the median interval so a missed crossing cannot halve the estimate.
    const sig = series[out.primary];
    const cross = [];
    for (let k = 1; k < list.length; k++) {
      if (list[k].t < a || list[k].t > b) continue;
      if (sig[k - 1] <= 0 && sig[k] > 0) cross.push(list[k].t);
    }
    if (cross.length >= 4) {
      const gaps = [];
      for (let i = 1; i < cross.length; i++) gaps.push(cross[i] - cross[i - 1]);
      const g = median(gaps);
      out.rateHz = g > 0 ? 1 / g : null;
    }
    if (out.rateHz == null || out.rateHz < cfg.calibRateMinHz || out.rateHz > cfg.calibRateMaxHz) {
      out.reason = 'rate';
      for (const id of CHANNEL_IDS) { out.usable[id] = false; out.gains[id] = 0; }
      return out;
    }
    out.ok = true;
    return out;
  }

  // ── browser glue ──────────────────────────────────────────────────────────
  // Everything below touches browser APIs and is guarded, so this file stays loadable in
  // Node for the numeric tests.

  const CAL_KEY = 'pm.vibrato.cal.v1';
  const SET_KEY = 'pm.vibrato.settings.v1';

  /** A "normal" vibrato in raw sensor units, used before a calibration exists. */
  const RAW_NOMINAL = { gyro: 20, accel: 2 };

  /**
   * Fallback gains for an uncalibrated phone: a normal vibrato should land roughly at
   * nominalCents. Approximate by construction (sensor sensitivity varies per model) — it
   * exists so the mode is usable immediately, and calibration replaces it with a measured
   * number.
   */
  function defaultGains(cfg) {
    const c = cfg || DEFAULTS;
    const g = {};
    for (const ch of CHANNELS) {
      g[ch.id] = c.nominalCents / (RAW_NOMINAL[ch.src] * 0.95);
    }
    return g;
  }

  function allUsable(map) {
    const u = {};
    for (const id of CHANNEL_IDS) u[id] = map ? map[id] !== false : true;
    return u;
  }

  function hasStorage() {
    try { return typeof window !== 'undefined' && !!window.localStorage; } catch (e) { return false; }
  }

  function saveCalibration(cal) {
    if (!cal || !hasStorage()) return null;
    const payload = {
      v: 1, savedAt: new Date().toISOString(), ok: !!cal.ok, reason: cal.reason || null,
      source: cal.source, primary: cal.primary, rateHz: cal.rateHz, fs: cal.fs,
      levels: cal.levels, measured: cal.measured,
      gains: cal.gains, usable: cal.usable, spanSec: cal.spanSec, samples: cal.samples,
      // The depth the gains were fitted for. Stored so that changing nominalCents later
      // rescales an existing calibration instead of silently changing the player's depth.
      nominalCents: DEFAULTS.nominalCents,
    };
    try { window.localStorage.setItem(CAL_KEY, JSON.stringify(payload)); } catch (e) { return null; }
    return payload;
  }

  function loadCalibration() {
    if (!hasStorage()) return null;
    try {
      const raw = window.localStorage.getItem(CAL_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || p.v !== 1 || !p.gains || !p.usable) return null;
      // Calibrations written before the field existed targeted 30 cents per normal vibrato.
      const src = p.nominalCents > 0 ? p.nominalCents : 30;
      const target = DEFAULTS.nominalCents;
      if (src !== target) {
        const f = target / src;
        for (const id of CHANNEL_IDS) {
          if (p.gains[id]) p.gains[id] = p.gains[id] * f;
        }
        p.rescaledFrom = src;
      }
      p.nominalCents = target;
      return p;
    } catch (e) { return null; }
  }

  function clearCalibration() {
    if (!hasStorage()) return;
    try { window.localStorage.removeItem(CAL_KEY); } catch (e) { /* ignore */ }
  }

  /** Player-facing settings that are not part of the calibration. */
  function loadSettings() {
    const out = { depthTrim: DEFAULTS.depthTrim };
    if (!hasStorage()) return out;
    try {
      const p = JSON.parse(window.localStorage.getItem(SET_KEY) || 'null');
      if (p && typeof p.depthTrim === 'number' && p.depthTrim > 0.05 && p.depthTrim < 8) {
        out.depthTrim = p.depthTrim;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function saveSettings(s) {
    if (!hasStorage()) return;
    try { window.localStorage.setItem(SET_KEY, JSON.stringify({ v: 1, depthTrim: s.depthTrim })); } catch (e) { /* ignore */ }
  }

  /**
   * Keep the screen awake while a mode is running — a phone that blanks its screen stops
   * delivering sensor events. Returns an async release function; failures are silent
   * (the API is unavailable on http:// origins outside localhost).
   */
  function keepAwake() {
    let sentinel = null, released = false;
    async function acquire() {
      try {
        if (typeof navigator === 'undefined' || !navigator.wakeLock || released) return;
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { sentinel = null; });
      } catch (e) { /* not fatal */ }
    }
    acquire();
    const onVisible = () => { if (!document.hidden && !sentinel) acquire(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return async function release() {
      released = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      try { if (sentinel) await sentinel.release(); } catch (e) { /* ignore */ }
      sentinel = null;
    };
  }

  global.PhoneMidiVibrato = {
    DEFAULTS,
    CHANNELS,
    CHANNEL_IDS,
    softLimit,
    centsToT,
    tToCents,
    centsToPb,
    centsToDawDisplay,
    createBiquadHighpass,
    createOnePoleLowpass,
    createChannel,
    createCore,
    createSelector,
    createOutputStage,
    createEngine,
    normaliseInput,
    calibrate,
    median,
    defaultGains,
    allUsable,
    saveCalibration,
    loadCalibration,
    clearCalibration,
    loadSettings,
    saveSettings,
    keepAwake,
    CAL_KEY,
    SET_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);
