// Shared by the make-clip pages: keying, outlines, masks and blending.
'use strict';
const { pathToFileURL } = require('url');

const FPS = 24;
const OUT_W = 532;
const OUT_H = 312;
const KEY_LO = 22; // green excess at or below: fully Lulu
const KEY_HI = 62; // green excess at or above: fully background
const WATERMARK = { x: 0.85, y: 0.88 }; // bottom-right corner, as a share of the frame
const STILL_TOL = 450; // mask pixels changed between frames that still count as "still"
const BLEND_START = 4; // frames blended in from the exact start pose
const DEFAULT_BLEND_END = 6; // frames blended into the exact end pose

async function loadImage(file) {
  const img = new Image();
  img.src = pathToFileURL(file).href;
  await img.decode();
  return img;
}

function imageData(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function key(data, w, h) {
  const d = data.data;
  const wx = Math.round(w * WATERMARK.x);
  const wy = Math.round(h * WATERMARK.y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x >= wx && y >= wy) { d[i + 3] = 0; continue; }
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const excess = g - Math.max(r, b);
      const a = 1 - Math.min(1, Math.max(0, (excess - KEY_LO) / (KEY_HI - KEY_LO)));
      d[i + 3] = Math.round(a * 255);
      if (excess > 0) d[i + 1] = Math.max(r, b); // no green tint on her edges
    }
  }
  return data;
}

function bbox(data, w, h, threshold = 128) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data.data[(y * w + x) * 4 + 3] > threshold) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('A frame has no Lulu in it after keying');
  return { minX, maxX, minY, maxY };
}

const mask = (data) => {
  const m = new Uint8Array(data.data.length / 4);
  for (let i = 0; i < m.length; i++) m[i] = data.data[i * 4 + 3] > 128 ? 1 : 0;
  return m;
};
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) n += a[i] ^ b[i]; return n; };
// Best match when b is slid sideways by up to ±range pixels: { iou, shift }.
function iouShifted(a, b, range) {
  let best = { iou: -1, shift: 0 };
  for (let s = -range; s <= range; s += 1) {
    let i2 = 0, u = 0;
    for (let y = 0; y < OUT_H; y++) for (let x = 0; x < OUT_W; x++) {
      const k = y * OUT_W + x; const xs = x + s;
      const av = a[k]; const bv = xs >= 0 && xs < OUT_W ? b[y * OUT_W + xs] : 0;
      i2 += av & bv; u += av | bv;
    }
    const v = u ? i2 / u : 1;
    if (v > best.iou) best = { iou: v, shift: -s };
  }
  return best;
}
const iou = (a, b) => { let i2 = 0, u = 0; for (let i = 0; i < a.length; i++) { i2 += a[i] & b[i]; u += a[i] | b[i]; } return u ? i2 / u : 1; };
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// w = 0 gives the reference, w = 1 the frame (premultiplied, so edges stay clean).
function blend(frame, ref, w) {
  const f = frame.data, r = ref.data;
  const out = new ImageData(OUT_W, OUT_H);
  const o = out.data;
  for (let i = 0; i < f.length; i += 4) {
    const fa = f[i + 3] / 255, ra = r[i + 3] / 255;
    const a = ra * (1 - w) + fa * w;
    for (let c = 0; c < 3; c++) {
      const pm = r[i + c] * ra * (1 - w) + f[i + c] * fa * w;
      o[i + c] = a > 0 ? Math.min(255, Math.round(pm / a)) : 0;
    }
    o[i + 3] = Math.round(a * 255);
  }
  return out;
}


module.exports = {
  FPS, OUT_W, OUT_H, STILL_TOL, BLEND_START, DEFAULT_BLEND_END,
  loadImage, imageData, key, bbox, mask, diff, iouShifted, iou, smooth, blend,
};
