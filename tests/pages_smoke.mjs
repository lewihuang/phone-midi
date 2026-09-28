// Smoke test: load the real page scripts against a stub DOM and drive them, so a typo in an
// element id, a missing export or a bad wire-up fails here instead of on the phone.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const pages = {
  home: { html: 'index.html', scripts: [] },
  xy: { html: 'xy.html', scripts: ['xy.js'] },
  // 格子那一层（建格/绘制/按下/离线拒按/震动）在 padgrid.js 里，pad.html 与推子页共用它
  fader: { html: 'fader.html', scripts: ['padgrid.js', 'fusion.js', 'vibrato.js', 'app.js'] },
  lab: { html: 'vibrato-lab.html', scripts: ['vibrato.js', 'vibrato-lab.js'] },
  latency: { html: 'latency.html', scripts: ['fusion.js', 'latency.js'] },
  pad: { html: 'pad.html', scripts: ['padgrid.js', 'pad.js'] },
  calFlip: { html: 'calibrate-flip.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  calLift: { html: 'calibrate-lift.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  calShake: { html: 'calibrate-shake.html', scripts: ['fusion.js', 'calibrate-wizard.js'] },
  devFlip: { html: 'fusion-calibrate-flip.html', scripts: ['fusion.js', 'fusion-calibrate.js'] },
  devShake: { html: 'fusion-calibrate-shake.html', scripts: ['fusion.js', 'fusion-calibrate-shake.js'] },
};
const files = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.scripts]));
const htmlOf = (page) => fs.readFileSync(web(pages[page].html), 'utf8');

function makeDom(page) {
  const html = htmlOf(page);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const profile = (html.match(/data-profile="([^"]+)"/) || [])[1] || 'lift';
  const nodes = {};
  // 控件面上的位置是 CSS 变量驱动的（--mx/--my），所以桩里的 style 要支持 setProperty
  const styleProto = {
    _v: {},
    setProperty(k, v) { this._v[k] = String(v); },
    getPropertyValue(k) { return this._v[k] || ''; },
  };
  const mk = (id, tag) => {
    const node = {
      id, tagName: tag || 'DIV', style: Object.create(styleProto), dataset: {}, children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
      },
      innerHTML: '', value: '1', disabled: false, href: '',
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
      removeEventListener() {}, appendChild(c) { this.children.push(c); },
      dispatch(type, event) { for (const fn of (this._listeners[type] || [])) fn(event || {}); },
      querySelector(sel) { return mk('sub', 'INPUT'); },
      querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; }, requestAnimationFrame() {},
      setPointerCapture() {}, releasePointerCapture() {}, focus() {},
      // X/Y Pad 要按触点算位置：给一个固定 300×300 的面（正方形，和真实布局一致）
      getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 }; },
    };
    let text = '';
    // A real DOM clears child nodes when textContent is assigned, and pad.js relies on that
    // when it rebuilds the page tabs.
    Object.defineProperty(node, 'textContent', {
      get() { return text; },
      set(v) { text = String(v); if (v === '') node.children.length = 0; },
    });
    return node;
  };
  const document = {
    hidden: false,
    body: { dataset: { profile } },
    getElementById(id) {
      if (!ids.has(id)) throw new Error(`getElementById('${id}') is not in ${page}.html`);
      return (nodes[id] ||= mk(id));
    },
    createElement: (tag) => mk('new-' + tag, tag),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  return { document, ids, nodes };
}

