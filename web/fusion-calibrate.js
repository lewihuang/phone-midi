// Phone MIDI CC — Fusion Calibrate (developer debug, profile-driven)
(() => {
  'use strict';

  const F = window.PhoneMidiFusion;
  const profileId = document.body.dataset.profile || 'lift';
  const profile = F.resolveProfile(profileId);
  const REC_INTERVAL_MS = 40;

  const UI = {
    lift: {
      pageTitle: 'Mode A 融合标定',
      trajHint: '缓慢从垂手抬至最高，用于检查融合值是否单调。',
      minBtn: '标定为 MIN (0)<br><span style="font-size:11px;font-weight:400">自然垂手</span>',
      maxBtn: '标定为 MAX (127)<br><span style="font-size:11px;font-weight:400">抬手最高</span>',
      minToast: '已标定 MIN (0)',
      maxToast: '已标定 MAX (127)',
      barGradient: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
      trajColor: '#3b82f6',
    },
    flip: {
      pageTitle: 'Mode B 融合标定',
      trajHint: '肘部尽量固定，缓慢从自然握姿翻到极限，检查融合值是否单调。',
      minBtn: '标定为 MIN (0)<br><span style="font-size:11px;font-weight:400">自然握姿</span>',
      maxBtn: '标定为 MAX (127)<br><span style="font-size:11px;font-weight:400">翻转极限</span>',
      minToast: '已标定 MIN (0)',
      maxToast: '已标定 MAX (127)',
      barGradient: 'linear-gradient(90deg, #7c3aed, #c084fc)',
      trajColor: '#8b5cf6',
    },
  };
  const ui = UI[profileId] || UI.lift;

  document.title = ui.pageTitle + ' — Phone MIDI CC';
  const elPageTitle = document.getElementById('pageTitle');
  if (elPageTitle) elPageTitle.textContent = ui.pageTitle;
  const elTrajHint = document.getElementById('trajHint');
  if (elTrajHint) elTrajHint.textContent = ui.trajHint;

  const elStatus = document.getElementById('status');
  const elPreviewPanel = document.getElementById('previewPanel');
  const elParamPanel = document.getElementById('paramPanel');
  const elTrajPanel = document.getElementById('trajPanel');
  const elExportPanel = document.getElementById('exportPanel');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnAnchorMin = document.getElementById('btnAnchorMin');
  const elBtnAnchorMax = document.getElementById('btnAnchorMax');
  const elAnchorMinInfo = document.getElementById('anchorMinInfo');
  const elAnchorMaxInfo = document.getElementById('anchorMaxInfo');
  const elAnchorWarn = document.getElementById('anchorWarn');
  const elCrossAxis = document.getElementById('crossAxis');
  const elFusedT = document.getElementById('fusedT');
  const elCcSim = document.getElementById('ccSim');
  const elCcBar = document.getElementById('ccBar');
  const elRawBeta = document.getElementById('rawBeta');
  const elRawGamma = document.getElementById('rawGamma');
  const elSelMode = document.getElementById('selMode');
  const elWeightPanel = document.getElementById('weightPanel');
  const elRngWBeta = document.getElementById('rngWBeta');
  const elRngWGamma = document.getElementById('rngWGamma');
  const elLblWBeta = document.getElementById('lblWBeta');
  const elLblWGamma = document.getElementById('lblWGamma');
  const elChkReverse = document.getElementById('chkReverse');
  const elBtnRecStart = document.getElementById('btnRecStart');
  const elBtnRecStop = document.getElementById('btnRecStop');
  const elTrajCanvas = document.getElementById('trajCanvas');
  const elTrajMeta = document.getElementById('trajMeta');
  const elBtnCopy = document.getElementById('btnCopy');
  const elBtnClear = document.getElementById('btnClear');
  const elExportArea = document.getElementById('exportArea');
  const elExportText = document.getElementById('exportText');
  const elError = document.getElementById('error');
  const elOrientationMeta = document.getElementById('orientationMeta');
  const elToast = document.getElementById('toast');

  const usesGravity = profile.input === 'gravity';
  const elRawGx = document.getElementById('rawGx');
  const elRawGy = document.getElementById('rawGy');
  const elRawGz = document.getElementById('rawGz');
  const elRawGravityRow = document.getElementById('rawGravityRow');
  const elFusionSource = document.getElementById('fusionSource');
  const elRawTRaw = document.getElementById('rawTRaw');

  let active = false;
  let busy = false;
  let sessionStartedAt = null;
  let liveBeta = null;
  let liveGamma = null;
  let liveG = null;
  let liveFlip = null;
  const anchors = { min: null, max: null };
  let recording = false;
  let recStartMs = 0;
  let recTimer = null;
  let trajectory = null;

  if (elBtnAnchorMin) elBtnAnchorMin.innerHTML = ui.minBtn;
  if (elBtnAnchorMax) elBtnAnchorMax.innerHTML = ui.maxBtn;
  if (elFusionSource && usesGravity) {
    elFusionSource.textContent = '融合源：姿态推导的重力向量（deviceorientation，无滤波）';
  }
  if (elCcBar) elCcBar.style.background = ui.barGradient;

  function fmt(v) {
    return typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(1) : '—';
  }

  function axisAngleDeg(aAnchors, bAnchors) {
    if (!F.anchorsReady(aAnchors) || !F.anchorsReady(bAnchors)) return null;
    const da = {
      b: aAnchors.max.beta - aAnchors.min.beta,
      g: aAnchors.max.gamma - aAnchors.min.gamma,
    };
    const db = {
      b: bAnchors.max.beta - bAnchors.min.beta,
      g: bAnchors.max.gamma - bAnchors.min.gamma,
    };
    const dot = da.b * db.b + da.g * db.g;
    const magA = Math.sqrt(da.b * da.b + da.g * da.g);
    const magB = Math.sqrt(db.b * db.b + db.g * db.g);
    if (magA < 1e-6 || magB < 1e-6) return null;
    const cos = Math.max(-1, Math.min(1, dot / (magA * magB)));
    return Math.round(Math.acos(cos) * 1800 / Math.PI) / 10;
  }

  function updateCrossAxisInfo() {
    if (!elCrossAxis || usesGravity) {
      if (elCrossAxis) elCrossAxis.style.display = 'none';
      return;
    }
    const otherId = profileId === 'flip' ? 'lift' : 'flip';
    const other = F.loadCalibration(otherId);
    if (!F.anchorsReady(anchors) || !other || !F.anchorsReady(other.anchors)) {
      elCrossAxis.style.display = 'none';
      return;
    }
    const angle = axisAngleDeg(anchors, other.anchors);
    if (angle == null) {
      elCrossAxis.style.display = 'none';
      return;
    }
    elCrossAxis.style.display = '';
    const warn = angle < 25;
    elCrossAxis.className = warn ? 'warn' : 'meta';
    elCrossAxis.textContent = '与 ' + otherId + ' 轴夹角 ' + angle + '°'
      + (warn ? '（过近，动作可能混叠）' : '');
  }

  function setStatus(on, text) {
    elStatus.textContent = text;
    elStatus.className = 'status ' + (on ? 'on' : 'off');
  }

  function showError(msg) {
    elError.textContent = msg || '';
    if (msg) console.warn(msg);
  }

  function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    setTimeout(() => elToast.classList.remove('show'), 2000);
  }

  function getFusionConfig() {
    return {
      mode: elSelMode.value,
      reverse: elChkReverse.checked,
      weights: {
        beta: parseInt(elRngWBeta.value, 10) / 100,
        gamma: parseInt(elRngWGamma.value, 10) / 100,
      },
    };
  }

  function feedFlip(event) {
    return F.feedFlipOrientation(event.beta, event.gamma, anchors, getFusionConfig());
  }

  function resetFlipPipeline() {
    liveFlip = null;
  }

  function computeT() {
    if (usesGravity) {
      if (!liveFlip) return null;
      return liveFlip.t;
    }
    return F.computeFusedT(liveBeta, liveGamma, anchors, getFusionConfig());
  }

  function fmt3(v) {
    return typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(2) : '—';
  }

  function updatePreview() {
    const ready = F.anchorsReadyForProfile(profileId, anchors);
    elPreviewPanel.classList.toggle('disabled', !ready);
    elParamPanel.classList.toggle('disabled', !ready);
    elTrajPanel.classList.toggle('disabled', !ready);
    elRawBeta.textContent = fmt(liveBeta);
    elRawGamma.textContent = fmt(liveGamma);
    if (elRawGravityRow) elRawGravityRow.style.display = usesGravity ? '' : 'none';
    const elRawTRow = document.getElementById('rawTRow');
    if (elRawTRow) elRawTRow.style.display = usesGravity ? '' : 'none';
    if (liveG && usesGravity) {
      if (elRawGx) elRawGx.textContent = fmt3(liveG.x);
      if (elRawGy) elRawGy.textContent = fmt3(liveG.y);
      if (elRawGz) elRawGz.textContent = fmt3(liveG.z);
    }
    if (!ready) {
      elFusedT.textContent = '—';
      elCcSim.textContent = '—';
      elCcBar.style.width = '0%';
      return;
    }
    const t = computeT();
    elFusedT.textContent = t != null ? t.toFixed(3) : '—';
    if (elRawTRaw) {
      elRawTRaw.textContent = (usesGravity && liveFlip && liveFlip.t_raw != null)
        ? liveFlip.t_raw.toFixed(3)
        : '—';
    }
    const elFusedTInline = document.getElementById('fusedTInline');
    if (elFusedTInline) {
      elFusedTInline.textContent = t != null ? t.toFixed(3) : '—';
    }
    elCcSim.textContent = t != null ? String(F.fusedToCc(t)) : '—';
    elCcBar.style.width = (t != null ? t * 100 : 0).toFixed(1) + '%';
  }

  function renderAnchorInfo() {
    if (anchors.min) {
      if (usesGravity) {
        elAnchorMinInfo.innerHTML = 'MIN: g=(' + fmt3(anchors.min.x) + ',' + fmt3(anchors.min.y) + ',' + fmt3(anchors.min.z) + ') <span class="ok">✓</span>';
      } else {
        elAnchorMinInfo.innerHTML = 'MIN: β=' + fmt(anchors.min.beta) + ' γ=' + fmt(anchors.min.gamma) + ' <span class="ok">✓</span>';
      }
      elBtnAnchorMin.classList.add('btn-accent');
    } else {
      elAnchorMinInfo.textContent = 'MIN: 未标定';
      elBtnAnchorMin.classList.remove('btn-accent');
    }
    if (anchors.max) {
      if (usesGravity) {
        elAnchorMaxInfo.innerHTML = 'MAX: g=(' + fmt3(anchors.max.x) + ',' + fmt3(anchors.max.y) + ',' + fmt3(anchors.max.z) + ') <span class="ok">✓</span>';
      } else {
        elAnchorMaxInfo.innerHTML = 'MAX: β=' + fmt(anchors.max.beta) + ' γ=' + fmt(anchors.max.gamma) + ' <span class="ok">✓</span>';
      }
      elBtnAnchorMax.classList.add('btn-accent');
    } else {
      elAnchorMaxInfo.textContent = 'MAX: 未标定';
      elBtnAnchorMax.classList.remove('btn-accent');
    }
    const sep = F.anchorSeparationForProfile(profileId, anchors);
    if (F.anchorsReadyForProfile(profileId, anchors) && sep < F.MIN_SEP) {
      const unit = usesGravity ? '°（向量夹角）' : '°';
      elAnchorWarn.style.display = '';
      elAnchorWarn.textContent = '端点过近（|' + sep.toFixed(1) + unit + '），请重新标定';
    } else {
      elAnchorWarn.style.display = 'none';
    }
    updateCrossAxisInfo();
    updatePreview();
  }

  async function captureAnchor(which) {
    if (!active || busy) return;
    busy = true;
    elBtnAnchorMin.disabled = true;
    elBtnAnchorMax.disabled = true;
    try {
      anchors[which] = await F.captureAnchorSamplesForProfile(profileId);
      showError('');
      renderAnchorInfo();
      showToast(which === 'min' ? ui.minToast : ui.maxToast);
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      elBtnAnchorMin.disabled = false;
      elBtnAnchorMax.disabled = false;
    }
  }

  function syncWeights(fromBeta) {
    if (fromBeta) {
      elRngWGamma.value = String(100 - parseInt(elRngWBeta.value, 10));
    } else {
      elRngWBeta.value = String(100 - parseInt(elRngWGamma.value, 10));
    }
    elLblWBeta.textContent = (parseInt(elRngWBeta.value, 10) / 100).toFixed(2);
    elLblWGamma.textContent = (parseInt(elRngWGamma.value, 10) / 100).toFixed(2);
    updatePreview();
    if (trajectory) drawTrajectory();
  }

  function onModeChange() {
    if (usesGravity) {
      elWeightPanel.classList.remove('show');
      elSelMode.value = 'endpoint_projection';
      elSelMode.disabled = true;
    } else {
      elSelMode.disabled = false;
      elWeightPanel.classList.toggle('show', elSelMode.value === 'weighted_linear');
    }
    updatePreview();
    if (trajectory) drawTrajectory();
  }

  function analyzeMonotonicity(samples) {
    let violations = 0;
    let maxRegression = 0;
    const thresh = 0.015;
    for (let i = 1; i < samples.length; i++) {
      const drop = samples[i - 1].fused_t - samples[i].fused_t;
      if (drop > thresh) {
        violations++;
        if (drop > maxRegression) maxRegression = drop;
      }
    }
    return { violations, max_regression: Math.round(maxRegression * 1000) / 1000 };
  }

  function drawTrajectory() {
    const canvas = elTrajCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
    if (!trajectory || !trajectory.samples.length) return;
    const samples = trajectory.samples;
    const pad = 8;
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.stroke();
    ctx.strokeStyle = ui.trajColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const dur = trajectory.duration_ms || 1;
    for (let i = 0; i < samples.length; i++) {
      const x = pad + (samples[i].t_ms / dur) * (w - pad * 2);
      const y = h - pad - samples[i].fused_t * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function startRecording() {
    if (!F.anchorsReadyForProfile(profileId, anchors) || recording) return;
    recording = true;
    recStartMs = performance.now();
    trajectory = { samples: [], duration_ms: 0, sample_count: 0, monotonicity: null };
    elBtnRecStart.disabled = true;
    elBtnRecStart.classList.add('btn-recording');
    elBtnRecStart.textContent = '录制中…';
    elBtnRecStop.disabled = false;
    recTimer = setInterval(() => {
      const t = computeT();
      if (t == null) return;
      const sample = {
        t_ms: Math.round(performance.now() - recStartMs),
        fused_t: Math.round(t * 1000) / 1000,
        cc_sim: F.fusedToCc(t),
      };
      if (usesGravity && liveFlip) {
        sample.fused_t_raw = Math.round(liveFlip.t_raw * 1000) / 1000;
      }
      if (usesGravity && liveG) {
        sample.gx = Math.round(liveG.x * 1000) / 1000;
        sample.gy = Math.round(liveG.y * 1000) / 1000;
        sample.gz = Math.round(liveG.z * 1000) / 1000;
      }
      if (liveBeta != null) {
        sample.beta = Math.round(liveBeta * 10) / 10;
        sample.gamma = Math.round(liveGamma * 10) / 10;
      }
      trajectory.samples.push(sample);
    }, REC_INTERVAL_MS);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    clearInterval(recTimer);
    elBtnRecStart.disabled = false;
    elBtnRecStart.classList.remove('btn-recording');
    elBtnRecStart.textContent = '开始录制';
    elBtnRecStop.disabled = true;
    if (!trajectory || !trajectory.samples.length) {
      elTrajMeta.textContent = '录制无数据';
      return;
    }
    trajectory.duration_ms = trajectory.samples[trajectory.samples.length - 1].t_ms;
    trajectory.sample_count = trajectory.samples.length;
    trajectory.monotonicity = analyzeMonotonicity(trajectory.samples);
    const m = trajectory.monotonicity;
    elTrajMeta.textContent = trajectory.sample_count + ' 点 · 回跳 ' + m.violations + ' 次 · max回跳 ' + m.max_regression;
    drawTrajectory();
    showToast('录制完成');
  }

  function buildExportPayload() {
    const extras = {
      startedAt: sessionStartedAt,
      trajectory: trajectory && trajectory.samples.length ? trajectory : undefined,
    };
    const out = F.buildExportJson(profileId, anchors, getFusionConfig(), extras);
    const otherId = profileId === 'flip' ? 'lift' : 'flip';
    const other = F.loadCalibration(otherId);
    if (F.anchorsReadyForProfile(profileId, anchors) && other && F.anchorsReady(other.anchors)) {
      out.cross_axis = {
        other_profile: otherId,
        angle_deg: axisAngleDeg(anchors, other.anchors),
        other_anchors: other.anchors,
      };
    }
    return out;
  }

  async function copyJson() {
    const json = JSON.stringify(buildExportPayload(), null, 2);
    elExportArea.classList.remove('show');
    try {
      await navigator.clipboard.writeText(json);
      showToast('JSON 已复制');
      return;
    } catch (_) {}
    elExportText.value = json;
    elExportArea.classList.add('show');
    showToast('请手动复制下方文本');
  }

  function clearAll() {
    if (!anchors.min && !anchors.max && !trajectory) return;
    if (!confirm('确定清空本页标定数据？')) return;
    anchors.min = null;
    anchors.max = null;
    trajectory = null;
    F.clearCalibration(profileId);
    elExportArea.classList.remove('show');
    elTrajMeta.textContent = '尚未录制';
    renderAnchorInfo();
  }

  function onOrientation(event) {
    if (!active || busy) return;
    if (event.beta == null) return;
    liveBeta = event.beta;
    liveGamma = event.gamma;
    if (usesGravity) {
      liveFlip = feedFlip(event);
      if (liveFlip) liveG = liveFlip.g;
    }
    updatePreview();
  }

  async function start() {
    try {
      await F.requestProfilePermissions(profileId);
    } catch (e) {
      showError(e.message);
      return;
    }
    active = true;
    sessionStartedAt = new Date().toISOString();
    resetFlipPipeline();
    liveFlip = null;
    elBtnStart.disabled = true;
    elBtnStart.textContent = '传感器运行中';
    setStatus(true, '● 传感器运行中');
    showError('');
    elOrientationMeta.textContent = '屏幕方向：' + F.getOrientationType() + ' · profile: ' + profileId + ' · input: ' + profile.input;
    const saved = F.loadCalibration(profileId);
    if (saved && F.anchorsReadyForProfile(profileId, saved.anchors)) {
      anchors.min = saved.anchors.min;
      anchors.max = saved.anchors.max;
      renderAnchorInfo();
    }
    ['anchorPanel', 'previewPanel', 'paramPanel', 'trajPanel', 'exportPanel'].forEach(id => {
      document.getElementById(id).style.display = '';
    });
    window.addEventListener('deviceorientation', onOrientation, true);
  }

  function init() {
    elBtnStart.addEventListener('click', start);
    elBtnAnchorMin.addEventListener('click', () => captureAnchor('min'));
    elBtnAnchorMax.addEventListener('click', () => captureAnchor('max'));
    elSelMode.addEventListener('change', onModeChange);
    elRngWBeta.addEventListener('input', () => syncWeights(true));
    elRngWGamma.addEventListener('input', () => syncWeights(false));
    elChkReverse.addEventListener('change', () => { updatePreview(); if (trajectory) drawTrajectory(); });
    elBtnRecStart.addEventListener('click', startRecording);
    elBtnRecStop.addEventListener('click', stopRecording);
    elBtnCopy.addEventListener('click', copyJson);
    elBtnClear.addEventListener('click', clearAll);
    onModeChange();
    renderAnchorInfo();
  }

  init();
})();
