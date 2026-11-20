// make-clip, in a hidden Electron page (Chromium decodes the MP4).
const { ipcRenderer } = require('electron');
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

const log = (s) => ipcRenderer.invoke('log', s);

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

(async () => {
  const { video: file, startRef, endRef, from, to, zoom, zoomFrom, zoomTo, blendEnd, minMatch, dryRun } = await ipcRenderer.invoke('job');
  const BLEND_END = blendEnd ?? DEFAULT_BLEND_END;
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.src = pathToFileURL(file).href;
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Chromium could not decode the video')), { once: true });
  });
  const W = video.videoWidth, H = video.videoHeight;
  const total = Math.round(video.duration * FPS);
  const first = from ?? 0;
  const lastSrc = Math.min(total - 1, to ?? total - 1);
  if (lastSrc <= first) throw new Error('--to must be after --from');
  const frames = lastSrc - first + 1; // frames are numbered from --from onwards
  const srcFrame = (i) => first + i;
  const seek = async (i) => {
    video.currentTime = (srcFrame(i) + 0.5) / FPS;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
  };
  const keyed = async (i) => { await seek(i); return key(imageData(video, W, H), W, H); };

  const refStart = imageData(await loadImage(startRef), OUT_W, OUT_H);
  const refEnd = imageData(await loadImage(endRef), OUT_W, OUT_H);
  const rs = bbox(refStart, OUT_W, OUT_H, 40);
  const re = bbox(refEnd, OUT_W, OUT_H, 40);

  // Her outline in every frame (video pixels). The bottom of the box is her
  // contact with the floor, used to keep her on Lulu's ground line.
  const boxes = [];
  for (let i = 0; i < frames; i++) boxes.push(bbox(await keyed(i), W, H, 40));
  const fit = (v, r) => ((r.maxX - r.minX + 1) / (v.maxX - v.minX + 1) + (r.maxY - r.minY + 1) / (v.maxY - v.minY + 1)) / 2;
  const s0 = fit(boxes[0], rs);
  const s1 = zoom ? fit(boxes[frames - 1], re) : s0;
  const tx0 = rs.minX - boxes[0].minX * s0;
  // Without zoom correction she keeps her start position as well as her size.
  const tx1 = zoom ? re.minX - boxes[frames - 1].minX * s1 : tx0;
  const differs = (p, q) => Math.abs(p.minX - q.minX) + Math.abs(p.maxX - q.maxX) > 6;
  let za = 0; while (za < frames - 1 && !differs(boxes[za], boxes[0])) za++;
  let zb = frames - 1; while (zb > 0 && !differs(boxes[zb], boxes[frames - 1])) zb--;
  if (zoomFrom !== null && zoomFrom !== undefined) za = Math.max(0, zoomFrom - first);
  if (zoomTo !== null && zoomTo !== undefined) zb = Math.min(frames - 1, zoomTo - first);
  await log(`${W}x${H}, ${frames} frames; camera zoom over the clip x${(s0 / s1).toFixed(3)} (corrected between source frames ${srcFrame(za)} and ${srcFrame(zb)})`);

  const transformFor = (i) => {
    const t = smooth((i - za) / Math.max(1, zb - za));
    const s = s0 * Math.pow(s1 / s0, t);
    const tx = tx0 + (tx1 - tx0) * t;
    const ty = rs.maxY + 1 - (boxes[i].maxY + 1) * s; // on the ground line
    return { s, tx, ty };
  };

  const keyedCanvas = document.createElement('canvas');
  keyedCanvas.width = W; keyedCanvas.height = H;
  const kctx = keyedCanvas.getContext('2d');
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingQuality = 'high';
  const render = async (i) => {
    kctx.putImageData(await keyed(i), 0, 0);
    const { s, tx, ty } = transformFor(i);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, OUT_W, OUT_H);
    octx.setTransform(s, 0, 0, s, tx, ty);
    octx.drawImage(keyedCanvas, 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    return octx.getImageData(0, 0, OUT_W, OUT_H);
  };

  const masks = [];
  for (let i = 0; i < frames; i++) masks.push(mask(await render(i)));
  let start = 0;
  while (start < frames - 1 && diff(masks[start + 1], masks[start]) < STILL_TOL && diff(masks[start + 1], masks[0]) < STILL_TOL) start++;
  let end = frames - 1;
  while (end > 0 && diff(masks[end - 1], masks[end]) < STILL_TOL && diff(masks[end - 1], masks[frames - 1]) < STILL_TOL) end--;
  const kept = end - start + 1;
  if (kept < BLEND_START + BLEND_END + 4) throw new Error(`Only ${kept} moving frames found`);
  const startMatch = iou(masks[start], mask(refStart));
  const endMatch = iou(masks[end], mask(refEnd));
  await log(`kept source frames ${srcFrame(start)}..${srcFrame(end)} (${kept} frames, ${(kept / FPS).toFixed(2)} s)`);
  await log(`match with her pose before blending: start ${(startMatch * 100).toFixed(1)}%, end ${(endMatch * 100).toFixed(1)}%`);
  const slid = iouShifted(masks[end], mask(refEnd), 120);
  await log(`end pose if slid sideways: ${(slid.iou * 100).toFixed(1)}% with her ${slid.shift} px from where the pose is`);
  if (dryRun) {
    await ipcRenderer.invoke('done', { frames: kept, startMatch, endMatch });
    return;
  }
  if (startMatch < minMatch || endMatch < minMatch) {
    throw new Error('The first or last frame is too different from her standing pose to join seamlessly');
  }

  for (let i = start, n = 0; i <= end; i++, n++) {
    let img = await render(i);
    if (n < BLEND_START) img = blend(img, refStart, n / BLEND_START);
    const fromEnd = end - i; // 0 for the last frame
    if (fromEnd < BLEND_END) img = blend(img, refEnd, fromEnd / BLEND_END);
    octx.putImageData(img, 0, 0);
    await ipcRenderer.invoke('save', `${String(n).padStart(4, '0')}.png`, out.toDataURL('image/png'));
  }
  await ipcRenderer.invoke('done', { frames: kept, startMatch, endMatch });
})().catch((err) => ipcRenderer.invoke('fail', err.message));
