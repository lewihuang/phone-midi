// Phone MIDI CC — 快捷键格子的共用实现
//
// 同一套"8 格按钮"现在有三个宿主：
//   * `/pad.html` —— 完整面板：固定 6 页、底部页签切换（spec D18）；
//   * `/fader.html` 的运行界面 —— 只显示**第 4 页（CC 廊）**那八格，方便推子正跑着的时候
//     顺手在 DAW 里把 CC 廊调出来。它没有自己的布局，就是面板第 4 页的镜像；
//   * `/tablet.html` —— 平板：**六个 2×4 页左右并排**（12 列 × 4 行的一屏），每页仍是一个
//     `createGrid(page = p)` 实例，所以编号还是 `页号 × 8 + 序号`，与手机逐格相同。
//
// 三个宿主之间只差"当前是第几页"和"连接状态从哪里读"，所以**建格、绘制、按下/松开、
// 离线拒按、震动确认、松手痕迹**这六件事收在这一份实现里：改一处，三端同时生效。
// （这也是这次重构要买的东西——以前这套逻辑长在 pad.js 里，第二处用它就只能抄一份。）
//
// 手机仍然是哑显示端：不推理颜色（字色由 Bridge 逐格算好，随布局下发 `ink`）、不认识宏、
// 一次按下只上送一个触发编号 `页号 × 8 + 序号`；Bridge 把它变成一条 MIDI Note（ADR 0004）。
(() => {
  'use strict';

  const COLS = 2;              // 2 列 × 4 行（D15：扁而宽的按钮浪费手机竖向空间）
  const ROWS = 4;
  const SLOTS = COLS * ROWS;   // 每页 8 格
  const PAGES = 6;             // 页数固定（D18）；各宿主都按这个上限裁布局
  // 布局还没到时兜底用的颜色：白色，和浅色页面是一套的（D26）。字色同理，缺 `ink` 时用深字。
  const DEFAULT_COLOR = '#ffffff';
  const DEFAULT_INK = '#1c1e26';
  // 松手后保留一小段"已发出"的痕迹。为什么：轻点的按住时间只有几十毫秒，纯 `:active` 式的
  // 反馈在真机上几乎看不见——用户明确要求"不能只凭感觉，要能看见自己在按什么"。
  const FIRE_MS = 220;
  // 震动 25 ms 而不是 10 ms：马达需要启动时间，脉冲太短等于没有（真机上试出来的，见 D25）。
  const HAPTIC_MS = 25;

  /** 触发编号只由**位置**决定：`页号 × 8 + 序号`（ADR 0004）。所以挪按钮位置不必在 DAW 里重学。 */
  const triggerId = (pageIndex, slot) => pageIndex * SLOTS + slot;

  /**
   * 有马达就振一下；没有 / 被系统压掉 / 抛错就安静跳过。
   * `navigator.vibrate` 存在**不等于**会振（鸿蒙上是空壳：API 在、返回 true、手上没感觉），
   * 所以触觉永远只是加分项，不能当成唯一的"已确认"证据（D25）。
   */
  function haptic() {
    if (!navigator.vibrate) return;
    try { navigator.vibrate(HAPTIC_MS); } catch (_) { /* unsupported or blocked: fine */ }
  }

  /**
   * 一格格子阵列。
   *
   * `opts`：
   *   page         起始页号（默认 0）。推子页固定给 3（第 4 页）；面板页靠 `setPage()` 换页。
   *   isConnected  `() => boolean`：现在能不能发。**没有连接就不给手感也不发消息**——
   *                一个按下去没反应的按钮，比一个看起来就不能按的按钮更糟。
   *   send         `(obj) => void`：把一条消息交给宿主的 WebSocket。
   *   haptic       `() => void`：可选，按下时的震动确认（一般传本模块的 `haptic`）。
   *   onBlocked    `(msg) => void`：可选，未连接时按下要提示什么。
   *   onSent       `() => void`：可选，真的按下去之后清掉提示。
   *
   * 返回：`{ cells, page, setPage, paint, releaseAll, dropHeld, setOffline }`
   */
  function createGrid(gridEl, opts) {
    const o = opts || {};
    const isConnected = o.isConnected || (() => true);
    const send = o.send || (() => {});
    const buzz = o.haptic || (() => {});
    const onBlocked = o.onBlocked || (() => {});
    const onSent = o.onSent || (() => {});

    const cells = [];        // 8 个 DOM 格，建一次、就地更新
    const held = new Map();  // pointerId → { id, cell }：滑出格子再松手，也要松开当初按下的那一条
    let page = o.page | 0;

    function flash(el) {
      el.classList.remove('pressed');
      el.classList.add('fired');
      clearTimeout(el._firedTimer);
      el._firedTimer = setTimeout(() => el.classList.remove('fired'), FIRE_MS);
    }

    /** 这一格上现在还按着哪几个指针（同一格可能落了两根手指）。 */
    function pointersOn(cell) {
      const out = [];
      for (const [pid, h] of held) if (h.cell === cell) out.push(pid);
      return out;
    }

    /** 关掉这一格：清掉它上面所有指针的记录，并且**只在真的发过 down 时**发一条 up。 */
    function closeCell(h, flashIt) {
      for (const pid of pointersOn(h.cell)) held.delete(pid);
      if (!h.cell.open) return;
      h.cell.open = false;
      if (flashIt) flash(h.cell.el);
      send({ kind: 'trigger', id: h.id, phase: 'up' });
    }

    function bind(cell, slot) {
      cell.el.addEventListener('pointerdown', (ev) => {
        if (!isConnected()) { onBlocked('未连接 Bridge，按键不会发出'); return; }
        ev.preventDefault();
        const id = triggerId(page, slot);
        held.set(ev.pointerId, { id, cell });
        try { cell.el.setPointerCapture(ev.pointerId); } catch (_) { /* not fatal */ }
        // 这一格已经按着了（第二根手指、或丢了"松开"之后又按）：**不再发第二条 down**。
        // 一格 = 一个音符：发两条 down 只配得出一条 up，DAW 里会永久留一条关不掉的 Note
        // （见 docs/changelog/2026-09-28_pad-stuck-note.md）。Bridge 侧也挡了一道。
        if (cell.open) return;
        cell.open = true;
        cell.el.classList.add('pressed');
        cell.el.classList.remove('fired');
        buzz();                    // 手指按下的那一下，先确认，再发消息
        onSent();
        send({ kind: 'trigger', id, phase: 'down' });
      });

      const release = (ev) => {
        const h = held.get(ev.pointerId);
        if (!h) return;
        // 这一格上**任何一根**手指抬起都算松开：用户要的是"按下就响、抬手就停"，
        // 而"另一根手指还压着所以不松"正是 DAW 里留下悬挂 Note 的那条路。
        closeCell(h, true);
      };
      cell.el.addEventListener('pointerup', release);
      cell.el.addEventListener('pointercancel', release);
      cell.el.addEventListener('lostpointercapture', release);
    }

    function build() {
      for (let slot = 0; slot < SLOTS; slot++) {
        const el = document.createElement('div');
        el.className = 'cell';
        el.dataset.slot = String(slot);
        const label = document.createElement('span');
        el.appendChild(label);
        gridEl.appendChild(el);
        const cell = { el, label, open: false };   // open = 这一格发出过 down、还欠一条 up
        cells.push(cell);
        bind(cell, slot);
      }
    }

    /**
     * 把一页布局画到格子上。缺字段一律退回默认值，永不抛错——一份坏布局不该让整页空白。
     * 音符编号**不画**（D19）：它是配置期信息（在 DAW 里对照学习用），摆在按钮上会干扰"一眼认出"。
     */
    function paint(cfg) {
      const list = (cfg && Array.isArray(cfg.cells)) ? cfg.cells : [];
      for (let slot = 0; slot < SLOTS; slot++) {
        const cell = cells[slot];
        const d = list[slot];
        const text = (d && typeof d.text === 'string') ? d.text : '';
        const color = (d && typeof d.color === 'string' && d.color) ? d.color : DEFAULT_COLOR;
        // 字色由 Bridge 算好（浅底深字 / 深底白字），手机只负责填进去；旧布局缺 `ink` 时用深色字
        const ink = (d && typeof d.ink === 'string' && d.ink) ? d.ink : DEFAULT_INK;
        if (cell.label.textContent !== text) cell.label.textContent = text;
        if (cell.el.style.background !== color) cell.el.style.background = color;
        if (cell.el.style.color !== ink) cell.el.style.color = ink;
      }
    }

    /** 换页：**必须先松开所有按住的键**，否则 DAW 里会留下一条永远关不掉的 Note。 */
    function releaseAll() {
      for (const [pointerId, h] of held) {
        held.delete(pointerId);
        if (!h.cell.open) continue;      // 同一格的多根手指：只处理发过 down 的那一次
        h.cell.open = false;
        flash(h.cell.el);
        send({ kind: 'trigger', id: h.id, phase: 'up' });
      }
    }

    /**
     * 断线时用：**只清手机这边的按住痕迹**，一条消息都不发。
     *
     * 为什么不是 `releaseAll()`：`send()` 要求 socket 还 OPEN，而 `onclose` 那一刻它已经关了
     * ——"先松开再断开引用"其实一个字节都发不出去（Bridge 侧的断连清扫与 1 秒兜底才是真兜底）。
     * 这里做手机该做的那一半：别让残留的记录使下一次松手发出一个无主的 `up`。
     */
    function dropHeld() {
      for (const h of held.values()) {
        h.cell.open = false;
        h.cell.el.classList.remove('pressed');
      }
      held.clear();
    }

    /** 换到第 i 页（返回是否真的换了）。同页重按不算换页——调用方据此决定要不要给手感。 */
    function setPage(i) {
      if (i === page) return false;
      releaseAll();
      page = i;
      return true;
    }

    /** 离线时格子不该能按（见 `isConnected` 的说明）。灰掉的样子由宿主的 CSS 决定。 */
    function setOffline(off) {
      gridEl.classList.toggle('offline', !!off);
    }

    build();

    return {
      cells,
      get page() { return page; },
      setPage,
      paint,
      releaseAll,
      dropHeld,
      setOffline,
    };
  }

  window.PhoneMidiPadGrid = {
    COLS, ROWS, SLOTS, PAGES, DEFAULT_COLOR, DEFAULT_INK, HAPTIC_MS,
    triggerId, haptic, createGrid,
  };
})();