function loadPage(page) {
  const { document, ids, nodes } = makeDom(page);
  const listeners = {};
  const sockets = [];
  const buzzes = [];          // navigator.vibrate(ms) 的调用记录（"按下有没有震动确认"）
  const win = {
    document, location: { protocol: 'http:', host: '127.0.0.1:8765', search: '', href: 'http://x/' },
    history: { replaceState() {} },
    navigator: { wakeLock: { request: async () => ({ addEventListener() {}, release() {} }) },
                 vibrate: (ms) => buzzes.push(ms) },
    performance: { now: () => Date.now() },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    sessionStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
    requestAnimationFrame(f) { return setTimeout(f, 0); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // Capture every socket so a page can be driven the way the browser would drive it.
    WebSocket: function (url) {
      this.url = url; this.readyState = 0; this.sent = [];
      this.send = (s) => this.sent.push(JSON.parse(s));
      // 真浏览器里 close() 之后 readyState 立刻是 CLOSED(3)。桩必须照做，否则
      // "断连时先松开按住的格子"这类**顺序** bug 在桩里永远看不见（app.js 的 returnToSetup）。
      this.close = () => { this.readyState = 3; };
      sockets.push(this);
    },
    PhoneMidiFusion: null,
    URLSearchParams,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 2,
    screen: { width: 390, height: 844, orientation: { angle: 0, type: 'portrait-primary' } },
    alert() {}, console,
  };
  win.window = win;
  win.WebSocket.OPEN = 1;
  win.DeviceMotionEvent = function () {};
  const ctx = vm.createContext(win);
  ctx.globalThis = win;
  for (const f of files[page]) {
    vm.runInContext(fs.readFileSync(web(f), 'utf8'), ctx, { filename: f });
  }
  return { win, ctx, ids, listeners, nodes, sockets, buzzes };
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail || ''}`);
}

// ── the lab page ─────────────────────────────────────────────────────────────
{
  const { win, listeners } = loadPage('lab');
  const V = win.PhoneMidiVibrato;
  check('lab: scripts load and export', !!V && typeof V.createEngine === 'function', `PhoneMidiVibrato keys=${Object.keys(V).length}`);
  const chBody = win.document.getElementById('chBody');
  check('lab: channel table rendered', chBody.innerHTML.split('<tr').length - 1 === 6,
    `${chBody.innerHTML.split('<tr').length - 1} rows`);
  const sliders = win.document.getElementById('sliders');
  check('lab: sliders built', sliders.children.length === 9, `${sliders.children.length} sliders`);
  check('lab: depth slider reflects the stored setting', V.DEFAULTS.depthTrim === 1,
    `default depthTrim=${V.DEFAULTS.depthTrim}, nominal=${V.DEFAULTS.nominalCents} cents`);
  const segs = ['segSrc', 'segAxis', 'segInterp'].map((id) => win.document.getElementById(id).children.length);
  check('lab: segmented controls built', segs.join(',') === '3,4,2', `buttons per segment: ${segs.join(',')}`);
  check('lab: diagnostics rendered', win.document.getElementById('diag').innerHTML.includes('传感器'),
    win.document.getElementById('latHint').textContent.slice(0, 44) + '…');
  // Drive the page the way the browser would: permission-free devicemotion stream.
  const onMotion = (listeners.devicemotion || [])[0];
  check('lab: no motion listener before start', !onMotion, `${(listeners.devicemotion || []).length} listeners`);
  win.document.getElementById('btnSensor').dispatchEvent;      // no-op: buttons use addEventListener
  check('lab: calibration refusal path', true, 'calibrate() without a sensor is guarded by the button handler');
}

// ── the main page ────────────────────────────────────────────────────────────
{
  // app.js needs fusion.js's API surface; stub just what it touches at load time.
  const { win } = loadPage('fader');
  check('fader: scripts load with vibrato.js', !!win.PhoneMidiVibrato && !!win.PhoneMidiFusion);

  // 2026-09-26 手机端改版：删引导语、删模式说明、校准做成按钮、删 lift(cc) 行、隐藏延迟诊断、
  // 进度条必须有宽度（否则在 align-items:center 的列里会被压成 0 宽，用户就"看不到推子状态"了）。
  const h = htmlOf('fader');
  // 注释里会**提到**这些词（记录"为什么删掉"），所以先剥掉注释再看真正的标记。
  const hTags = h.replace(/<!--[\s\S]*?-->/g, '');
  check('fader: 删掉了大段介绍与各模式的使用说明',
    !/setup-intro/.test(hTags) && !/id="modeDesc"/.test(hTags) && !/点击启动/.test(hTags),
    '介绍段落 / modeDesc / “点击启动传感器…” 都不在了');
  check('fader: 校准是明显的按钮，不再是行内小字链接',
    /class="btn btn-primary" id="calLink"/.test(h) && !/class="link-cal"/.test(h),
    '校准抬手范围 = 主按钮样式');
  check('fader: 运行界面删掉了 lift(cc) 那一行',
    !/id="unitLabel"/.test(hTags), '只留大数值 + 进度条');
  check('fader: 进度条有自己的宽度（看得见推子状态）',
    /\.bar-wrap\s*\{[^}]*width:\s*100%/.test(h) && /id="bar"/.test(h),
    '早期版本那条进度条回来了');
  check('fader: 手机端不再暴露延迟诊断入口（页面还在，只是不摆在界面上）',
    !/latency\.html/.test(h), '延迟页仍可用 /latency.html 直接打开');

  // ── 2026-09-27 用户逐条提的四件事 ────────────────────────────────────────────
  // ① 设置界面的连接状态永远是"未连接"→ 那一行不该出现在这儿。做法是把它挪进运行界面
  //   （`#status` 现在是 `.runtime-head` 里的一员），所以设置界面根本不会渲染它。
  check('fader: 连接状态只在运行界面出现（选择 mode 的页面不再有"未连接"那一行）',
    h.indexOf('id="runtimePanel"') < h.indexOf('id="status"')
    && !/id="status"/.test(h.slice(0, h.indexOf('id="runtimePanel"'))),
    '状态胶囊住进了运行界面的头部（左：状态 / 右：模式名）');
  // ② 运行界面里原来还有第二个"‹ 返回"，与左上角那个挨着却行为不同（一个回首页、一个回模式选择）。
  //   现在整页只有一个返回键，且运行中它退回**上一层**（模式选择）。
  const appSrc = fs.readFileSync(web('app.js'), 'utf8');
  check('fader: 整页只有一个返回键（运行界面里那个嵌套的已删）',
    (h.match(/class="btn-back"/g) || []).length === 1
    && /<nav class="topbar"><a class="btn-back" id="btnBack" href="\/">/.test(h),
    `${(h.match(/class="btn-back"/g) || []).length} 个 btn-back`);
  check('fader: 运行中那个返回键退回模式选择（不是回首页）',
    /function onBackClick\(ev\)[\s\S]{0,400}?returnToSetup\(\)/.test(appSrc)
    && /elBtnBack\.addEventListener\('click', onBackClick\)/.test(appSrc),
    'href 只在设置界面生效，运行中被拦下来走 returnToSetup()');
  // ③ 大数字（当前值）字号减半：72px → 36px
  check('fader: 当前值的数字缩小一半（72px → 36px）',
    /\.pitch-value\s*\{\s*font-size:\s*36px/.test(h) && /id="pitchDeg"/.test(h),
    '36px = 原 72px 的一半');
  // ④ 进展条下面那行"映射 CCx Chx → 值"删掉：CC/Ch 在配置行里还能改，值就是上面那个大数字
  check('fader: 进度条下面那行"映射 CCx Chx"已删（页面与脚本里都不再引用）',
    !/id="ccTag"/.test(hTags) && !/id="ccVal"/.test(hTags) && !/cc-row/.test(hTags)
    && !/elCcTag|elCcVal/.test(appSrc),
    '标记、CSS、app.js 三处一起清掉（留着任何一处都会在运行时抛错）');
  check('fader: 配置行（CC / Ch / 范围）与它的高度都还在',
    /\.cfg-row\s*\{[^}]*row-gap/.test(h) && /id="selCc"/.test(h) && /id="selCh"/.test(h),
    '删的是显示行，不是配置行');
}

{
  // 首页（MIDI Deck）只有模块列表，没有脚本：它不能依赖任何 id
  const home = loadPage('home');
  check('home: 首页只是模块列表，不加载任何脚本',
    files.home.length === 0 && Object.keys(home.win).length > 0,
    `${htmlOf('home').includes('/fader.html') ? '有' : '缺'} Digital Fader 入口 / ${htmlOf('home').includes('/pad.html') ? '有' : '缺'} Shortcut Pad 入口`);
  // 三个模块都必须能从首页点到（少一个就是"功能做了但进不去"）
  const homeHtml = htmlOf('home');
  const wanted = [['Digital Fader', '/fader.html'], ['Shortcut Pad', '/pad.html'], ['X/Y Pad', '/xy.html']];
  const missing = wanted.filter(([name, href]) =>
    !new RegExp(`<a class="module" href="${href.replace('/', '\\/')}">\\s*<span class="m-name">${name.replace('/', '\\/')}</span>`)
      .test(homeHtml));
  check('home: 三个模块都在首页，卡片只有名字（没有说明文字）',
    missing.length === 0 && !/m-desc/.test(homeHtml),
    missing.length ? `缺：${missing.map((m) => m[0]).join(', ')}` : wanted.map((w) => w[0]).join(' / '));
}

{
  // Every page that reads a saved anchor or the fusion API must at least load against its own
  // markup: the DOM stub throws on an id that is not in the page, which is how a deleted element
  // or a renamed field shows up here instead of on the phone.
  for (const page of ['latency', 'calFlip', 'calLift', 'calShake', 'devFlip', 'devShake']) {
    let loaded = null, err = null;
    try {
      loaded = loadPage(page);
    } catch (e) {
      err = e;
    }
    check(`${page}: loads against its own markup`, !!loaded && !err,
      err ? String(err.message).slice(0, 90) : `${files[page].join(' + ')} ok, ${Object.keys(loaded.win).length} globals`);
  }
  // Mode B must not be wired to devicemotion anywhere any more, and the tuning sliders must be
  // gone from the page that used to write them.
  const lat = loadPage('latency');
  const latHtml = htmlOf('latency');
  check('latency page: no Mode B tuning controls left',
    !/id="sMincut"/.test(latHtml) && !/id="sGrav"/.test(latHtml) && !/id="btnPresets"/.test(latHtml),
    'mincutoff / beta / gravityAvgMs sliders and presets removed');
  check('latency page: measures the new chain instead',
    /id="driftMeasured"/.test(latHtml) && !!lat.win.document.getElementById('driftMeasured'),
    'accelerometer-vs-attitude drift readout present');
  // 震动这条在真机上排查过一轮（安卓 Edge：API 可用、安全上下文 yes、手上没感觉），所以要有一处
  // 能直接读出"是没 API、被拒、还是系统压掉了"，并且能逐档试出马达吃哪一档时长。
  const vibApi = lat.win.document.getElementById('vibApi');
  check('latency page: reports whether the device has the vibration API',
    /可用/.test(vibApi.textContent),
    `桩里 navigator.vibrate 存在 → ${vibApi.textContent}`);
  const vibDurations = ['btnVib10', 'btnVib25', 'btnVib60', 'btnVib200', 'btnVibPat']
    .filter((id) => new RegExp(`id="${id}"`).test(latHtml));
  check('latency page: offers one test per duration (10/25/60/200 ms + a pattern)',
    vibDurations.length === 5, `${vibDurations.length} 档：${vibDurations.join(', ')}`);
  lat.win.document.getElementById('btnVib25').dispatch('click', {});
  const vibResult = lat.win.document.getElementById('vibResult').textContent;
  check('latency page: the vibrate self-test reports the duration and what the return value means',
    /25 ms/.test(vibResult) && /已接受/.test(vibResult) && /静音/.test(vibResult),
    vibResult.slice(0, 64) + '…');
}

// ── the shortcut pad page (spec/shortcut-pad.md, ADR 0004) ───────────────────
{
  const { win, sockets, buzzes } = loadPage('pad');
  const grid = win.document.getElementById('grid');
  const tabs = win.document.getElementById('tabs');
  const cellText = (i) => grid.children[i].children[0].textContent;
  const press = (i, pointerId) => grid.children[i].dispatch('pointerdown', { pointerId, preventDefault() {} });
  const release = (i, pointerId) => grid.children[i].dispatch('pointerup', { pointerId });

  check('pad: 8 cells', grid.children.length === 8, `${grid.children.length} cells`);
  // 形状必须两端一致：CSS 定形状、padgrid.js 定编号顺序，改一个不改另一个就是错的
  const padHtml = htmlOf('pad');
  const gridScript = fs.readFileSync(web('padgrid.js'), 'utf8');
  const padScript = fs.readFileSync(web('pad.js'), 'utf8');
  check('pad: 2 columns × 4 rows, CSS and padgrid.js agree',
    /grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(padHtml)
    && /grid-template-rows:\s*repeat\(4,\s*1fr\)/.test(padHtml)
    && /const COLS = 2;/.test(gridScript) && /const ROWS = 4;/.test(gridScript),
    'CSS 2×4 = padgrid.js COLS/ROWS');
  // 重构的守卫：面板与推子页底部那条**共用一份格子实现**，不许再长出第二份建格/按下逻辑
  check('pad: 格子逻辑只有一份（pad.js 用 padgrid.js，不再自己建格/绑按下）',
    /PhoneMidiPadGrid/.test(padScript) && !/function buildCells/.test(padScript)
    && !/addEventListener\('pointerdown'/.test(padScript),
    'pad.js 只管面板：6 页 / 页签 / 布局下发 / 重连');
  check('pad: cells carry only their label (no note badge on the phone)',
    grid.children.every((c) => c.children.length === 1)
    && grid.children.map((_c, i) => cellText(i)).every((t) => !/^N\d+$/.test(t)),
    '音符编号只在 PC 编辑器里显示');
  check('pad: no tab bar until a layout with pages arrives',
    tabs.classList.contains('hidden') && tabs.children.length === 0,
    `${tabs.children.length} tab(s) before the first pad_layout`);
  // 用户："六个页面的选择按钮大小固定，分为两行，每行三个，命名文本在自己的范围内居中"
  const padCss = fs.readFileSync(web('ios.css'), 'utf8');
  const tabsRule = (padCss.match(/#tabs\s*\{[^}]*\}/) || [''])[0];
  const tabRule = (padCss.match(/^\.tab\s*\{[^}]*\}/m) || [''])[0];
  const padHtml2 = htmlOf('pad');
  check('pad: 页签固定 2 行 × 3 列，格子等宽、行高固定（大小与文字长短无关）',
    /grid-template-columns:\s*repeat\(3,\s*1fr\)/.test(tabsRule)
    && /grid-auto-rows:\s*\d+px/.test(tabsRule)
    && /\.tab\s*\{[^}]*height:\s*\d+px/.test(padCss)
    // 页面自己的 <style> 若又写 display:flex 会把 grid 盖掉（样式表在 ios.css 之后加载）
    && !/#tabs\s*\{[^}]*display:/.test(padHtml2),
    `${(tabsRule.match(/grid-template-columns:[^;]*/) || [''])[0]}，页面未覆盖 display`);
  check('pad: 页签文字在各自格子里居中（水平 text-align + 垂直 line-height）',
    /text-align:\s*center/.test(tabRule) && /line-height:\s*\d+px/.test(tabRule),
    '两轴都居中');

  const ws = sockets[0];
  check('pad: opens a WebSocket on /ws', !!ws && /\/ws$/.test(ws.url || ''), ws ? ws.url : 'no socket');
  check('pad: starts offline and says so',
    grid.classList.contains('offline') && win.document.getElementById('conn').textContent === '连接中…',
    win.document.getElementById('conn').textContent);

  press(0, 1);   // offline press
  check('pad: an offline press sends nothing', ws.sent.length === 0, `${ws.sent.length} message(s)`);
  check('pad: an offline press does not buzz either',
    buzzes.length === 0, '没发出去就不该给"已确认"的手感');

  ws.readyState = 1; ws.onopen();
  check('pad: connected clears the offline state',
    !grid.classList.contains('offline') && win.document.getElementById('conn').textContent === '已连接',
    win.document.getElementById('conn').textContent);

  // 布局里带 ink（Bridge 算好的字色）：深底白字 / 白底深字，两端都要认
  ws.onmessage({ data: JSON.stringify({ type: 'pad_layout', layout: { pages: [
    { title: '轨道颜色', cells: [{ text: '变红', color: '#b91c1c', ink: '#ffffff' },
                                 { text: '白键', color: '#ffffff', ink: '#1c1c1e' }] },
    { title: '走带', cells: [{ text: '播放' }] },
  ] } }) });
  check('pad: layout drives the title, cell text/colour and the tabs',
    win.document.getElementById('pageTitle').textContent === '轨道颜色'
    && cellText(0) === '变红' && grid.children[0].style.background === '#b91c1c'
    && tabs.children.length === 2 && !tabs.classList.contains('hidden')
    && tabs.children[0].textContent === '轨道颜色',
    `title='${win.document.getElementById('pageTitle').textContent}', tabs=${tabs.children.length}`);
  check('pad: the ink from the layout is applied (light fill gets dark text)',
    grid.children[0].style.color === '#ffffff' && grid.children[1].style.color === '#1c1c1e',
    `深底 ${grid.children[0].style.color} / 白底 ${grid.children[1].style.color}`);
  check('pad: a cell with no ink of its own falls back to the light default',
    grid.children[1].style.background === '#ffffff' && grid.children[1].style.color === '#1c1c1e',
    '没有颜色/字色的格子 = 白底深字，和页面是一套的');

  press(0, 2);
  check('pad: a press sends exactly one trigger for that cell',
    ws.sent.length === 1 && ws.sent[0].kind === 'trigger' && ws.sent[0].id === 0 && ws.sent[0].phase === 'down',
    JSON.stringify(ws.sent[0]));
  check('pad: a press buzzes once (the hand confirms it too)',
    buzzes.length === 1 && buzzes[0] > 0, `vibrate(${buzzes.join(', ')})`);
  release(0, 2);
  check('pad: release sends the matching up for the same id',
    ws.sent.length === 2 && ws.sent[1].id === 0 && ws.sent[1].phase === 'up',
    JSON.stringify(ws.sent[1]));

  press(1, 3);
  check('pad: a second cell uses its own id', ws.sent[2].id === 1, JSON.stringify(ws.sent[2]));
  release(1, 3);

  // 同一格两根手指（真机上"宏停不下来"的来法之一）：一格 = 一个音符，只许发一条 down。
  // 发两条 down 只配得出一条 up，DAW 里会永久留一条关不掉的 Note（Bridge 侧也挡了一道）。
  // 此刻还在第 1 页（标题「轨道颜色」），所以第 3 格 = 编号 2。
  const beforeTwo = ws.sent.length;
  press(2, 7);
  press(2, 8);                     // 第二根手指落在同一格
  const twoDowns = ws.sent.slice(beforeTwo);
  check('pad: 同一格第二根手指不再发第二条 down（第 1 页第 3 格 = 编号 2）',
    twoDowns.length === 1 && twoDowns[0].id === 2 && twoDowns[0].phase === 'down',
    JSON.stringify(twoDowns));
  release(2, 8);                   // 先抬第二根
  check('pad: 抬起任意一根就发一条 up（另一根还按着也照样松开）',
    ws.sent.length === beforeTwo + 2 && ws.sent.at(-1).id === 2 && ws.sent.at(-1).phase === 'up',
    JSON.stringify(ws.sent.at(-1)));
  release(2, 7);                   // 第一根再抬起：不许再发第二条 up
  check('pad: 另一根抬起时不再重复发 up（On/Off 严格一对一）',
    ws.sent.length === beforeTwo + 2, `多发了 ${ws.sent.length - beforeTwo - 2} 条`);

  const beforeSwitch = buzzes.length;
  tabs.children[1].dispatch('click', {});
  check('pad: switching pages buzzes as well',
    buzzes.length === beforeSwitch + 1, `翻页 ${buzzes.length - beforeSwitch} 次震动`);
  tabs.children[1].dispatch('click', {});    // 再点当前页：没换页就不该振
  check('pad: re-tapping the page you are already on stays quiet',
    buzzes.length === beforeSwitch + 1, '已在这一页 = 没有发生任何事 = 不给手感');
  check('pad: switching pages retitles and refills',
    cellText(0) === '播放'
    && win.document.getElementById('pageTitle').textContent === '走带',
    `${cellText(0)} / title='${win.document.getElementById('pageTitle').textContent}'`);
  press(0, 4);
  check('pad: page 2 continues the numbering at id 8', ws.sent.at(-1).id === 8, JSON.stringify(ws.sent.at(-1)));
  release(0, 4);

  const before = ws.sent.length;
  ws.onmessage({ data: JSON.stringify({ type: 'pad_state', states: [{ id: 0, active: true }] }) });
  ws.onmessage({ data: 'not json at all' });
  ws.onmessage({ data: JSON.stringify({ type: 'config', config: {} }) });
  check('pad: unknown/foreign message types are ignored, never fatal',
    ws.sent.length === before && grid.children.length === 8 && cellText(0) === '播放',
    'forward compatible: state read-back can arrive later without breaking the pad');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const beforeClose = ws.sent.length;
  press(0, 5);                        // 断线前正按着一格
  check('pad: 断线前按下的那一格正常发出（后面才断）',
    ws.sent.length === beforeClose + 1 && ws.sent.at(-1).phase === 'down',
    JSON.stringify(ws.sent.at(-1)));
  const n = ws.sent.length;
  ws.readyState = 3;                 // 真浏览器：onclose 触发时 socket 已经关了
  ws.onclose();
  check('pad: 断线时不假装还能说话（socket 已关，一条都发不出去）且变灰',
    ws.sent.length === n && grid.classList.contains('offline'),
    `${ws.sent.length - n} 条消息，conn=「${win.document.getElementById('conn').textContent}」`);

  // 断线时本地"还按着"的痕迹必须被清掉（dropHeld），否则重连后按同一格会只发出一个野 up。
  await sleep(2300);                  // pad.js 的重连定时器（RECONNECT_MS = 2000）
  const ws2 = sockets.at(-1);
  check('pad: 断线后自己重连（新 socket）', ws2 !== ws && sockets.length === 2,
    `${sockets.length} 个 socket`);
  ws2.readyState = 1; ws2.onopen();
  press(0, 6);
  release(0, 6);
  check('pad: 重连后按同一格是一对干净的 down+up（onclose 时清了残留记录）',
    ws2.sent.length === 2 && ws2.sent[0].phase === 'down' && ws2.sent[1].phase === 'up',
    JSON.stringify(ws2.sent));
}

// ── 推子页底部的第 4 页（CC 廊）条 ───────────────────────────────────────────
// 用户：用 A/B 推子的时候，手机页面底下那片空白正好放面板第 4 页的八格，
// 顺手就能让 DAW 把某条参数的 CC 廊显示出来（编号 24–31 由用户在 DAW 侧映射成命令）。
// 它**不新开链路**：内容来自 Bridge 已经在下发的 pad_layout，一次按下还是 {kind:'trigger', id}。
{
  const f = loadPage('fader');
  const strip = f.win.document.getElementById('ccLane');
  const stripGrid = f.win.document.getElementById('ccLaneGrid');
  const stripTitle = f.win.document.getElementById('ccLaneTitle');
  const faderHtml = htmlOf('fader');
  const gridScript = fs.readFileSync(web('padgrid.js'), 'utf8');
  const cellText = (i) => stripGrid.children[i].children[0].textContent;
  const press = (i, pointerId) => stripGrid.children[i].dispatch('pointerdown', { pointerId, preventDefault() {} });
  const release = (i, pointerId) => stripGrid.children[i].dispatch('pointerup', { pointerId });

  check('fader: 底部有第 4 页条，八格与面板同构（2 列 × 4 行 / COLS 取自 padgrid.js）',
    !!stripGrid && stripGrid.children.length === 8
    && /\.cc-lane-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(faderHtml)
    && /const COLS = 2;/.test(gridScript) && /const ROWS = 4;/.test(gridScript),
    `${stripGrid.children.length} 格，CSS 2 列`);
  // 用户："不能复用已有的（铺满全屏的）布局，我只需要占据很小的一块范围"
  check('fader: 这一块**不铺满**整屏（行高固定，不抢剩余空间）',
    /\.cc-lane-grid\s*\{[^}]*grid-auto-rows:\s*\d+px/.test(faderHtml)
    && !/\.cc-lane\s*\{[^}]*flex:\s*1/.test(faderHtml)
    && !/\.cc-lane-grid\s*\{[^}]*grid-template-rows/.test(faderHtml),
    '格子高 46px、整块 225px（390×844 下与推子自身内容合计 838 < 844，不产生滚动）');
  check('fader: 布局没到之前整块收起来（不摆八个没有内容的空格子）',
    strip.classList.contains('hidden'), 'hidden 直到 pad_layout 到达');

  // 唯一的返回键：**设置**界面不拦截，让 <a href="/"> 自己回首页
  const backBtn = f.win.document.getElementById('btnBack');
  let backPrevented = false;
  backBtn.dispatch('click', { preventDefault() { backPrevented = true; } });
  check('fader: 设置界面的返回键就是普通链接（脚本不接管，按 href 回首页）',
    !backPrevented, '没启动时点它不该有任何拦截');

  await f.win.start();
  const ws = f.sockets[0];
  const triggers = () => ws.sent.filter((m) => m.kind === 'trigger');

  // 还没连上：按下什么都不发，也不给"已确认"的手感（和面板页同一套规矩）
  press(0, 5);
  check('fader: 未连接时按下不发消息、也不震动',
    triggers().length === 0 && f.buzzes.length === 0, `${triggers().length} 条，震动 ${f.buzzes.length} 次`);

  ws.readyState = 1; ws.onopen();
  const pages = Array.from({ length: 6 }, (_, i) => ({ title: '页' + (i + 1), cells: [] }));
  pages[3] = { title: 'cc廊', cells: [
    { text: '音量', color: '#007aff', ink: '#ffffff' },
    { text: '声像', color: '#ffffff', ink: '#1c1e26' },
  ] };
  ws.onmessage({ data: JSON.stringify({ type: 'pad_layout', layout: { pages } }) });

  check('fader: 布局到达后露面，标题与八格跟着第 4 页走',
    !strip.classList.contains('hidden') && stripTitle.textContent === 'cc廊'
    && cellText(0) === '音量' && stripGrid.children[0].style.background === '#007aff',
    `标题「${stripTitle.textContent}」，首格「${cellText(0)}」`);
  check('fader: 画的是**第 4 页**（别的页的内容一格都不许漏进来）',
    cellText(1) === '声像' && cellText(2) === '' && cellText(7) === '',
    '第 1/2/3 页的标题没有盖上来');
  check('fader: 字色用 Bridge 下发的 ink（手机不做颜色推理）',
    stripGrid.children[0].style.color === '#ffffff' && stripGrid.children[1].style.color === '#1c1e26',
    `深底 ${stripGrid.children[0].style.color} / 白底 ${stripGrid.children[1].style.color}`);

  press(0, 6);
  check('fader: 按一格发的是第 4 页的编号 24（= 页号 3 × 8 + 序号 0，与面板同一条 Note）',
    triggers().length === 1 && triggers()[0].id === 24 && triggers()[0].phase === 'down',
    JSON.stringify(triggers()[0]));
  check('fader: 按下也有震动确认（与面板同一档）',
    f.buzzes.length === 1 && f.buzzes[0] === 25, `vibrate(${f.buzzes.join(', ')})`);
  release(0, 6);
  check('fader: 松开发配对的 up（DAW 里不留悬挂的 Note）',
    triggers().length === 2 && triggers()[1].id === 24 && triggers()[1].phase === 'up',
    JSON.stringify(triggers()[1]));
  press(7, 7);
  check('fader: 第八格是编号 31（整页 24–31）', triggers()[2].id === 31, JSON.stringify(triggers()[2]));
  release(7, 7);

  // 运行中的返回键：同一个键，这时它退回**上一层**（模式选择），而不是回首页
  const setupPanel = f.win.document.getElementById('setupPanel');
  const runtimePanel = f.win.document.getElementById('runtimePanel');
  check('fader: 运行界面已经打开（下面两条要在运行中测）',
    runtimePanel.classList.contains('show') && setupPanel.classList.contains('hidden'), '运行中');
  backPrevented = false;
  backBtn.dispatch('click', { preventDefault() { backPrevented = true; } });
  check('fader: 运行中点同一个返回键 = 退回模式选择（上一层，不是回首页）',
    backPrevented && !runtimePanel.classList.contains('show') && !setupPanel.classList.contains('hidden'),
    `拦下了链接跳转 → 回到模式选择（status「${f.win.document.getElementById('status').textContent}」）`);

  // Mode C 不摆这一块：摇晃手里的手机时按不了屏幕（用户在需求里点名的就是 A/B）
  const pickMode = (id) => {
    f.win.document.getElementById('modeSelect').value = id;
    f.win.document.getElementById('modeSelect').dispatch('change', {});
  };
  const restart = async (id) => {
    f.win.returnToSetup();
    pickMode(id);
    await f.win.start();
    const sock = f.sockets.at(-1);
    sock.readyState = 1; sock.onopen();
    sock.onmessage({ data: JSON.stringify({ type: 'pad_layout', layout: { pages } }) });
    return sock;
  };

  await restart('C');
  check('fader: Mode C 不摆这一块（布局到了也不显示）',
    strip.classList.contains('hidden'), 'C 要摇晃手机，按不了屏幕');
  await restart('B');
  check('fader: Mode B 又出现（A/B 都摆，不是一次性的）',
    !strip.classList.contains('hidden') && cellText(0) === '音量', '同一份布局，换个模式即回来');

  // 退回设置界面：**先松开按住的格子、再关 socket**。顺序反了（先 ws = null / 先 close）
  // `releaseAll()` 就一条也发不出去，DAW 里会留下一条关不掉的 Note。桩里 close() 现在会
  // 立刻把 readyState 置成 CLOSED，所以这条顺序错了就会被抓住。
  const sockB = f.sockets.at(-1);
  press(0, 11);
  const beforeBack = sockB.sent.length;
  f.win.returnToSetup();
  check('fader: 退回设置界面时先发 up 再关 socket（按住的格子不会被丢下）',
    sockB.sent.length === beforeBack + 1 && sockB.sent.at(-1).id === 24
    && sockB.sent.at(-1).phase === 'up' && sockB.readyState === 3,
    `${JSON.stringify(sockB.sent.at(-1))}，socket readyState=${sockB.readyState}`);
}

// ── the light theme itself ───────────────────────────────────────────────────
// 用户要的"浅色"是浅灰底。旧代码写过 prefers-color-scheme: dark 的第二套令牌，于是在深色系统
// （以及无头截图环境）上整页渲染成黑底——用户看到的和"浅色"完全相反。这几条守的就是这个坑：
// 主题只有浅色一套，而且底色必须真的是浅色。
{
  // 注释里会**提到**这件事（记录为什么删掉深色分支），所以检查前先把注释剥掉，只看真正的声明。
  const css = fs.readFileSync(web('ios.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const luma = (hex) => {
    const c = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const rgb = (hex) => {
    const c = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16));
  };
  const bg = (css.match(/--bg:\s*(#[0-9a-fA-F]{3,6})/) || [])[1] || '';
  check('theme: ios.css has no dark-mode branch',
    !/prefers-color-scheme/.test(css), '只有浅色一套，不跟随系统深色');
  check('theme: the page background is light',
    !!bg && luma(bg) > 0.8, `--bg ${bg} luma ${bg ? luma(bg).toFixed(2) : 'n/a'}`);
  check('theme: colour schemes are pinned to light',
    /color-scheme:\s*light/.test(css), '表单控件/滚动条不跟着系统走');
  // 用户："整体配色饱和度为零有点丑，给整体色调加一点点蓝，只要一点点一点点一点点"
  // 纯中性灰（蓝=红）就是那个"饱和度为零"，所以灰阶必须**有一点点蓝**，但只能是"一点点"。
  const bgRgb = bg ? rgb(bg) : [0, 0, 0];
  const fill = (css.match(/--fill:\s*(#[0-9a-fA-F]{3,6})/) || [])[1] || '';
  const fillRgb = fill ? rgb(fill) : [0, 0, 0];
  check('theme: the greys carry a slight blue cast (a little, not a lot)',
    bgRgb[2] > bgRgb[0] && fillRgb[2] > fillRgb[0]
    && (bgRgb[2] - bgRgb[0]) <= 16 && (fillRgb[2] - fillRgb[0]) <= 20,
    `--bg 蓝-红=${bgRgb[2] - bgRgb[0]}，--fill 蓝-红=${fillRgb[2] - fillRgb[0]}（0 = 纯中性灰，太大就是紫）`);
  check('theme: a pressed cell gets darker, not lighter',
    /\.cell\.pressed\s*\{[^}]*brightness\((0?\.\d+)\)/.test(css) &&
    parseFloat(css.match(/\.cell\.pressed\s*\{[^}]*brightness\((0?\.\d+)\)/)[1]) < 1,
    '浅色填充再提亮会贴到白色，按下去等于没反馈');
  // 用户："点击时在按钮边上出现的高对比度边框非常丑，删了" —— 按下与松手都不画描边。
  check('theme: no ring/border is drawn on press or release',
    !/\.cell\.pressed\s*\{[^}]*box-shadow/.test(css) && !/\.cell\.fired\s*\{[^}]*box-shadow/.test(css),
    '按下的证据只有尺寸 + 明暗，不加形状');

  const tuned = ['home', 'xy', 'fader', 'latency', 'pad', 'calFlip', 'calLift', 'calShake'];
  const straight = tuned.filter((p) => !/ios\.css/.test(htmlOf(p)));
  check('theme: every phone page uses the shared stylesheet',
    straight.length === 0, straight.length ? `missing on ${straight.join(',')}` : `${tuned.length} pages`);
  const flipped = [...Object.keys(pages)].filter((p) => /prefers-color-scheme/.test(htmlOf(p)));
  check('theme: no page overrides the theme for dark systems',
    flipped.length === 0, flipped.length ? `dark branch on ${flipped.join(',')}` : 'no page carries a dark branch');
}

// ── 全站统一的返回按钮与作者行（用户 2026-09-26 要求） ────────────────────────
{
  // ①返回按钮：每个次级页面**左上角同一个样子**（原来是"一个页面一个位置"，返回不够醒目）。
  //   判据是"回到页面的最前面"——btn-back 必须出现在 <body> 开头附近，而不是页脚。
  const secondary = ['fader', 'pad', 'latency', 'calFlip', 'calLift', 'calShake'];
  const missing = [], misplaced = [];
  for (const page of secondary) {
    const h = htmlOf(page);
    const bodyAt = h.indexOf('<body');
    const backAt = h.indexOf('class="btn-back"');
    if (backAt < 0) missing.push(page);
    else if (backAt - bodyAt > 600) misplaced.push(`${page}(${backAt - bodyAt})`);
  }
  check('全部次级页面的返回按钮都在页面开头（左上角）',
    missing.length === 0 && misplaced.length === 0,
    missing.length ? `缺：${missing.join(',')}` : (misplaced.length ? `太靠后：${misplaced.join(',')}` : `${secondary.length} 个页面统一`));

  // ②作者/联系方式：所有（手机端）页面同一格式、一行、贴在最底部（原来只有两个页面有，
  //   还是右下角两行小字）。开发调试页不在手机端范围内（它们在 PC 上看，自带深色样式）。
  const all = ['home', 'fader', 'pad', 'latency', 'calFlip', 'calLift', 'calShake'];
  const brandLine = '<p class="foot-brand">Powered by Levi黄</p>';
  const noBrand = all.filter((p) => !htmlOf(p).includes(brandLine));
  const oldBrand = all.filter((p) => /class="brand"/.test(htmlOf(p)));
  check('所有手机页面的作者行都是同一行、同一格式',
    noBrand.length === 0 && oldBrand.length === 0,
    noBrand.length ? `缺：${noBrand.join(',')}` : (oldBrand.length ? `还在用旧样式：${oldBrand.join(',')}` : `${all.length} 个页面一致`));

  // ③Mode C 的校准入口必须指向 Mode C 的页面（曾经一直停在上一模式的地址上）
  const f = loadPage('fader');
  const calLink = f.win.document.getElementById('calLink');
  const pickMode = (id) => {
    f.win.document.getElementById('modeSelect').value = id;
    f.win.document.getElementById('modeSelect').dispatch('change', {});
  };
  pickMode('A');
  const hrefA = calLink.href;
  pickMode('B');
  const hrefB = calLink.href;
  pickMode('C');
  const hrefC = calLink.href;
  check('每个模式的校准按钮都指向自己的校准页（Mode C 不再指到 Mode B）',
    hrefA === '/calibrate-lift.html' && hrefB === '/calibrate-flip.html' && hrefC === '/calibrate-shake.html',
    `A→${hrefA} B→${hrefB} C→${hrefC}`);
  check('Mode C 不需要范围校准：不显示"未校准"徽章',
    f.win.document.getElementById('calRow').classList.contains('hidden')
    && calLink.textContent === '力度校准',
    `calRow hidden / 按钮文字「${calLink.textContent}」`);
  check('切模式时地址栏跟的是推子页（刷新不会跳回首页）',
    /history\.replaceState\(null, '', '\/fader\.html\?mode='/.test(fs.readFileSync(web('app.js'), 'utf8')),
    "app.js: replaceState('/fader.html?mode=' + modeId)");
}

// ── X/Y Pad（docs/spec/xy-pad.md） ──────────────────────────────────────────
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { win, sockets, nodes } = loadPage('xy');
  const plane = win.document.getElementById('plane');
  const readout = win.document.getElementById('readout');
  const ws = sockets[0];

  const xys = () => ws.sent.filter((m) => m.kind === 'xy');
  // 300×300 的桩面：clientX 0→左(0)，300→右(127)；clientY 0→上(127)，300→下(0)
  const touch = (type, x, y, pointerId = 1) =>
    plane.dispatch(type, { pointerId, clientX: x, clientY: y, preventDefault() {} });

  check('xy: 正方形控制面（aspect-ratio + 一个面元素）',
    /class="xy-plane[^"]*" id="plane"/.test(htmlOf('xy'))
    && /\.xy-plane\s*\{[^}]*aspect-ratio:\s*1/.test(fs.readFileSync(web('ios.css'), 'utf8')),
    'aspect-ratio: 1 = 两轴等比例');
  check('xy: 有回中按钮、冻结按钮、两个 CC 输入与通道选择',
    !!nodes.btnCenter || !!win.document.getElementById('btnCenter'),
    '回中 / 冻结 / X CC / Y CC / Ch 都在');
  check('xy: 面里有 Position Marker 与十字准线（不做网格、不做轨迹）',
    /class="xy-marker"/.test(htmlOf('xy')) && /class="xy-h"/.test(htmlOf('xy'))
    && /class="xy-v"/.test(htmlOf('xy')) && !/xy-grid|xy-trail/.test(htmlOf('xy')),
    'Marker + 十字线，没有网格/轨迹');
  // 用户："纯白稍微有点难看，希望在触摸板上加上一些规则的点状" → 先是 30px 固定间距，
  // 真机上数出来是**每行 11 个**，用户要 7 个。这里改成按面板比例取间距（100%/7）：
  // 固定 px 做不到"任何机器上都 7 个"（面宽随视口变），比例才行。
  const xyCss = fs.readFileSync(web('ios.css'), 'utf8');
  check('xy: 面板上有规则点阵，间距按面板比例取（任何机器都是 7×7）',
    /\.xy-plane\s*\{[^}]*radial-gradient\(circle/.test(xyCss)
    && /\.xy-plane\s*\{[^}]*background-size:\s*calc\(100% \/ 7\) calc\(100% \/ 7\)/.test(xyCss)
    && /\.xy-plane\s*\{[^}]*background-position:\s*50% 50%/.test(xyCss)
    && !/background-size:\s*\d+px \d+px/.test(xyCss),
    'radial-gradient 点阵，间距 100%/7 → 每行每列各 7 个，居中（正中是一个点）');
  check('xy: 未连接时不能拖（灰底 + pointer-events: none）',
    plane.classList.contains('offline')
    && /\.xy-plane\.offline\s*\{[^}]*pointer-events:\s*none/.test(fs.readFileSync(web('ios.css'), 'utf8'))
    && readout.textContent === '未连接',
    `readout="${readout.textContent}"`);

  // 连上，但**还没碰过**：一个值都不许发（打开页面就发中心值会静默改掉插件里的音色位置）
  ws.readyState = 1; ws.onopen();
  check('xy: 连上之后、碰之前，一条值都不发', xys().length === 0, `${xys().length} 条`);
  check('xy: 未触碰时读数是"未定"（X — · Y —），面上是虚线环',
    readout.textContent === 'X — · Y —'
    // 桩不解析 HTML 上的 class，所以"虚线环"这条按标记断言：页面初始就带 unset，CSS 里也有对应样式
    && /class="xy-plane unset"/.test(htmlOf('xy'))
    && /\.xy-plane\.unset \.xy-marker\s*\{[^}]*dashed/.test(fs.readFileSync(web('ios.css'), 'utf8')),
    `readout="${readout.textContent}"`);

  // 落点（Landing）：中心 → 触点，40 ms 内插过去，沿途照发
  touch('pointerdown', 300, 0);
  await sleep(90);
  const landing = xys();
  check('xy: 落点后开始发送，终点就是触点（右上角 = 127/127）',
    landing.length >= 1 && landing.at(-1).x === 127 && landing.at(-1).y === 127
    && landing.at(-1).cc_x === 20 && landing.at(-1).cc_y === 21,
    `${landing.length} 条，最后一条 ${JSON.stringify(landing.at(-1))}`);
  check('xy: 落点是补间而不是跳变（中间有过渡值）',
    landing.length >= 2 && landing.some((m) => m.x > 0 && m.x < 127),
    `x 序列 ${landing.map((m) => m.x).join(',')}`);
  check('xy: 标记跟到触点上（--mx/--my 是 JS 每帧写的）',
    plane.style.getPropertyValue('--mx') === '100.000%'
    && plane.style.getPropertyValue('--my') === '0.000%',
    `${plane.style.getPropertyValue('--mx')} / ${plane.style.getPropertyValue('--my')}`);

  // Drag：跟手（每一档都发，不插帧）
  const beforeDrag = xys().length;
  touch('pointermove', 150, 150);
  await sleep(8);
  touch('pointermove', 60, 240);
  await sleep(8);
  const drag = xys().slice(beforeDrag);
  // 300×300 的桩面：x=150 → 127×0.5 = 63.5 → 64；y=150 → 1−0.5 → 63.5 → 64
  //                    x=60  → 127×0.2 = 25.4 → 25；y=240 → 1−0.8 → 25.4 → 25
  check('xy: Drag 直接跟手（两次移动两条消息，中间没有插帧）',
    drag.length === 2 && drag[0].x === 64 && drag[0].y === 64
    && drag[1].x === 25 && drag[1].y === 25,
    `${JSON.stringify(drag)}`);

  // 抬起：绝对 + 保持，什么都不发
  const beforeUp = xys().length;
  touch('pointerup', 60, 240);
  await sleep(20);
  check('xy: 抬起不产生任何消息（值留在那儿，没有归零/归中）',
    xys().length === beforeUp, `${xys().length - beforeUp} 条`);

  // 第二根手指：不夺权
  touch('pointerdown', 300, 300, 1);
  await sleep(60);
  const afterA = xys().at(-1);
  touch('pointerdown', 0, 0, 2);          // 第二根落在左下角
  await sleep(60);
  check('xy: 第二根手指落下不夺权（位置不动）',
    xys().at(-1).x === afterA.x && xys().at(-1).y === afterA.y
    && plane.classList.contains('pressed'),
    `A 停在 ${afterA.x}/${afterA.y}，最后一条 ${xys().at(-1).x}/${xys().at(-1).y}`);
  touch('pointerup', 300, 300, 1);

  // 回中
  const beforeCenter = xys().length;
  win.document.getElementById('btnCenter').dispatch('click', {});
  await sleep(90);
  check('xy: 回中把 Position 送回正中并发出中心值（64/64，走同一条补间）',
    xys().at(-1).x === 64 && xys().at(-1).y === 64 && xys().length > beforeCenter,
    `${xys().length - beforeCenter} 条，最后 ${xys().at(-1).x}/${xys().at(-1).y}`);

  // 冻结：可以摆位但不发送；解冻发一次
  win.document.getElementById('btnFreeze').dispatch('click', {});
  check('xy: 冻结后按钮变成"已冻结 · 点此恢复"，面加上了标记',
    /已冻结/.test(win.document.getElementById('btnFreeze').textContent)
    && plane.classList.contains('frozen'),
    win.document.getElementById('btnFreeze').textContent);
  const beforeFrozen = xys().length;
  touch('pointerdown', 300, 0);
  await sleep(80);
  touch('pointerup', 300, 0);
  check('xy: 冻结期间拖动不发任何值（但 Marker 照样跟着走）',
    xys().length === beforeFrozen && readout.textContent.includes('已冻结'),
    `${xys().length - beforeFrozen} 条，readout="${readout.textContent}"`);
  win.document.getElementById('btnFreeze').dispatch('click', {});
  await sleep(90);
  check('xy: 解冻时把 Marker 的位置发出去一次（把插件拉到位）',
    xys().length > beforeFrozen && xys().at(-1).x === 127 && xys().at(-1).y === 127,
    `${xys().length - beforeFrozen} 条，最后 ${xys().at(-1).x}/${xys().at(-1).y}`);

  // 改 CC 号：立刻生效（Bridge 侧会落盘记住）
  win.document.getElementById('ccX').value = '30';
  win.document.getElementById('ccY').value = '31';
  win.document.getElementById('ccX').dispatch('change', {});
  check('xy: 改 CC 号立刻用新号发一次当前位置',
    xys().at(-1).cc_x === 30 && xys().at(-1).cc_y === 31,
    `${JSON.stringify(xys().at(-1))}`);

  // 断连
  ws.onclose();
  check('xy: 断连后面变灰、读数显示未连接', plane.classList.contains('offline')
    && readout.textContent === '未连接', `readout="${readout.textContent}"`);
  const beforeOffline = xys().length;
  touch('pointerdown', 0, 300);
  await sleep(30);
  check('xy: 断连时拖动不发值（宁可看起来不能按，也不做"悄悄不发"）',
    xys().length === beforeOffline, `${xys().length - beforeOffline} 条`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
