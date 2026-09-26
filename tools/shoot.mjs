// 手机端页面的无头截图工具：起一个源码模式的 Bridge（HTTP、无 GUI），用 Edge 无头渲染并截图。
//
// 为什么需要：UI 改动不能靠盲改。这台机器上没有 playwright，但有 Edge，用它的
// --headless --screenshot 就能把真实页面（含 Bridge 推过来的真实布局）渲染成 PNG。
//
// 用法:
//   node tools/shoot.mjs                     # 截全部手机端页面到 %TEMP%\phoneshots\
//   node tools/shoot.mjs --out D:\shots --port 8799 --width 390 --height 844
//   node tools/shoot.mjs --only pad,index    # 只截指定页面
//
// 注意：Bridge 以 `--no-ssl` 启动（HTTP），只用于本机渲染；pad 页不需要传感器，所以没有影响。
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(opt('port', '8799'));
const OUT = opt('out', join(tmpdir(), 'phoneshots'));
const WIDTH = Number(opt('width', '390'));
const HEIGHT = Number(opt('height', '844'));
const ONLY = opt('only', '');
const SETTLE_MS = Number(opt('settle', '2500'));   // 等 WebSocket 连上、布局推过来

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('找不到 Edge，无法截图');
  process.exit(1);
}

const PAGES = [
  ['pad', '/pad.html'],
  ['index', '/'],
  ['calibrate-lift', '/calibrate-lift.html'],
  ['calibrate-flip', '/calibrate-flip.html'],
  ['calibrate-shake', '/calibrate-shake.html'],
  ['latency', '/latency.html'],
];

const run = (cmd, argv, opts = {}) => new Promise((resolve) => {
  // stdio: 'ignore' —— 沙箱里不能通过管道捕获子进程输出（EPERM），所以不捕获。
  const child = spawn(cmd, argv, { stdio: 'ignore', ...opts });
  child.on('exit', (code) => resolve(code));
  child.on('error', () => resolve(-1));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

mkdirSync(OUT, { recursive: true });
console.log(`输出目录：${OUT}`);
console.log('启动 Bridge（源码模式、HTTP、无 GUI）…');
const bridge = spawn('python', [join(ROOT, 'bridge', 'server.py'), '--no-gui', '--no-ssl',
  '--port', String(PORT), '--midi-name', 'loopMIDI'], { stdio: 'ignore', cwd: ROOT });

try {
  if (!await waitForServer()) {
    console.error(`Bridge 没起来（端口 ${PORT}）——是不是已经有一个在跑？`);
    process.exit(1);
  }
  console.log('Bridge 就绪，开始截图');
  const wanted = ONLY ? PAGES.filter(([name]) => ONLY.split(',').includes(name)) : PAGES;
  for (const [name, path] of wanted) {
    const png = join(OUT, `${name}.png`);
    await run(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--window-size=${WIDTH},${HEIGHT}`, `--virtual-time-budget=${SETTLE_MS}`,
      `--screenshot=${png}`, `http://127.0.0.1:${PORT}${path}`,
    ]);
    console.log(`  ${existsSync(png) ? '✓' : '✗'} ${name.padEnd(16)} ${png}`);
  }
} finally {
  bridge.kill();
  console.log('Bridge 已关闭');
}
