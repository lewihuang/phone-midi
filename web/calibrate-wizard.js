// Phone MIDI CC — User calibration wizard (profile-driven, 3 steps)
(() => {
  'use strict';

  const F = window.PhoneMidiFusion;
  const profileId = document.body.dataset.profile || 'lift';
  const profile = F.resolveProfile(profileId);
  const returnMode = profile.modeId;

  const WIZARD = {
    lift: {
      pageTitle: '校准 · 抬手推子 (A)',
      minToast: '已记录最低位置',
      maxToast: '已记录最高位置',
      steps: [
        {
          title: '确认最低位置',
          desc: '竖屏握持，与平时演奏相同。手臂自然下垂，然后点击下方按钮。',
          action: '确认：这是最低位置 (0)',
          key: 'min',
        },
        {
          title: '确认最高位置',
          desc: '将手机抬到你能舒适达到的最高位置，保持片刻后点击下方按钮。',
          action: '确认：这是最高位置 (127)',
          key: 'max',
        },
        {
          title: '试一下',
          desc: '来回抬手几次，观察推子是否从 0 跟到 127。不满意可点「上一步」返回重新确认端点。',
          action: '完成校准',
          key: 'done',
        },
      ],
    },
    flip: {
      pageTitle: '校准 · 翻转推子 (B)',
      minToast: '已记录自然握姿',
      maxToast: '已记录翻转极限',
      steps: [
        {
          title: '确认自然握姿',
          desc: '竖屏握持，肘部保持固定高度。掌心朝自己、正常演奏握法，然后点击下方按钮。',
          action: '确认：自然握姿 (0)',
          key: 'min',
        },
        {
          title: '确认翻转极限',
          desc: '肘部尽量不动，只翻转手腕到你能舒适达到的最大角度，然后点击下方按钮。',
          action: '确认：翻转极限 (127)',
          key: 'max',
        },
        {
          title: '试一下',
          desc: '来回翻转几次，观察推子是否从 0 跟到 127。不满意可点「上一步」返回重新确认端点。',
          action: '完成校准',
          key: 'done',
        },
      ],
    },
    shake: {
      pageTitle: '力度精调 · 摇晃弯音 (C)',
      minToast: '零位已确认',
      maxToast: '力度已记录',
      // Mode C works without any of this (adaptive scale); the wizard only *pins*
      // the scale so the bend amount stops depending on how hard you happen to shake.
      steps: [
        {
          title: '确认静止零位',
          desc: '把手机以演奏姿势拿好，保持不动约 2 秒。系统会顺便测出「静止时的残余偏移」——'
            + '它决定弯音会不会跑调。',
          action: '开始：保持静止',
          key: 'zero',
        },
        {
          title: '演示满力度',
          desc: '向两侧来回晃动到你觉得「这就是满弯音」的力度，持续 5 秒。'
            + '只记录幅度，不会发送 MIDI。',
          action: '开始：演示 ±100% 力度',
          key: 'effort',
        },
        {
          title: '回放校验',
          desc: '按刚才的力度再晃 3 秒，看看实际用到多少刻度。',
          action: '保存并校验',
          key: 'done',
        },
      ],
    },
  };

  const cfg = WIZARD[profileId] || WIZARD.lift;
  const STEPS = cfg.steps;

  document.title = cfg.pageTitle + ' — Phone MIDI CC';
  const elPageTitle = document.getElementById('pageTitle');
  if (elPageTitle) elPageTitle.textContent = cfg.pageTitle;

  const elPreviewLabel = document.getElementById('previewLabel');
  if (elPreviewLabel) elPreviewLabel.textContent = profile.previewLabel;

  const elStepLabel = document.getElementById('stepLabel');
  const elStepTitle = document.getElementById('stepTitle');
  const elStepDesc = document.getElementById('stepDesc');
  const elStepDots = document.getElementById('stepDots');
  const elPreviewBlock = document.getElementById('previewBlock');
  const elCcVal = document.getElementById('ccVal');
  const elCcBar = document.getElementById('ccBar');
  const elBtnAction = document.getElementById('btnAction');
  const elBtnBack = document.getElementById('btnBack');
  const elError = document.getElementById('error');
  const elToast = document.getElementById('toast');

  let step = 0;
  let sensorActive = false;
  let busy = false;
  const anchors = { min: null, max: null };
  let liveBeta = null;
  let liveGamma = null;
  let liveG = null;
  let liveFlip = null;
  const usesGravity = profile.input === 'gravity';
  const isShake = profile.input === 'motion';

  // ── Mode C (shake) wizard state ─────────────────────────────────────────────
  // A single devicemotion handler feeds the *production* runtime
  // (F.feedShakeMotion) so the wizard measures exactly what the instrument will do,
  // auto-zero included. Recording just taps that stream.
  const shakeRec = { active: false, values: [], samples: 0, srcs: {}, t0: 0 };
  let shakeStep1 = null;   // { residual, source, samples }
  let shakeStep2 = null;   // { robust, scaleNeg, scalePos, samples, srcs, windowMs }

  function onShakeMotion(e) {
    // NOTE: deliberately not gated on `busy`. `busy` is set for the whole duration of a
    // capture (see onShakeAction), so gating here meant the recorder never received a
    // single sample — every shake step failed with "未收到运动数据". `busy` exists to
    // suppress preview repaints, not to close the data path.
    if (!sensorActive) return;
    const out = F.feedShakeMotion(e);
    if (!out) return;
    if (shakeRec.active) {
      shakeRec.samples++;
      shakeRec.srcs[out.source] = (shakeRec.srcs[out.source] || 0) + 1;
      shakeRec.values.push(out.raw);
    }
    if (step === 2) {
      elCcVal.textContent = String(out.pb);
      elCcBar.style.width = (out.pb / 16383 * 100).toFixed(1) + '%';
    }
  }

  function collectShake(ms) {
    return new Promise((resolve) => {
      shakeRec.active = true;
      shakeRec.values = [];
      shakeRec.samples = 0;
      shakeRec.srcs = {};
      shakeRec.t0 = performance.now();
      setTimeout(() => {
        shakeRec.active = false;
        resolve({
          values: shakeRec.values.slice(),
          samples: shakeRec.samples,
          srcs: { ...shakeRec.srcs },
          elapsed: performance.now() - shakeRec.t0,
        });
      }, ms);
    });
  }

  /** Step 1: hold still. The auto-zero absorbs the residual; we report what it saw. */
  async function shakeConfirmZero() {
    F.resetShakeRuntime();
    const res = await collectShake(1800);
    if (res.samples < 20) throw new Error('未收到运动数据（' + res.samples + ' 个样本），请重试');
    const diag = F.getShakeDiagnostics();
    const residual = Math.max(Math.abs(diag.bias.x), Math.abs(diag.bias.y));
    shakeStep1 = { residual, source: diag.source, samples: res.samples };
    showToast(cfg.minToast);
    return shakeStep1;
  }

  /** Step 2: demonstrate full bend effort; keep the robust per-direction peaks. */
  async function shakeCaptureEffort() {
    showToast('开始晃动（5 秒）…');
    const res = await collectShake(F.SHAKE_PEAK_MS);
    if (res.samples < 60) throw new Error('样本太少（' + res.samples + '），请重试');
    const robust = F.robustShakePeaks(res.values);
    if (!robust) throw new Error('未能算出力度峰值，请重试');
    const scaleNeg = Math.abs(robust.neg_trim);
    const scalePos = robust.pos_trim;
    if (!F.validShakeScale(scaleNeg) || !F.validShakeScale(scalePos)) {
      throw new Error('力度跨度不足（−' + scaleNeg.toFixed(1) + ' / +' + scalePos.toFixed(1)
        + ' m/s²），请向两侧加大晃动');
    }
    shakeStep2 = { robust, scaleNeg, scalePos, samples: res.samples, srcs: res.srcs, windowMs: res.elapsed };
    showToast(cfg.maxToast);
    return shakeStep2;
  }

  /**
   * Step 3: save, then immediately replay one burst to prove the scale is reachable.
   * Without this the user has no way to know the calibration actually matches their
   * effort — the failure mode the archived sample showed (anchors 56 vs motion 20).
   */
  async function shakeFinishAndVerify() {
    if (!shakeStep2) throw new Error('请先完成前两步');
    F.saveFixedShakeScales(shakeStep2.scaleNeg, shakeStep2.scalePos, {
      source: Object.keys(shakeStep2.srcs)[0] || null,
      sources: shakeStep2.srcs,
      robust: shakeStep2.robust,
      windowMs: Math.round(shakeStep2.windowMs),
    });
    showToast('已保存，正在校验…');
    const res = await collectShake(3000);
    const robust = F.robustShakePeaks(res.values);
    const diag = F.getShakeDiagnostics();
    const achievedNeg = robust && diag.scaleNeg
      ? Math.min(100, Math.round(100 * Math.abs(robust.neg_trim) / diag.scaleNeg)) : null;
    const achievedPos = robust && diag.scalePos
      ? Math.min(100, Math.round(100 * robust.pos_trim / diag.scalePos)) : null;
    const worst = Math.min(achievedNeg == null ? 100 : achievedNeg, achievedPos == null ? 100 : achievedPos);
    const summary = '校验：用到 −' + (achievedNeg == null ? '—' : achievedNeg + '%')
      + ' / +' + (achievedPos == null ? '—' : achievedPos + '%');
    if (worst < 80) {
      showError(summary + '。刻度偏大：请点「上一步」重新演示更大的力度。');
      return false;
    }
    showToast(summary);
    return true;
  }

  function showError(msg) {
    elError.textContent = msg || '';
  }

  function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    setTimeout(() => elToast.classList.remove('show'), 2000);
  }

  function renderStep() {
    const s = STEPS[step];
    elStepLabel.textContent = '步骤 ' + (step + 1) + ' / 3';
    elStepTitle.textContent = s.title;
    elStepDesc.textContent = s.desc;
    elBtnAction.textContent = s.action;
    if (step === 0) {
      elBtnBack.style.display = 'none';
    } else {
      elBtnBack.style.display = '';
      if (isShake) {
        elBtnBack.textContent = step === 2 ? '上一步：重新演示力度' : '上一步：重新确认零位';
      } else if (step === 2) {
        elBtnBack.textContent = profileId === 'flip'
          ? '上一步：重新确认翻转极限'
          : '上一步：重新确认最高位置';
      } else {
        elBtnBack.textContent = profileId === 'flip'
          ? '上一步：重新确认自然握姿'
          : '上一步：重新确认最低位置';
      }
    }

    elStepDots.querySelectorAll('.step-dot').forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < step) dot.classList.add('done');
      else if (i === step) dot.classList.add('active');
    });

    elPreviewBlock.classList.toggle('show', step === 2);
    if (step === 2 && !isShake) updatePreview();
  }

  function updatePreview() {
    if (step !== 2 || !F.anchorsReadyForProfile(profileId, anchors)) return;
    let t;
    if (usesGravity) {
      if (!liveFlip) return;
      t = liveFlip.t;
    } else {
      t = F.computeFusedT(liveBeta, liveGamma, anchors, F.DEFAULT_FUSION);
    }
    const cc = F.fusedToCc(t);
    elCcVal.textContent = cc != null ? String(cc) : '—';
    elCcBar.style.width = (t != null ? t * 100 : 0).toFixed(1) + '%';
  }

  function onOrientation(e) {
    if (!sensorActive || busy) return;
    if (e.beta == null) return;
    liveBeta = e.beta;
    liveGamma = e.gamma;
    if (usesGravity) {
      liveFlip = F.feedFlipOrientation(e.beta, e.gamma, anchors, F.DEFAULT_FUSION);
      if (liveFlip) liveG = liveFlip.g;
    }
    if (step === 2) updatePreview();
  }

  async function ensureSensor() {
    if (sensorActive) return;
    await F.requestProfilePermissions(profileId);
    if (isShake) F.resetShakeRuntime();
    sensorActive = true;
    window.addEventListener('deviceorientation', onOrientation, true);
    if (isShake) {
      window.addEventListener('devicemotion', onShakeMotion, true);
    }
  }

  async function captureKey(key) {
    busy = true;
    elBtnAction.disabled = true;
    showError('');
    try {
      const point = await F.captureAnchorSamplesForProfile(profileId);
      anchors[key] = point;
      showToast(key === 'min' ? cfg.minToast : cfg.maxToast);
      if (step === 0 || step === 1) step += 1;
      renderStep();
    } catch (e) {
      showError(e.message || '采样失败');
    } finally {
      busy = false;
      elBtnAction.disabled = false;
    }
  }

  function finishCalibration() {
    if (!F.anchorsReadyForProfile(profileId, anchors)) {
      showError('请先完成前两步');
      return;
    }
    const sep = F.anchorSeparationForProfile(profileId, anchors);
    if (sep < F.MIN_SEP) {
      showError('两个位置太接近，请返回重新校准');
      return;
    }
    try {
      F.saveCalibration(profileId, anchors, F.DEFAULT_FUSION);
    } catch (e) {
      showError(e.message || '保存失败');
      return;
    }
    showToast('校准已保存');
    setTimeout(() => {
      window.location.replace('/fader.html?mode=' + returnMode);
    }, 400);
  }

  async function onShakeAction() {
    const s = STEPS[step];
    busy = true;
    elBtnAction.disabled = true;
    showError('');
    try {
      if (s.key === 'zero') {
        const r = await shakeConfirmZero();
        elStepDesc.textContent = '静止残余偏移 ' + r.residual.toFixed(2) + ' m/s²（'
          + (r.source === 'gravity_delta' ? '重力估计路径' : '线性加速度') + '）。'
          + '已把它作为零位，静止时弯音会停在中点。';
        step = 1;
        renderStep();
      } else if (s.key === 'effort') {
        const r = await shakeCaptureEffort();
        elStepDesc.textContent = '力度刻度：−' + r.scaleNeg.toFixed(1) + ' / +' + r.scalePos.toFixed(1)
          + ' m/s²（幅度上限 ' + r.robust.pos_max.toFixed(1) + '，已按稳健统计剔掉尖峰）。';
        step = 2;
        renderStep();
      } else if (s.key === 'done') {
        const ok = await shakeFinishAndVerify();
        if (!ok) return;
        setTimeout(() => window.location.replace('/fader.html?mode=' + returnMode), 700);
      }
    } catch (e) {
      showError(e.message || '采样失败');
    } finally {
      busy = false;
      elBtnAction.disabled = false;
    }
  }

  async function onAction() {
    await ensureSensor();
    if (isShake) {
      await onShakeAction();
      return;
    }
    const s = STEPS[step];
    if (s.key === 'min' || s.key === 'max') {
      await captureKey(s.key);
      return;
    }
    if (s.key === 'done') {
      finishCalibration();
    }
  }

  function onBack() {
    if (step <= 0) return;
    step -= 1;
    showError('');
    renderStep();
  }

  elBtnAction.addEventListener('click', onAction);
  elBtnBack.addEventListener('click', onBack);
  renderStep();
})();
