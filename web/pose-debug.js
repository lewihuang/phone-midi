// Phone MIDI CC — Pose Debug (standalone, no WebSocket / no MIDI)
(() => {
  'use strict';

  const POSES = [
    { id: 'flat',   label: '平放',     hint: '屏幕朝上平放桌面' },
    { id: 'rest',   label: '自然垂手', hint: '握持，手臂自然下垂' },
    { id: 'mid',    label: '抬手中',   hint: '抬到舒适高度的一半' },
    { id: 'top',    label: '抬手最高', hint: '抬到最高舒适位置' },
    { id: 'tilt_l', label: '侧倾左',   hint: '保持高度，向左倾' },
    { id: 'tilt_r', label: '侧倾右',   hint: '保持高度，向右倾' },
  ];

  const CAPTURE_MS = 400;
  const SCHEMA = 'phone-midi/pose-debug/v1';

  const elStatus = document.getElementById('status');
  const elLivePanel = document.getElementById('livePanel');
  const elCapturePanel = document.getElementById('capturePanel');
  const elLiveBeta = document.getElementById('liveBeta');
  const elLiveGamma = document.getElementById('liveGamma');
  const elLiveAlpha = document.getElementById('liveAlpha');
  const elOrientationMeta = document.getElementById('orientationMeta');
  const elPoseButtons = document.getElementById('poseButtons');
  const elSnapBody = document.getElementById('snapBody');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnCopy = document.getElementById('btnCopy');
  const elBtnClear = document.getElementById('btnClear');
  const elExportArea = document.getElementById('exportArea');
  const elExportText = document.getElementById('exportText');
  const elError = document.getElementById('error');
  const elHint = document.getElementById('hint');
  const elToast = document.getElementById('toast');

  let active = false;
  let capturing = false;
  let sessionStartedAt = null;
  const snapshots = Object.create(null);
  const poseBtnMap = Object.create(null);

  function fmt(v) {
    return typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(1) : '—';
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) {
      return '—';
    }
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

  function getOrientationType() {
    if (screen.orientation && screen.orientation.type) return screen.orientation.type;
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  }

  function updateOrientationMeta() {
    elOrientationMeta.textContent = '屏幕方向：' + getOrientationType();
  }

  function updateLiveDisplay(event) {
    elLiveBeta.textContent = fmt(event.beta);
    elLiveGamma.textContent = fmt(event.gamma);
    elLiveAlpha.textContent = event.alpha == null ? '—' : fmt(event.alpha);
  }

  function onOrientation(event) {
    if (!active || capturing) return;
    updateLiveDisplay(event);
  }

  function buildPoseButtons() {
    elPoseButtons.innerHTML = '';
    for (const p of POSES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pose-btn';
      btn.dataset.pose = p.id;
      btn.title = p.hint;
      btn.textContent = p.label;
      btn.addEventListener('click', () => capturePose(p.id));
      elPoseButtons.appendChild(btn);
      poseBtnMap[p.id] = btn;
    }
  }

  function refreshPoseButtonStates() {
    for (const p of POSES) {
      const btn = poseBtnMap[p.id];
      if (!btn) continue;
      btn.classList.toggle('captured', snapshots[p.id] != null);
    }
  }

  function renderSnapshotTable() {
    const keys = POSES.map(p => p.id).filter(id => snapshots[id]);
    if (keys.length === 0) {
      elSnapBody.innerHTML = '<tr><td colspan="4" class="snap-empty">尚未抓拍</td></tr>';
      refreshPoseButtonStates();
      return;
    }
    elSnapBody.innerHTML = keys.map(id => {
      const pose = POSES.find(p => p.id === id);
      const s = snapshots[id];
      return '<tr>'
        + '<td>' + (pose ? pose.label : id) + '</td>'
        + '<td>' + fmt(s.beta) + '</td>'
        + '<td>' + fmt(s.gamma) + '</td>'
        + '<td>' + fmtTime(s.capturedAt) + '</td>'
        + '</tr>';
    }).join('');
    refreshPoseButtonStates();
  }

  function average(samples, key) {
    const vals = samples.map(s => s[key]).filter(v => typeof v === 'number' && !Number.isNaN(v));
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function capturePose(poseId) {
    if (!active || capturing) return;
    capturing = true;
    for (const id in poseBtnMap) poseBtnMap[id].disabled = true;

    const samples = [];
    const handler = (e) => {
      if (e.beta != null) {
        samples.push({ beta: e.beta, gamma: e.gamma, alpha: e.alpha });
      }
    };

    window.addEventListener('deviceorientation', handler, true);

    setTimeout(() => {
      window.removeEventListener('deviceorientation', handler, true);
      capturing = false;
      for (const id in poseBtnMap) poseBtnMap[id].disabled = false;

      if (samples.length === 0) {
        showError('采样失败：未收到 orientation 数据');
        return;
      }

      snapshots[poseId] = {
        beta: average(samples, 'beta'),
        gamma: average(samples, 'gamma'),
        alpha: average(samples, 'alpha'),
        capturedAt: new Date().toISOString(),
        sampleCount: samples.length,
      };
      showError('');
      renderSnapshotTable();
      const label = (POSES.find(p => p.id === poseId) || {}).label || poseId;
      showToast('已抓拍：' + label);
    }, CAPTURE_MS);
  }

  function buildExportJson() {
    const poses = {};
    for (const p of POSES) {
      if (snapshots[p.id]) poses[p.id] = { ...snapshots[p.id] };
    }
    return {
      schema: SCHEMA,
      device: {
        userAgent: navigator.userAgent,
        platform: navigator.platform || '',
      },
      session: {
        orientation: getOrientationType(),
        startedAt: sessionStartedAt || new Date().toISOString(),
      },
      poses,
    };
  }

  async function copyJson() {
    const json = JSON.stringify(buildExportJson(), null, 2);
    elExportArea.classList.remove('show');

    try {
      await navigator.clipboard.writeText(json);
      showToast('JSON 已复制到剪贴板');
      return;
    } catch (_) {}

    elExportText.value = json;
    elExportArea.classList.add('show');
    elExportText.focus();
    elExportText.select();
    showToast('请手动复制下方文本');
  }

  function clearAll() {
    if (Object.keys(snapshots).length === 0) return;
    if (!confirm('确定清空全部抓拍记录？')) return;
    for (const key of Object.keys(snapshots)) delete snapshots[key];
    elExportArea.classList.remove('show');
    renderSnapshotTable();
    showToast('已清空');
  }

  async function start() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          showError('传感器权限被拒绝');
          return;
        }
      } catch (e) {
        showError('权限请求失败: ' + e.message);
        return;
      }
    }

    active = true;
    sessionStartedAt = new Date().toISOString();
    elBtnStart.disabled = true;
    elBtnStart.textContent = '传感器运行中';
    elLivePanel.style.display = '';
    elCapturePanel.style.display = '';
    elHint.textContent = '请保持竖屏，依次完成关键姿势抓拍';
    setStatus(true, '● 传感器运行中');
    showError('');
    updateOrientationMeta();

    window.addEventListener('deviceorientation', onOrientation, true);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', updateOrientationMeta);
    }
  }

  function init() {
    buildPoseButtons();
    renderSnapshotTable();
    elBtnStart.addEventListener('click', start);
    elBtnCopy.addEventListener('click', copyJson);
    elBtnClear.addEventListener('click', clearAll);
  }

  init();
})();
