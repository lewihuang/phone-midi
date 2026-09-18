// Mode C debug/tuning page. Everything it shows comes from web/vibrato.js, the same module
// the production page runs, so a setting tuned here is a setting the main page can use.
(() => {
  'use strict';

  const V = window.PhoneMidiVibrato;
  const $ = (id) => document.getElementById(id);

  const elStatus = $('status');
  const elErr = $('err');
  const elCents = $('cents');
  const elBar = $('bar');
  const elLive = $('live');
  const elChBody = $('chBody');
  const elCalOut = $('calOut');
  const elDiag = $('diag');
  const elLatHint = $('latHint');
  const btnSensor = $('btnSensor');
  const btnDaw = $('btnDaw');
  const btnCal = $('btnCal');
  const btnReset = $('btnReset');
  const btnClear = $('btnClear');
  const elCh = $('ch');

  if (!V) {
    elErr.textContent = 'vibrato.js 未加载，请刷新';
    return;
  }

  // ── state ───────────────────────────────────────────────────────────────────
  const cfg = {
    hpHz: 1.5, lpHz: 15, nominalCents: 15, kneeCents: 35, capCents: 50, gateCents: 3,
    gateMinSteps: 5, minStepCounts: 4, outputHz: 250, interpolate: true, depthTrim: 1,
    sourceMode: 'auto', axisMode: 'auto', dawBendSemitones: 2, nominalFs: 60,
  };
  let engine = null;
  let timer = null;
  let running = false;
  let calibrating = false;
  let gainMap = null;
  let usableMap = null;
  let calInfo = null;
  let releaseWake = null;
  let ws = null;
  let sendDaw = false;
  let lastRaw = {};
  let pending = null;
  let rafPending = false;

  // ── engine ──────────────────────────────────────────────────────────────────
  function buildEngine() {
    const g = gainMap || (gainMap = V.defaultGains());
    const u = usableMap || (usableMap = V.allUsable());
    engine = V.createEngine(Object.assign({ gains: g, usable: u }, cfg));
  }

  function applyLive() {
    if (engine) engine.setConfig(cfg);
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (running) timer = setInterval(tick, Math.max(4, Math.round(1000 / cfg.outputHz)));
  }

  function motionInput(event) {
    const rr = event.rotationRate;
    const ac = event.acceleration || event.accelerationIncludingGravity;
    return {
      gyro: rr ? [rr.alpha, rr.beta, rr.gamma] : null,
      accel: ac ? [ac.x, ac.y, ac.z] : null,
    };
  }

  function onMotion(event) {
    if (!running) return;
    if (!engine) buildEngine();
    const input = motionInput(event);
    lastRaw = V.normaliseInput(input);
    engine.feed(performance.now() / 1000, input);
  }

  function tick() {
    if (!running || !engine) return;
    const r = engine.tick(performance.now() / 1000);
    if (!r) return;
    if (sendDaw && r.shouldSend) sendValue(r.t);
    pending = r;
    if (!rafPending) { rafPending = true; requestAnimationFrame(flush); }
  }

  function flush() {
    rafPending = false;
    const r = pending;
    pending = null;
    if (!r) return;
    elCents.textContent = (r.cents >= 0 ? '+' : '') + r.cents.toFixed(1);
    elBar.style.width = (r.pb / 16383 * 100).toFixed(1) + '%';
  }

  // ── rendering ───────────────────────────────────────────────────────────────
  function renderTables() {
    const levels = engine ? engine.levels() : {};
    const gains = engine ? engine.getGains() : {};
    const pick = engine && engine.diagnostics().channel;
    const rows = V.CHANNELS.map((c) => {
      const raw = lastRaw[c.id];
      const cents = engine ? engine.channels[c.id].cents : 0;
      const lv = levels[c.id] || 0;
      const usable = usableMap ? usableMap[c.id] !== false : true;
      const cls = c.id === pick ? 'pick' : (usable && lv > 0.5 ? 'live' : 'dead');
      const gain = gains[c.id] || 0;
      return '<tr class="' + cls + '">'
        + '<td>' + c.id + '</td>'
        + '<td style="text-align:left;color:#64748b">' + c.api + '</td>'
        + '<td>' + (raw == null ? '—' : raw.toFixed(1)) + '</td>'
        + '<td>' + (cents >= 0 ? '+' : '') + cents.toFixed(1) + '</td>'
        + '<td>' + lv.toFixed(1) + '</td>'
        + '<td>' + (gain ? gain.toFixed(2) : '—') + '</td>'
        + '<td><span class="tag ' + (usable ? 'ok' : 'no') + '">' + (usable ? '可用' : '不用') + '</span></td>'
        + '</tr>';
    });
    elChBody.innerHTML = rows.join('');

    if (!engine) return;
    const d = engine.diagnostics();
    const depth = Math.min(cfg.capCents, d.amplitudeCents || 0);
    elLive.innerHTML =
      'PB <b>' + (engine.output.last == null ? '—' : Math.round(8192 + engine.output.last * 40.96)) + '</b> · '
      + 'Nuendo 显示 <b>' + (d.amplitudeCents ? (V.centsToDawDisplay(depth, cfg.dawBendSemitones) >= 0 ? '+' : '')
        + V.centsToDawDisplay(depth, cfg.dawBendSemitones).toFixed(1) : '0.0') + '</b> · '
      + '深度 <b>±' + depth.toFixed(1) + '</b> 音分 · 通道 <b>' + (d.channel || '—') + '</b><br>'
      + '门 ' + d.gate.toFixed(2) + ' · 传感器 ' + fmt(d.inputRateHz, 1) + ' Hz · 输出 ' + fmt(d.outputRateHz, 1) + ' Hz';

    elDiag.innerHTML =
      '传感器 <b>' + fmt(d.inputRateHz, 1) + ' Hz</b> · 输出 <b>' + fmt(d.outputRateHz, 1) + ' Hz</b>'
      + '（' + Math.max(4, Math.round(1000 / cfg.outputHz)) + ' ms 定时器）<br>'
      + '通道 <b>' + (d.channel || '—') + '</b> · 换轴 <b>' + d.switches + '</b> · 相位对齐 <b>' + d.realigns + '</b>'
      + ' · 紧急换轴 <b>' + d.urgent + '</b><br>'
      + '插值失败 <b>' + d.linearFallbacks + '</b> · 补零保持 <b>' + d.holdFallbacks + '</b>'
      + '（' + (d.outputUpdates ? (d.holdFallbacks / d.outputUpdates * 100).toFixed(1) : '0.0') + '% 的 tick）<br>'
      + '步进 p95 <b>' + fmt(d.p95StepCents, 2) + '</b> / 峰值 <b>' + fmt(d.maxStepCents, 2) + '</b> 音分'
      + '（' + fmt(d.p95StepCents * 40.96, 0) + ' counts @ 250 Hz）<br>'
      + '手动速率 <b>' + fmt(d.oscHz, 1) + ' Hz</b>（仅显示，不做判定——慢动作也会照样输出）'
      + (d.gate > 0 ? ' · 输出中' : ' · 静止（精确 0，DAW 在中心）') + '<br>'
      + 'gain 来源 <b>' + (calInfo ? '校准' : '估算') + '</b>'
      + (calInfo ? '（' + (calInfo.primary || '?') + ' / ' + fmt(calInfo.rateHz, 2) + ' Hz / ' + fmt(calInfo.fs, 1) + ' Hz 采样）' : '');

    const cascade = cfgPhaseDelay(6);
    elLatHint.textContent = '延迟估算（6 Hz）：采样间隔 ' + fmt(1000 / (cfg.nominalFs || 60), 1)
      + ' ms' + (cfg.interpolate ? '（插值点）' : '（补零保持，约半个采样）')
      + ' + 带通相位 ' + fmt(cascade, 1) + ' ms + 网络 ~2 ms ≈ '
      + fmt((cfg.interpolate ? 1000 / (cfg.nominalFs || 60) + cascade : 500 / (cfg.nominalFs || 60) + cascade) + 2, 1)
      + ' ms 相位延迟；起振到 90% 深度约 120 ms（由 hpHz 决定，调高更快但更易漏入慢速动作）。';
  }

  function fmt(x, d) { return (x == null || !isFinite(x)) ? '—' : x.toFixed(d); }

  /** Analytic phase delay of the bandpass cascade at f, in ms (see the spec). */
  function cfgPhaseDelay(f) {
    const dt = 1 / (cfg.nominalFs || 60);
    const hp = (() => {
      const w0 = 2 * Math.PI * Math.min(cfg.hpHz, 0.45 / dt) * dt;
      const cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * Math.SQRT1_2), a0 = 1 + al;
      const b = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0];
      const a = [1, -2 * cw / a0, (1 - al) / a0];
      const w = 2 * Math.PI * f * dt;
      let nr = 0, ni = 0, dr = 0, di = 0;
      for (let k = 0; k < 3; k++) {
        nr += b[k] * Math.cos(-k * w); ni += b[k] * Math.sin(-k * w);
        dr += a[k] * Math.cos(-k * w); di += a[k] * Math.sin(-k * w);
      }
      return Math.atan2(ni, nr) - Math.atan2(di, dr);
    })();
    const lp = (() => {
      const a = 1 - Math.exp(-2 * Math.PI * Math.min(cfg.lpHz, 0.45 / dt) * dt);
      const w = 2 * Math.PI * f * dt;
      return -Math.atan2(-(1 - a) * Math.sin(-w), 1 - (1 - a) * Math.cos(-w));
    })();
    return -(hp + lp) * 180 / Math.PI / (360 * f) * 1000;
  }

  // ── sensor lifecycle ────────────────────────────────────────────────────────
  function setErr(msg) { elErr.textContent = msg || ''; }

  function setStatus() {
    if (running) {
      elStatus.className = 'status on';
      elStatus.textContent = '● 运行中' + (sendDaw ? ' · 正在发送到 DAW' : '');
    } else {
      elStatus.className = 'status off';
      elStatus.textContent = '● 传感器未启动';
    }
  }

  async function startSensor() {
    try {
      const motion = window.DeviceMotionEvent;
      if (motion && typeof motion.requestPermission === 'function') {
        const res = await motion.requestPermission();
        if (res !== 'granted') { setErr('未授予运动权限'); return; }
      }
    } catch (e) { setErr('权限请求失败：' + (e.message || e)); return; }

    if (!gainMap) loadStoredCalibration();
    buildEngine();
    lastRaw = {};
    running = true;
    btnSensor.textContent = '停止传感器';
    btnSensor.className = 'btn off';
    window.addEventListener('devicemotion', onMotion, true);
    restartTimer();
    if (V.keepAwake) releaseWake = V.keepAwake();
    setStatus();
    setErr('');
  }

  function stopSensor() {
    running = false;
    window.removeEventListener('devicemotion', onMotion, true);
    if (timer) { clearInterval(timer); timer = null; }
    if (releaseWake) { releaseWake(); releaseWake = null; }
    btnSensor.textContent = '启动传感器';
    btnSensor.className = 'btn';
    setStatus();
  }

  btnSensor.addEventListener('click', () => (running ? stopSensor() : startSensor()));
  btnReset.addEventListener('click', () => {
    if (engine) engine.reset();
    lastRaw = {};
    renderTables();
  });

  // ── calibration ─────────────────────────────────────────────────────────────
  function loadStoredCalibration() {
    calInfo = V.loadCalibration();
    if (calInfo && calInfo.ok) {
      gainMap = calInfo.gains;
      usableMap = calInfo.usable;
      if (calInfo.fs > 10 && calInfo.fs < 400) cfg.nominalFs = Math.round(calInfo.fs);
      renderCal();
      return true;
    }
    calInfo = null;
    renderCal();
    return false;
  }

  function renderCal() {
    if (!calInfo) {
      elCalOut.innerHTML = '尚未校准：当前用估算 gain（正常揉弦 ≈ ±' + cfg.nominalCents + ' 音分）。'
        + '<br><span style="color:#64748b">点上面的「校准」录 5 秒你自己的揉弦即可。</span>';
      return;
    }
    const rows = V.CHANNEL_IDS.map((id) => {
      const lv = (calInfo.levels && calInfo.levels[id]) || 0;
      if (!lv) return null;
      const ok = calInfo.usable && calInfo.usable[id];
      return '<tr class="' + (ok ? 'live' : 'dead') + '">'
        + '<td>' + id + '</td><td>' + lv.toFixed(2) + '</td><td>'
        + (calInfo.gains[id] ? calInfo.gains[id].toFixed(3) : '—') + '</td><td>'
        + '<span class="tag ' + (ok ? 'ok' : 'no') + '">' + (ok ? '可用' : '不用') + '</span></td></tr>';
    }).filter(Boolean).join('');
    elCalOut.innerHTML =
      '来源 <b>' + (calInfo.source || '?') + '</b> · 主通道 <b>' + (calInfo.primary || '?') + '</b> · 揉弦 '
      + fmt(calInfo.rateHz, 2) + ' Hz · 采样 ' + fmt(calInfo.fs, 1) + ' Hz · 时长 ' + fmt(calInfo.spanSec, 1) + ' s'
      + ' · 保存于 ' + (calInfo.savedAt || '').slice(0, 16).replace('T', ' ')
      + (calInfo.rescaledFrom ? ' · <span style="color:#fcd34d">已按新标称深度（'
        + calInfo.rescaledFrom + ' → ' + cfg.nominalCents + ' 音分）自动缩放 gain</span>' : '')
      + '<table style="margin-top:8px"><thead><tr><th>通道</th><th>电平(音分)</th><th>gain</th><th>状态</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<span style="color:#64748b">校准后：正常揉弦 = ±' + (cfg.nominalCents * cfg.depthTrim).toFixed(1)
      + ' 音分（倍率 ×' + cfg.depthTrim.toFixed(2) + '，上限 ±' + (cfg.capCents * cfg.depthTrim).toFixed(0) + '）。</span>';
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function runCalibration() {
    if (calibrating) return;
    if (!running) { setErr('请先启动传感器'); return; }
    calibrating = true;
    btnCal.disabled = true;
    const cap = [];
    const t0 = performance.now();
    const onCap = (e) => {
      cap.push(Object.assign({ t: (performance.now() - t0) / 1000 }, motionInput(e)));
    };
    window.addEventListener('devicemotion', onCap, true);
    const total = V.DEFAULTS.calibSec;
    for (let i = 0; i < total * 2; i++) {
      await sleep(500);
      btnCal.textContent = '录音中… ' + Math.min(total, (i + 1) * 0.5).toFixed(1) + ' / ' + total + ' s（正常揉弦）';
    }
    window.removeEventListener('devicemotion', onCap, true);
    calibrating = false;
    btnCal.disabled = false;
    btnCal.textContent = '校准：录 5 秒揉弦';

    const cal = V.calibrate(cap);
    if (!cal.ok) {
      const why = { too_short: '录音太短（至少 ' + V.DEFAULTS.calibMinSec + ' 秒）',
        too_quiet: '没检测到揉弦动作：请对着手机做明显的揉弦',
        rate: '揉弦频率不合适（' + V.DEFAULTS.calibRateMinHz + '–' + V.DEFAULTS.calibRateMaxHz + ' Hz）：'
          + '太快/太慢，或匀速晃动被当成揉弦' }[cal.reason] || cal.reason;
      setErr('校准失败：' + why + '（本次 ' + cal.samples + ' 个采样 / ' + fmt(cal.spanSec, 1) + ' s）');
      return;
    }
    gainMap = cal.gains;
    usableMap = cal.usable;
    if (cal.fs > 10 && cal.fs < 400) cfg.nominalFs = Math.round(cal.fs);
    V.saveCalibration(cal);
    calInfo = V.loadCalibration();
    buildEngine();
    renderCal();
    renderTables();
    setErr('');
    elStatus.className = 'status on';
  }

  btnCal.addEventListener('click', runCalibration);
  btnClear.addEventListener('click', () => {
    V.clearCalibration();
    calInfo = null;
    gainMap = V.defaultGains();
    usableMap = V.allUsable();
    buildEngine();
    renderCal();
    renderTables();
  });

  // ── DAW output ──────────────────────────────────────────────────────────────
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      send({ type: 'set_source', sensor: 'motion', axis: 'fused_vibrato' });
      send({ type: 'set_range', in_min: 0, in_max: 1 });
      send({ type: 'set_target', channel: parseInt(elCh.value, 10) });
      setStatus();
    };
    ws.onclose = () => {
      ws = null;
      if (sendDaw) setTimeout(connect, 1500);
      setStatus();
    };
    ws.onerror = () => {};
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendValue(t) {
    send({ sensor: 'motion', axis: 'fused_vibrato', value: t, kind: 'pb', value_kind: 'bipolar' });
  }

  function toggleDaw() {
    sendDaw = !sendDaw;
    btnDaw.textContent = '发送到 DAW：' + (sendDaw ? '开' : '关');
    btnDaw.className = 'btn ' + (sendDaw ? 'on' : 'off');
    if (sendDaw) {
      if (!running) startSensor();
      connect();
    } else if (ws) {
      ws.close();
      ws = null;
    }
    setStatus();
  }

  btnDaw.addEventListener('click', toggleDaw);
  elCh.addEventListener('change', () => send({ type: 'set_target', channel: parseInt(elCh.value, 10) }));

  // ── controls ────────────────────────────────────────────────────────────────
  const SLIDERS = [
    { k: 'depthTrim', label: '深度倍率（整体缩放输出）', min: 0.25, max: 2, step: 0.05, save: true,
      note: '0.5 = 整体减半，连上限一起缩到 ±25 音分；不影响静止静默与门限。' },
    { k: 'hpHz', label: '高通 hpHz', min: 0.5, max: 6, step: 0.1, rebuild: true,
      note: '去掉重力、零偏和慢速晃动。调高更跟手，但 2–3 Hz 的慢动作会漏进来。' },
    { k: 'lpHz', label: '低通 lpHz', min: 5, max: 40, step: 1, rebuild: true,
      note: '限制带宽，给插值器用。' },
    { k: 'kneeCents', label: '线性区上限 knee', min: 10, max: 120, step: 1,
      note: '低于 knee 严格线性（力度比例）；之上平滑压缩到 cap。' },
    { k: 'capCents', label: '硬上限 cap', min: 20, max: 200, step: 1,
      note: '任何动作都不会超过这个音分数。' },
    { k: 'gateCents', label: '静音门限', min: 0.5, max: 20, step: 0.5,
      note: '幅度低于它视为没在揉弦：输出严格为 0，不发送任何消息。' },
    { k: 'gateMinSteps', label: '门限斜坡步数', min: 2, max: 10, step: 1,
      note: '开/关门时至少这么多步（按传感器采样率量化），避免幅度台阶。' },
    { k: 'minStepCounts', label: '最小发送步进（counts）', min: 1, max: 40, step: 1,
      note: '14 位弯音；小于它就不发，避免重复消息。' },
    { k: 'outputHz', label: '输出频率 Hz', min: 60, max: 250, step: 10, timer: true,
      note: '浏览器定时器下限 4 ms = 250 Hz。' },
  ];

  const slWrap = $('sliders');
  for (const s of SLIDERS) {
    const div = document.createElement('div');
    div.className = 'sl';
    div.innerHTML = '<div class="sl-head"><span>' + s.label + '</span><b id="v-' + s.k + '">' + cfg[s.k] + '</b></div>'
      + '<input type="range" id="r-' + s.k + '" min="' + s.min + '" max="' + s.max + '" step="' + s.step + '" value="' + cfg[s.k] + '">'
      + (s.note ? '<div class="sl-note">' + s.note + '</div>' : '');
    slWrap.appendChild(div);
    const range = div.querySelector('input');
    range.addEventListener('input', () => {
      cfg[s.k] = parseFloat(range.value);
      $('v-' + s.k).textContent = range.value;
      if (s.rebuild) buildEngine();
      else applyLive();
      if (s.timer) restartTimer();
      if (s.save) { V.saveSettings({ depthTrim: cfg.depthTrim }); renderTables(); }
    });
  }

  function segment(host, label, options, get, set) {
    const el = $(host);
    el.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      if (o.value === get()) b.className = 'sel';
      b.addEventListener('click', () => {
        set(o.value);
        Array.from(el.children).forEach((c) => { c.className = ''; });
        b.className = 'sel';
      });
      el.appendChild(b);
    }
  }

  segment('segSrc', 'source', [
    { value: 'auto', label: '源：自动' }, { value: 'gyro', label: '只用陀螺' }, { value: 'accel', label: '只用加速度' },
  ], () => cfg.sourceMode, (v) => { cfg.sourceMode = v; applyLive(); });

  segment('segAxis', 'axis', [
    { value: 'auto', label: '轴：自动' }, { value: 'x', label: 'x' }, { value: 'y', label: 'y' }, { value: 'z', label: 'z' },
  ], () => cfg.axisMode, (v) => { cfg.axisMode = v; applyLive(); });

  segment('segInterp', 'interp', [
    { value: true, label: '插值：开（250 Hz 平滑）' }, { value: false, label: '插值：关（少 ~8 ms）' },
  ], () => cfg.interpolate, (v) => { cfg.interpolate = v; applyLive(); renderTables(); });

  const elSem = $('sem');
  elSem.addEventListener('input', () => {
    cfg.dawBendSemitones = parseInt(elSem.value, 10);
    $('semV').textContent = elSem.value;
    applyLive();
    renderTables();
  });

  // ── boot ────────────────────────────────────────────────────────────────────
  cfg.nominalFs = V.DEFAULTS.nominalFs;
  Object.assign(cfg, V.loadSettings());          // depth trim chosen on either page
  loadStoredCalibration();
  buildEngine();
  renderTables();
  setStatus();
  setInterval(() => { if (running) renderTables(); }, 250);
})();
