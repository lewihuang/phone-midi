// Phone MIDI CC — shared fusion + per-mode calibration storage
(function (global) {
  'use strict';

  const LEGACY_STORAGE_KEY = 'phone-midi/calibration/v1';
  const CAPTURE_MS = 400;
  const MIN_SEP = 4;

  /** Flip runtime stabilizer: A sliding avg (ms) + C One Euro on t */
  const FLIP_STABILIZER = {
    gravityAvgMs: 50,
    oneEuro: { mincutoff: 1.0, beta: 0.008, dcutoff: 1.0 },
    sendMinDelta: 0.012,
    ccHysteresis: 0.5,
  };

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

  function anchorsReadyForProfile(profileId, anchors) {
    if (profileInput(profileId) === 'gravity') return gravityAnchorsReady(anchors);
    return anchorsReady(anchors);
  }

  function calibrationDataValid(profileId, data) {
    if (!data || !data.anchors) return false;
    const input = data.input || profileInput(profileId);
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

  function anchorSeparationForProfile(profileId, anchors) {
    if (profileInput(profileId) === 'gravity') return gravityAnchorSeparation(anchors);
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
      anchors: {
        min: { ...anchors.min },
        max: { ...anchors.max },
      },
      fusion: fusion || DEFAULT_FUSION,
      orientation: getOrientationType(),
      calibratedAt: new Date().toISOString(),
    };
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

  function captureGravityAnchorSamples() {
    return new Promise((resolve, reject) => {
      const samples = [];
      const handler = (e) => {
        const acc = e.accelerationIncludingGravity;
        if (!acc || acc.x == null) return;
        samples.push({ x: acc.x, y: acc.y, z: acc.z });
      };
      global.addEventListener('devicemotion', handler, true);
      setTimeout(() => {
        global.removeEventListener('devicemotion', handler, true);
        if (samples.length === 0) {
          reject(new Error('未收到传感器数据'));
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
    await requestOrientationPermission();
    if (profileInput(profileId) === 'gravity') {
      await requestMotionPermission();
    }
  }

  function extractGravityFromMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x == null) return null;
    return normalize3(acc.x, acc.y, acc.z);
  }

  function lowPassAlpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 1e-4));
  }

  function oneEuroFilterT(euro, value, dt) {
    const cfg = FLIP_STABILIZER.oneEuro;
    if (euro.x == null || Number.isNaN(euro.x)) {
      euro.x = value;
      euro.dx = 0;
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

  function createFlipStabilizer() {
    return {
      gravityBuffer: [],
      euro: { x: null, dx: 0, lastTime: null },
    };
  }

  function resetFlipStabilizer(state) {
    if (!state) return;
    state.gravityBuffer = [];
    state.euro = { x: null, dx: 0, lastTime: null };
  }

  function pushFlipGravityRaw(state, event, gravityAvgMs) {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x == null) return false;
    const avgMs = typeof gravityAvgMs === 'number' ? gravityAvgMs : FLIP_STABILIZER.gravityAvgMs;
    const now = performance.now();
    state.gravityBuffer.push({ x: acc.x, y: acc.y, z: acc.z, t: now });
    const cutoff = now - avgMs;
    while (state.gravityBuffer.length && state.gravityBuffer[0].t < cutoff) {
      state.gravityBuffer.shift();
    }
    return true;
  }

  function averagedGravityFromBuffer(state) {
    const buf = state.gravityBuffer;
    if (!buf.length) return null;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < buf.length; i++) {
      sx += buf[i].x;
      sy += buf[i].y;
      sz += buf[i].z;
    }
    const n = buf.length;
    return normalize3(sx / n, sy / n, sz / n);
  }

  /**
   * A + C pipeline: buffer-averaged ĝ → project → One Euro on t.
   * Returns { t, t_raw, g } or null.
   */
  function processFlipGravityMotion(state, event, anchors, fusion, opts) {
    const gravityAvgMs = opts && typeof opts.gravityAvgMs === 'number'
      ? opts.gravityAvgMs
      : FLIP_STABILIZER.gravityAvgMs;
    if (!state || !pushFlipGravityRaw(state, event, gravityAvgMs)) return null;
    const g = averagedGravityFromBuffer(state);
    if (!g) return null;
    const tRaw = computeGravityFusedT(g.x, g.y, g.z, anchors, fusion);
    if (tRaw == null) return null;
    const now = performance.now();
    const dt = state.euro.lastTime != null ? (now - state.euro.lastTime) / 1000 : 0.016;
    state.euro.lastTime = now;
    const t = clamp(oneEuroFilterT(state.euro, tRaw, dt), 0, 1);
    return { t, t_raw: tRaw, g };
  }

  /** B: CC-level hysteresis + minimum delta before WebSocket send */
  function flipShouldSendValue(t, lastSentVal, lastSentCc) {
    if (t == null) return false;
    const cc = fusedToCc(t);
    const h = FLIP_STABILIZER.ccHysteresis;
    if (lastSentCc != null) {
      if (cc === lastSentCc) return false;
      if (cc > lastSentCc) {
        if (t < (cc - h) / 127) return false;
      } else if (t > (cc + h) / 127) {
        return false;
      }
    }
    if (lastSentVal !== null && Math.abs(t - lastSentVal) < FLIP_STABILIZER.sendMinDelta) {
      return false;
    }
    return true;
  }

  let _flipRuntime = createFlipStabilizer();

  /** Mode B production path: smoothed flip t from devicemotion (A+C internal). */
  function feedFlipMotion(event, anchors, fusion) {
    return processFlipGravityMotion(_flipRuntime, event, anchors, fusion);
  }

  function resetFlipMotion() {
    resetFlipStabilizer(_flipRuntime);
  }

  /**
   * Debug / tuning: isolated stabilizer session with configurable gravityAvgMs.
   * Production Mode B uses feedFlipMotion() → FLIP_STABILIZER.gravityAvgMs.
   */
  function createFlipStabilizerSession(initialOpts) {
    const state = createFlipStabilizer();
    const sessionOpts = {
      gravityAvgMs: (initialOpts && initialOpts.gravityAvgMs != null)
        ? initialOpts.gravityAvgMs
        : FLIP_STABILIZER.gravityAvgMs,
    };
    return {
      getOptions() { return { ...sessionOpts }; },
      setOptions(o) {
        if (o && typeof o.gravityAvgMs === 'number') sessionOpts.gravityAvgMs = o.gravityAvgMs;
      },
      reset() { resetFlipStabilizer(state); },
      feed(event, anchors, fusion) {
        return processFlipGravityMotion(state, event, anchors, fusion, sessionOpts);
      },
    };
  }

  function getFlipProductionGravityAvgMs() {
    return FLIP_STABILIZER.gravityAvgMs;
  }

  function buildExportJson(profile, anchors, fusion, extras) {
    const p = resolveProfile(profile);
    const isGravity = p.input === 'gravity';
    const out = {
      schema: p.exportSchema,
      profile: p.id,
      input: p.input,
      device: { userAgent: navigator.userAgent, platform: navigator.platform || '' },
      session: {
        orientation: getOrientationType(),
        startedAt: (extras && extras.startedAt) || new Date().toISOString(),
      },
      endpoint_semantics: {
        min_pose: p.minLabel,
        min_cc: 0,
        max_pose: p.maxLabel,
        max_cc: 127,
      },
      anchors: {},
      fusion: fusion || DEFAULT_FUSION,
      recommended_mapping: {
        sensor: isGravity ? 'accelerometer' : 'rotation_vector',
        axis: p.axis,
        value_range: [0.0, 1.0],
        notes: isGravity
          ? 'Phone computes fused t from gravity vector; Bridge in_min=0, in_max=1 → CC 0-127'
          : 'Phone computes fused t; Bridge in_min=0, in_max=1 → CC 0-127',
      },
    };
    if (anchors.min) out.anchors.min = { ...anchors.min };
    if (anchors.max) out.anchors.max = { ...anchors.max };
    if (anchorsReadyForProfile(p.id, anchors)) {
      out.anchor_separation_deg = Math.round(anchorSeparationForProfile(p.id, anchors) * 10) / 10;
    }
    if (extras && extras.trajectory) out.trajectory = extras.trajectory;
    return out;
  }

  global.PhoneMidiFusion = {
    LEGACY_STORAGE_KEY,
    STORAGE_KEY,
    EXPORT_SCHEMA,
    PROFILES,
    CAPTURE_MS,
    MIN_SEP,
    DEFAULT_FUSION,
    clamp,
    normalize3,
    getOrientationType,
    resolveProfile,
    profileInput,
    profileFromModeId,
    anchorsReady,
    gravityAnchorsReady,
    anchorsReadyForProfile,
    anchorSeparation,
    gravityAnchorSeparation,
    anchorSeparationForProfile,
    computeFusedT,
    computeGravityFusedT,
    computeFusedTForProfile,
    fusedToCc,
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
    extractGravityFromMotion,
    feedFlipMotion,
    resetFlipMotion,
    flipShouldSendValue,
    createFlipStabilizerSession,
    getFlipProductionGravityAvgMs,
    buildExportJson,
    consumeJustSavedFlag,
    isValidAnchor,
    isValidGravityAnchor,
    migrateLegacyCalibration,
  };
})(typeof window !== 'undefined' ? window : globalThis);
