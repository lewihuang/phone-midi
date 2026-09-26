// 真·PNG 平均亮度：解析 IHDR/IDAT，反滤波（None/Sub/Up/Average/Paeth），再算 RGB 均值。
// 用途：客观判断某个截图是浅底还是暗底——这是"手机端要浅灰"这条需求唯一可自动验证的判据。
//   node tools/luminance.mjs <png...>          # 平均亮度
//   node tools/luminance.mjs --top 6 <png>     # 另列占比最高的几种颜色（查"格子实际填了什么色"）
import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
  const buf = fs.readFileSync(file);
  let i = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(i + 8); h = buf.readUInt32BE(i + 12);
      bitDepth = buf[i + 16]; colorType = buf[i + 17];
    } else if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= channels) ? prev[x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  // 平均亮度（权重的感知近似）+ 颜色直方图（实心填充的格子会各自聚成一个大色块，很好认）
  let sum = 0, n = 0;
  const hist = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * channels;
      let r, g, bl;
      if (channels >= 3) { r = out[p]; g = out[p + 1]; bl = out[p + 2]; }
      else { r = g = bl = out[p]; }
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * bl; n++;
      const key = (r << 16) | (g << 8) | bl;
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, c]) => [(k >>> 0).toString(16).padStart(6, '0'), c / n]);
  return { w, h, lum: sum / n, top, px: out, channels };
}

/** 沿某一行数"比底色暗的团块"有多少个 —— 用来核实点阵每行有几个点（不靠推断）。 */
function countRow({ w, px, channels }, y, darkBelow) {
  const lumAt = (x) => {
    const p = (y * w + x) * channels;
    const r = px[p], g = channels >= 3 ? px[p + 1] : px[p], b = channels >= 3 ? px[p + 2] : px[p];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hits = [];
  for (let x = 0; x < w; x++) if (lumAt(x) < darkBelow) hits.push(x);
  // 相邻像素算同一个点
  const groups = [];
  for (const x of hits) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= 2) last.push(x);
    else groups.push([x]);
  }
  return groups.map((g) => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
}

const argv = process.argv.slice(2);
const topIdx = argv.indexOf('--top');
const TOP = topIdx >= 0 ? Number(argv[topIdx + 1] || 6) : 0;
const rowIdx = argv.indexOf('--row');
const ROW = rowIdx >= 0 ? Number(argv[rowIdx + 1]) : null;
const darkIdx = argv.indexOf('--dark-below');
const DARK = darkIdx >= 0 ? Number(argv[darkIdx + 1]) : 235;
// 只有给了 --top 时才跳过它后面那个数字，否则第一个文件名会被当成参数吃掉。
const skip = new Set([topIdx, rowIdx, darkIdx].filter((i) => i >= 0).map((i) => i + 1));
const files = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));

for (const f of files) {
  const img = decode(f);
  const { w, h, lum, top } = img;
  const kind = lum > 180 ? '浅底 ✓' : (lum > 90 ? '偏中' : '暗底 ✗');
  console.log(`${kind}  平均亮度 ${lum.toFixed(1).padStart(6)}  ${w}x${h}  ${f}`);
  if (TOP) {
    for (const [hex, share] of top.slice(0, TOP)) {
      console.log(`        #${hex}  ${(share * 100).toFixed(1).padStart(5)}%`);
    }
  }
  if (ROW != null) {
    const centres = countRow(img, Math.min(h - 1, Math.max(0, ROW)), DARK);
    console.log(`        第 ${ROW} 行：${centres.length} 个团块（亮度 < ${DARK}），x 位置 ${centres.join(', ')}`);
  }
}
