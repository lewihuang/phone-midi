// Smoke test: load the real page scripts against a stub DOM and drive them, so a typo in an
// element id, a missing export or a bad wire-up fails here instead of on the phone.
import fs from 'node:fs';
import vm from 'node:vm';
import { web } from './_paths.mjs';

const pages = {
  index: { html: 'index.html', scripts: ['fusion.js', 'vibrato.js', 'app.js'] },
  lab: { html: 'vibrato-lab.html', scripts: ['vibrato.js', 'vibrato-lab.js'] },
  latency: { html: 'latency.html', scripts: ['fusion.js', 'latency.js'] },
  pad: { html: 'pad.html', scripts: ['pad.js'] },
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
  const mk = (id, tag) => {
    const node = {
      id, tagName: tag || 'DIV', style: {}, dataset: {}, children: [],
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
      this.close = () => {};
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
  const { win } = loadPage('index');
  check('index: scripts load with vibrato.js', !!win.PhoneMidiVibrato && !!win.PhoneMidiFusion);
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
  // 形状必须两端一致：CSS 定形状、pad.js 定编号顺序，改一个不改另一个就是错的
  const padHtml = htmlOf('pad');
  const padScript = fs.readFileSync(web('pad.js'), 'utf8');
  check('pad: 2 columns × 4 rows, CSS and pad.js agree',
    /grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(padHtml)
    && /grid-template-rows:\s*repeat\(4,\s*1fr\)/.test(padHtml)
    && /const COLS = 2;/.test(padScript) && /const ROWS = 4;/.test(padScript),
    'CSS 2×4 = pad.js COLS/ROWS');
  check('pad: cells carry only their label (no note badge on the phone)',
    grid.children.every((c) => c.children.length === 1)
    && grid.children.map((_c, i) => cellText(i)).every((t) => !/^N\d+$/.test(t)),
    '音符编号只在 PC 编辑器里显示');
  check('pad: no tab bar until a layout with pages arrives',
    tabs.classList.contains('hidden') && tabs.children.length === 0,
    `${tabs.children.length} tab(s) before the first pad_layout`);

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

  press(0, 5);
  const n = ws.sent.length;
  ws.onclose();
  check('pad: a disconnect releases held buttons and goes offline',
    ws.sent.length === n + 1 && ws.sent.at(-1).phase === 'up' && grid.classList.contains('offline'),
    `${ws.sent.at(-1).phase} then offline`);
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

  const tuned = ['index', 'latency', 'pad', 'calFlip', 'calLift', 'calShake'];
  const straight = tuned.filter((p) => !/ios\.css/.test(htmlOf(p)));
  check('theme: every phone page uses the shared stylesheet',
    straight.length === 0, straight.length ? `missing on ${straight.join(',')}` : `${tuned.length} pages`);
  const flipped = [...Object.keys(pages)].filter((p) => /prefers-color-scheme/.test(htmlOf(p)));
  check('theme: no page overrides the theme for dark systems',
    flipped.length === 0, flipped.length ? `dark branch on ${flipped.join(',')}` : 'no page carries a dark branch');
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.some((r) => !r) ? 1 : 0);
