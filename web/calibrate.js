// Phone MIDI CC — User calibration wizard (3 steps)
(() => {
  'use strict';

  const F = window.PhoneMidiFusion;
  const STEPS = [
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
  ];

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
      elBtnBack.textContent = step === 2
        ? '上一步：重新确认最高位置'
        : '上一步：重新确认最低位置';
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
    if (step !== 2 || !F.anchorsReady(anchors)) return;
    const t = F.computeFusedT(liveBeta, liveGamma, anchors, F.DEFAULT_FUSION);
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

  async function ensureSensor() {
    if (sensorActive) return;
    await F.requestOrientationPermission();
    sensorActive = true;
    window.addEventListener('deviceorientation', onOrientation, true);
  }

  async function captureKey(key) {
    busy = true;
    elBtnAction.disabled = true;
    showError('');
    try {
      const point = await F.captureAnchorSamples();
      anchors[key] = point;
      showToast(key === 'min' ? '已记录最低位置' : '已记录最高位置');
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
    if (!F.anchorsReady(anchors)) {
      showError('请先完成前两步');
      return;
    }
    const sep = F.anchorSeparation(anchors);
    if (sep < F.MIN_SEP) {
      showError('两个位置太接近，请返回重新校准');
      return;
    }
    try {
      F.saveCalibration(anchors, F.DEFAULT_FUSION);
    } catch (e) {
      showError(e.message || '保存失败');
      return;
    }
    showToast('校准已保存');
    setTimeout(() => { window.location.replace('/'); }, 400);
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
