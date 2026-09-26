// Phone MIDI CC — on-device latency diagnosis
//
// Answers "is the lag the platform or the code?" by measuring, on the real
// phone, the stages that add up to hand-feel latency:
//   ① sensor event rate        -> platform floor, cannot be beaten by JS
//   ② main-thread queue delay  -> code cost (per-event work, jank)
//   ③ network RTT to the Bridge
//   ④ the production Mode B chain (feedFlipOrientation), which is now stateless: the
//      attitude projection *is* the sent value. What is measured is (a) the delay the
//      send-side threshold adds between the projection crossing t=0.5 and the value
//      actually leaving the phone, and (b) how far the accelerometer's gravity direction
//      drifts from the attitude's while the hand moves — the contamination that the old
//      filter chain could not remove and that this page exists to show.
//
// Does not open a WebSocket and never sends MIDI.

(() => {
  'use strict';

  const F = window.PhoneMidiFusion;

  const elErr = document.getElementById('err');
  const elBtnStart = document.getElementById('btnStart');

  const elRateOri = document.getElementById('rateOri');
  const elRateOriIv = document.getElementById('rateOriIv');
  const elRateMot = document.getElementById('rateMot');
  const elRateMotIv = document.getElementById('rateMotIv');

  const elQueueDelay = document.getElementById('queueDelay');
  const elFps = document.getElementById('fps');
  const elLongestFrame = document.getElementById('longestFrame');
  const elJankCount = document.getElementById('jankCount');
  const elStorageCost = document.getElementById('storageCost');
  const elBtnStorage = document.getElementById('btnStorage');

  const elRtt = document.getElementById('rtt');
  const elBtnRtt = document.getElementById('btnRtt');

  const elLagMeasured = document.getElementById('lagMeasured');
  const elLagSamples = document.getElementById('lagSamples');
  const elDriftMeasured = document.getElementById('driftMeasured');
  const elDriftSamples = document.getElementById('driftSamples');
  const elAnchorSrc = document.getElementById('anchorSrc');
  const elBarAtt = document.getElementById('barAtt');
  const elNumAtt = document.getElementById('numAtt');
  const elBarAcc = document.getElementById('barAcc');
  const elNumAcc = document.getElementById('numAcc');

  const elVerdict = document.getElementById('verdict');

  const elVibApi = document.getElementById('vibApi');
  const elVibSecure = document.getElementById('vibSecure');
  const elVibResult = document.getElementById('vibResult');

  let running = false;
  let anchors = null;
  let anchorSource = '—';
  const fusion = F ? F.DEFAULT_FUSION : null;

  // ── helpers ────────────────────────────────────────────────────────────────

  function showError(msg) {
    const text = msg || '';
    if (elErr.textContent === text) return;
    elErr.textContent = text;
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.floor(s.length * p));
    return s[i];
  }

  function fmtMs(v, digits) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits == null ? 1 : digits) + ' ms';
  }

  function setVerdictClass(el, rating) {
    el.className = 'v' + (rating ? ' ' + rating : '');
  }

  // ── ① sensor rate + ② queue delay ─────────────────────────────────────────

  function makeTracker() {
    return { last: null, intervals: [], queue: [], count: 0, t0: performance.now() };
  }

  const oriTracker = makeTracker();
  const motTracker = makeTracker();

  function track(tracker, ev) {
    const now = performance.now();
    if (tracker.last != null) {
      const d = now - tracker.last;
      if (d > 0 && d < 2000) tracker.intervals.push(d);
    }
    tracker.last = now;
    tracker.count++;
    if (typeof ev.timeStamp === 'number' && ev.timeStamp > 0) {
      const q = now - ev.timeStamp;
      if (q >= 0 && q < 2000) tracker.queue.push(q);
    }
  }

  function drain(tracker) {
    const now = performance.now();
    const spanMs = now - tracker.t0;
    const out = {
      hz: spanMs > 0 ? (tracker.count / spanMs) * 1000 : 0,
      p50: percentile(tracker.intervals, 0.5),
      p95: percentile(tracker.intervals, 0.95),
      q50: percentile(tracker.queue, 0.5),
      q95: percentile(tracker.queue, 0.95),
    };
    tracker.intervals = [];
    tracker.queue = [];
    tracker.count = 0;
    tracker.t0 = now;
    tracker.last = null;
    return out;
  }

  // ── frame monitor ─────────────────────────────────────────────────────────

  const frames = { last: null, log: [] };

  function frameLoop(ts) {
    if (frames.last != null) {
      const d = ts - frames.last;
      if (d > 0 && d < 5000) frames.log.push({ ts, d });
    }
    frames.last = ts;
    const cutoff = ts - 3000;
    while (frames.log.length && frames.log[0].ts < cutoff) frames.log.shift();
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  // ── ④ production Mode B chain ─────────────────────────────────────────────
  //
  // Mode B is stateless now: t = projection(gravityFromOrientation(beta, gamma)). The only
  // thing between that value and the wire is the send-side change threshold in app.js, so
  // that — not a filter — is what gets measured here. The accelerometer's own gravity
  // projection is computed alongside purely to quantify the contamination the attitude
  // source avoids.

  const SEND_THRESHOLD = 0.008;   // must match app.js SEND_THRESHOLD.B
  const MIN_SEND_INTERVAL_MS = 4; // must match app.js

  const lag = {
    samples: [],
    drift: [],
    prevT: null,
    armedForRise: false,
    projCrossAt: null,
    lastSent: null,
    lastSentAt: -1e9,
  };

  /** Replicates app.js's emitValue gate: threshold + 4 ms floor, drops nothing else. */
  function wouldSend(t, now) {
    if (lag.lastSent !== null && Math.abs(t - lag.lastSent) < SEND_THRESHOLD) return false;
    if (now - lag.lastSentAt < MIN_SEND_INTERVAL_MS) return false;
    lag.lastSent = t;
    lag.lastSentAt = now;
    return true;
  }

  function feedAndMeasure(e) {
    if (!anchors) return null;
    const out = F.feedFlipOrientation(e.beta, e.gamma, anchors, fusion);
    if (!out) return null;
    const now = performance.now();

    // (a) projection crossing t=0.5 -> the value that actually leaves the phone.
    if (out.t < 0.35) {
      lag.armedForRise = true;
      lag.projCrossAt = null;
    }
    if (lag.armedForRise && lag.projCrossAt == null && out.t >= 0.5
        && lag.prevT != null && out.t > lag.prevT) {
      lag.projCrossAt = now;
    } else if (lag.armedForRise && lag.projCrossAt != null) {
      if (wouldSend(out.t, now) && out.t >= 0.5) {
        const d = now - lag.projCrossAt;
        if (d >= 0 && d < 2000) {
          lag.samples.push(d);
          if (lag.samples.length > 60) lag.samples.shift();
        }
        lag.armedForRise = false;
        lag.projCrossAt = null;
      }
    }
    lag.prevT = out.t;
    return out;
  }

  /** |attitude t - accelerometer t| in CC steps, sampled while the hand moves. */
  function measureAccelDrift(e, tAtt) {
    if (!anchors || tAtt == null) return;
    const acc = e.accelerationIncludingGravity || e.acceleration;
    if (!acc || acc.x == null) return;
    const tAcc = F.computeGravityFusedT(acc.x, acc.y, acc.z, anchors, fusion);
    if (tAcc == null) return;
    const d = Math.abs(tAcc - tAtt) * 127;
    if (d <= 127) {
      lag.drift.push(d);
      if (lag.drift.length > 400) lag.drift.shift();
    }
  }

  function resolveAnchors() {
    const cal = F.loadCalibration('flip');
    if (cal && F.gravityAnchorsReady(cal.anchors)) {
      anchorSource = '已校准（Mode B）';
      return cal.anchors;
    }
    anchorSource = '合成锚点（未校准，仅用于测延迟）';
    return { min: { x: 0, y: 0, z: -1 }, max: { x: 0, y: -1, z: 0 } };
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  function onOrientation(e) {
    if (!running) return;
    track(oriTracker, e);
    const out = feedAndMeasure(e);
    if (!out) return;
    elBarAtt.style.width = (out.t * 100).toFixed(1) + '%';
    elNumAtt.textContent = out.t.toFixed(3);
    lag.lastAttT = out.t;
  }

  function onMotion(e) {
    if (!running) return;
    track(motTracker, e);
    if (!anchors) return;
    const acc = e.accelerationIncludingGravity || e.acceleration;
    if (!acc || acc.x == null) return;
    const tAcc = F.computeGravityFusedT(acc.x, acc.y, acc.z, anchors, fusion);
    if (tAcc == null) return;
    elBarAcc.style.width = (tAcc * 100).toFixed(1) + '%';
    elNumAcc.textContent = tAcc.toFixed(3);
    measureAccelDrift(e, lag.lastAttT);
  }

  // ── ③ network RTT ─────────────────────────────────────────────────────────

  async function measureRtt() {
    elBtnRtt.disabled = true;
    elRtt.textContent = '测量中…';
    const out = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      try {
        await fetch('/status', { cache: 'no-store' });
        out.push(performance.now() - t0);
      } catch (_) {
        elRtt.textContent = '失败（Bridge 未运行？）';
        setVerdictClass(elRtt, 'bad');
        elBtnRtt.disabled = false;
        return null;
      }
    }
    const res = { min: Math.min(...out), p50: percentile(out, 0.5), p95: percentile(out, 0.95) };
    elRtt.textContent = `${res.min.toFixed(1)} / ${res.p50.toFixed(1)} / ${res.p95.toFixed(1)} ms`;
    setVerdictClass(elRtt, res.p50 < 15 ? 'good' : (res.p50 < 40 ? 'warn' : 'bad'));
    elBtnRtt.disabled = false;
    return res;
  }

  // ── storage cost (what the old hot path did twice per sensor event) ───────

  function measureStorage() {
    const keys = [F.PROFILES.flip.storageKey, F.PROFILES.lift.storageKey];
    const n = 300;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      for (const k of keys) {
        const raw = localStorage.getItem(k);
        if (raw) JSON.parse(raw);
      }
    }
    const perCall = ((performance.now() - t0) * 1000) / (n * keys.length);
    elStorageCost.textContent = perCall.toFixed(0) + ' µs/次';
    setVerdictClass(elStorageCost, perCall < 60 ? 'good' : (perCall < 250 ? 'warn' : 'bad'));
    return perCall;
  }

  // ── ⑥ haptics: can this device confirm a press by feel? ────────────────────
  //
  // The pad page buzzes on every press and page switch. "No buzz" has several very different
  // causes and they are indistinguishable by feel, so this reports the one fact that separates
  // them: whether the API exists at all, and what vibrate() *returned*.
  //   no API  -> iOS Safari (no Vibration API at all), or a browser that dropped it
  //   false   -> the call was refused (page not visible / no user gesture)
  //   true    -> accepted; a silent phone means the *system* muted it (silent / DND /
  //              vibration switched off / battery saver) or the motor cannot render a pulse
  //              that short — which is why the durations are offered one by one.
  const vibSupported = typeof navigator.vibrate === 'function';

  // 面板按键用的是 25 ms；这里把每一档都给出，好判断"马达能不能做出这么短的脉冲"。
  const VIB_TESTS = [
    ['btnVib10', '10 ms', 10],
    ['btnVib25', '25 ms', 25],
    ['btnVib60', '60 ms', 60],
    ['btnVib200', '200 ms', 200],
    ['btnVibPat', '节奏 [30,40,30]', [30, 40, 30]],
  ];

  function reportVibrationApi() {
    elVibApi.textContent = vibSupported ? '可用' : '不可用（本浏览器没有 navigator.vibrate）';
    setVerdictClass(elVibApi, vibSupported ? 'good' : 'bad');
    elVibSecure.textContent = window.isSecureContext ? '是' : '否（HTTP：不影响震动，但会影响唤醒锁等）';
  }

  function testVibration(label, pattern) {
    if (!vibSupported) {
      elVibResult.textContent = `${label}：本浏览器没有这个 API —— iOS Safari 就属于这一类（网页拿不到 iPhone 的马达）`;
      setVerdictClass(elVibResult, 'bad');
      return;
    }
    let accepted;
    try {
      accepted = navigator.vibrate(pattern);
    } catch (e) {
      accepted = false;
    }
    elVibResult.textContent = accepted
      ? `${label}：调用已接受但手上没感觉 → 系统层面压掉了（静音/勿扰/系统里关了触感/省电模式），或马达做不出这一档`
      : `${label}：调用被拒（false）→ 多为页面不可见或没有用户手势，可在页面可见时再点一次`;
    setVerdictClass(elVibResult, accepted ? 'warn' : 'bad');
  }

  // ── tuning UI ─────────────────────────────────────────────────────────────

  // ── periodic UI refresh ───────────────────────────────────────────────────

  function refresh() {
    if (!running) return;

    const ori = drain(oriTracker);
    const mot = drain(motTracker);

    elRateOri.textContent = ori.hz.toFixed(1) + ' Hz';
    setVerdictClass(elRateOri, ori.hz >= 100 ? 'good' : (ori.hz >= 50 ? 'warn' : 'bad'));
    elRateOriIv.textContent = `${fmtMs(ori.p50)} / ${fmtMs(ori.p95)}`;

    elRateMot.textContent = mot.hz.toFixed(1) + ' Hz';
    setVerdictClass(elRateMot, mot.hz >= 100 ? 'good' : (mot.hz >= 50 ? 'warn' : 'bad'));
    elRateMotIv.textContent = `${fmtMs(mot.p50)} / ${fmtMs(mot.p95)}`;

    const q50 = mot.q50 != null ? mot.q50 : ori.q50;
    const q95 = mot.q95 != null ? mot.q95 : ori.q95;
    elQueueDelay.textContent = `${fmtMs(q50)} / ${fmtMs(q95)}`;
    setVerdictClass(elQueueDelay, q95 == null ? '' : (q95 < 25 ? 'good' : (q95 < 80 ? 'warn' : 'bad')));

    const now = performance.now();
    const lastSecond = frames.log.filter((f) => f.ts > now - 1000).length;
    elFps.textContent = lastSecond + ' fps';
    setVerdictClass(elFps, lastSecond >= 55 ? 'good' : (lastSecond >= 40 ? 'warn' : 'bad'));

    let maxFrame = 0;
    let jank = 0;
    for (const f of frames.log) {
      if (f.d > maxFrame) maxFrame = f.d;
      if (f.d > 50) jank++;
    }
    elLongestFrame.textContent = fmtMs(maxFrame);
    setVerdictClass(elLongestFrame, maxFrame < 33 ? 'good' : (maxFrame < 100 ? 'warn' : 'bad'));
    elJankCount.textContent = String(jank);
    setVerdictClass(elJankCount, jank === 0 ? 'good' : (jank < 5 ? 'warn' : 'bad'));

    const lagP50 = percentile(lag.samples, 0.5);
    elLagMeasured.textContent = lag.samples.length ? fmtMs(lagP50) : '翻转手机以测量…';
    setVerdictClass(elLagMeasured, lagP50 == null ? '' : (lagP50 < 40 ? 'good' : (lagP50 < 90 ? 'warn' : 'bad')));
    elLagSamples.textContent = String(lag.samples.length);

    const driftP50 = percentile(lag.drift, 0.5);
    const driftMax = lag.drift.length ? Math.max(...lag.drift) : null;
    elDriftMeasured.textContent = lag.drift.length
      ? `${driftP50.toFixed(1)} / ${driftMax.toFixed(1)} CC 步`
      : '翻转手机以测量…';
    setVerdictClass(elDriftMeasured, driftP50 == null ? '' : (driftP50 < 2 ? 'good' : (driftP50 < 8 ? 'warn' : 'bad')));
    elDriftSamples.textContent = String(lag.drift.length);
    elAnchorSrc.textContent = anchorSource;

    updateVerdict({ ori, mot, q50, q95, lagP50 });
  }

  function updateVerdict(m) {
    const sensorHalf = m.ori.p50 != null ? m.ori.p50 / 2 : (m.mot.p50 != null ? m.mot.p50 / 2 : null);
    const parts = [];
    let total = 0;

    if (sensorHalf != null) { parts.push(`采样半周期 ${sensorHalf.toFixed(1)}`); total += sensorHalf; }
    if (m.q50 != null) { parts.push(`主线程排队 ${m.q50.toFixed(1)}`); total += m.q50; }
    if (rttResult) { parts.push(`网络半程 ${(rttResult.p50 / 2).toFixed(1)}`); total += rttResult.p50 / 2; }
    if (m.lagP50 != null) { parts.push(`发送侧门限 ${m.lagP50.toFixed(0)}`); total += m.lagP50; }

    let head;
    if (m.ori.hz && m.ori.hz < 40) {
      head = '姿态采样率偏低，这是平台限制（浏览器/系统给的上限）。';
    } else if (m.q95 != null && m.q95 > 80) {
      head = '主线程存在明显排队/掉帧 —— 属于代码开销。';
    } else {
      head = 'Mode B 链路无滤波：投影值即发送值，剩余延迟是采样与系统姿态融合的物理下限。';
    }

    const totalTxt = parts.length ? `<br>估算端到端 ≈ <b>${total.toFixed(0)} ms</b>（${parts.join(' + ')}）` : '';
    elVerdict.innerHTML = head + totalTxt
      + '<br><span class="dim">参考：手感「无延迟」阈值约 50 ms 以内；100 ms 以上明显可感。</span>';
  }

  let rttResult = null;

  // ── start ─────────────────────────────────────────────────────────────────

  async function start() {
    if (!F) { showError('fusion.js 未加载，请刷新页面'); return; }
    elBtnStart.disabled = true;
    try {
      await F.requestProfilePermissions('flip');
    } catch (e) {
      showError(e.message || '权限请求失败');
      elBtnStart.disabled = false;
      return;
    }
    // devicemotion is only needed for the accelerometer-contamination readout, so a refusal
    // must not stop the diagnosis.
    try { await F.requestMotionPermission(); } catch (_) { /* comparison unavailable */ }
    showError('');
    anchors = resolveAnchors();
    lag.samples = [];
    lag.drift = [];
    lag.lastSent = null;
    lag.lastSentAt = -1e9;
    running = true;
    window.addEventListener('deviceorientation', onOrientation, true);
    window.addEventListener('devicemotion', onMotion, true);
    elBtnStart.textContent = '传感器运行中（可翻转手机试延迟）';
    setInterval(refresh, 500);
    refresh();
    measureRtt().then((r) => { rttResult = r; });
    measureStorage();
  }

  elBtnStart.addEventListener('click', start);
  elBtnStorage.addEventListener('click', measureStorage);
  elBtnRtt.addEventListener('click', () => { measureRtt().then((r) => { rttResult = r; }); });
  for (const [id, label, pattern] of VIB_TESTS) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => testVibration(label, pattern));
  }
  reportVibrationApi();       // 一进页面就报，不用点任何东西

  if (!F) {
    showError('fusion.js 未加载，请刷新页面');
    elBtnStart.disabled = true;
  }
})();
