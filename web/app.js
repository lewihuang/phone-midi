// Phone MIDI CC — Web Client
// Mode A: tilt (DeviceOrientation)  /  Mode B: shake (devicemotion magnitude)

(() => {
  'use strict';

  // ── DOM refs ──
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

  // ── Mode definitions ──
  const MODES = {
    A: { sensor: 'rotation_vector', axis: 'pitch', unit: 'deg', label: 'Pitch', desc: '手持手机，倾斜改变cc值。', inputMin: -30, inputMax: 60 },
    B: { sensor: 'accelerometer',   axis: 'x', unit: 'm/s²', label: 'Shake', desc: '手持手机摇晃改变弯音值。仅支持弯音。', inputMin: -40, inputMax: 40, pb: true },
  };

  // ── State ──
  let ws = null;
  let active = false;
  let sending = true;
  let lastSentVal = null;
  let currentMode = 'A';
  let _syncing = false;
  const SEND_THRESHOLD = { A: 0.3, B: 0.5 };
  const SEND_INTERVAL = 16;

  // ── Populate channel dropdown ──
  function populateSelects() {
    for (let i = 1; i <= 16; i++) {
      const opt = document.createElement('option');
      opt.value = i - 1; opt.textContent = i;
      elSelCh.appendChild(opt);
    }
  }

  // ── UI helpers ──
  function setStatus(type, text) { elStatus.textContent = text; elStatus.className = 'status ' + type; }
  function showError(msg) { elError.textContent = msg; if (msg) console.warn(msg); }
  function updateDisplay(value) {
    elPitchDeg.textContent = typeof value === 'number' ? value.toFixed(1) : '—';
  }
  function updateCcDisplay(outputs) {
    if (!outputs || outputs.length === 0) return;
    const o = outputs[0];
    if (o.cc === 'PB') {
      elCcTag.textContent = 'Pitch Bend Ch' + (o.channel + 1);
      elCcVal.textContent = o.value;
      elBar.style.width = (o.value / 16383 * 100).toFixed(1) + '%';
      // Show PB value as large number for shake mode
      elPitchDeg.textContent = o.value;
    } else {
      elCcTag.textContent = 'CC' + o.cc + ' Ch' + (o.channel + 1);
      elCcVal.textContent = o.value;
      elBar.style.width = (o.value / 127 * 100).toFixed(1) + '%';
    }
  }

  // ── WebSocket ──
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
  function sendMessage(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function sendValue(val) {
    if (!sending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const thresh = SEND_THRESHOLD[currentMode] || 0.3;
    if (lastSentVal !== null && Math.abs(val - lastSentVal) < thresh) return;
    lastSentVal = val;
    const m = MODES[currentMode];
    sendMessage({ sensor: m.sensor, axis: m.axis, value: val });
  }

  // ── Mode switching ──
  function setMode(mode) {
    currentMode = mode;
    const m = MODES[mode];
    elModeDesc.textContent = m.desc;
    elUnitLabel.textContent = m.label + ' (' + m.unit + ')';
    lastSentVal = null;
    // Show/hide CC/Ch config (mode B = pitch bend, no CC)
    const ccEls = document.querySelectorAll('#cfgRow .cc-cfg');
    ccEls.forEach(el => el.style.display = m.pb ? 'none' : '');
    // Update bridge source
    if (!_syncing) sendMessage({ type: 'set_source', sensor: m.sensor, axis: m.axis });
    // Update range inputs to mode defaults
    elInMin.value = m.inputMin;
    elInMax.value = m.inputMax;
    sendMessage({ type: 'set_range', in_min: m.inputMin, in_max: m.inputMax });
  }

  function onModeChange() {
    if (_syncing) return;
    setMode(elSelMode.value);
  }

  // ── Config from bridge ──
  function onConfigReceived(config) {
    _syncing = true;
    const m = (config.mappings || [])[0];
    if (m) {
      const tgt = m.target || {};
      elSelCc.value = tgt.cc != null ? tgt.cc : 1;
      elSelCh.value = tgt.channel != null ? tgt.channel : 0;
      const r = m.range || {};
      elInMin.value = r.in_min != null ? r.in_min : -90;
      elInMax.value = r.in_max != null ? r.in_max : 90;
      elCcTag.textContent = 'CC' + tgt.cc + ' Ch' + (tgt.channel + 1);
      // Detect current mode from source
      const src = m.source || {};
      for (const [k, v] of Object.entries(MODES)) {
        if (v.sensor === src.sensor && v.axis === src.axis) {
          elSelMode.value = k; currentMode = k;
          elModeDesc.textContent = v.desc;
          elUnitLabel.textContent = v.label + ' (' + v.unit + ')';
          break;
        }
      }
    }
    _syncing = false;
  }

  // ── Config change handlers ──
  function onCcChange() {
    if (_syncing || MODES[currentMode].pb) return;
    const cc = parseInt(elSelCc.value); if (isNaN(cc) || cc < 0 || cc > 127) return;
    sendMessage({ type: 'set_target', cc: cc, channel: parseInt(elSelCh.value) });
  }
  function onRangeChange() {
    if (_syncing) return;
    const inMin = parseFloat(elInMin.value), inMax = parseFloat(elInMax.value);
    if (isNaN(inMin) || isNaN(inMax) || inMin >= inMax) return;
    sendMessage({ type: 'set_range', in_min: inMin, in_max: inMax });
  }

  // ── Toggle send ──
  function toggleSend() {
    sending = !sending;
    elBtnSend.textContent = sending ? '发送中' : '已暂停';
    elBtnSend.className = 'btn ' + (sending ? 'send-on' : 'send-off');
    if (sending) lastSentVal = null;
  }
  window.toggleSend = toggleSend;

  // ── Mode A: DeviceOrientation (tilt) ─────────────────────────────────
  let lastSendTime = 0;
  function onOrientation(event) {
    if (!active || currentMode !== 'A') return;
    if (event.beta == null) return;
    updateDisplay(event.beta);
    const now = performance.now();
    if (now - lastSendTime < SEND_INTERVAL) return;
    lastSendTime = now;
    sendValue(event.beta);
  }

  // ── Mode B: devicemotion → magnitude (shake) ─────────────────────────
  function computeMagnitude(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z);
  }

  function onMotion(event) {
    if (!active || currentMode !== 'B') return;
    // Use linear acceleration (no gravity) — oscillates around 0 when shaking
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc || acc.x == null) return;
    updateDisplay(acc.x);
    const now = performance.now();
    if (now - lastSendTime < SEND_INTERVAL) return;
    lastSendTime = now;
    sendValue(acc.x);
  }

  // ── Event routing ──
  function onOrientationRoute(event) {
    if (!active) return;
    if (currentMode === 'A') onOrientation(event);
  }

  function onMotionRoute(event) {
    if (!active) return;
    if (currentMode === 'B') onMotion(event);
  }

  // ── Start ──
  async function start() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') { showError('传感器权限被拒绝'); return; }
      } catch (e) { showError('权限请求失败: ' + e.message); return; }
    }

    active = true; sending = true;
    elBtn.textContent = '运行中...'; elBtn.disabled = true;
    elBtnSend.textContent = '发送中'; elBtnSend.className = 'btn send-on';
    elBtnRow.style.display = 'flex'; elCfgRow.classList.add('show');
    elModeRow.style.display = 'flex';

    setMode(elSelMode.value);
    setStatus('wait', '等待连接...');
    connectWs();

    // Always register both — route by currentMode
    window.addEventListener('deviceorientation', onOrientationRoute, true);
    window.addEventListener('devicemotion', onMotionRoute, true);

    lastSentVal = null; lastSendTime = 0;
  }

  // ── Init ──
  function init() {
    populateSelects();
    elBtn.disabled = false;
    elHint.textContent = '点击按钮开始';
    elSelMode.addEventListener('change', onModeChange);
    elSelCc.addEventListener('change', onCcChange);
    elSelCh.addEventListener('change', onCcChange);
    elInMin.addEventListener('change', onRangeChange);
    elInMax.addEventListener('change', onRangeChange);
    setMode('A');
  }

  window.start = start;
  document.addEventListener('visibilitychange', () => { if (document.hidden) lastSentVal = null; });
  init();
})();
