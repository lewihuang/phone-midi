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
      if (step === 2) {
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
    if (step === 2) updatePreview();
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
    if (step === 2) updatePreview();
  }

  function onMotion(e) {
    if (!sensorActive || busy || !usesGravity) return;
    liveFlip = F.feedFlipMotion(e, anchors, F.DEFAULT_FUSION);
    if (liveFlip) liveG = liveFlip.g;
    if (step === 2) updatePreview();
  }

  async function ensureSensor() {
    if (sensorActive) return;
    await F.requestProfilePermissions(profileId);
    F.resetFlipMotion();
    sensorActive = true;
    window.addEventListener('deviceorientation', onOrientation, true);
    if (usesGravity) {
      window.addEventListener('devicemotion', onMotion, true);
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
      window.location.replace('/?mode=' + returnMode);
    }, 400);
  }

  async function onAction() {
    await ensureSensor();
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
