import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Compare two PNG screenshots pixel by pixel.
 *
 * Written because "it still builds" is not evidence that a colour refactor left
 * the rendering untouched, and because this model cannot look at images. The
 * decoder below is deliberately minimal: it handles what Chrome's screenshot
 * encoder emits (8-bit truecolour, with or without alpha) and throws on anything
 * else rather than guessing.
 */

function decode(path) {
  const buf = readFileSync(path);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== sig[i]) throw new Error(`${path}: not a PNG`);
  }

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`${path}: unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNG unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pr) & 0xff;
          break;
        }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = channels >= 3 ? line[s + 1] : line[s];
      out[d + 2] = channels >= 3 ? line[s + 2] : line[s];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

const [a, b, tolArg] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node tools/diff-shots.mjs <a.png> <b.png> [tolerance=0]");
  process.exit(2);
}
const tol = tolArg === undefined ? 0 : Number(tolArg);

const A = decode(a);
const B = decode(b);
if (A.width !== B.width || A.height !== B.height) {
  console.log(JSON.stringify({ same: false, reason: "size differs", a: [A.width, A.height], b: [B.width, B.height] }, null, 2));
  process.exit(1);
}

let diff = 0, maxDelta = 0, firstDiff = null;
const hist = new Map();
for (let i = 0; i < A.data.length; i += 4) {
  let d = 0;
  for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
  if (d > tol) {
    diff += 1;
    if (d > maxDelta) maxDelta = d;
    const key = d > 32 ? ">32" : d > 8 ? "9-32" : d > 2 ? "3-8" : "1-2";
    hist.set(key, (hist.get(key) ?? 0) + 1);
    if (firstDiff === null) {
      const px = i / 4;
      firstDiff = { x: px % A.width, y: Math.floor(px / A.width), delta: d };
    }
  }
}
const total = A.width * A.height;
console.log(JSON.stringify({
  same: diff === 0,
  size: [A.width, A.height],
  differingPixels: diff,
  percent: +((diff / total) * 100).toFixed(4),
  maxChannelDelta: maxDelta,
  histogram: Object.fromEntries([...hist].sort()),
  firstDiff,
}, null, 2));
process.exit(diff === 0 ? 0 : 1);