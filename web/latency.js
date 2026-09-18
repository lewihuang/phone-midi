// Phone MIDI CC — on-device latency diagnosis + Mode B tuning
//
// Answers "is the lag the platform or the code?" by measuring, on the real
// phone, the four stages that add up to hand-feel latency:
//   ① sensor event rate        -> platform floor, cannot be beaten by JS
//   ② main-thread queue delay  -> code cost (per-event work, jank)
//   ③ network RTT to the Bridge
//   ④ the production Mode B filter chain (feedFlipMotion), measured as the
//      delay between the unfiltered projection crossing t=0.5 and the value
//      that is actually sent crossing t=0.5.
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
  const elTauRest = document.getElementById('tauRest');
  const elTauFast = document.getElementById('tauFast');
  const elAnchorSrc = document.getElementById('anchorSrc');
  const elBarRaw = document.getElementById('barRaw');
  const elNumRaw = document.getElementById('numRaw');
  const elBarFilt = document.getElementById('barFilt');
  const elNumFilt = document.getElementById('numFilt');

  const elVMincut = document.getElementById('vMincut');
  const elSBeta0 = document.getElementById('sBeta');
  const elVBeta = document.getElementById('vBeta');
  const elSGrav = document.getElementById('sGrav');
  const elVGrav = document.getElementById('vGrav');
  const elSMincut = document.getElementById('sMincut');
  const elBtnDefaults = document.getElementById('btnDefaults');
  const elBtnPresets = document.getElementById('btnPresets');
  const elVerdict = document.getElementById('verdict');

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

  // ── ④ production filter chain lag ─────────────────────────────────────────

  const lag = { samples: [], prevRaw: null, armedForRise: false, rawCrossAt: null, lastT: null, lastRaw: null };

  function feedAndMeasure(event) {
    const out = F.feedFlipMotion(event, anchors, fusion);
    if (!out) return null;
    lag.lastT = out.t;
    lag.lastRaw = out.t_raw;

    if (out.t_raw < 0.35) {
      lag.armedForRise = true;
      lag.rawCrossAt = null;
    }
    if (lag.armedForRise && lag.rawCrossAt == null && out.t_raw >= 0.5
        && lag.prevRaw != null && out.t_raw > lag.prevRaw) {
      lag.rawCrossAt = performance.now();
    } else if (lag.armedForRise && lag.rawCrossAt != null && out.t >= 0.5) {
      const d = performance.now() - lag.rawCrossAt;
      if (d >= 0 && d < 2000) {
        lag.samples.push(d);
        if (lag.samples.length > 60) lag.samples.shift();
      }
      lag.armedForRise = false;
      lag.rawCrossAt = null;
    }
    lag.prevRaw = out.t_raw;
    return out;
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
  }

  function onMotion(e) {
    if (!running) return;
    track(motTracker, e);
    if (!anchors) return;
    const out = feedAndMeasure(e);
    if (!out) return;
    elBarRaw.style.width = (out.t_raw * 100).toFixed(1) + '%';
    elNumRaw.textContent = out.t_raw.toFixed(3);
    elBarFilt.style.width = (out.t * 100).toFixed(1) + '%';
    elNumFilt.textContent = out.t.toFixed(3);
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

  // ── tuning UI ─────────────────────────────────────────────────────────────

  function syncTuningUi() {
    const t = F.getFlipTuning();
    elSMincut.value = t.mincutoff;
    elSBeta0.value = t.beta;
    elSGrav.value = t.gravityAvgMs;
    elVMincut.textContent = t.mincutoff.toFixed(1) + ' Hz';
    elVBeta.textContent = t.beta.toFixed(1);
    elVGrav.textContent = t.gravityAvgMs.toFixed(0) + ' ms';
    elTauRest.textContent = F.flipTimeConstantMs(0).toFixed(0) + ' ms';
    elTauFast.textContent = F.flipTimeConstantMs(3).toFixed(0) + ' ms';
    setVerdictClass(elTauRest, F.flipTimeConstantMs(0) < 80 ? 'good' : 'bad');
  }

  function onTuningInput() {
    F.setFlipTuning({
      mincutoff: parseFloat(elSMincut.value),
      beta: parseFloat(elSBeta0.value),
      gravityAvgMs: parseFloat(elSGrav.value),
    });
    syncTuningUi();
  }

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
    elAnchorSrc.textContent = anchorSource;

    updateVerdict({ ori, mot, q50, q95, lagP50 });
  }

  function updateVerdict(m) {
    const sensorHalf = m.mot.p50 != null ? m.mot.p50 / 2 : (m.ori.p50 != null ? m.ori.p50 / 2 : null);
    const parts = [];
    let total = 0;

    if (sensorHalf != null) { parts.push(`采样半周期 ${sensorHalf.toFixed(1)}`); total += sensorHalf; }
    if (m.q50 != null) { parts.push(`主线程排队 ${m.q50.toFixed(1)}`); total += m.q50; }
    if (rttResult) { parts.push(`网络半程 ${(rttResult.p50 / 2).toFixed(1)}`); total += rttResult.p50 / 2; }
    if (m.lagP50 != null) { parts.push(`Mode B 滤波 ${m.lagP50.toFixed(0)}`); total += m.lagP50; }

    let head;
    if (m.ori.hz && m.ori.hz < 40) {
      head = '传感器采样率偏低，这是平台限制（浏览器/系统给的上限）。';
    } else if (m.lagP50 != null && m.lagP50 > 90) {
      head = '滤波链是主要延迟来源 —— 属于代码，可在下方 ⑤ 调小。';
    } else if (m.q95 != null && m.q95 > 80) {
      head = '主线程存在明显排队/掉帧 —— 属于代码开销。';
    } else {
      head = '各段均正常，剩余延迟主要是采样与系统融合的物理下限。';
    }

    const totalTxt = parts.length ? `<br>估算端到端 ≈ <b>${total.toFixed(0)} ms</b>（${parts.join(' + ')}）` : '';
    elVerdict.innerHTML = head + totalTxt
      + '<br><span style="color:#64748b">参考：手感「无延迟」阈值约 50 ms 以内；100 ms 以上明显可感。</span>';
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
    showError('');
    anchors = resolveAnchors();
    F.resetFlipMotion();
    lag.samples = [];
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

  elSMincut.addEventListener('input', onTuningInput);
  elSBeta0.addEventListener('input', onTuningInput);
  elSGrav.addEventListener('input', onTuningInput);

  elBtnDefaults.addEventListener('click', () => { F.resetFlipTuning(); syncTuningUi(); });
  elBtnPresets.addEventListener('click', () => {
    // lowest lag: no averaging, high rest cutoff, strongly adaptive
    F.setFlipTuning({ gravityAvgMs: 0, mincutoff: 8, beta: 3 });
    syncTuningUi();
  });

  if (!F) {
    showError('fusion.js 未加载，请刷新页面');
    elBtnStart.disabled = true;
  } else {
    syncTuningUi();
  }
})();
