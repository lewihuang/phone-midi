// Phone MIDI CC — Web Client

// Mode A: fused lift  /  Mode B: fused flip  /  Mode C: vibrato pitch bend



(() => {

  'use strict';



  const F = window.PhoneMidiFusion;

  // Mode C's DSP: 6-channel bandpass → channel selector → gate → 250 Hz interpolated output.
  const V = window.PhoneMidiVibrato;



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

  const elInDepth = document.getElementById('inDepth');

  const elModeNote = document.getElementById('modeNote');



  const MODES = {

    A: {

      id: 'A',

      name: '抬手推子',

      sensor: 'rotation_vector',

      axis: 'fused_lift',

      kind: 'cc',

      valueKind: 'unipolar',

      profile: 'lift',

      unit: 'CC',

      label: 'Lift',

      desc: '自然垂手 ↔ 抬手最高 → CC 0–127',
      calibrateHref: '/calibrate-lift.html',
      calibrateLabel: '校准抬手范围',

      inputMin: 0,

      inputMax: 1,

      fused: true,

      calMode: 'required',

    },

    B: {

      id: 'B',

      name: '翻转推子',

      sensor: 'rotation_vector',

      axis: 'fused_flip',

      kind: 'cc',

      valueKind: 'unipolar',

      profile: 'flip',

      unit: 'CC',

      label: 'Flip',

      desc: '固定肘部，翻转手掌 → CC 0–127',
      calibrateHref: '/calibrate-flip.html',
      calibrateLabel: '校准翻转范围',

      inputMin: 0,

      inputMax: 1,

      fused: true,

      calMode: 'required',

    },

    C: {

      id: 'C',

      name: '摇晃弯音',

      sensor: 'accelerometer',

      // The committed, working Mode C: the phone's *gravity-removed* linear acceleration on
      // one axis, mapped linearly onto the bend range. No filter, no auto-zero, no gate, no
      // calibration — and it needs none of them, because `event.acceleration` is already 0
      // when the phone is at rest: the centre is structural, and at a ±40 m/s² range sensor
      // noise and hand tremor are ~0.1% of full scale. (A 1000-line rotational "vibrato"
      // engine replaced this and broke exactly that property; see the changelog.)
      axis: 'x',

      kind: 'pb',

      valueKind: 'bipolar',

      unit: 'm/s²',

      label: '加速度',

      desc: '手持摇晃 → 弯音；静止时加速度天然为 0，所以精确回中（无需校准，范围可调）',

      inputMin: -40,

      inputMax: 40,

      pb: true,

      // No filtering in the phone and none needed in the Bridge: every sensor event is sent.
      calMode: 'none',

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

  const SEND_THRESHOLD = { A: 0.008, B: 0.008, C: 0.2 };

  // Hard floor only, to protect against pathological sensor rates (>250 Hz).

  // Deliberately NOT the old 16 ms leading-edge gate: that gate dropped the

  // event outright and never re-sent the latest value, capping updates at ~60 Hz

  // and adding up to 16 ms on top of the sensor interval.

  const MIN_SEND_INTERVAL_MS = 4;

  let lastSendTime = 0;

  let lastSentPb = null;

  let calibCache = { modeId: null, profile: null, data: null, ok: false };

  let pendingDisplay = null;

  let displayRafPending = false;



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
    invalidateCalibration();
    invalidateVibratoCalibration();
    const m = MODES[selectedMode];
    if (m && m.calMode !== 'none' && m.profile && !m.vibrato) {
      F.consumeJustSavedFlag(m.profile);
    }
    applyModeSetupUi(selectedMode);
    updateStartButtonLabel();
  }

  /** Mode C keeps its calibration under its own key, not in fusion.js's profiles. */
  function hasModeCalibration(m) {
    if (!m) return false;
    if (m.vibrato) return vibratoCalOk();
    return !!(F && m.profile && F.hasCalibration(m.profile));
  }

  function applyModeSetupUi(modeId) {
    const m = MODES[modeId];
    if (!m) return;
    if (elModeSelect) elModeSelect.value = modeId;
    if (elModeDesc) elModeDesc.textContent = m.desc;
    if (!elCalRow) return;
    if (m.calMode !== 'none' && m.calibrateHref) {
      elCalRow.classList.remove('hidden');
      if (elCalLink) {
        elCalLink.href = m.calibrateHref;
        elCalLink.textContent = m.calibrateLabel || '去校准';
      }
      const ok = hasModeCalibration(m);
      if (elCalBadge) {
        // Mode C works uncalibrated with approximate gains, so "未校准" alone would read
        // as "broken". Say which of the two states it is in.
        const optional = m.calMode === 'optional';
        elCalBadge.textContent = ok ? '已校准' : (optional ? '默认力度' : '未校准');
        elCalBadge.className = 'cal-badge ' + (ok || optional ? 'ok' : 'warn');
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

    if (m.calMode === 'required' && !hasModeCalibration(m)) {

      elHint.textContent = m.name + ' 尚未校准，可先校准或启动后仅预览（不发送有效 CC）';

    } else if (m.calMode === 'required') {

      elHint.textContent = '点击启动传感器；请先完成上方校准';

    } else if (m.calMode === 'optional' && !hasModeCalibration(m)) {

      elHint.textContent = m.vibrato
        ? '点击启动；力度是估算值（去「力度校准」用你自己的揉弦定标更准）'
        : '点击启动传感器；力度刻度是固定值（想按自己的力度精调可先校准）';

    } else {

      elHint.textContent = '点击启动传感器';

    }

  }



  function setStatus(type, text) {

    elStatus.textContent = text;

    elStatus.className = 'status ' + type;

  }



  function showError(msg) {

    const text = msg || '';

    // Called on every sensor event — skip the DOM write when nothing changed.

    if (elError.textContent === text) return;

    elError.textContent = text;

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



  /** Calibration is read once per mode, not once per sensor event. */

  function ensureCalibration(mode) {

    if (!mode || !mode.profile) return null;

    if (calibCache.modeId === mode.id && calibCache.profile === mode.profile) return calibCache;

    const data = F.loadCalibration(mode.profile);

    calibCache = { modeId: mode.id, profile: mode.profile, data: data, ok: !!data };

    return calibCache;

  }



  function invalidateCalibration() {

    calibCache = { modeId: null, profile: null, data: null, ok: false };

  }



  /** UI writes are batched to one paint per frame; sends stay per event. */

  function requestDisplayFlush() {

    if (displayRafPending) return;

    displayRafPending = true;

    requestAnimationFrame(flushDisplay);

  }



  function flushDisplay() {

    displayRafPending = false;

    const p = pendingDisplay;

    pendingDisplay = null;

    if (!p) return;

    if (p.kind === 'fused') updateFusedCcDisplay(p.value);

    else if (p.kind === 'vibrato') { updateVibratoDisplay(p.value); updateVibratoNote(p.value); }

    else updateDisplay(p.value, false);

  }



  function scheduleFusedDisplay(t) {

    pendingDisplay = { kind: 'fused', value: t };

    requestDisplayFlush();

  }



  function scheduleRawDisplay(v) {

    pendingDisplay = { kind: 'raw', value: v };

    requestDisplayFlush();

  }



  function scheduleVibratoDisplay(r) {

    pendingDisplay = { kind: 'vibrato', value: r };

    requestDisplayFlush();

  }



  let _pbTag = '';

  let _noteAt = 0;



  /** Cents → the centred bar + big number used for Mode C. */
  function updateVibratoDisplay(r) {

    if (!r) return;

    elPitchDeg.textContent = (r.cents >= 0 ? '+' : '') + r.cents.toFixed(1);

    elCcVal.textContent = String(r.pb);

    elBar.style.width = (r.pb / 16383 * 100).toFixed(1) + '%';

    const tag = 'Pitch Bend Ch' + (parseInt(elSelCh.value, 10) + 1);

    if (tag !== _pbTag) {

      _pbTag = tag;

      elCcTag.textContent = tag;

    }

  }



  /** Mode C status line: which axis, how deep the vibrato is, and how it was set. */
  function updateVibratoNote(r) {

    if (!elModeNote || !r) return;

    const now = performance.now();

    if (now - _noteAt < 250) return;

    _noteAt = now;

    const d = vibEngine ? vibEngine.diagnostics() : null;

    const depth = Math.min(V.DEFAULTS.capCents, (d && d.amplitudeCents) || 0);

    const daw = Math.abs(V.centsToDawDisplay(depth, V.DEFAULTS.dawBendSemitones));

    const parts = [

      '轴 ' + ((d && d.channel) || '—'),

      '深度 ±' + depth.toFixed(1) + ' 音分（Nuendo ±' + daw.toFixed(1) + '）',

      vibratoCalOk() ? '已校准' : '默认力度（未校准）',

    ];

    const trim = vibratoSettings().depthTrim;

    if (Math.abs(trim - 1) > 0.001) parts.push('倍率 ×' + trim.toFixed(2));

    if (d && d.fading) parts.push('换轴中');

    if (r.shouldSend === false) parts.push('已到量化下限');

    elModeNote.textContent = parts.join(' · ');

  }



  function syncBridgeFromRuntime() {

    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;

    const m = MODES[currentMode];

    if (!m) return;

    sendMessage({ type: 'set_source', sensor: m.sensor, axis: m.axis });

    sendMessage({ type: 'set_range', in_min: m.inputMin, in_max: m.inputMax });

    // Target type is declared on every value message (ADR 0003); this only tells the
    // Bridge which channel to use, and the CC number when the target really is a CC.
    const target = { type: 'set_target', channel: parseInt(elSelCh.value, 10) };

    if (!m.pb) target.cc = parseInt(elSelCc.value, 10);

    sendMessage(target);

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



  function emitValue(val) {

    if (!sending) return false;

    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const thresh = SEND_THRESHOLD[currentMode] || 0.3;

    if (lastSentVal !== null && Math.abs(val - lastSentVal) < thresh) return false;

    const now = performance.now();

    if (now - lastSendTime < MIN_SEND_INTERVAL_MS) return false;

    lastSendTime = now;

    lastSentVal = val;

    const m = MODES[currentMode];

    sendMessage({ sensor: m.sensor, axis: m.axis, value: val, kind: m.kind, value_kind: m.valueKind });

    return true;

  }



  /**

   * Mode C send path. The DSP already decided whether a message is worth sending

   * (`shouldSend`, gated on 4 of 16384 counts of pitch change), so there is no extra

   * throttle here — 250 Hz of 14-bit updates is exactly the point of the design.

   */

  function sendVibratoPb(r) {

    if (!r || !r.shouldSend) return false;

    if (!sending) return false;

    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const m = MODES[currentMode];

    lastSendTime = performance.now();

    lastSentVal = r.t;

    lastSentPb = r.pb;

    // The phone predicts the counts for its own display/diagnostics; the Bridge maps

    // t∈[0,1] onto the full 14-bit bend, so both agree by construction.

    sendMessage({

      sensor: m.sensor,

      axis: m.axis,

      value: r.t,

      kind: m.kind,

      value_kind: m.valueKind,

    });

    return true;

  }



  /**
   * Centre the bend right now. A page that becomes hidden or is being unloaded stops
   * delivering sensor events and its timers are throttled, so the engine would never get to
   * send the centring message — and a MIDI pitch bend is absolute state: the DAW would sit
   * on the last value for ever. The Bridge has a dead-man timer for the same reason; this
   * just makes it immediate.
   */
  function centrePitchBendNow() {
    if (!active || currentMode !== 'C' || !sending) return;
    if (vibEngine) vibEngine.output.reset();
    sendMessage({ sensor: 'motion', axis: 'fused_vibrato', value: 0.5, kind: 'pb', value_kind: 'bipolar' });
    lastSentPb = 8192;
  }

  // ── Mode C runtime: devicemotion in, 250 Hz interpolated pitch bend out ─────

  let vibEngine = null;

  let vibTimer = null;

  let vibCal = null;

  let vibCalLoaded = false;

  let vibSettings = null;

  let releaseWakeLock = null;

  // The browser timer floor is 4 ms; the sensor runs at ~60 Hz, so the interpolator is

  // what turns 60 Hz of new information into a 250 Hz, click-free bend lane.

  const VIB_TICK_MS = 4;



  function vibratoCalibration() {

    if (!vibCalLoaded) {

      vibCal = V.loadCalibration();

      vibCalLoaded = true;

    }

    return vibCal;

  }



  function vibratoCalOk() {

    const c = vibratoCalibration();

    return !!(V && c && c.ok);

  }



  function invalidateVibratoCalibration() {

    vibCalLoaded = false;

    vibCal = null;

  }



  /** Player-facing settings (currently just the depth trim), read once and cached. */
  function vibratoSettings() {
    if (!vibSettings) vibSettings = V.loadSettings ? V.loadSettings() : { depthTrim: 1 };
    return vibSettings;
  }

  function setDepthTrim(v) {
    const s = vibratoSettings();
    s.depthTrim = v;
    if (V.saveSettings) V.saveSettings(s);
    if (vibEngine) vibEngine.setConfig({ depthTrim: v });
    if (elInDepth) elInDepth.value = String(v);
  }

  /** Builds (or rebuilds) the engine from the stored calibration, if any. */

  function vibratoEngine() {

    if (vibEngine) return vibEngine;

    if (!V) return null;

    const cal = vibratoCalibration();

    const opts = {

      gains: vibratoCalOk() ? cal.gains : V.defaultGains(),

      usable: vibratoCalOk() ? cal.usable : V.allUsable(),

      depthTrim: vibratoSettings().depthTrim,

    };

    // Only override the nominal rate when the calibration actually measured one.

    if (vibratoCalOk() && cal.fs > 10 && cal.fs < 400) opts.nominalFs = Math.round(cal.fs);

    vibEngine = V.createEngine(opts);

    return vibEngine;

  }



  function resetVibratoRuntime() {

    if (vibEngine) vibEngine.reset();

  }



  function startVibratoLoop() {

    stopVibratoLoop();

    vibTimer = setInterval(vibratoTick, VIB_TICK_MS);

  }



  function stopVibratoLoop() {

    if (vibTimer) { clearInterval(vibTimer); vibTimer = null; }

  }



  function vibratoTick() {

    if (!active || currentMode !== 'C') return;

    const eng = vibEngine;

    if (!eng) return;

    // performance.now() is the same clock the sensor events are stamped with, so the

    // interpolator's one-sample delay is exact.

    const r = eng.tick(performance.now() / 1000);

    if (!r) return;

    scheduleVibratoDisplay(r);

    sendVibratoPb(r);

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

    // The channel selector stays available for pitch bend too (a bend can be aimed at
    // any channel); only the CC number is meaningless there.
    document.querySelectorAll('#cfgRow .ch-cfg').forEach(el => {

      el.style.display = '';

    });

    if (elModeNote) elModeNote.style.display = m.vibrato ? '' : 'none';

    document.querySelectorAll('#cfgRow .depth-cfg').forEach(el => {

      el.style.display = m.vibrato ? '' : 'none';

    });

    if (m.vibrato && elInDepth) elInDepth.value = String(vibratoSettings().depthTrim);

  }



  function setMode(mode) {

    currentMode = mode;

    const m = MODES[mode];

    applyModeUi(mode);

    lastSentVal = null;

    lastSentPb = null;

    if (m.vibrato) {

      resetVibratoRuntime();

      if (active) startVibratoLoop();

    } else {

      stopVibratoLoop();

    }



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

  }

  window.toggleSend = toggleSend;



  function handleFusedOrientation(event, modeId) {

    if (!active || currentMode !== modeId) return;

    if (event.beta == null) return;



    const m = MODES[modeId];

    const cached = ensureCalibration(m);

    calibration = cached.data;



    if (!calibration) {

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



    scheduleFusedDisplay(t);

    showError('');



    emitValue(t);

  }



  /**
   * Mode B, deliberately the same shape as Mode A above: attitude → projection → emitValue.
   * The gravity vector is derived from (beta, gamma) inside fusion.js, so nothing between the
   * hand and the CC value filters, averages, or delays — the previous boxcar + One Euro chain
   * that Mode B used to run here is what made it feel a beat behind Mode A.
   */
  function handleFusedFlip(event, modeId) {

    if (!active || currentMode !== modeId) return;

    if (event.beta == null || event.gamma == null) return;



    const m = MODES[modeId];

    const cached = ensureCalibration(m);

    calibration = cached.data;



    if (!calibration) {

      showError('请先校准' + m.name);

      return;

    }



    const out = F.feedFlipOrientation(

      event.beta,

      event.gamma,

      calibration.anchors,

      calibration.fusion || F.DEFAULT_FUSION,

    );

    if (!out) return;



    const t = out.t;

    scheduleFusedDisplay(t);

    showError('');



    emitValue(t);

  }



  function onMotion(event) {

    if (!active || currentMode !== 'C') return;

    // Mode C as committed and known to work: one *gravity-removed* acceleration axis, mapped
    // linearly onto the bend range by the Bridge. At rest `acceleration` is 0, so the bend is
    // centred by physics — there is nothing to auto-zero, filter, gate or calibrate, and at a
    // ±40 m/s² range tremor and sensor noise sit ~0.1% below full scale.
    //
    // The one thing that *was* wrong here: a 16 ms leading-edge gate that dropped every event
    // inside the window instead of re-sending the latest value, which capped updates at ~60 Hz
    // and added up to 16 ms on top of the sensor interval. `emitValue` now applies only a
    // change threshold plus a 4 ms floor, so every changed sensor event reaches the DAW.
    const acc = event.acceleration || event.accelerationIncludingGravity;

    if (!acc || acc.x == null) return;

    scheduleRawDisplay(acc.x);

    showError('');

    emitValue(acc.x);

  }



  function onOrientationRoute(event) {

    if (!active) return;

    if (currentMode === 'A') handleFusedOrientation(event, 'A');

    else if (currentMode === 'B') handleFusedFlip(event, 'B');

  }



  function onMotionRoute(event) {

    if (!active) return;

    if (currentMode === 'C') onMotion(event);

  }



  async function start() {

    try {

      await F.requestOrientationPermission();

      // Only Mode C reads devicemotion. Mode B now derives gravity from the attitude, so it
      // asks for exactly what Mode A asks for.
      if (selectedMode === 'C') {

        await F.requestMotionPermission();

      }

    } catch (e) {

      showError(e.message || '权限请求失败');

      return;

    }



    const m = MODES[selectedMode];

    if (m.calMode === 'required' && !hasModeCalibration(m)) {

      showError(m.name + ' 尚未校准，请返回完成校准');

    }



    active = true;

    sending = true;

    currentMode = selectedMode;

    invalidateCalibration();



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



    invalidateVibratoCalibration();

    vibEngine = null;

    resetVibratoRuntime();

    if (m.vibrato) startVibratoLoop();

    // Every mode benefits: a phone that blanks its screen stops delivering sensor events.
    if (V && V.keepAwake) releaseWakeLock = V.keepAwake();

    lastSentVal = null;

    lastSentPb = null;

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



    stopVibratoLoop();

    if (releaseWakeLock) { releaseWakeLock(); releaseWakeLock = null; }

    resetVibratoRuntime();

    lastSentVal = null;

    lastSentPb = null;

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

    if (elInDepth) {

      elInDepth.addEventListener('change', () => {

        const v = parseFloat(elInDepth.value);

        if (isNaN(v) || v < 0.25 || v > 2) { elInDepth.value = String(vibratoSettings().depthTrim); return; }

        setDepthTrim(v);

      });

    }

  }



  window.start = start;

  window.returnToSetup = returnToSetup;

  document.addEventListener('visibilitychange', () => {

    if (document.hidden) { centrePitchBendNow(); lastSentVal = null; }

    else if (!active) refreshModeSetup();

  });

  window.addEventListener('pagehide', centrePitchBendNow);

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


