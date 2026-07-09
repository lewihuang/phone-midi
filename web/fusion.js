// Phone MIDI CC — shared lift fusion + calibration storage
(function (global) {
  'use strict';

  const STORAGE_KEY = 'phone-midi/calibration/v1';
  const EXPORT_SCHEMA = 'phone-midi/fusion-calibrate/v1';
  const CAPTURE_MS = 400;
  const MIN_SEP = 4;

  const DEFAULT_FUSION = {
    mode: 'endpoint_projection',
    reverse: false,
    weights: { beta: 0.7, gamma: 0.3 },
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function getOrientationType() {
    if (screen.orientation && screen.orientation.type) return screen.orientation.type;
    return global.innerWidth > global.innerHeight ? 'landscape' : 'portrait';
  }

  function isValidAnchor(a) {
    return a != null && typeof a.beta === 'number' && !Number.isNaN(a.beta)
      && typeof a.gamma === 'number' && !Number.isNaN(a.gamma);
  }

  function anchorsReady(anchors) {
    return anchors && isValidAnchor(anchors.min) && isValidAnchor(anchors.max);
  }

  function anchorSeparation(anchors) {
    if (!anchorsReady(anchors)) return 0;
    const db = anchors.max.beta - anchors.min.beta;
    const dg = anchors.max.gamma - anchors.min.gamma;
    return Math.sqrt(db * db + dg * dg);
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

  function computeFusedT(beta, gamma, anchors, fusion) {
    if (!anchorsReady(anchors) || beta == null || gamma == null) return null;
    const cfg = fusion || DEFAULT_FUSION;
    if (cfg.mode === 'weighted_linear') return fuseWeightedLinear(beta, gamma, anchors, cfg);
    return fuseEndpointProjection(beta, gamma, anchors, cfg);
  }

  function fusedToCc(t) {
    if (t == null) return null;
    return Math.round(clamp(t, 0, 1) * 127);
  }

  function loadCalibration() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.anchors) return null;
      if (!anchorsReady(data.anchors)) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function persistCalibrationJson(json) {
    localStorage.setItem(STORAGE_KEY, json);
    sessionStorage.setItem(STORAGE_KEY, json);
    sessionStorage.setItem('phone-midi/calibration/just-saved', '1');
  }

  function saveCalibration(anchors, fusion) {
    if (!anchorsReady(anchors)) {
      throw new Error('端点数据不完整，请重新确认最低和最高位置');
    }
    const data = {
      schema: STORAGE_KEY,
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
      persistCalibrationJson(json);
    } catch (e) {
      throw new Error('无法写入本地存储：' + (e.message || '请检查浏览器权限'));
    }
    const verify = loadCalibration();
    if (!verify) {
      throw new Error('校准保存后校验失败，请重试');
    }
    return verify;
  }

  function clearCalibration() {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem('phone-midi/calibration/just-saved');
  }

  function consumeJustSavedFlag() {
    const v = sessionStorage.getItem('phone-midi/calibration/just-saved');
    if (v) sessionStorage.removeItem('phone-midi/calibration/just-saved');
    return v === '1';
  }

  function hasCalibration() {
    const c = loadCalibration();
    return anchorsReady(c && c.anchors);
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

  async function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') throw new Error('传感器权限被拒绝');
    }
  }

  function buildExportJson(anchors, fusion, extras) {
    const out = {
      schema: EXPORT_SCHEMA,
      device: { userAgent: navigator.userAgent, platform: navigator.platform || '' },
      session: {
        orientation: getOrientationType(),
        startedAt: (extras && extras.startedAt) || new Date().toISOString(),
      },
      endpoint_semantics: {
        min_pose: '自然垂手',
        min_cc: 0,
        max_pose: '抬手最高',
        max_cc: 127,
      },
      anchors: {},
      fusion: fusion || DEFAULT_FUSION,
      recommended_mapping: {
        sensor: 'rotation_vector',
        axis: 'fused_lift',
        value_range: [0.0, 1.0],
        notes: 'Phone computes fused t; Bridge in_min=0, in_max=1 → CC 0-127',
      },
    };
    if (anchors.min) out.anchors.min = { ...anchors.min };
    if (anchors.max) out.anchors.max = { ...anchors.max };
    if (anchorsReady(anchors)) {
      out.anchor_separation_deg = Math.round(anchorSeparation(anchors) * 10) / 10;
    }
    if (extras && extras.trajectory) out.trajectory = extras.trajectory;
    return out;
  }

  global.PhoneMidiFusion = {
    STORAGE_KEY,
    EXPORT_SCHEMA,
    CAPTURE_MS,
    MIN_SEP,
    DEFAULT_FUSION,
    clamp,
    getOrientationType,
    anchorsReady,
    anchorSeparation,
    computeFusedT,
    fusedToCc,
    loadCalibration,
    saveCalibration,
    clearCalibration,
    hasCalibration,
    captureAnchorSamples,
    requestOrientationPermission,
    buildExportJson,
    consumeJustSavedFlag,
    isValidAnchor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
