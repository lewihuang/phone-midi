// Phone MIDI CC — shared fusion + per-mode calibration storage
(function (global) {
  'use strict';

  const LEGACY_STORAGE_KEY = 'phone-midi/calibration/v1';
  const CAPTURE_MS = 400;
  const SHAKE_PEAK_MS = 5000;
  const MIN_SEP = 4;
  const MIN_SHAKE_SEP = 3;

  /**
   * Mode B gravity direction, derived from the device's *attitude* (deviceorientation).
   *
   * Why not the accelerometer: `accelerationIncludingGravity` reports gravity **plus the
   * hand's own linear acceleration**. A deliberate palm flip reaches 2-3 g of hand
   * acceleration (model of a 300 ms flip: |a| 4.8-33 m/s^2), which tilts the estimated
   * gravity direction by tens of degrees. No low-pass can remove that, because the
   * contamination sits in the same band as the gesture itself — the old boxcar + One Euro
   * chain therefore had to choose between lag and error, and measured 76 CC steps RMS of
   * error at 300 ms while still lagging 35 ms at 1200 ms. The OS attitude is already fused
   * from gyro + accelerometer, so it carries the *orientation* alone, unfiltered and exact.
   *
   * Derivation (W3C deviceorientation, intrinsic Z-X'-Y''): R = Rz(a)*Rx(b)*Ry(g), and the
   * gravity direction in the device frame is R^T*z = the third row of R:
   *
   *     u = (-cos(b)*sin(g),  sin(b),  cos(b)*cos(g))
   *
   * independent of alpha (yaw), and continuous through b = +-90 degrees because cos(b) = 0
   * there makes the ill-defined g drop out. This is the same quantity Mode A projects with
   * (beta, gamma), so both modes now share one architecture:
   * attitude -> projection onto calibrated anchors -> CC, with no temporal filtering.
   *
   * Consequence for stored calibrations: anchors are unit gravity vectors, and the endpoint
   * projection (u - u0).(u1 - u0) / |u1 - u0|^2 is NOT invariant under a sign flip of the
   * anchors. A flip calibration captured through the old accelerometer path therefore has to be
   * re-taken once, in the (rare) case that the platform's `accelerationIncludingGravity` points
   * opposite to R^T*z; the wizard's preview makes it obvious (the value would move backwards).
   */
  function gravityFromOrientation(beta, gamma) {
    if (beta == null || gamma == null || Number.isNaN(beta) || Number.isNaN(gamma)) return null;
    const b = beta * Math.PI / 180;
    const g = gamma * Math.PI / 180;
    const cb = Math.cos(b);
    return normalize3(-cb * Math.sin(g), Math.sin(b), cb * Math.cos(g));
  }


  const DEFAULT_FUSION = {
    mode: 'endpoint_projection',
    reverse: false,
    weights: { beta: 0.7, gamma: 0.3 },
  };

  const PROFILES = {
    lift: {
      id: 'lift',
      modeId: 'A',
      input: 'orientation',
      storageKey: 'phone-midi/calibration/lift/v1',
      exportSchema: 'phone-midi/fusion-calibrate/lift/v1',
      axis: 'fused_lift',
      minLabel: '自然垂手',
      maxLabel: '抬手最高',
      previewLabel: '抬手预览 · CC 0 – 127',
    },
    flip: {
      id: 'flip',
      modeId: 'B',
      input: 'gravity',
      storageKey: 'phone-midi/calibration/flip/v1',
      exportSchema: 'phone-midi/fusion-calibrate/flip/v1',
      axis: 'fused_flip',
      minLabel: '自然握姿',
      maxLabel: '翻转极限',
      previewLabel: '翻转预览 · CC 0 – 127',
    },
    shake: {
      id: 'shake',
      modeId: 'C',
      input: 'motion',
      // v2: the runtime calibration key. Holds either the wizard's pinned scales
      // (`mode:'fixed'`) or the legacy v1 anchor shape written by the debug page.
      storageKey: 'phone-midi/calibration/shake/v2',
      exportSchema: 'phone-midi/fusion-calibrate/shake/v1',
      axis: 'fused_shake',
      minLabel: '负向满弯音',
      maxLabel: '正向满弯音',
      previewLabel: '摇晃预览 · ±100%',
    },
  };

  const STORAGE_KEY = PROFILES.lift.storageKey;
  const EXPORT_SCHEMA = PROFILES.lift.exportSchema;

  let _legacyMigrated = false;

  function resolveProfile(profile) {
    if (profile == null || profile === '') return PROFILES.lift;
    if (typeof profile === 'string') {
      const p = PROFILES[profile];
      if (!p) throw new Error('未知校准 profile: ' + profile);
      return p;
    }
    return profile;
  }

  function profileInput(profileId) {
    return resolveProfile(profileId).input;
  }

  function profileFromModeId(modeId) {
    if (modeId === 'B') return PROFILES.flip;
    if (modeId === 'A') return PROFILES.lift;
    if (modeId === 'C') return PROFILES.shake;
    return null;
  }

  function justSavedKey(profileId) {
    return 'phone-midi/calibration/just-saved/' + profileId;
  }

  function migrateLegacyCalibration() {
    if (_legacyMigrated) return;
    _legacyMigrated = true;
    try {
      const liftKey = PROFILES.lift.storageKey;
      if (localStorage.getItem(liftKey)) return;
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
        || sessionStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !data.anchors || !anchorsReady(data.anchors)) return;
      data.schema = liftKey;
      data.profile = 'lift';
      data.input = 'orientation';
      const json = JSON.stringify(data);
      localStorage.setItem(liftKey, json);
      sessionStorage.setItem(liftKey, json);
    } catch (_) { /* ignore */ }
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** Quantile of an already-ascending-sorted array (nearest-rank). */
  function quantileSorted(sorted, p) {
    if (!sorted || !sorted.length) return null;
    const i = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[i];
  }

  function getOrientationType() {
    if (screen.orientation && screen.orientation.type) return screen.orientation.type;
    return global.innerWidth > global.innerHeight ? 'landscape' : 'portrait';
  }

  function normalize3(x, y, z) {
    const m = Math.sqrt(x * x + y * y + z * z);
    if (m < 1e-6) return null;
    return { x: x / m, y: y / m, z: z / m };
  }

  function isValidAnchor(a) {
    return a != null && typeof a.beta === 'number' && !Number.isNaN(a.beta)
      && typeof a.gamma === 'number' && !Number.isNaN(a.gamma);
  }

  function isValidGravityAnchor(a) {
    return a != null && typeof a.x === 'number' && !Number.isNaN(a.x)
      && typeof a.y === 'number' && !Number.isNaN(a.y)
      && typeof a.z === 'number' && !Number.isNaN(a.z);
  }

  function anchorsReady(anchors) {
    return anchors && isValidAnchor(anchors.min) && isValidAnchor(anchors.max);
  }

  function gravityAnchorsReady(anchors) {
    return anchors && isValidGravityAnchor(anchors.min) && isValidGravityAnchor(anchors.max);
  }

  function isValidRest(rest) {
    return rest != null && typeof rest.x === 'number' && !Number.isNaN(rest.x)
      && typeof rest.y === 'number' && !Number.isNaN(rest.y)
      && typeof rest.z === 'number' && !Number.isNaN(rest.z);
  }

  function isValidShakePeak(p) {
    return p != null && typeof p.peak === 'number' && !Number.isNaN(p.peak);
  }

  function shakeAnchorsReady(anchors) {
    return anchors && isValidShakePeak(anchors.min) && isValidShakePeak(anchors.max)
      && anchors.max.peak - anchors.min.peak >= MIN_SHAKE_SEP;
  }

  function anchorsReadyForProfile(profileId, anchors) {
    const input = profileInput(profileId);
    if (input === 'gravity') return gravityAnchorsReady(anchors);
    if (input === 'motion') return shakeAnchorsReady(anchors);
    return anchorsReady(anchors);
  }

  function calibrationDataValid(profileId, data) {
    if (!data) return false;
    const input = data.input || profileInput(profileId);
    if (input === 'motion') {
      // Two accepted shapes: the wizard's pinned scales (v2), or the debug page's
      // v1 anchor peaks. Anything else is not a usable shake calibration.
      if (data.mode === 'fixed'
          && validShakeScale(Number(data.scale_neg))
          && validShakeScale(Number(data.scale_pos))) return true;
      return !!data.anchors && shakeAnchorsReady(data.anchors);
    }
    if (!data.anchors) return false;
    if (input === 'gravity') return gravityAnchorsReady(data.anchors);
    return anchorsReady(data.anchors);
  }

  function anchorSeparation(anchors) {
    if (!anchorsReady(anchors)) return 0;
    const db = anchors.max.beta - anchors.min.beta;
    const dg = anchors.max.gamma - anchors.min.gamma;
    return Math.sqrt(db * db + dg * dg);
  }

  function gravityAnchorSeparation(anchors) {
    if (!gravityAnchorsReady(anchors)) return 0;
    const dot = anchors.min.x * anchors.max.x
      + anchors.min.y * anchors.max.y
      + anchors.min.z * anchors.max.z;
    return Math.acos(clamp(dot, -1, 1)) * 180 / Math.PI;
  }

  function shakePeakSpan(anchors) {
    if (!anchors || !isValidShakePeak(anchors.min) || !isValidShakePeak(anchors.max)) return 0;
    return anchors.max.peak - anchors.min.peak;
  }

  function anchorSeparationForProfile(profileId, anchors) {
    const input = profileInput(profileId);
    if (input === 'gravity') return gravityAnchorSeparation(anchors);
    if (input === 'motion') return shakePeakSpan(anchors);
    return anchorSeparation(anchors);
  }

  function fuseEndpointProjection(beta, gamma, anchors, cfg) {
    const b0 = anchors.min.beta;
    const g0 = anchors.min.gamma;
    const db = anchors.max.beta - b0;
    const dg = anchors.max.gamma - g0;
    const denom = db * db + dg * dg;
    if (denom < 1e-6) return 0;
    let t = ((beta - b0) * db + (gamma - g0) * dg) / denom;
    t = clamp(t, 0, 1);
    if (cfg.reverse) t = 1 - t;
    return t;
  }

  function fuseWeightedLinear(beta, gamma, anchors, cfg) {
    const b0 = anchors.min.beta;
    const b1 = anchors.max.beta;
    const g0 = anchors.min.gamma;
    const g1 = anchors.max.gamma;
    const nb = b1 !== b0 ? (beta - b0) / (b1 - b0) : 0;
    const ng = g1 !== g0 ? (gamma - g0) / (g1 - g0) : 0;
    let t = cfg.weights.beta * nb + cfg.weights.gamma * ng;
    t = clamp(t, 0, 1);
    if (cfg.reverse) t = 1 - t;
    return t;
  }

  function fuseGravityEndpointProjection(gx, gy, gz, anchors, cfg) {
    const g = normalize3(gx, gy, gz);
    if (!g) return null;
    const x0 = anchors.min.x;
    const y0 = anchors.min.y;
    const z0 = anchors.min.z;
    const dx = anchors.max.x - x0;
    const dy = anchors.max.y - y0;
    const dz = anchors.max.z - z0;
    const denom = dx * dx + dy * dy + dz * dz;
    if (denom < 1e-6) return 0;
    let t = ((g.x - x0) * dx + (g.y - y0) * dy + (g.z - z0) * dz) / denom;
    t = clamp(t, 0, 1);
    if (cfg.reverse) t = 1 - t;
    return t;
  }

  function computeFusedT(beta, gamma, anchors, fusion) {
    if (!anchorsReady(anchors) || beta == null || gamma == null) return null;
    const cfg = fusion || DEFAULT_FUSION;
    if (cfg.mode === 'weighted_linear') return fuseWeightedLinear(beta, gamma, anchors, cfg);
    return fuseEndpointProjection(beta, gamma, anchors, cfg);
  }

  function computeGravityFusedT(gx, gy, gz, anchors, fusion) {
    if (!gravityAnchorsReady(anchors) || gx == null || gy == null || gz == null) return null;
    const cfg = fusion || DEFAULT_FUSION;
    if (cfg.mode === 'weighted_linear') {
      return fuseGravityEndpointProjection(gx, gy, gz, anchors, cfg);
    }
    return fuseGravityEndpointProjection(gx, gy, gz, anchors, cfg);
  }

  function computeFusedTForProfile(profileId, sample, anchors, fusion) {
    if (profileInput(profileId) === 'gravity') {
      return computeGravityFusedT(sample.gx, sample.gy, sample.gz, anchors, fusion);
    }
    return computeFusedT(sample.beta, sample.gamma, anchors, fusion);
  }

  function fusedToCc(t) {
    if (t == null) return null;
    return Math.round(clamp(t, 0, 1) * 127);
  }

  function shakeSignedToPercent(signed) {
    if (signed == null) return null;
    return Math.round(clamp(signed, -1, 1) * 100);
  }

  function shakeTToPitchBend(t) {
    if (t == null) return null;
    const signed = 2 * clamp(t, 0, 1) - 1;
    return Math.round(8192 + signed * 8192);
  }

  function extractMotionDelta(event, rest) {
    const linear = event.acceleration;
    if (linear && linear.x != null) {
      return {
        x: linear.x - (rest ? rest.x : 0),
        y: linear.y - (rest ? rest.y : 0),
        z: linear.z - (rest ? rest.z : 0),
        source: 'acceleration',
      };
    }
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x == null) return null;
    return {
      x: acc.x - (rest ? rest.x : 0),
      y: acc.y - (rest ? rest.y : 0),
      z: acc.z - (rest ? rest.z : 0),
      source: 'gravity_delta',
    };
  }

  function projectShakeAxis(sample, axis) {
    if (!sample) return null;
    if (axis === 'x') return sample.x;
    if (axis === 'y') return sample.y;
    return Math.abs(sample.x) >= Math.abs(sample.y) ? sample.x : sample.y;
  }

  function resolveShakeAxis(anchors, opts) {
    if (opts && (opts.primaryAxis === 'x' || opts.primaryAxis === 'y')) return opts.primaryAxis;
    if (anchors && (anchors.primaryAxis === 'x' || anchors.primaryAxis === 'y')) {
      return anchors.primaryAxis;
    }
    return 'auto';
  }

  /**
   * Map shake motion to t∈[0,1] (0.5=center), signed∈[-1,1], pb 0..16383.
   */
  function computeShakeMotion(event, anchors, opts) {
    if (!shakeAnchorsReady(anchors)) return null;
    const sample = extractMotionDelta(event, null);
    if (!sample) return null;
    const axis = resolveShakeAxis(anchors, opts);
    const raw = projectShakeAxis(sample, axis);
    if (raw == null) return null;
    const peakMin = anchors.min.peak;
    const peakMax = anchors.max.peak;
    const span = peakMax - peakMin;
    if (span < 1e-6) return null;
    const center = (peakMin + peakMax) / 2;
    const dz = (opts && typeof opts.centerDeadband === 'number') ? opts.centerDeadband : 0.02;
    let t = (raw - peakMin) / span;
    if (Math.abs(raw - center) <= span * dz / 2) t = 0.5;
    t = clamp(t, 0, 1);
    const signed = 2 * t - 1;
    return {
      t,
      signed,
      raw,
      pb: shakeTToPitchBend(t),
      axis,
      source: sample.source,
    };
  }

  /**
   * One-window bidirectional peak capture. Zero reference = absolute still (linear accel ≈ 0).
   *
   * Reports BOTH the raw extremes and robust quantiles. A single spike can otherwise
   * define the whole scale — the archived sample `docs/json.json` has anchors at
   * −52.4/+59.8 while its own trajectory never exceeds 20.2 m/s², and there was no way
   * to tell which number was real. The robust figures make that decidable.
   */
  function captureShakePeaksBoth(windowMs, onTick) {
    const duration = typeof windowMs === 'number' ? windowMs : SHAKE_PEAK_MS;
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const values = [];
      const srcCounts = {};
      let peakMin = Infinity;
      let peakMax = -Infinity;
      let axisVoteX = 0;
      let axisVoteY = 0;
      const handler = (e) => {
        const sample = extractMotionDelta(e, null);
        if (!sample) return;
        srcCounts[sample.source] = (srcCounts[sample.source] || 0) + 1;
        const absX = Math.abs(sample.x);
        const absY = Math.abs(sample.y);
        if (absX >= absY) axisVoteX++;
        else axisVoteY++;
        const raw = absX >= absY ? sample.x : sample.y;
        values.push(raw);
        peakMin = Math.min(peakMin, raw);
        peakMax = Math.max(peakMax, raw);
        if (onTick) {
          onTick({
            peakMin,
            peakMax,
            raw,
            span: peakMax - peakMin,
            elapsed: performance.now() - started,
            sampleCount: values.length,
          });
        }
      };
      global.addEventListener('devicemotion', handler, true);
      setTimeout(() => {
        global.removeEventListener('devicemotion', handler, true);
        const sampleCount = values.length;
        if (sampleCount === 0) {
          reject(new Error('未收到晃动数据，请重试'));
          return;
        }
        if (!Number.isFinite(peakMin) || !Number.isFinite(peakMax)) {
          reject(new Error('峰值采样失败'));
          return;
        }
        const span = peakMax - peakMin;
        const robust = robustShakePeaks(values);
        const robustSpan = robust ? (robust.pos_trim - robust.neg_trim) : 0;
        if (robustSpan < MIN_SHAKE_SEP) {
          reject(new Error(
            '稳健峰值跨度过小（' + robustSpan.toFixed(2) + ' m/s²，原始极值跨度 '
            + span.toFixed(2) + '），请向两侧加大晃动力度'));
          return;
        }
        const capturedAt = new Date().toISOString();
        const source = srcCounts.gravity_delta && !srcCounts.acceleration
          ? 'gravity_delta'
          : (srcCounts.acceleration ? 'acceleration' : null);
        resolve({
          min: {
            peak: Math.round(peakMin * 1000) / 1000,
            peak_robust: Math.round(robust.neg_trim * 1000) / 1000,
            capturedAt,
            sampleCount,
          },
          max: {
            peak: Math.round(peakMax * 1000) / 1000,
            peak_robust: Math.round(robust.pos_trim * 1000) / 1000,
            capturedAt,
            sampleCount,
          },
          primaryAxis: axisVoteX >= axisVoteY ? 'x' : 'y',
          source,
          sources: srcCounts,
          windowMs: duration,
          peak_span: Math.round(span * 1000) / 1000,
          robust,
          robust_span: Math.round(robustSpan * 1000) / 1000,
        });
      }, duration);
    });
  }

  /** Robust per-direction saturation estimate; ignores single-sample spikes. */
  function robustShakePeaks(values) {
    if (!values || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const negatives = sorted.filter((v) => v < 0);   // ascending: most negative first
    const positives = sorted.filter((v) => v > 0);   // ascending: most positive last
    const absSorted = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
    return {
      // Per-direction "high effort" magnitude with the most extreme 10 % trimmed:
      // robust to a single spike, yet still reflects how hard the user really shook.
      // Computed per direction (not as p05/p95 of the whole series) so an asymmetric
      // or time-skewed shake cannot collapse one side to ~0.
      neg_trim: negatives.length ? quantileSorted(negatives, 0.10) : sorted[0],
      pos_trim: positives.length ? quantileSorted(positives, 0.90) : sorted[sorted.length - 1],
      neg_min: sorted[0],
      pos_max: sorted[sorted.length - 1],
      abs_p50: quantileSorted(absSorted, 0.5),
      abs_p95: quantileSorted(absSorted, 0.95),
      sample_count: values.length,
    };
  }

  function loadCalibration(profile) {
    migrateLegacyCalibration();
    const p = resolveProfile(profile);
    try {
      let raw = localStorage.getItem(p.storageKey);
      if (!raw) raw = sessionStorage.getItem(p.storageKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!calibrationDataValid(p.id, data)) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function persistCalibrationJson(profileId, json) {
    const p = resolveProfile(profileId);
    localStorage.setItem(p.storageKey, json);
    sessionStorage.setItem(p.storageKey, json);
    sessionStorage.setItem(justSavedKey(profileId), '1');
  }

  function saveCalibration(profileOrAnchors, anchorsOrFusion, fusionMaybe) {
    let profileId = 'lift';
    let anchors;
    let fusion;
    if (typeof profileOrAnchors === 'string' && PROFILES[profileOrAnchors]) {
      profileId = profileOrAnchors;
      anchors = anchorsOrFusion;
      fusion = fusionMaybe;
    } else {
      anchors = profileOrAnchors;
      fusion = anchorsOrFusion;
    }
    const p = resolveProfile(profileId);
    if (!anchorsReadyForProfile(profileId, anchors)) {
      throw new Error('端点数据不完整，请重新确认两个端点位置');
    }
    const data = {
      schema: p.storageKey,
      profile: p.id,
      input: p.input,
      anchors: {},
      fusion: fusion || DEFAULT_FUSION,
      orientation: getOrientationType(),
      calibratedAt: new Date().toISOString(),
    };
    if (p.input === 'motion') {
      data.zero_reference = 'absolute_still';
      data.anchors.min = { ...anchors.min };
      data.anchors.max = { ...anchors.max };
      if (anchors.primaryAxis) data.anchors.primaryAxis = anchors.primaryAxis;
    } else {
      data.anchors.min = { ...anchors.min };
      data.anchors.max = { ...anchors.max };
    }
    const json = JSON.stringify(data);
    try {
      persistCalibrationJson(profileId, json);
    } catch (e) {
      throw new Error('无法写入本地存储：' + (e.message || '请检查浏览器权限'));
    }
    const verify = loadCalibration(profileId);
    if (!verify) {
      throw new Error('校准保存后校验失败，请重试');
    }
    return verify;
  }

  function clearCalibration(profile) {
    const p = resolveProfile(profile);
    localStorage.removeItem(p.storageKey);
    sessionStorage.removeItem(p.storageKey);
    sessionStorage.removeItem(justSavedKey(p.id));
  }

  function consumeJustSavedFlag(profile) {
    const p = resolveProfile(profile);
    const key = justSavedKey(p.id);
    const v = sessionStorage.getItem(key);
    if (v) sessionStorage.removeItem(key);
    return v === '1';
  }

  function hasCalibration(profile) {
    const c = loadCalibration(profile);
    return calibrationDataValid(resolveProfile(profile).id, c);
  }

  function average(samples, key) {
    const vals = samples.map(s => s[key]).filter(v => typeof v === 'number' && !Number.isNaN(v));
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function captureAnchorSamples() {
    return new Promise((resolve, reject) => {
      const samples = [];
      const handler = (e) => {
        if (e.beta == null || e.gamma == null) return;
        samples.push({ beta: e.beta, gamma: e.gamma });
      };
      global.addEventListener('deviceorientation', handler, true);
      setTimeout(() => {
        global.removeEventListener('deviceorientation', handler, true);
        if (samples.length === 0) {
          reject(new Error('未收到 orientation 数据'));
          return;
        }
        const point = {
          beta: average(samples, 'beta'),
          gamma: average(samples, 'gamma'),
          capturedAt: new Date().toISOString(),
          sampleCount: samples.length,
        };
        if (!isValidAnchor(point)) {
          reject(new Error('采样数据不完整（需要 beta 与 gamma），请重试'));
          return;
        }
        resolve(point);
      }, CAPTURE_MS);
    });
  }

  /**
   * Gravity anchors from the attitude, averaged and normalised — deliberately the *same* source
   * `feedFlipOrientation` uses at runtime, so capture and runtime cannot disagree about the
   * frame or the sign convention (a calibration taken from the old accelerometer source has to
   * be re-taken once: a platform that reports the negated gravity vector would otherwise map the
   * flip backwards, and the endpoint projection is not invariant under that sign change).
   * The stored JSON shape is unchanged (x/y/z unit vector).
   */
  function captureGravityAnchorSamples() {
    return new Promise((resolve, reject) => {
      const samples = [];
      const handler = (e) => {
        const g = gravityFromOrientation(e.beta, e.gamma);
        if (g) samples.push(g);
      };
      global.addEventListener('deviceorientation', handler, true);
      setTimeout(() => {
        global.removeEventListener('deviceorientation', handler, true);
        if (samples.length === 0) {
          reject(new Error('未收到姿态数据，请确认已授权方向传感器'));
          return;
        }
        const ax = average(samples, 'x');
        const ay = average(samples, 'y');
        const az = average(samples, 'z');
        const n = normalize3(ax, ay, az);
        if (!n) {
          reject(new Error('采样不稳定，请保持静止后重试'));
          return;
        }
        resolve({
          x: n.x,
          y: n.y,
          z: n.z,
          raw: { x: ax, y: ay, z: az },
          capturedAt: new Date().toISOString(),
          sampleCount: samples.length,
        });
      }, CAPTURE_MS);
    });
  }

  function captureAnchorSamplesForProfile(profileId) {
    if (profileInput(profileId) === 'gravity') return captureGravityAnchorSamples();
    return captureAnchorSamples();
  }

  async function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') throw new Error('传感器权限被拒绝');
    }
  }

  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') throw new Error('运动传感器权限被拒绝');
    }
  }

  async function requestProfilePermissions(profileId) {
    const input = profileInput(profileId);
    if (input === 'motion') {
      await requestMotionPermission();
      return;
    }
    // 'gravity' (Mode B) is derived from the attitude, so it needs the orientation sensor
    // only — the same single permission Mode A needs. Mode C's 'motion' needs both.
    await requestOrientationPermission();
  }

  /**
   * Mode B production path: attitude -> gravity direction -> endpoint projection.
   * Stateless and unfiltered, exactly like Mode A. The only conditioning left is the
   * send-side change threshold in `emitValue` (>= 1 CC step), which rejects rest noise
   * without adding any lag to the control value.
   */
  function feedFlipOrientation(beta, gamma, anchors, fusion) {
    const g = gravityFromOrientation(beta, gamma);
    if (!g) return null;
    const t = computeGravityFusedT(g.x, g.y, g.z, anchors, fusion);
    if (t == null) return null;
    return { t, t_raw: t, g };
  }

  // ── Mode C: shake → pitch bend runtime ─────────────────────────────────────
  //
  // Design: docs/spec/mode-c-shake.md. Three properties drive this code:
  //  1. The control variable is instantaneous *linear* acceleration, so stopping the
  //     shake physically re-centres the bend. There is deliberately NO hard re-centre
  //     rule (10.1) — which makes an exact zero point the single point of failure.
  //  2. Therefore: a slowly tracked bias (auto-zero) plus, on devices that lack
  //     `event.acceleration`, a high-pass gravity estimate. Without those, "at rest"
  //     is not zero and the instrument sits detuned instead of merely feeling off.
  //  3. Full bend (`scale`, m/s²) is adaptive by default and can be pinned by the
  //     optional wizard. It is persisted per screen orientation as a *prior* (P2).

  const SHAKE_TUNING_KEY = 'phone-midi/tuning/shake/v1';
  const SHAKE_SCALES_KEY = PROFILES.shake.storageKey;
  const SHAKE_MIN_SCALE = 3;

  const SHAKE_TUNING_DEFAULTS = {
    bendRange: 0.5,          // output excursion: PB = 8192 ± bendRange·8192
    deadbandCounts: 30,      // centre deadband, counted in PB counts
    minStepCounts: 4,        // send when |ΔPB| >= this
    axisMode: 'auto',        // 'auto' | 'x' | 'y'
    // Fixed full-bend amplitude, m/s². A shake of this size drives the bend to its
    // configured limit (bendRange); anything gentler scales down proportionally, so the
    // hand fully determines the output. Deliberately NOT adaptive: an estimator that
    // re-normalises to the user's habitual effort severs the link between how hard you
    // shake and how far the bend goes, which is the whole point of an instrument.
    // 80 rather than 40 because real-device feedback showed ordinary shaking already
    // reaching ~40 m/s², i.e. the default saturated on normal playing.
    fixedScale: 80,
    gravityCutoffHz: 0.3,    // fallback path: high-pass estimate of linear accel
    biasTauSec: 3.0,         // how fast the zero point tracks while stationary
    stillThreshold: 1.2,     // m/s² below which we call it stationary
    stillSamples: 12,
    measureWindowMs: 3000,   // rolling window for the "how hard are you shaking" readout
    // Deliberately transparent: the mapping must stay proportional to the hand, and a
    // One Euro filter tightens its cutoff exactly where the waveform peaks (derivative
    // ≈ 0), which rounds off the top of the travel. Measured peak loss: 2.3% at
    // mincutoff 6 / beta 1.2 versus 1.0% here. Rest jitter is handled by the count-space
    // deadband instead, so a high mincutoff costs nothing.
    oneEuro: { mincutoff: 12.0, beta: 3.0, dcutoff: 1.0 },
  };

  const SHAKE_TUNING_LIMITS = {
    bendRange: { min: 0.05, max: 1.0, step: 0.05 },
    deadbandCounts: { min: 0, max: 400, step: 10 },
    minStepCounts: { min: 1, max: 64, step: 1 },
    fixedScale: { min: 3, max: 400, step: 1 },
    stillThreshold: { min: 0.2, max: 6, step: 0.1 },
  };

  const _shakeTuning = { ...SHAKE_TUNING_DEFAULTS, oneEuro: { ...SHAKE_TUNING_DEFAULTS.oneEuro } };

  function clampShakeValue(key, v) {
    const lim = SHAKE_TUNING_LIMITS[key];
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (!lim) return n;
    return Math.max(lim.min, Math.min(lim.max, n));
  }

  function getShakeTuning() {
    return { ..._shakeTuning, oneEuro: { ..._shakeTuning.oneEuro } };
  }

  /** Mutates _shakeTuning in place so live readers (feedShakeMotion) pick changes up. */
  function applyShakeTuning(t) {
    if (!t) return getShakeTuning();
    for (const key of Object.keys(SHAKE_TUNING_LIMITS)) {
      if (t[key] === undefined) continue;
      const v = clampShakeValue(key, t[key]);
      if (v != null) _shakeTuning[key] = v;
    }
    if (t.axisMode === 'auto' || t.axisMode === 'x' || t.axisMode === 'y') {
      _shakeTuning.axisMode = t.axisMode;
    }
    if (t.oneEuro) {
      for (const k of ['mincutoff', 'beta', 'dcutoff']) {
        const v = Number(t.oneEuro[k]);
        if (Number.isFinite(v) && v >= 0) _shakeTuning.oneEuro[k] = v;
      }
    }
    return getShakeTuning();
  }

  function setShakeTuning(t) {
    const next = applyShakeTuning(t);
    try {
      localStorage.setItem(SHAKE_TUNING_KEY, JSON.stringify(next));
    } catch (_) { /* private mode: keep the in-memory value */ }
    return next;
  }

  function resetShakeTuning() {
    try { localStorage.removeItem(SHAKE_TUNING_KEY); } catch (_) { /* ignore */ }
    return applyShakeTuning(SHAKE_TUNING_DEFAULTS);
  }

  function loadShakeTuning() {
    try {
      const raw = localStorage.getItem(SHAKE_TUNING_KEY);
      if (!raw) return getShakeTuning();
      return applyShakeTuning(JSON.parse(raw));
    } catch (_) {
      return getShakeTuning();
    }
  }

  /** One-pole alpha for a cutoff in Hz. Shared by Mode C's One Euro step. */
  function lowPassAlpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 1e-4));
  }

  function oneEuroStep(euro, value, dt, cfg) {
    if (euro.x == null || Number.isNaN(euro.x)) {
      euro.x = value; euro.dx = 0;
      return value;
    }
    const dtSafe = Math.max(dt, 1e-4);
    const edx = (value - euro.x) / dtSafe;
    const aD = lowPassAlpha(cfg.dcutoff, dtSafe);
    euro.dx = aD * edx + (1 - aD) * euro.dx;
    const cutoff = cfg.mincutoff + cfg.beta * Math.abs(euro.dx);
    const a = lowPassAlpha(cutoff, dtSafe);
    euro.x = a * value + (1 - a) * euro.x;
    return euro.x;
  }

  function createShakeRuntime() {
    return {
      startedAt: performance.now(),
      lastTime: null,
      sampleCount: 0,
      // fallback path state
      gravity: { x: 0, y: 0, z: 0, init: false },
      srcCounts: { acceleration: 0, gravity_delta: 0 },
      lastSource: null,
      // zero point
      bias: { x: 0, y: 0, z: 0 },
      stillCount: 0,
      stationary: true,
      // axis
      axis: 'x',
      vote: { x: 0, y: 0 },
      voteWindow: [],
      // scale: fixed amplitude for full bend, from the wizard calibration when present,
      // otherwise from tuning.fixedScale. Never estimated at runtime.
      scaleNeg: null,
      scalePos: null,
      scaleMode: 'fixed',
      cal: null,
      // Rolling measurements for the UI. They are *display only* — they never feed back
      // into the mapping, which is what keeps shake → bend strictly proportional.
      measureWindow: [],
      motionMaxNeg: null,
      motionMaxPos: null,
      motionP95Neg: null,
      motionP95Pos: null,
      // Rolling "how much of the bend range is this motion actually using".
      usageWindow: [],
      // output
      euro: { x: null, dx: 0 },
      lastU: null,
      lastRaw: null,
      lastPb: null,
      // diagnostics for acceptance A1/A9/A10
      staticLog: [],
      motionSeen: false,
      stillSince: null,
      recenterMs: null,
    };
  }

  let _shakeRuntime = createShakeRuntime();

  function shakeRuntime() {
    return _shakeRuntime;
  }

  /**
   * Full reset, e.g. when (re)entering Mode C. The wizard calibration is re-read eagerly
   * so a value saved on another page is picked up, and the state is inspectable
   * immediately after the reset.
   */
  function resetShakeRuntime() {
    _shakeRuntime = createShakeRuntime();
    _shakeRuntime.cal = loadFixedShakeScales();
  }

  /** Wizard result: pin both directions. Overrides tuning.fixedScale when present. */
  function loadFixedShakeScales() {
    try {
      const raw = localStorage.getItem(SHAKE_SCALES_KEY) || sessionStorage.getItem(SHAKE_SCALES_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      const neg = Number(d.scale_neg);
      const pos = Number(d.scale_pos);
      if (d.mode !== 'fixed' || !validShakeScale(neg) || !validShakeScale(pos)) return null;
      return {
        mode: 'fixed',
        scale_neg: neg,
        scale_pos: pos,
        calibratedAt: d.calibratedAt || null,
        source: d.source || null,
      };
    } catch (_) {
      return null;
    }
  }

  function validShakeScale(v) {
    return Number.isFinite(v) && v >= SHAKE_MIN_SCALE && v <= 400;
  }

  function saveFixedShakeScales(scaleNeg, scalePos, extras) {
    if (!validShakeScale(scaleNeg) || !validShakeScale(scalePos)) {
      throw new Error('力度刻度无效（需要 3–400 m/s² 两个方向的值）');
    }
    const data = {
      schema: SHAKE_SCALES_KEY,
      profile: 'shake',
      mode: 'fixed',
      input: 'motion',
      scale_neg: Math.round(scaleNeg * 100) / 100,
      scale_pos: Math.round(scalePos * 100) / 100,
      source: (extras && extras.source) || null,
      sources: (extras && extras.sources) || null,
      robust: (extras && extras.robust) || null,
      windowMs: (extras && extras.windowMs) || null,
      orientation: getOrientationType(),
      calibratedAt: new Date().toISOString(),
    };
    try {
      const json = JSON.stringify(data);
      localStorage.setItem(SHAKE_SCALES_KEY, json);
      sessionStorage.setItem(SHAKE_SCALES_KEY, json);
    } catch (e) {
      throw new Error('无法写入本地存储：' + (e.message || '请检查浏览器权限'));
    }
    resetShakeRuntime();
    return data;
  }

  function clearFixedShakeScales() {
    try {
      localStorage.removeItem(SHAKE_SCALES_KEY);
      sessionStorage.removeItem(SHAKE_SCALES_KEY);
    } catch (_) { /* ignore */ }
    resetShakeRuntime();
  }

  /**
   * Linear acceleration.
   *  - `event.acceleration` is already gravity-free → use it verbatim.
   *  - Otherwise subtract a slow gravity estimate from `accelerationIncludingGravity`.
   *    Using the raw including-gravity vector here (the old behaviour) leaves a
   *    constant ~9.8 m/s² offset, i.e. a permanently detuned instrument at rest.
   */
  function extractLinearAcceleration(state, event, tuning, dt) {
    const lin = event.acceleration;
    if (lin && lin.x != null) {
      state.srcCounts.acceleration++;
      state.lastSource = 'acceleration';
      return { x: lin.x, y: lin.y, z: lin.z };
    }
    const raw = event.accelerationIncludingGravity;
    if (!raw || raw.x == null) return null;
    state.srcCounts.gravity_delta++;
    state.lastSource = 'gravity_delta';
    if (!state.gravity.init) {
      state.gravity = { x: raw.x, y: raw.y, z: raw.z, init: true };
    } else {
      const a = lowPassAlpha(tuning.gravityCutoffHz, dt);
      state.gravity.x = a * raw.x + (1 - a) * state.gravity.x;
      state.gravity.y = a * raw.y + (1 - a) * state.gravity.y;
      state.gravity.z = a * raw.z + (1 - a) * state.gravity.z;
    }
    return { x: raw.x - state.gravity.x, y: raw.y - state.gravity.y, z: raw.z - state.gravity.z };
  }

  /**
   * Stationarity + auto-zero. Both are evaluated on the *uncorrected* linear
   * acceleration: unlike the residual, its magnitude is independent of the current
   * bias estimate, so a bad bias cannot deadlock the update.
   */
  function updateZeroPoint(state, a, tuning, dt) {
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (mag < tuning.stillThreshold) state.stillCount++;
    else state.stillCount = 0;
    const wasStationary = state.stationary;
    state.stationary = state.stillCount >= tuning.stillSamples;
    if (state.stationary) {
      const alpha = 1 - Math.exp(-dt / Math.max(tuning.biasTauSec, 1e-3));
      state.bias.x += alpha * (a.x - state.bias.x);
      state.bias.y += alpha * (a.y - state.bias.y);
      state.bias.z += alpha * (a.z - state.bias.z);
    }
    return { mag, becameStationary: state.stationary && !wasStationary };
  }

  /**
   * Axis energy vote over the last 2 s, applied only while stationary: at rest the
   * bend is centred, so switching then is invisible; switching mid-shake would jump.
   *
   * Two guards matter here, both learned the hard way:
   *  1. Only samples that carry real motion are recorded. Recording near-zero residual
   *     samples let *floating-point noise* decide the axis — on the gravity-fallback
   *     path that pinned the axis to `y` and produced no bend at all until the next
   *     shake.
   *  2. A clear winner (1.3×) is required, otherwise the current axis is kept.
   */
  function updateAxisVote(state, corr, tuning, dt, stationary) {
    if (tuning.axisMode === 'x' || tuning.axisMode === 'y') {
      state.axis = tuning.axisMode;
      return;
    }
    const now = performance.now();
    const ax = Math.abs(corr.x);
    const ay = Math.abs(corr.y);
    const mag = ax + ay;
    const moved = mag > tuning.stillThreshold;

    if (!stationary && moved) {
      state.voteWindow.push({ t: now, x: ax, y: ay });
    }
    while (state.voteWindow.length && state.voteWindow[0].t < now - 2000) state.voteWindow.shift();

    if (stationary) {
      // Decide from the last burst of movement.
      if (!state.voteWindow.length) return;
      let sx = 0; let sy = 0;
      for (const s of state.voteWindow) { sx += s.x; sy += s.y; }
      state.vote = { x: sx, y: sy };
      if (sx >= sy * 1.3) state.axis = 'x';
      else if (sy >= sx * 1.3) state.axis = 'y';
      return;
    }

    // Rescue while shaking: switch only when the current axis is dead and the other
    // one clearly carries the motion. The output is centred in that case anyway, so
    // the switch cannot produce a jump.
    const cur = state.axis === 'x' ? ax : ay;
    const other = state.axis === 'x' ? ay : ax;
    if (cur < tuning.stillThreshold && other > cur * 3) {
      state.axis = state.axis === 'x' ? 'y' : 'x';
    }
  }

  /**
   * Rolling measurements of how hard the user is actually shaking, for the UI only.
   * Displayed so the fixed full-bend amplitude can be set from observation instead of
   * guesswork ("shake normally, read the peak, set the value"). Never used as a scale.
   */
  function measureMotion(state, value, now, tuning) {
    state.measureWindow.push({ t: now, v: value });
    while (state.measureWindow.length && state.measureWindow[0].t < now - tuning.measureWindowMs) {
      state.measureWindow.shift();
    }
    const pos = state.measureWindow.filter((s) => s.v > 0).map((s) => s.v).sort((a, b) => a - b);
    const neg = state.measureWindow.filter((s) => s.v < 0).map((s) => -s.v).sort((a, b) => a - b);
    if (pos.length) {
      state.motionMaxPos = pos[pos.length - 1];
      state.motionP95Pos = quantileSorted(pos, 0.95);
    }
    if (neg.length) {
      state.motionMaxNeg = neg[neg.length - 1];
      state.motionP95Neg = quantileSorted(neg, 0.95);
    }
  }

  /** u ∈ [−1,1] → PB counts, with the centre deadband applied in count space. */
  function shakeUToPb(u, tuning) {
    const t = tuning || getShakeTuning();
    const excursion = clamp(u, -1, 1) * t.bendRange * 8192;
    if (Math.abs(excursion) < t.deadbandCounts) return 8192;
    return Math.max(0, Math.min(16383, Math.round(8192 + excursion)));
  }

  /**
   * Mode C production path.
   * Returns null until sensor data arrives, otherwise the full diagnostic record so
   * the UI (and /fusion-calibrate-shake.html) can show what the runtime is doing.
   */
  function feedShakeMotion(event, opts) {
    const tuning = getShakeTuning();
    const state = shakeRuntime();
    const now = performance.now();
    const dt = state.lastTime != null
      ? Math.min(0.2, Math.max(0.001, (now - state.lastTime) / 1000))
      : 1 / 60;
    state.lastTime = now;

    const a = extractLinearAcceleration(state, event, tuning, dt);
    if (!a) return null;
    state.sampleCount++;
    state.lastDt = dt;

    const { becameStationary } = updateZeroPoint(state, a, tuning, dt);
    const corr = { x: a.x - state.bias.x, y: a.y - state.bias.y, z: a.z - state.bias.z };
    updateAxisVote(state, corr, tuning, dt, state.stationary);
    const raw = state.axis === 'x' ? corr.x : corr.y;

    // Fixed mapping: the amplitude demonstrated in the wizard when available, otherwise
    // the user-set full-bend amplitude. No runtime estimation — the bend is a pure
    // function of how hard the phone is being shaken.
    if (state.cal == null) state.cal = loadFixedShakeScales();
    const scaleNeg = state.cal ? state.cal.scale_neg : tuning.fixedScale;
    const scalePos = state.cal ? state.cal.scale_pos : tuning.fixedScale;
    state.scaleNeg = scaleNeg;
    state.scalePos = scalePos;
    state.scaleMode = state.cal ? 'calibrated' : 'fixed';

    const scale = raw >= 0 ? scalePos : scaleNeg;
    const uRaw = scale > 0 ? clamp(raw / scale, -1, 1) : 0;
    const u = clamp(oneEuroStep(state.euro, uRaw, dt, tuning.oneEuro), -1, 1);
    const pb = shakeUToPb(u, tuning);

    state.lastRaw = raw;
    state.lastU = u;
    state.lastPb = pb;
    measureMotion(state, raw, now, tuning);

    state.usageWindow.push({ t: now, a: Math.abs(u) });
    while (state.usageWindow.length && state.usageWindow[0].t < now - 3000) state.usageWindow.shift();
    let usage = 0;
    for (const e of state.usageWindow) { if (e.a > usage) usage = e.a; }

    // A10: how long after motion stops the bend is back within 16 counts of centre.
    if (!state.stationary) {
      state.motionSeen = true;
      state.stillSince = null;
    } else if (state.motionSeen && state.stillSince == null) {
      state.stillSince = now;
    }
    if (state.stillSince != null && Math.abs(pb - 8192) <= 16) {
      state.recenterMs = now - state.stillSince;
      state.motionSeen = false;
      state.stillSince = null;
    }

    // A1/A9: distribution of the static offset over a rolling 60 s.
    if (state.stationary) {
      state.staticLog.push({ t: now, off: Math.abs(pb - 8192) });
      while (state.staticLog.length && state.staticLog[0].t < now - 60000) state.staticLog.shift();
    }

    return {
      pb,
      t: (u + 1) / 2,
      u,
      u_raw: uRaw,
      raw,
      dt,
      axis: state.axis,
      source: state.lastSource,
      degraded: state.lastSource === 'gravity_delta',
      stationary: state.stationary,
      becameStationary,
      scaleNeg: state.scaleNeg,
      scalePos: state.scalePos,
      scaleMode: state.scaleMode,
      bendRange: tuning.bendRange,
      usage,
      usagePct: Math.round(usage * 100),
      inDeadband: pb === 8192,
      bias: { ...state.bias },
    };
  }

  /** Snapshot for the diagnostic UI (A1/A9/A10 numbers included). */
  function getShakeDiagnostics() {
    const s = shakeRuntime();
    const offsets = s.staticLog.map((e) => e.off);
    const spanMs = s.staticLog.length > 1
      ? s.staticLog[s.staticLog.length - 1].t - s.staticLog[0].t
      : 0;
    return {
      samples: s.sampleCount,
      axis: s.axis,
      axisMode: _shakeTuning.axisMode,
      source: s.lastSource,
      degraded: s.lastSource === 'gravity_delta',
      srcCounts: { ...s.srcCounts },
      stationary: s.stationary,
      bias: { ...s.bias },
      gravityEstimate: { ...s.gravity },
      lastDt: s.lastTime != null && s.lastDt != null ? s.lastDt : null,
      scaleNeg: s.scaleNeg,
      scalePos: s.scalePos,
      scaleMode: s.scaleMode,
      fixedScale: _shakeTuning.fixedScale,
      calibrated: s.cal != null,
      // Measured motion (display only, never fed back into the mapping).
      motionMaxNeg: s.motionMaxNeg,
      motionMaxPos: s.motionMaxPos,
      motionP95Neg: s.motionP95Neg,
      motionP95Pos: s.motionP95Pos,
      lastRaw: s.lastRaw,
      lastU: s.lastU,
      lastPb: s.lastPb,
      // Usage over the last 3 s: "how much of the bend range is this using".
      usagePct: Math.round((s.usageWindow.reduce((m, e) => Math.max(m, e.a), 0)) * 100),
      bendRange: _shakeTuning.bendRange,
      // A1 / A9
      staticSamples: offsets.length,
      staticSpanMs: Math.round(spanMs),
      staticMaxOffset: offsets.length ? Math.max.apply(null, offsets) : null,
      staticMeanOffset: offsets.length
        ? Math.round((offsets.reduce((a, b) => a + b, 0) / offsets.length) * 10) / 10
        : null,
      // A10
      recenterMs: s.recenterMs != null ? Math.round(s.recenterMs) : null,
      fastWindowMs: Math.max(0, Math.round(_shakeTuning.adaptiveFastMs - (performance.now() - s.startedAt))),
    };
  }

  function buildExportJson(profile, anchors, fusion, extras) {
    const p = resolveProfile(profile);
    const isGravity = p.input === 'gravity';
    const isMotion = p.input === 'motion';
    const out = {
      schema: p.exportSchema,
      profile: p.id,
      input: p.input,
      device: { userAgent: navigator.userAgent, platform: navigator.platform || '' },
      session: {
        orientation: getOrientationType(),
        startedAt: (extras && extras.startedAt) || new Date().toISOString(),
      },
      endpoint_semantics: isMotion
        ? {
          zero_reference: 'absolute_still (linear acceleration ≈ 0)',
          min_pose: p.minLabel,
          min_bend: '-100%',
          max_pose: p.maxLabel,
          max_bend: '+100%',
        }
        : {
          min_pose: p.minLabel,
          min_cc: 0,
          max_pose: p.maxLabel,
          max_cc: 127,
        },
      anchors: {},
      fusion: fusion || DEFAULT_FUSION,
      recommended_mapping: isMotion
        ? {
          sensor: 'accelerometer',
          axis: p.axis,
          kind: 'pb',
          value_kind: 'bipolar',
          value_range: [0.0, 1.0],
          bend_range: getShakeTuning().bendRange,
          notes: 'Phone computes fused t from shake peaks; Bridge maps t→Pitch Bend (0.5=center). '
            + 'kind/value_kind are explicit since ADR 0003 — the Bridge no longer infers the '
            + 'target type from sensor/axis.',
        }
        : {
          sensor: isGravity ? 'accelerometer' : 'rotation_vector',
          axis: p.axis,
          value_range: [0.0, 1.0],
          notes: isGravity
            ? 'Phone computes fused t from gravity vector; Bridge in_min=0, in_max=1 → CC 0-127'
            : 'Phone computes fused t; Bridge in_min=0, in_max=1 → CC 0-127',
        },
    };
    if (isMotion) {
      out.zero_reference = 'absolute_still';
      if (anchors.min) out.anchors.min = { ...anchors.min };
      if (anchors.max) out.anchors.max = { ...anchors.max };
      if (anchors.primaryAxis) out.anchors.primaryAxis = anchors.primaryAxis;
      // A8: the export must be able to prove itself. Without `source` the archived
      // sample cannot tell a real linear-acceleration capture from the
      // gravity-subtracted fallback, and without quantiles a single spike cannot be
      // told apart from a genuine full-effort shake.
      out.source = anchors.source || null;
      out.sources = anchors.sources || null;
      out.robust = anchors.robust || null;
      out.robust_span = anchors.robust_span != null ? anchors.robust_span : null;
      out.window_ms = anchors.windowMs != null ? anchors.windowMs : null;
    } else {
      if (anchors.min) out.anchors.min = { ...anchors.min };
      if (anchors.max) out.anchors.max = { ...anchors.max };
    }
    if (anchorsReadyForProfile(p.id, anchors)) {
      const sep = anchorSeparationForProfile(p.id, anchors);
      out.anchor_separation = isMotion
        ? { peak_span: Math.round(sep * 1000) / 1000, unit: 'm/s²' }
        : { angle_deg: Math.round(sep * 10) / 10 };
    }
    if (extras && extras.shake_opts) out.shake_opts = extras.shake_opts;
    if (extras && extras.trajectory) out.trajectory = extras.trajectory;
    return out;
  }

  // Mode B has no tunable state: its chain is stateless (see gravityFromOrientation), so a
  // debug page can no longer leave a persisted override behind for the control page.
  // Mode C: bendRange and friends are user-tunable and persisted.
  loadShakeTuning();

  global.PhoneMidiFusion = {
    LEGACY_STORAGE_KEY,
    STORAGE_KEY,
    EXPORT_SCHEMA,
    PROFILES,
    CAPTURE_MS,
    SHAKE_PEAK_MS,
    MIN_SEP,
    MIN_SHAKE_SEP,
    DEFAULT_FUSION,
    // ── Mode C runtime (ADR 0003 + spec/mode-c-shake.md) ──
    SHAKE_TUNING_KEY,
    SHAKE_SCALES_KEY,
    SHAKE_TUNING_DEFAULTS,
    SHAKE_TUNING_LIMITS,
    getShakeTuning,
    setShakeTuning,
    resetShakeTuning,
    loadShakeTuning,
    shakeUToPb,
    feedShakeMotion,
    resetShakeRuntime,
    getShakeDiagnostics,
    loadFixedShakeScales,
    saveFixedShakeScales,
    clearFixedShakeScales,
    validShakeScale,
    robustShakePeaks,
    quantileSorted,
    // ── Mode B: attitude-declared gravity, no tunable state ──
    gravityFromOrientation,
    feedFlipOrientation,
    clamp,
    normalize3,
    getOrientationType,
    resolveProfile,
    profileInput,
    profileFromModeId,
    anchorsReady,
    gravityAnchorsReady,
    shakeAnchorsReady,
    shakePeakSpan,
    anchorsReadyForProfile,
    anchorSeparation,
    gravityAnchorSeparation,
    anchorSeparationForProfile,
    computeFusedT,
    computeGravityFusedT,
    computeFusedTForProfile,
    fusedToCc,
    shakeSignedToPercent,
    shakeTToPitchBend,
    extractMotionDelta,
    projectShakeAxis,
    computeShakeMotion,
    captureShakePeaksBoth,
    loadCalibration,
    saveCalibration,
    clearCalibration,
    hasCalibration,
    captureAnchorSamples,
    captureGravityAnchorSamples,
    captureAnchorSamplesForProfile,
    requestOrientationPermission,
    requestMotionPermission,
    requestProfilePermissions,
    buildExportJson,
    consumeJustSavedFlag,
    isValidAnchor,
    isValidGravityAnchor,
    migrateLegacyCalibration,
  };
})(typeof window !== 'undefined' ? window : globalThis);
