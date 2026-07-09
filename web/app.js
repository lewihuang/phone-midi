// Phone MIDI CC — Web Client
// Mode A: fused lift (DeviceOrientation)  /  Mode B: shake (devicemotion)

(() => {
  'use strict';

  const F = window.PhoneMidiFusion;

  const elStatus = document.getElementById('status');
  const elPitchDeg = document.getElementById('pitchDeg');
  const elUnitLabel = document.getElementById('unitLabel');
  const elBar = document.getElementById('bar');
  const elCcTag = document.getElementById('ccTag');
  const elCcVal = document.getElementById('ccVal');
  const elError = document.getElementById('error');
  const elHint = document.getElementById('hint');
  const elBtn = document.getElementById('btnStart');
  const elBtnRow = document.getElementById('btnRow');
  const elBtnSend = document.getElementById('btnSend');
  const elCfgRow = document.getElementById('cfgRow');
  const elModeRow = document.getElementById('modeRow');
  const elModeDesc = document.getElementById('modeDesc');
  const elSelMode = document.getElementById('selMode');
  const elSelCc = document.getElementById('selCc');
  const elSelCh = document.getElementById('selCh');
  const elInMin = document.getElementById('inMin');
  const elInMax = document.getElementById('inMax');
  const elCalBadge = document.getElementById('calBadge');

  const MODES = {
    A: {
      sensor: 'rotation_vector',
      axis: 'fused_lift',
      unit: 'CC',
      label: 'Lift',
      desc: '抬手控制 CC。请先校准设备（自然垂手=0，抬最高=127）。',
      inputMin: 0,
      inputMax: 1,
      fused: true,
    },
    B: {
      sensor: 'accelerometer',
      axis: 'x',
      unit: 'm/s²',
      label: 'Shake',
      desc: '手持手机摇晃改变弯音值。仅支持弯音。',
      inputMin: -40,
      inputMax: 40,
      pb: true,
    },
  };

  let ws = null;
  let active = false;
  let sending = true;
  let lastSentVal = null;
  let currentMode = 'A';
  let _syncing = false;
  let calibration = null;
  const SEND_THRESHOLD = { A: 0.008, B: 0.5 };
  const SEND_INTERVAL = 16;

  function populateSelects() {
    for (let i = 1; i <= 16; i++) {
      const opt = document.createElement('option');
      opt.value = i - 1;
      opt.textContent = i;
      elSelCh.appendChild(opt);
    }
  }

  function refreshCalibrationBadge() {
    if (!elCalBadge) return;
    if (!F) {
      elCalBadge.textContent = '校准模块未加载，请刷新页面';
      elCalBadge.className = 'cal-badge warn';
      return;
    }
    if (F.consumeJustSavedFlag && F.consumeJustSavedFlag()) {
      /* 刚从校准页返回，强制重新读取 */
    }
    calibration = F.loadCalibration();
    const ok = F.hasCalibration();
    elCalBadge.textContent = ok ? '已校准抬手范围' : '尚未校准抬手范围';
    elCalBadge.className = 'cal-badge' + (ok ? '' : ' warn');
  }

  function setStatus(type, text) {
    elStatus.textContent = text;
    elStatus.className = 'status ' + type;
  }

  function showError(msg) {
    elError.textContent = msg || '';
    if (msg) console.warn(msg);
  }

  function updateDisplay(value, asCc) {
    if (asCc) {
      elPitchDeg.textContent = typeof value === 'number' ? String(Math.round(value)) : '—';
    } else {
      elPitchDeg.textContent = typeof value === 'number' ? value.toFixed(1) : '—';
    }
  }

  function updateCcDisplay(outputs) {
    if (!outputs || outputs.length === 0) return;
    const o = outputs[0];
    if (o.cc === 'PB') {
      elCcTag.textContent = 'Pitch Bend Ch' + (o.channel + 1);
      elCcVal.textContent = o.value;
      elBar.style.width = (o.value / 16383 * 100).toFixed(1) + '%';
      elPitchDeg.textContent = o.value;
    } else {
      elCcTag.textContent = 'CC' + o.cc + ' Ch' + (o.channel + 1);
      elCcVal.textContent = o.value;
      elBar.style.width = (o.value / 127 * 100).toFixed(1) + '%';
    }
  }

  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/ws');
    ws.onopen = () => { setStatus('on', '已连接'); showError(''); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'cc_output') updateCcDisplay(msg.outputs);
        else if (msg.type === 'config') onConfigReceived(msg.config);
      } catch (e) {}
    };
    ws.onclose = () => {
      if (active) setStatus('wait', '重连中...');
      else setStatus('off', '未连接');
      ws = null;
      if (active) setTimeout(() => { if (active) connectWs(); }, 2000);
    };
    ws.onerror = () => {};
  }

  function sendMessage(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendValue(val) {
    if (!sending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const thresh = SEND_THRESHOLD[currentMode] || 0.3;
    if (lastSentVal !== null && Math.abs(val - lastSentVal) < thresh) return;
    lastSentVal = val;
    const m = MODES[currentMode];
    sendMessage({ sensor: m.sensor, axis: m.axis, value: val });
  }

  function applyModeUi(mode) {
    const m = MODES[mode];
    if (!m) return;
    elSelMode.value = mode;
    elModeDesc.textContent = m.desc;
    elUnitLabel.textContent = m.label + (m.unit ? ' (' + m.unit + ')' : '');

    document.querySelectorAll('#cfgRow .cc-cfg').forEach(el => {
      el.style.display = m.pb ? 'none' : '';
    });
    document.querySelectorAll('#cfgRow .range-cfg').forEach(el => {
      el.style.display = m.fused ? 'none' : '';
    });

    const elRangeUnit = document.getElementById('rangeUnit');
    if (elRangeUnit) elRangeUnit.textContent = m.fused ? '' : (m.unit || '');
  }

  function setMode(mode) {
    currentMode = mode;
    const m = MODES[mode];
    applyModeUi(mode);
    lastSentVal = null;

    if (!_syncing) sendMessage({ type: 'set_source', sensor: m.sensor, axis: m.axis });
    elInMin.value = m.inputMin;
    elInMax.value = m.inputMax;
    sendMessage({ type: 'set_range', in_min: m.inputMin, in_max: m.inputMax });
  }

  function onModeChange() {
    if (_syncing) return;
    setMode(elSelMode.value);
  }

  function onConfigReceived(config) {
    _syncing = true;
    const m = (config.mappings || [])[0];
    if (m) {
      const tgt = m.target || {};
      elSelCc.value = tgt.cc != null ? tgt.cc : 1;
      elSelCh.value = tgt.channel != null ? tgt.channel : 0;
      const r = m.range || {};
      elInMin.value = r.in_min != null ? r.in_min : 0;
      elInMax.value = r.in_max != null ? r.in_max : 1;
      elCcTag.textContent = 'CC' + tgt.cc + ' Ch' + (tgt.channel + 1);
      const src = m.source || {};
      for (const [k, v] of Object.entries(MODES)) {
        if (v.sensor === src.sensor && v.axis === src.axis) {
          currentMode = k;
          break;
        }
      }
    }
    applyModeUi(currentMode);
    _syncing = false;
  }

  function onCcChange() {
    if (_syncing || MODES[currentMode].pb) return;
    const cc = parseInt(elSelCc.value, 10);
    if (isNaN(cc) || cc < 0 || cc > 127) return;
    sendMessage({ type: 'set_target', cc: cc, channel: parseInt(elSelCh.value, 10) });
  }

  function onRangeChange() {
    if (_syncing || MODES[currentMode].fused) return;
    const inMin = parseFloat(elInMin.value);
    const inMax = parseFloat(elInMax.value);
    if (isNaN(inMin) || isNaN(inMax) || inMin >= inMax) return;
    sendMessage({ type: 'set_range', in_min: inMin, in_max: inMax });
  }

  function toggleSend() {
    sending = !sending;
    elBtnSend.textContent = sending ? '发送中' : '已暂停';
    elBtnSend.className = 'btn ' + (sending ? 'send-on' : 'send-off');
    if (sending) lastSentVal = null;
  }
  window.toggleSend = toggleSend;

  let lastSendTime = 0;

  function onOrientation(event) {
    if (!active || currentMode !== 'A') return;
    if (event.beta == null) return;

    calibration = F.loadCalibration();
    if (!F.hasCalibration()) {
      showError('请先校准设备');
      return;
    }

    const t = F.computeFusedT(
      event.beta,
      event.gamma,
      calibration.anchors,
      calibration.fusion || F.DEFAULT_FUSION,
    );
    if (t == null) return;

    const cc = F.fusedToCc(t);
    updateDisplay(cc, true);
    showError('');

    const now = performance.now();
    if (now - lastSendTime < SEND_INTERVAL) return;
    lastSendTime = now;
    sendValue(t);
  }

  function onMotion(event) {
    if (!active || currentMode !== 'B') return;
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc || acc.x == null) return;
    updateDisplay(acc.x, false);
    const now = performance.now();
    if (now - lastSendTime < SEND_INTERVAL) return;
    lastSendTime = now;
    sendValue(acc.x);
  }

  function onOrientationRoute(event) {
    if (!active) return;
    if (currentMode === 'A') onOrientation(event);
  }

  function onMotionRoute(event) {
    if (!active) return;
    if (currentMode === 'B') onMotion(event);
  }

  async function start() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') { showError('传感器权限被拒绝'); return; }
      } catch (e) { showError('权限请求失败: ' + e.message); return; }
    }

    refreshCalibrationBadge();
    if (elSelMode.value === 'A' && !F.hasCalibration()) {
      showError('Mode A 需要先校准设备');
    }

    active = true;
    sending = true;
    elBtn.textContent = '运行中...';
    elBtn.disabled = true;
    elBtnSend.textContent = '发送中';
    elBtnSend.className = 'btn send-on';
    elBtnRow.style.display = 'flex';
    elCfgRow.classList.add('show');
    elModeRow.style.display = 'flex';

    setMode(elSelMode.value);
    setStatus('wait', '等待连接...');
    connectWs();

    window.addEventListener('deviceorientation', onOrientationRoute, true);
    window.addEventListener('devicemotion', onMotionRoute, true);

    lastSentVal = null;
    lastSendTime = 0;
  }

  function init() {
    populateSelects();
    if (!F) {
      elHint.textContent = '校准模块未加载，请刷新页面后重试';
      elBtn.disabled = true;
      refreshCalibrationBadge();
      return;
    }
    elBtn.disabled = false;
    elHint.textContent = '点击启动传感器；Mode A 使用前请先校准设备';
    refreshCalibrationBadge();
    elSelMode.addEventListener('change', onModeChange);
    elSelCc.addEventListener('change', onCcChange);
    elSelCh.addEventListener('change', onCcChange);
    elInMin.addEventListener('change', onRangeChange);
    elInMax.addEventListener('change', onRangeChange);
    setMode('A');
  }

  window.start = start;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) lastSentVal = null;
    else refreshCalibrationBadge();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      /* 从 bfcache 恢复时重新拉脚本与校准状态（避免旧版 index 无 fusion.js） */
      window.location.reload();
      return;
    }
    refreshCalibrationBadge();
  });
  window.addEventListener('focus', refreshCalibrationBadge);
  init();
})();
