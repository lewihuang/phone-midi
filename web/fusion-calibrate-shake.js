// Phone MIDI CC — Mode C shake calibrate (developer debug)
(() => {
  'use strict';

  const F = window.PhoneMidiFusion;
  const PROFILE_ID = 'shake';
  const REC_INTERVAL_MS = 40;

  const elStatus = document.getElementById('status');
  const elFusionSource = document.getElementById('fusionSource');
  const elPreviewPanel = document.getElementById('previewPanel');
  const elParamPanel = document.getElementById('paramPanel');
  const elTrajPanel = document.getElementById('trajPanel');
  const elExportPanel = document.getElementById('exportPanel');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnCapture = document.getElementById('btnCapture');
  const elPeakMinInfo = document.getElementById('peakMinInfo');
  const elPeakMaxInfo = document.getElementById('peakMaxInfo');
  const elAnchorWarn = document.getElementById('anchorWarn');
  const elLivePeak = document.getElementById('livePeak');
  const elSignedPct = document.getElementById('signedPct');
  const elPbSim = document.getElementById('pbSim');
  const elBendBar = document.getElementById('bendBar');
  const elRawVal = document.getElementById('rawVal');
  const elAxisUsed = document.getElementById('axisUsed');
  const elFusedT = document.getElementById('fusedT');
  const elMotionSource = document.getElementById('motionSource');
  const elSelAxis = document.getElementById('selAxis');
  const elRngDeadband = document.getElementById('rngDeadband');
  const elLblDeadband = document.getElementById('lblDeadband');
  const elBtnRecStart = document.getElementById('btnRecStart');
  const elBtnRecStop = document.getElementById('btnRecStop');
  const elTrajCanvas = document.getElementById('trajCanvas');
  const elTrajMeta = document.getElementById('trajMeta');
  const elBtnSave = document.getElementById('btnSave');
  const elBtnCopy = document.getElementById('btnCopy');
  const elBtnClear = document.getElementById('btnClear');
  const elExportArea = document.getElementById('exportArea');
  const elExportText = document.getElementById('exportText');
  const elError = document.getElementById('error');
  const elOrientationMeta = document.getElementById('orientationMeta');
  const elToast = document.getElementById('toast');

  const anchors = { min: null, max: null, primaryAxis: 'auto' };
  let active = false;
  let busy = false;
  let sessionStartedAt = null;
  let liveMotion = null;
  let recording = false;
  let recStartMs = 0;
  let recTimer = null;
  let trajectory = null;

  if (elFusionSource) {
    elFusionSource.textContent = '一步标定窗口 ' + F.SHAKE_PEAK_MS + 'ms · 零偏=绝对静止 · 最小跨度 '
      + F.MIN_SHAKE_SEP + ' m/s²';
  }

  function fmt3(v) {
    return typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(3) : '—';
  }

  function getShakeOpts() {
    return {
      primaryAxis: elSelAxis.value,
      centerDeadband: parseInt(elRngDeadband.value, 10) / 100,
    };
  }

  function syncDeadbandLabel() {
    if (!elLblDeadband || !elRngDeadband) return;
    elLblDeadband.textContent = elRngDeadband.value + '%';
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

  function updateBendBar(signed) {
    if (!elBendBar) return;
    const pct = signed != null ? F.clamp(signed, -1, 1) : 0;
    const half = Math.abs(pct) * 50;
    if (pct >= 0) {
      elBendBar.style.left = '50%';
      elBendBar.style.width = half + '%';
    } else {
      elBendBar.style.left = (50 - half) + '%';
      elBendBar.style.width = half + '%';
    }
  }

  function computeLive(event) {
    return F.computeShakeMotion(event, anchors, getShakeOpts());
  }

  function updatePreview() {
    const ready = F.shakeAnchorsReady(anchors);
    elPreviewPanel.classList.toggle('disabled', !ready);
    elParamPanel.classList.toggle('disabled', !ready);
    elTrajPanel.classList.toggle('disabled', !ready);
    elBtnSave.disabled = !ready;

    if (!ready) {
      elSignedPct.textContent = '—';
      elPbSim.textContent = '—';
      updateBendBar(null);
      return;
    }

    const m = liveMotion;
    if (!m) {
      elSignedPct.textContent = '0';
      elPbSim.textContent = String(F.shakeTToPitchBend(0.5));
      updateBendBar(0);
      return;
    }

    const pct = F.shakeSignedToPercent(m.signed);
    elSignedPct.textContent = (pct >= 0 ? '+' : '') + pct;
    elPbSim.textContent = String(m.pb);
    elRawVal.textContent = fmt3(m.raw);
    elAxisUsed.textContent = m.axis;
    elFusedT.textContent = m.t.toFixed(3);
    elMotionSource.textContent = m.source;
    updateBendBar(m.signed);
  }

  function renderAnchorInfo() {
    if (anchors.min) {
      elPeakMinInfo.innerHTML = '负向峰值: ' + fmt3(anchors.min.peak) + ' m/s² <span class="ok">✓</span>';
      elBtnCapture.classList.add('btn-accent');
    } else {
      elPeakMinInfo.textContent = '负向峰值: 未标定';
      elBtnCapture.classList.remove('btn-accent');
    }

    if (anchors.max) {
      elPeakMaxInfo.innerHTML = '正向峰值: ' + fmt3(anchors.max.peak) + ' m/s² <span class="ok">✓</span>';
    } else {
      elPeakMaxInfo.textContent = '正向峰值: 未标定';
    }

    const span = F.shakePeakSpan(anchors);
    if (F.shakeAnchorsReady(anchors)) {
      elAnchorWarn.style.display = 'none';
    } else if (anchors.min && anchors.max && span < F.MIN_SHAKE_SEP) {
      elAnchorWarn.style.display = '';
      elAnchorWarn.textContent = '峰值跨度过小（' + span.toFixed(2) + ' m/s²），请加大晃动力度重标';
    } else {
      elAnchorWarn.style.display = 'none';
    }

    if (anchors.primaryAxis && elSelAxis) {
      elSelAxis.value = anchors.primaryAxis === 'x' || anchors.primaryAxis === 'y'
        ? anchors.primaryAxis
        : 'auto';
    }

    updatePreview();
  }

  async function capturePeaks() {
    if (!active || busy) return;
    busy = true;
    elBtnCapture.disabled = true;
    elBtnCapture.classList.add('btn-recording');
    const origText = elBtnCapture.textContent;
    elBtnCapture.textContent = '采样中…';

    try {
      const result = await F.captureShakePeaksBoth(F.SHAKE_PEAK_MS, (tick) => {
        const left = Math.max(0, Math.ceil((F.SHAKE_PEAK_MS - tick.elapsed) / 1000));
        elLivePeak.textContent = 'min ' + fmt3(tick.peakMin) + ' · max ' + fmt3(tick.peakMax)
          + ' · 跨度 ' + fmt3(tick.span) + ' m/s² · ' + left + 's';
      });
      anchors.min = result.min;
      anchors.max = result.max;
      anchors.primaryAxis = result.primaryAxis;
      showError('');
      renderAnchorInfo();
      showToast('标定完成 · 跨度 ' + fmt3(result.peak_span) + ' m/s²');
      if (result.source === 'gravity_delta') {
        elAnchorWarn.style.display = '';
        elAnchorWarn.textContent = '当前使用含重力加速度；不晃时可能非 0。建议设备支持 linear acceleration。';
      }
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      elBtnCapture.disabled = false;
      elBtnCapture.classList.remove('btn-recording');
      elBtnCapture.textContent = origText;
      elLivePeak.textContent = '';
    }
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
    ctx.moveTo(pad, h / 2);
    ctx.lineTo(w - pad, h / 2);
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.stroke();

    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const dur = trajectory.duration_ms || 1;
    for (let i = 0; i < samples.length; i++) {
      const x = pad + (samples[i].t_ms / dur) * (w - pad * 2);
      const y = h / 2 - samples[i].signed_pct / 100 * (h / 2 - pad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function startRecording() {
    if (!F.shakeAnchorsReady(anchors) || recording) return;
    recording = true;
    recStartMs = performance.now();
    trajectory = { samples: [], duration_ms: 0, sample_count: 0 };
    elBtnRecStart.disabled = true;
    elBtnRecStart.classList.add('btn-recording');
    elBtnRecStart.textContent = '录制中…';
    elBtnRecStop.disabled = false;
    recTimer = setInterval(() => {
      if (!liveMotion) return;
      trajectory.samples.push({
        t_ms: Math.round(performance.now() - recStartMs),
        signed_pct: F.shakeSignedToPercent(liveMotion.signed),
        t: Math.round(liveMotion.t * 1000) / 1000,
        pb_sim: liveMotion.pb,
        raw: Math.round(liveMotion.raw * 1000) / 1000,
        axis: liveMotion.axis,
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
    elTrajMeta.textContent = trajectory.sample_count + ' 点 · '
      + '范围 ' + Math.min(...trajectory.samples.map(s => s.signed_pct)) + ' … '
      + Math.max(...trajectory.samples.map(s => s.signed_pct));
    drawTrajectory();
    showToast('录制完成');
  }

  function buildExportPayload() {
    return F.buildExportJson(PROFILE_ID, anchors, F.DEFAULT_FUSION, {
      startedAt: sessionStartedAt,
      shake_opts: getShakeOpts(),
      trajectory: trajectory && trajectory.samples.length ? trajectory : undefined,
    });
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

  function saveToStorage() {
    if (!F.shakeAnchorsReady(anchors)) return;
    try {
      F.saveCalibration(PROFILE_ID, anchors, F.DEFAULT_FUSION);
      showToast('已写入 localStorage');
    } catch (e) {
      showError(e.message);
    }
  }

  function clearAll() {
    if (!anchors.min && !anchors.max && !trajectory) return;
    if (!confirm('确定清空本页标定数据？')) return;
    anchors.min = null;
    anchors.max = null;
    anchors.primaryAxis = 'auto';
    trajectory = null;
    liveMotion = null;
    F.clearCalibration(PROFILE_ID);
    elExportArea.classList.remove('show');
    elTrajMeta.textContent = '尚未录制';
    renderAnchorInfo();
  }

  function onMotion(event) {
    if (!active || busy) return;
    liveMotion = computeLive(event);
    updatePreview();
  }

  async function start() {
    try {
      await F.requestProfilePermissions(PROFILE_ID);
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
    elOrientationMeta.textContent = '屏幕方向：' + F.getOrientationType()
      + ' · profile: shake · zero=absolute_still';

    const saved = F.loadCalibration(PROFILE_ID);
    if (saved && saved.anchors) {
      if (saved.anchors.min) anchors.min = saved.anchors.min;
      if (saved.anchors.max) anchors.max = saved.anchors.max;
      if (saved.anchors.primaryAxis) anchors.primaryAxis = saved.anchors.primaryAxis;
      renderAnchorInfo();
    }

    ['anchorPanel', 'previewPanel', 'paramPanel', 'trajPanel', 'exportPanel'].forEach((id) => {
      document.getElementById(id).style.display = '';
    });

    window.addEventListener('devicemotion', onMotion, true);
  }

  function init() {
    if (!F) {
      showError('fusion.js 未加载');
      return;
    }
    elBtnStart.addEventListener('click', start);
    elBtnCapture.addEventListener('click', capturePeaks);
    elSelAxis.addEventListener('change', () => {
      anchors.primaryAxis = elSelAxis.value;
      updatePreview();
    });
    elRngDeadband.addEventListener('input', () => {
      syncDeadbandLabel();
      updatePreview();
    });
    elBtnRecStart.addEventListener('click', startRecording);
    elBtnRecStop.addEventListener('click', stopRecording);
    elBtnSave.addEventListener('click', saveToStorage);
    elBtnCopy.addEventListener('click', copyJson);
    elBtnClear.addEventListener('click', clearAll);
    syncDeadbandLabel();
    renderAnchorInfo();
  }

  init();
})();
