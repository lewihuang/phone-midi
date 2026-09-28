// MIDI Deck — X/Y Pad（二维控制面）
//
// 绝对语义 + 松手保持：Position 就是发出去的值，手指离开后它留在原处（Marker 也留在原处）。
// Landing（手指新落到别处）走一小段补间抹掉跳变；Drag（按着移动）**零平滑、零插帧、零延迟**。
// 滤波的教训（Mode B 那条被删掉的滤波链）不在这里重犯：跟手优先。
//
// 一条手指动作 → 两条 7-bit CC（两个可配的 CC 号，同通道），不走映射引擎。
// 页面上还有两个"快速预设"（弦乐表情 = CC1+CC11 / X/Y Pad = CC20+CC21）：**只填两个 CC 号、
// 不锁定**，输入框始终可手改。
// 设计：docs/spec/xy-pad.md；术语：CONTEXT.md（Position / Marker / Landing / Drag / Recentre）。
(() => {
  'use strict';

  const MAX = 127;
  const LANDING_MS = 40;        // Landing / 回中 / 解冻 的补间时长（只用于"程序性移动"）
  const MIN_SEND_MS = 4;        // 两次发送之间的下限（与推子同一条，防止病态事件率灌满链路）
  const CENTER = 63.5;          // 面的正中（→ 64，两边对称）
  const RECONNECT_MS = 2000;

  const elPlane = document.getElementById('plane');
  const elReadout = document.getElementById('readout');
  const elHint = document.getElementById('hint');
  const elBtnCenter = document.getElementById('btnCenter');
  const elBtnFreeze = document.getElementById('btnFreeze');
  const elCcX = document.getElementById('ccX');
  const elCcY = document.getElementById('ccY');
  const elSelCh = document.getElementById('selCh');

  let ws = null;
  let connected = false;
  let retryTimer = null;
  let wakeLock = null;

  // Position 用浮点保存：补间要平滑，像素级才四舍五入成 CC
  let pos = { x: CENTER, y: CENTER };
  let sent = null;              // 上一次**真的发出去**的位置（null = 一条都没发过）
  let armed = false;            // 碰过面没有（没碰过 = "未定"状态，一个值都不发）
  let frozen = false;
  let activePointer = null;     // 第一根手指独占（第二根落下不夺权）
  let glide = null;             // {fromX, fromY, toX, toY, t0, sendAfter}
  let lastSendAt = -1e9;
  let cfg = { ccX: 20, ccY: 21, channel: 0 };

  // ── 显示 ────────────────────────────────────────────────────────────────────

  function paint() {
    const px = (pos.x / MAX) * 100;
    const py = (1 - pos.y / MAX) * 100;          // 屏幕向下 = 值变小
    elPlane.style.setProperty('--mx', px.toFixed(3) + '%');
    elPlane.style.setProperty('--my', py.toFixed(3) + '%');
  }

  function setReadout() {
    if (!connected) {
      elReadout.textContent = '未连接';
      elReadout.classList.add('dim');
      elHint.textContent = 'Bridge 没连上，拖动不会发送';
      return;
    }
    if (!armed) {
      elReadout.textContent = 'X — · Y —';
      elReadout.classList.add('dim');
      elHint.textContent = '点一下控制面开始';
      return;
    }
    elReadout.textContent = 'X ' + Math.round(pos.x) + ' · Y ' + Math.round(pos.y)
      + (frozen ? '（已冻结，未发送）' : '');
    elReadout.classList.toggle('dim', frozen);
    elHint.textContent = frozen ? '解冻后会把这两个值发出去' : '';
  }

  // ── 发送 ────────────────────────────────────────────────────────────────────

  function canSend() { return connected && armed && !frozen; }

  /** 值变一档才发那一条；两轴独立判断；两条之间遵守 MIN_SEND_MS。 */
  function sendNow(force) {
    if (!canSend()) return;
    const now = performance.now();
    if (!force && now - lastSendAt < MIN_SEND_MS) return;
    const x = Math.max(0, Math.min(MAX, Math.round(pos.x)));
    const y = Math.max(0, Math.min(MAX, Math.round(pos.y)));
    const sameAsSent = sent && sent.x === x && sent.y === y;
    if (sameAsSent && !force) return;
    const msg = { kind: 'xy', x: x, y: y, cc_x: cfg.ccX, cc_y: cfg.ccY, channel: cfg.channel };
    if (!send(msg)) return;
    sent = { x: x, y: y };
    lastSendAt = now;
  }

  // ── 补间（只用于 Landing / 回中 / 解冻，不用于 Drag） ───────────────────────

  function startGlide(toX, toY, sendAfter) {
    glide = { fromX: pos.x, fromY: pos.y, toX: toX, toY: toY, t0: performance.now(),
              sendAfter: !!sendAfter };
    requestAnimationFrame(step);
  }

  function step() {
    if (!glide) return;
    const k = Math.min(1, (performance.now() - glide.t0) / LANDING_MS);
    const e = k;                                  // 线性就够：40 ms 内看不出曲线差别
    pos.x = glide.fromX + (glide.toX - glide.fromX) * e;
    pos.y = glide.fromY + (glide.toY - glide.fromY) * e;
    paint();
    setReadout();
    if (canSend()) sendNow(false);                // 补间沿途照发（这正是抹掉跳变的方式）
    if (k < 1) { requestAnimationFrame(step); return; }
    pos.x = glide.toX; pos.y = glide.toY;
    paint(); setReadout();
    if (glide.sendAfter) sendNow(true);
    glide = null;
  }

  // ── 触摸 ────────────────────────────────────────────────────────────────────

  function planeValue(ev) {
    const r = elPlane.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / Math.max(1, r.width)) * MAX;
    const y = (1 - (ev.clientY - r.top) / Math.max(1, r.height)) * MAX;
    return { x: Math.max(0, Math.min(MAX, x)), y: Math.max(0, Math.min(MAX, y)) };
  }

  elPlane.addEventListener('pointerdown', (ev) => {
    if (activePointer !== null) return;           // 第二根手指：忽略（不夺权）
    ev.preventDefault();
    activePointer = ev.pointerId;
    try { elPlane.setPointerCapture(ev.pointerId); } catch (_) { /* not fatal */ }
    elPlane.classList.add('pressed');
    elPlane.classList.remove('unset');
    const first = !armed;
    armed = true;
    const v = planeValue(ev);
    // **每次落点都走补间**（Landing）：第一次从"未定"的中心出发，之后从上次停的地方出发。
    // 只有手指按着**移动**才是 Drag（下面那条，直接跟手、不平滑）。
    glide = null;
    startGlide(v.x, v.y, true);
    if (first) setReadout();
  });

  elPlane.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== activePointer) return;
    ev.preventDefault();
    glide = null;
    pos = planeValue(ev);                         // **跟手**：不插帧、不平滑
    paint(); setReadout(); sendNow(false);
  });

  function endPointer(ev) {
    if (ev.pointerId !== activePointer) return;
    activePointer = null;
    glide = null;
    elPlane.classList.remove('pressed');
    // 松手**什么都不发**：绝对 + 保持语义，值就该留在那儿
    try { elPlane.releasePointerCapture(ev.pointerId); } catch (_) { /* fine */ }
    paint(); setReadout();
  }
  elPlane.addEventListener('pointerup', endPointer);
  elPlane.addEventListener('pointercancel', endPointer);

  // ── 回中 / 冻结 ─────────────────────────────────────────────────────────────

  elBtnCenter.addEventListener('click', () => {
    if (!connected) return;
    elPlane.classList.remove('unset');
    armed = true;
    glide = null;
    startGlide(CENTER, CENTER, true);             // 与 Landing 同一条补间，结束时发出中心值
  });

  elBtnFreeze.addEventListener('click', () => {
    if (!connected) return;
    if (!frozen) {
      // 冻结：Marker 仍可拖（它表示"解冻后要去的位置"），但一个 CC 都不发
      frozen = true;
      elPlane.classList.add('frozen');
      elBtnFreeze.textContent = '已冻结 · 点此恢复';
      elBtnFreeze.classList.add('btn-primary');
      setReadout();
      return;
    }
    frozen = false;
    elPlane.classList.remove('frozen');
    elBtnFreeze.textContent = '冻结';
    elBtnFreeze.classList.remove('btn-primary');
    armed = true;
    elPlane.classList.remove('unset');
    const target = { x: pos.x, y: pos.y };
    if (sent) pos = { x: sent.x, y: sent.y };     // 从"上次真的发出去的位置"起步
    glide = null;
    startGlide(target.x, target.y, true);         // 结束时发出当前值，把插件拉到位
    setReadout();
  });

  // ── CC 配置（改了立刻生效，Bridge 会落盘记住） ──────────────────────────────

  function fillChannels() {
    for (let i = 1; i <= 16; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      elSelCh.appendChild(o);
    }
    elSelCh.value = String(cfg.channel + 1);
  }

  function readConfig() {
    const x = parseInt(elCcX.value, 10);
    const y = parseInt(elCcY.value, 10);
    const ch = parseInt(elSelCh.value, 10);
    cfg.ccX = (Number.isFinite(x) && x >= 0 && x <= 127) ? x : cfg.ccX;
    cfg.ccY = (Number.isFinite(y) && y >= 0 && y <= 127) ? y : cfg.ccY;
    cfg.channel = (Number.isFinite(ch) && ch >= 1 && ch <= 16) ? ch - 1 : cfg.channel;
    elCcX.value = String(cfg.ccX);
    elCcY.value = String(cfg.ccY);
    elSelCh.value = String(cfg.channel + 1);
    paintPresets();                               // 高亮跟着实际的两个号走（手改也算数）
    sendNow(true);                                // 立刻用新号发一次当前位置
  }
  elCcX.addEventListener('change', readConfig);
  elCcY.addEventListener('change', readConfig);
  elSelCh.addEventListener('change', readConfig);

  // ── 快速预设（弦乐表情 / X/Y Pad） ──────────────────────────────────────────
  //
  // 只是"一键把两个 CC 号填好"，**不是锁定**：填完输入框照样能手改；高亮如实反映当前那两个号
  // （手改成别的值 → 两个都不亮）。所以预设不进协议、Bridge 侧一个字都不用改 —— 两个号本来就
  // 是随每条消息带的、Bridge 会落盘（spec 决策 6）。
  //
  // 弦乐表情用 CC1 + CC11（调制/颤音 + 表情），这是画弦乐表情最顺的一对；代价是 CC1 与推子
  // （Mode A/B）同号同通道，**别和推子同时跑**（同一根线会混）。
  const PRESETS = [
    { el: document.getElementById('presetExpr'), ccX: 1,  ccY: 11 },   // 弦乐表情
    { el: document.getElementById('presetXy'),   ccX: 20, ccY: 21 },   // X/Y Pad（默认）
  ];

  /** 高亮 = "当前这两个号正好是这套预设"；一个手改过的值就能让它灭掉（不假装）。 */
  function paintPresets() {
    for (const p of PRESETS) p.el.classList.toggle('sel', cfg.ccX === p.ccX && cfg.ccY === p.ccY);
  }

  function applyPreset(p) {
    elCcX.value = String(p.ccX);
    elCcY.value = String(p.ccY);
    readConfig();          // 复用既有那条路：校验 + 立刻用新号发一次当前位置 + Bridge 落盘
  }

  for (const p of PRESETS) p.el.addEventListener('click', () => applyPreset(p));

  // ── WebSocket ───────────────────────────────────────────────────────────────

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }

  function setConn(on) {
    connected = on;
    elPlane.classList.toggle('offline', !on);
    setReadout();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RECONNECT_MS);
  }

  function connect() {
    if (ws) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(protocol + '//' + location.host + '/ws');
    } catch (_) {
      ws = null; setConn(false); scheduleRetry(); return;
    }
    ws.onopen = () => { setConn(true); };
    ws.onmessage = () => { /* X/Y 目前不需要服务器消息（布局下发是面板的事） */ };
    ws.onclose = () => {
      connected = false;
      ws = null;
      setConn(false);
      scheduleRetry();
    };
    ws.onerror = () => {};
  }

  // 值在断连时不该"跟着手指变"却发不出去 —— 面上已 pointer-events: none，这里再兜一层
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!connected && !ws) { clearTimeout(retryTimer); connect(); }
  });

  async function keepAwake() {
    if (!navigator.wakeLock || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { wakeLock = null; }
  }

  fillChannels();
  paint();
  paintPresets();          // 打开页面时按默认 CC20/21 点亮「X/Y Pad」（值对不上就两个都不亮）
  setConn(false);
  keepAwake();
  connect();
})();
