// Phone MIDI CC — Fusion Calibrate (developer debug page)
(() => {
  'use strict';

  const F = window.PhoneMidiFusion;
  const REC_INTERVAL_MS = 40;

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
  const elHint = document.getElementById('hint');
  const elOrientationMeta = document.getElementById('orientationMeta');
  const elToast = document.getElementById('toast');

  let active = false;
  let busy = false;
  let sessionStartedAt = null;
  let liveBeta = null;
  let liveGamma = null;
  const anchors = { min: null, max: null };
  let recording = false;
  let recStartMs = 0;
  let recTimer = null;
  let trajectory = null;

  function fmt(v) {
    return typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(1) : '—';
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

  function computeT() {
    return F.computeFusedT(liveBeta, liveGamma, anchors, getFusionConfig());
  }

  function updatePreview() {
    const ready = F.anchorsReady(anchors);
    elPreviewPanel.classList.toggle('disabled', !ready);
    elParamPanel.classList.toggle('disabled', !ready);
    elTrajPanel.classList.toggle('disabled', !ready);
    elRawBeta.textContent = fmt(liveBeta);
    elRawGamma.textContent = fmt(liveGamma);
    if (!ready) {
      elFusedT.textContent = '—';
      elCcSim.textContent = '—';
      elCcBar.style.width = '0%';
      return;
    }
    const t = computeT();
    elFusedT.textContent = t != null ? t.toFixed(3) : '—';
    elCcSim.textContent = t != null ? String(F.fusedToCc(t)) : '—';
    elCcBar.style.width = (t != null ? t * 100 : 0).toFixed(1) + '%';
  }

  function renderAnchorInfo() {
    if (anchors.min) {
      elAnchorMinInfo.innerHTML = 'MIN: β=' + fmt(anchors.min.beta) + ' γ=' + fmt(anchors.min.gamma) + ' <span class="ok">✓</span>';
      elBtnAnchorMin.classList.add('btn-accent');
    } else {
      elAnchorMinInfo.textContent = 'MIN: 未标定';
      elBtnAnchorMin.classList.remove('btn-accent');
    }
    if (anchors.max) {
      elAnchorMaxInfo.innerHTML = 'MAX: β=' + fmt(anchors.max.beta) + ' γ=' + fmt(anchors.max.gamma) + ' <span class="ok">✓</span>';
      elBtnAnchorMax.classList.add('btn-accent');
    } else {
      elAnchorMaxInfo.textContent = 'MAX: 未标定';
      elBtnAnchorMax.classList.remove('btn-accent');
    }
    const sep = F.anchorSeparation(anchors);
    if (F.anchorsReady(anchors) && sep < F.MIN_SEP) {
      elAnchorWarn.style.display = '';
      elAnchorWarn.textContent = '端点过近（|' + sep.toFixed(1) + '°|），请重新标定';
    } else {
      elAnchorWarn.style.display = 'none';
    }
    updatePreview();
  }

  async function captureAnchor(which) {
    if (!active || busy) return;
    busy = true;
    elBtnAnchorMin.disabled = true;
    elBtnAnchorMax.disabled = true;
    try {
      anchors[which] = await F.captureAnchorSamples();
      showError('');
      renderAnchorInfo();
      showToast(which === 'min' ? '已标定 MIN (0)' : '已标定 MAX (127)');
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
    elWeightPanel.classList.toggle('show', elSelMode.value === 'weighted_linear');
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
    ctx.strokeStyle = '#3b82f6';
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
    if (!F.anchorsReady(anchors) || recording) return;
    recording = true;
    recStartMs = performance.now();
    trajectory = { samples: [], duration_ms: 0, sample_count: 0, monotonicity: null };
    elBtnRecStart.disabled = true;
    elBtnRecStart.classList.add('btn-recording');
    elBtnRecStart.textContent = '录制中…';
    elBtnRecStop.disabled = false;
    recTimer = setInterval(() => {
      if (liveBeta == null) return;
      const t = computeT();
      trajectory.samples.push({
        t_ms: Math.round(performance.now() - recStartMs),
        beta: Math.round(liveBeta * 10) / 10,
        gamma: Math.round(liveGamma * 10) / 10,
        fused_t: Math.round(t * 1000) / 1000,
        cc_sim: F.fusedToCc(t),
      });
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
    elTrajMeta.textContent = trajectory.sample_count + ' 点 · 回跳 ' + m.violations + ' 次';
    drawTrajectory();
    showToast('录制完成');
  }

  async function copyJson() {
    const json = JSON.stringify(F.buildExportJson(anchors, getFusionConfig(), {
      startedAt: sessionStartedAt,
      trajectory: trajectory && trajectory.samples.length ? trajectory : undefined,
    }), null, 2);
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
    if (!confirm('确定清空？')) return;
    anchors.min = null;
    anchors.max = null;
    trajectory = null;
    F.clearCalibration();
    elExportArea.classList.remove('show');
    elTrajMeta.textContent = '尚未录制';
    renderAnchorInfo();
  }

  function onOrientation(event) {
    if (!active || busy) return;
    if (event.beta == null) return;
    liveBeta = event.beta;
    liveGamma = event.gamma;
    updatePreview();
  }

  async function start() {
    try {
      await F.requestOrientationPermission();
    } catch (e) {
      showError(e.message);
      return;
    }
    active = true;
    sessionStartedAt = new Date().toISOString();
    elBtnStart.disabled = true;
    elBtnStart.textContent = '传感器运行中';
    setStatus(true, '● 传感器运行中');
    showError('');
    elOrientationMeta.textContent = '屏幕方向：' + F.getOrientationType();
    const saved = F.loadCalibration();
    if (saved && F.anchorsReady(saved.anchors)) {
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
