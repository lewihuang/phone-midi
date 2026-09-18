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
    // One feed of the production runtime per event; the legacy preview reads the
    // anchor-based path separately so both can be compared side by side.
    feedRuntime(event);
    liveMotion = computeLive(event);
    updatePreview();
  }

  // ── production runtime mirror (acceptance A1 / A9 / A10 / A11) ──────────────
  const elRngBend = document.getElementById('rngBend');
  const elLblBend = document.getElementById('lblBend');
  const elRngDeadC = document.getElementById('rngDeadC');
  const elLblDeadC = document.getElementById('lblDeadC');
  const elRngStep = document.getElementById('rngStep');
  const elLblStep = document.getElementById('lblStep');
  const elRngStill = document.getElementById('rngStill');
  const elLblStill = document.getElementById('lblStill');
  const elRngScale = document.getElementById('rngScale');
  const elLblScale = document.getElementById('lblScale');
  const elBtnFillScale1 = document.getElementById('btnFillScale1');
  const elBtnFillScale2 = document.getElementById('btnFillScale2');
  const elRtMotion = document.getElementById('rtMotion');
  const elRtUsage = document.getElementById('rtUsage');
  const elRtAxis = document.getElementById('rtAxis');
  const elRtScale = document.getElementById('rtScale');
  const elRtMode = document.getElementById('rtMode');
  const elRtPb = document.getElementById('rtPb');
  const elRtU = document.getElementById('rtU');
  const elRtState = document.getElementById('rtState');
  const elRtStatic = document.getElementById('rtStatic');
  const elRtStaticN = document.getElementById('rtStaticN');
  const elRtStaticSpan = document.getElementById('rtStaticSpan');
  const elRtRecenter = document.getElementById('rtRecenter');
  const elRtBias = document.getElementById('rtBias');
  const elRtSamples = document.getElementById('rtSamples');
  const elRtDegraded = document.getElementById('rtDegraded');
  const elBtnRtReset = document.getElementById('btnRtReset');
  const elBtnClearCal = document.getElementById('btnClearCal');

  function feedRuntime(event) {
    const out = F.feedShakeMotion(event);
    if (out) lastRuntime = out;
    return out;
  }

  let lastRuntime = null;

  function syncTuningLabels() {
    const t = F.getShakeTuning();
    elRngBend.value = t.bendRange;
    elLblBend.textContent = '±' + Math.round(t.bendRange * 100) + '%';
    elRngDeadC.value = t.deadbandCounts;
    elLblDeadC.textContent = String(t.deadbandCounts);
    elRngStep.value = t.minStepCounts;
    elLblStep.textContent = String(t.minStepCounts);
    elRngStill.value = t.stillThreshold;
    elLblStill.textContent = Number(t.stillThreshold).toFixed(1);
    elRngScale.value = t.fixedScale;
    elLblScale.textContent = Math.round(t.fixedScale) + ' m/s²';
  }

  function renderRuntime() {
    const d = F.getShakeDiagnostics();
    const rt = lastRuntime;
    const scale = d.scaleNeg == null || d.scalePos == null
      ? '—'
      : '−' + Math.round(d.scaleNeg) + '/' + Math.round(d.scalePos) + ' m/s²';
    elRtAxis.textContent = d.axis + (d.axisMode === 'auto' ? '（自动）' : '（锁定）');
    elRtScale.textContent = scale + ' · ' + (d.scaleMode === 'calibrated' ? '向导校准' : '固定值');
    elRtMode.textContent = d.source || '—';
    const fmtRange = (lo, hi) => (lo == null || hi == null
      ? '—'
      : '−' + lo.toFixed(1) + '/+' + hi.toFixed(1) + ' m/s²');
    elRtMotion.textContent = fmtRange(d.motionMaxNeg, d.motionMaxPos)
      + '  (p95 ' + (d.motionP95Neg == null || d.motionP95Pos == null
        ? '—'
        : '−' + d.motionP95Neg.toFixed(1) + '/+' + d.motionP95Pos.toFixed(1)) + ')';
    elRtUsage.textContent = d.usagePct == null ? '—' : d.usagePct + '%';
    elRtPb.textContent = rt ? String(rt.pb) : '—';
    elRtU.textContent = rt ? rt.u.toFixed(3) : '—';
    elRtState.textContent = d.stationary ? '静止（居中）' : '晃动中';
    elRtStatic.textContent = d.staticMaxOffset == null ? '—' : String(Math.round(d.staticMaxOffset));
    elRtStaticN.textContent = String(d.staticSamples);
    elRtStaticSpan.textContent = (d.staticSpanMs / 1000).toFixed(1);
    elRtRecenter.textContent = d.recenterMs == null ? '—' : d.recenterMs + ' ms';
    elRtBias.textContent = rt
      ? rt.bias.x.toFixed(2) + ' / ' + rt.bias.y.toFixed(2)
      : '—';
    elRtSamples.textContent = String(d.samples);
    elRtDegraded.textContent = d.degraded ? '是（重力估计）' : '否';
  }

  function bindRuntimeControls() {
    const onTune = () => {
      F.setShakeTuning({
        bendRange: parseFloat(elRngBend.value),
        deadbandCounts: parseFloat(elRngDeadC.value),
        minStepCounts: parseFloat(elRngStep.value),
        stillThreshold: parseFloat(elRngStill.value),
        fixedScale: parseFloat(elRngScale.value),
      });
      syncTuningLabels();
    };
    [elRngBend, elRngDeadC, elRngStep, elRngStill, elRngScale].forEach((el) => el.addEventListener('input', onTune));

    // One-tap calibration of the fixed scale: shake at the effort that should mean "full
    // bend", then capture it. Removes the guesswork of picking a number in m/s².
    const fillFromPeak = (multiplier) => {
      const d = F.getShakeDiagnostics();
      const peakNeg = d.motionMaxNeg;
      const peakPos = d.motionMaxPos;
      if (peakNeg == null || peakPos == null || Math.max(peakNeg, peakPos) < 2) {
        showToast('先按你的最大力度晃几下，再点这里');
        return;
      }
      const neg = Math.round(peakNeg * multiplier);
      const pos = Math.round(peakPos * multiplier);
      F.saveFixedShakeScales(neg, pos, {
        source: d.source,
        sources: d.srcCounts,
        windowMs: F.getShakeTuning().measureWindowMs,
      });
      F.resetShakeRuntime();
      showToast('满量程设为 −' + neg + '/+' + pos + ' m/s²（峰值 ×' + multiplier + '）');
    };
    elBtnFillScale1.addEventListener('click', () => fillFromPeak(1));
    elBtnFillScale2.addEventListener('click', () => fillFromPeak(2));

    elBtnRtReset.addEventListener('click', () => {
      F.resetShakeRuntime();
      lastRuntime = null;
      showToast('运行时已重置（零位清空）');
    });
    elBtnClearCal.addEventListener('click', () => {
      F.clearFixedShakeScales();
      F.resetShakeRuntime();
      showToast('已清除向导校准，回到固定值 ' + Math.round(F.getShakeTuning().fixedScale) + ' m/s²');
    });
    setInterval(renderRuntime, 250);
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

    ['anchorPanel', 'previewPanel', 'paramPanel', 'trajPanel', 'exportPanel', 'runtimePanel'].forEach((id) => {
      document.getElementById(id).style.display = '';
    });

    F.resetShakeRuntime();
    syncTuningLabels();
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
    bindRuntimeControls();
    syncDeadbandLabel();
    renderAnchorInfo();
  }

  init();
})();
