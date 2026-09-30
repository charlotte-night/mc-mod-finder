// Renders assets/icon.ico (multi-size, PNG-compressed entries) with no image deps.
// Run: node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor for smooth edges

const BG = [0x1e, 0x20, 0x28];
const BORDER = [0x39, 0x3d, 0x4d];
const TILES = [
  [0x4f, 0xc3, 0x6a],
  [0xe8, 0xc0, 0x4a],
  [0x5a, 0xc8, 0xe0],
  [0xd2, 0x5a, 0x4a],
];
const SPARK = [0xf2, 0xf2, 0xf6];

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function roundedAlpha(x, y, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Renders one size at SS times the resolution; caller downsamples. */
function renderHiRes(size) {
  const n = size * SS;
  const px = new Uint8Array(n * n * 4);
  const plateR = 0.16 * n;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!roundedAlpha(x, y, 0, 0, n, n, plateR)) continue;
      const d = Math.hypot(
        x - Math.min(Math.max(x, plateR), n - plateR),
        y - Math.min(Math.max(y, plateR), n - plateR),
      );
      const onBorder = d > plateR - Math.max(1, 0.022 * n);
      const color = onBorder ? BORDER : BG;
      const i = (y * n + x) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
    }
  }

  const margin = 0.115 * n;
  const gap = 0.045 * n;
  const tile = (n - 2 * margin - gap) / 2;
  const tileR = 0.075 * n;
  const positions = [
    [margin, margin],
    [margin + tile + gap, margin],
    [margin, margin + tile + gap],
    [margin + tile + gap, margin + tile + gap],
  ];

  positions.forEach(([tx, ty], index) => {
    const base = TILES[index % TILES.length];
    const edge = base.map((c) => Math.floor(c * 0.55));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!roundedAlpha(x, y, tx, ty, tile, tile, tileR)) continue;
        const cx = Math.min(Math.max(x, tx + tileR), tx + tile - tileR);
        const cy = Math.min(Math.max(y, ty + tileR), ty + tile - tileR);
        const d = Math.hypot(x - cx, y - cy);
        const color = d > tileR - Math.max(1, 0.02 * n) ? edge : base;
        const i = (y * n + x) * 4;
        px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
      }
    }
  });

  // centre mark: a small plus, readable even at 16px
  const c = n / 2;
  const arm = 0.085 * n;
  const thick = Math.max(1, 0.026 * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const onVertical = Math.abs(x - c) <= thick && Math.abs(y - c) <= arm;
      const onHorizontal = Math.abs(y - c) <= thick && Math.abs(x - c) <= arm;
      if (!onVertical && !onHorizontal) continue;
      const i = (y * n + x) * 4;
      px[i] = SPARK[0]; px[i + 1] = SPARK[1]; px[i + 2] = SPARK[2]; px[i + 3] = 255;
    }
  }
  return { px, n };
}

/** Box filter down to the target size, with alpha-aware colour averaging. */
function downsample({ px, n }, size) {
  const out = Buffer.alloc(size * size * 4);
  const block = n / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = 0; sy < block; sy++) {
        for (let sx = 0; sx < block; sx++) {
          const i = ((y * block + sy) * n + (x * block + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha; g += px[i + 1] * alpha; b += px[i + 2] * alpha;
          a += alpha; count++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container ----
const images = SIZES.map((size) => ({ size, png: encodePng(downsample(renderHiRes(size), size), size) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const image of images) {
  const entry = Buffer.alloc(16);
  entry[0] = image.size >= 256 ? 0 : image.size;
  entry[1] = image.size >= 256 ? 0 : image.size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.png.length;
  entries.push(entry);
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
const outFile = path.join(root, 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, ico);
console.log(`wrote ${outFile} (${(ico.length / 1024).toFixed(1)} KB, ${images.length} sizes: ${SIZES.join('/')})`);

// also drop a PNG preview next to it
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), images[images.length - 1].png);
