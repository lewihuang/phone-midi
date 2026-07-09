// Phone MIDI CC — Web Client

// Mode A: fused lift  /  Mode B: fused flip  /  Mode C: shake pitch bend



(() => {

  'use strict';



  const F = window.PhoneMidiFusion;



  const elStatus = document.getElementById('status');

  const elSetupPanel = document.getElementById('setupPanel');

  const elRuntimePanel = document.getElementById('runtimePanel');

  const elModeSelect = document.getElementById('modeSelect');
  const elModeDesc = document.getElementById('modeDesc');
  const elCalRow = document.getElementById('calRow');
  const elCalBadge = document.getElementById('calBadge');
  const elCalLink = document.getElementById('calLink');

  const elRuntimeModeName = document.getElementById('runtimeModeName');

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

  const elSelCc = document.getElementById('selCc');

  const elSelCh = document.getElementById('selCh');

  const elInMin = document.getElementById('inMin');

  const elInMax = document.getElementById('inMax');



  const MODES = {

    A: {

      id: 'A',

      name: '抬手推子',

      sensor: 'rotation_vector',

      axis: 'fused_lift',

      profile: 'lift',

      unit: 'CC',

      label: 'Lift',

      desc: '自然垂手 ↔ 抬手最高 → CC 0–127',
      calibrateHref: '/calibrate-lift.html',
      calibrateLabel: '校准抬手范围',

      inputMin: 0,

      inputMax: 1,

      fused: true,

      needsCal: true,

    },

    B: {

      id: 'B',

      name: '翻转推子',

      sensor: 'rotation_vector',

      axis: 'fused_flip',

      profile: 'flip',

      unit: 'CC',

      label: 'Flip',

      desc: '固定肘部，翻转手掌 → CC 0–127',
      calibrateHref: '/calibrate-flip.html',
      calibrateLabel: '校准翻转范围',

      inputMin: 0,

      inputMax: 1,

      fused: true,

      needsCal: true,

    },

    C: {

      id: 'C',

      name: '摇晃弯音',

      sensor: 'accelerometer',

      axis: 'x',

      unit: 'm/s²',

      label: 'Shake',

      desc: '手持摇晃 → 弯音（Pitch Bend）；可在下方调整输入范围',

      inputMin: -40,

      inputMax: 40,

      pb: true,

      needsCal: false,

    },

  };



  let ws = null;

  let active = false;

  let sending = true;

  let lastSentVal = null;

  let selectedMode = 'A';

  let currentMode = 'A';

  let _syncing = false;

  let calibration = null;

  const SEND_THRESHOLD = { A: 0.008, B: 0.008, C: 0.5 };

  const SEND_INTERVAL = 16;

  let lastSendTime = 0;

  let lastSentCc = null;



  function populateSelects() {

    for (let i = 1; i <= 16; i++) {

      const opt = document.createElement('option');

      opt.value = i - 1;

      opt.textContent = i;

      elSelCh.appendChild(opt);

    }

  }



  function getModeFromUrl() {

    const m = new URLSearchParams(location.search).get('mode');

    return MODES[m] ? m : null;

  }



  function refreshModeSetup() {
    if (!F) return;
    F.migrateLegacyCalibration();
    const m = MODES[selectedMode];
    if (m && m.needsCal && m.profile) {
      F.consumeJustSavedFlag(m.profile);
    }
    applyModeSetupUi(selectedMode);
    updateStartButtonLabel();
  }

  function applyModeSetupUi(modeId) {
    const m = MODES[modeId];
    if (!m) return;
    if (elModeSelect) elModeSelect.value = modeId;
    if (elModeDesc) elModeDesc.textContent = m.desc;
    if (!elCalRow) return;
    if (m.needsCal && m.calibrateHref) {
      elCalRow.classList.remove('hidden');
      if (elCalLink) {
        elCalLink.href = m.calibrateHref;
        elCalLink.textContent = m.calibrateLabel || '去校准';
      }
      const ok = F && F.hasCalibration(m.profile);
      if (elCalBadge) {
        elCalBadge.textContent = ok ? '已校准' : '未校准';
        elCalBadge.className = 'cal-badge ' + (ok ? 'ok' : 'warn');
      }
    } else {
      elCalRow.classList.add('hidden');
    }
  }

  function selectMode(modeId) {
    if (!MODES[modeId]) return;
    selectedMode = modeId;
    applyModeSetupUi(modeId);
    updateStartButtonLabel();
    history.replaceState(null, '', '/?mode=' + modeId);
  }



  function updateStartButtonLabel() {

    if (!elBtn || active) return;

    const m = MODES[selectedMode];

    elBtn.textContent = '启动 · ' + m.name;

    if (m.needsCal && F && !F.hasCalibration(m.profile)) {

      elHint.textContent = m.name + ' 尚未校准，可先校准或启动后仅预览（不发送有效 CC）';

    } else if (m.needsCal) {

      elHint.textContent = '点击启动传感器；请先完成上方校准';

    } else {

      elHint.textContent = '点击启动传感器';

    }

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



  function updateFusedCcDisplay(t) {

    const cc = F.fusedToCc(t);

    if (cc == null) return;

    elPitchDeg.textContent = String(cc);

    elCcVal.textContent = String(cc);

    elBar.style.width = (cc / 127 * 100).toFixed(1) + '%';

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



  function syncBridgeFromRuntime() {

    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;

    const m = MODES[currentMode];

    if (!m) return;

    sendMessage({ type: 'set_source', sensor: m.sensor, axis: m.axis });

    sendMessage({ type: 'set_range', in_min: m.inputMin, in_max: m.inputMax });

    if (!m.pb) {

      sendMessage({

        type: 'set_target',

        cc: parseInt(elSelCc.value, 10),

        channel: parseInt(elSelCh.value, 10),

      });

    }

  }



  function connectWs() {

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    ws = new WebSocket(protocol + '//' + location.host + '/ws');

    ws.onopen = () => {

      setStatus('on', '已连接');

      showError('');

      syncBridgeFromRuntime();

    };

    ws.onmessage = (event) => {

      try {

        const msg = JSON.parse(event.data);

        if (msg.type === 'cc_output') {

          const m = MODES[currentMode];

          if (!m || !m.fused) updateCcDisplay(msg.outputs);

        }

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

    if (elRuntimeModeName) elRuntimeModeName.textContent = m.name;

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

      if (!active) {

        const src = m.source || {};

        for (const [k, v] of Object.entries(MODES)) {

          if (v.sensor === src.sensor && v.axis === src.axis) {

            currentMode = k;

            break;

          }

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

    lastSentCc = null;

  }

  window.toggleSend = toggleSend;



  function handleFusedOrientation(event, modeId) {

    if (!active || currentMode !== modeId) return;

    if (event.beta == null) return;



    const m = MODES[modeId];

    calibration = F.loadCalibration(m.profile);

    if (!F.hasCalibration(m.profile)) {

      showError('请先校准' + m.name);

      return;

    }



    const t = F.computeFusedT(

      event.beta,

      event.gamma,

      calibration.anchors,

      calibration.fusion || F.DEFAULT_FUSION,

    );

    if (t == null) return;



    updateFusedCcDisplay(t);

    showError('');



    const now = performance.now();

    if (now - lastSendTime < SEND_INTERVAL) return;

    lastSendTime = now;

    sendValue(t);

  }



  function handleFusedGravity(event, modeId) {

    if (!active || currentMode !== modeId) return;



    const m = MODES[modeId];

    calibration = F.loadCalibration(m.profile);

    if (!F.hasCalibration(m.profile)) {

      showError('请先校准' + m.name);

      return;

    }



    const out = F.feedFlipMotion(

      event,

      calibration.anchors,

      calibration.fusion || F.DEFAULT_FUSION,

    );

    if (!out) return;



    const t = out.t;

    updateFusedCcDisplay(t);

    showError('');



    const now = performance.now();

    if (now - lastSendTime < SEND_INTERVAL) return;

    if (!F.flipShouldSendValue(t, lastSentVal, lastSentCc)) return;



    lastSendTime = now;

    lastSentVal = t;

    lastSentCc = F.fusedToCc(t);



    if (!sending) return;

    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    sendMessage({ sensor: m.sensor, axis: m.axis, value: t });

  }



  function onMotion(event) {

    if (!active || currentMode !== 'C') return;

    const acc = event.acceleration || event.accelerationIncludingGravity;

    if (!acc || acc.x == null) return;

    updateDisplay(acc.x, false);

    showError('');

    const now = performance.now();

    if (now - lastSendTime < SEND_INTERVAL) return;

    lastSendTime = now;

    sendValue(acc.x);

  }



  function onOrientationRoute(event) {

    if (!active) return;

    if (currentMode === 'A') handleFusedOrientation(event, 'A');

  }



  function onMotionRoute(event) {

    if (!active) return;

    if (currentMode === 'B') handleFusedGravity(event, 'B');

    else if (currentMode === 'C') onMotion(event);

  }



  async function start() {

    try {

      await F.requestOrientationPermission();

      if (selectedMode === 'B' || selectedMode === 'C') {

        await F.requestMotionPermission();

      }

    } catch (e) {

      showError(e.message || '权限请求失败');

      return;

    }



    const m = MODES[selectedMode];

    if (m.needsCal && !F.hasCalibration(m.profile)) {

      showError(m.name + ' 尚未校准，请返回完成校准');

    }



    active = true;

    sending = true;

    currentMode = selectedMode;



    elSetupPanel.classList.add('hidden');

    elRuntimePanel.classList.add('show');

    elBtnSend.textContent = '发送中';

    elBtnSend.className = 'btn send-on';

    elCfgRow.classList.add('show');



    setMode(currentMode);

    setStatus('wait', '等待连接...');

    connectWs();



    window.addEventListener('deviceorientation', onOrientationRoute, true);

    window.addEventListener('devicemotion', onMotionRoute, true);



    F.resetFlipMotion();

    lastSentVal = null;

    lastSentCc = null;

    lastSendTime = 0;

  }



  function returnToSetup() {

    if (!active) return;

    active = false;

    sending = true;



    window.removeEventListener('deviceorientation', onOrientationRoute, true);

    window.removeEventListener('devicemotion', onMotionRoute, true);



    if (ws) {

      ws.onclose = null;

      ws.close();

      ws = null;

    }



    elSetupPanel.classList.remove('hidden');

    elRuntimePanel.classList.remove('show');

    elCfgRow.classList.remove('show');



    showError('');

    setStatus('off', '未连接');

    elPitchDeg.textContent = '—';

    elCcVal.textContent = '—';

    elBar.style.width = '50%';



    F.resetFlipMotion();

    lastSentVal = null;

    lastSentCc = null;

    lastSendTime = 0;

    calibration = null;



    refreshModeSetup();

  }



  function initModeSelect() {
    if (elModeSelect) {
      elModeSelect.addEventListener('change', () => selectMode(elModeSelect.value));
    }
    const urlMode = getModeFromUrl();
    selectMode(urlMode || 'A');
  }



  function init() {

    populateSelects();

    if (!F) {

      elHint.textContent = '校准模块未加载，请刷新页面后重试';

      elBtn.disabled = true;

      return;

    }

    elBtn.disabled = false;

    initModeSelect();

    refreshModeSetup();

    elSelCc.addEventListener('change', onCcChange);

    elSelCh.addEventListener('change', onCcChange);

    elInMin.addEventListener('change', onRangeChange);

    elInMax.addEventListener('change', onRangeChange);

  }



  window.start = start;

  window.returnToSetup = returnToSetup;

  document.addEventListener('visibilitychange', () => {

    if (document.hidden) lastSentVal = null;

    else if (!active) refreshModeSetup();

  });

  window.addEventListener('pageshow', (e) => {

    if (e.persisted) {

      window.location.reload();

      return;

    }

    if (!active) refreshModeSetup();

  });

  window.addEventListener('focus', () => { if (!active) refreshModeSetup(); });

  init();

})();


