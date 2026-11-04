#!/usr/bin/env node
/**
 * Generates the CongLive PC icon set without external dependencies:
 *   - build/icon.ico         (packaged into CongLive.exe by @electron/packager)
 *   - src/assets/icon.ico    (runtime window/taskbar icon on Windows)
 *   - src/assets/icon.png    (256×256 PNG used by the launcher UI and on Linux)
 *
 * The artwork is drawn procedurally (rounded brand tile + "C" ring + play mark)
 * and anti-aliased with supersampling, so no binary assets or font rendering are
 * required on the build machine.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 256;

/* ------------------------------------------------------------------ *
 * PNG writing
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Assemble PNG-compressed ICO entries (supported by Windows Vista+ / 10 / 11). */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  const blobs = [];
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
    blobs.push(entry.png);
  });
  return Buffer.concat([header, directory, ...blobs]);
}

/* ------------------------------------------------------------------ *
 * Artwork
 * ------------------------------------------------------------------ */

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

function insideRoundedRect(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function sampleIcon(px, py) {
  // px, py in [0,1) with (0,0) at the top-left.
  if (!insideRoundedRect(px, py, 1, 0.225)) return [0, 0, 0, 0];

  // Diagonal brand gradient (#7c5cff → #3ec6ff), slightly brightened top-left.
  const t = ease(clamp01((px + py) / 2));
  let r = mix(124 / 255, 62 / 255, t);
  let g = mix(92 / 255, 198 / 255, t);
  let b = mix(255 / 255, 255 / 255, t);
  const highlight = 0.1 * (1 - clamp01(py * 1.4));
  r = mix(r, 1, highlight);
  g = mix(g, 1, highlight);
  b = mix(b, 1, highlight);

  const cx = 0.5;
  const cy = 0.5;
  const dx = px - cx;
  const dy = py - cy;
  const distance = Math.hypot(dx, dy);

  // White "C" ring with a right-facing opening.
  const angle = Math.atan2(dy, dx);
  const inRing = distance >= 0.198 && distance <= 0.288;
  const inOpening = Math.abs(angle) <= 0.5;
  if (inRing && !inOpening) {
    return [1, 1, 1, 1];
  }

  // Play triangle in the middle.
  const triangle = [
    [0.452, 0.408],
    [0.452, 0.592],
    [0.6, 0.5],
  ];
  const pointInTriangle = (x, y, points) => {
    const [p1, p2, p3] = points;
    const d1 = (x - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (y - p2[1]);
    const d2 = (x - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (y - p3[1]);
    const d3 = (x - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (y - p1[1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  if (pointInTriangle(px, py, triangle)) {
    return [1, 1, 1, 1];
  }

  return [r, g, b, 1];
}

function renderRgba(size) {
  const supersample = size <= 64 ? 4 : 3;
  const large = size * supersample;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const px = (x * supersample + sx + 0.5) / large;
          const py = (y * supersample + sy + 0.5) / large;
          const [r, g, b, a] = sampleIcon(px, py);
          red += r;
          green += g;
          blue += b;
          alpha += a;
        }
      }
      const count = supersample * supersample;
      const index = (y * size + x) * 4;
      rgba[index] = Math.round((red / count) * 255);
      rgba[index + 1] = Math.round((green / count) * 255);
      rgba[index + 2] = Math.round((blue / count) * 255);
      rgba[index + 3] = Math.round((alpha / count) * 255);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export function makeIcons({ quiet = false } = {}) {
  const cache = new Map();
  const pngFor = (size) => {
    if (!cache.has(size)) cache.set(size, encodePng(size, size, renderRgba(size)));
    return cache.get(size);
  };
  const ico = encodeIco(ICO_SIZES.map((size) => ({ size, png: pngFor(size) })));
  const png256 = pngFor(PNG_SIZE);

  const outputs = [
    [join(ROOT, 'build', 'icon.ico'), ico],
    [join(ROOT, 'src', 'assets', 'icon.ico'), ico],
    [join(ROOT, 'src', 'assets', 'icon.png'), png256],
  ];
  for (const [file, buffer] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buffer);
    if (!quiet) console.log(`icon: ${file} (${statSync(file).size} bytes)`);
  }
  return outputs.map(([file]) => file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  makeIcons();
}
