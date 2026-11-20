// make-clip --run: builds a gait (start, repeating loop, stop) from two
// green-screen videos filmed with a camera tracking alongside her:
//   start video: standing pose, then she breaks into a run and keeps going
//   stop video:  running, then she slows down and ends in the standing pose
// The loop is one stride cut from the start video where she returns to the
// same shape. The stop clip joins onto that stride where the stop video
// matches it best. Her ground line stays fixed (no per-frame lift
// correction), so her hops off the ground are kept.
const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const {
  FPS, OUT_W, OUT_H, STILL_TOL, BLEND_START, DEFAULT_BLEND_END,
  loadImage, imageData, key, bbox, mask, diff, iouShifted, iou, smooth, blend,
} = require('./common');

const log = (s) => ipcRenderer.invoke('log', s);
const JOIN_BLEND = 0; // stop-clip frames blended in from the loop's first frames (0: a clean cut, best when the two gallops differ in rhythm)
const MIN_PERIOD = 6;
const MAX_PERIOD = 16;

async function openVideo(file) {
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.src = pathToFileURL(file).href;
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error(`Chromium could not decode ${file}`)), { once: true });
  });
  const W = video.videoWidth, H = video.videoHeight;
  const frames = Math.round(video.duration * FPS);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const keyed = async (i) => {
    video.currentTime = (i + 0.5) / FPS;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    return key(imageData(video, W, H), W, H);
  };
  // Draws source frame i placed by { s, tx, ty } onto the output canvas.
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingQuality = 'high';
  const render = async (i, { s, tx, ty }) => {
    ctx.putImageData(await keyed(i), 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, OUT_W, OUT_H);
    octx.setTransform(s, 0, 0, s, tx, ty);
    octx.drawImage(canvas, 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    return octx.getImageData(0, 0, OUT_W, OUT_H);
  };
  return { W, H, frames, keyed, render };
}

// Scale and position that put the standing frame exactly over her pose.
function placeOn(box, ref) {
  const s = ((ref.maxX - ref.minX + 1) / (box.maxX - box.minX + 1) + (ref.maxY - ref.minY + 1) / (box.maxY - box.minY + 1)) / 2;
  return { s, tx: ref.minX - box.minX * s, ty: ref.maxY + 1 - (box.maxY + 1) * s };
}

// How far her planted paws slid backwards between two frames (clip pixels,
// quarter-pixel steps): the paw band just above the ground line of the
// previous frame is matched against this frame. null when she is in the air.
function pawProfile(img, groundY) {
  const p = new Float32Array(OUT_W);
  for (let y = groundY - 7; y <= groundY; y++) {
    for (let x = 0; x < OUT_W; x++) p[x] += img.data[(y * OUT_W + x) * 4 + 3] / 255;
  }
  return p;
}
function slide(prev, cur) {
  const mass = cur.reduce((a, b) => a + b, 0);
  const prevMass = prev.reduce((a, b) => a + b, 0);
  if (mass < 12 || prevMass < 12) return null;
  const at = (p, x) => {
    const i = Math.floor(x);
    if (i < 0 || i >= OUT_W - 1) return 0;
    return p[i] + (p[i + 1] - p[i]) * (x - i);
  };
  let best = null;
  for (let d = -4; d <= 90; d += 0.25) {
    let err = 0;
    for (let x = 0; x < OUT_W; x++) err += Math.abs(cur[x] - at(prev, x + d));
    if (!best || err < best.err) best = { d, err };
  }
  return best.err / mass < 0.6 ? best.d : null;
}
function fillGaps(values) {
  const out = values.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let a = i - 1; while (a >= 0 && values[a] === null) a--;
    let b = i + 1; while (b < out.length && values[b] === null) b++;
    const va = a >= 0 ? values[a] : null, vb = b < out.length ? values[b] : null;
    out[i] = va === null ? (vb ?? 0) : vb === null ? va : va + (vb - va) * (i - a) / (b - a);
  }
  return out;
}
const median = (xs) => { const s = xs.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const r2 = (x) => Math.round(x * 4) / 4;

(async () => {
  const { start: startFile, stop: stopFile, ref, loopFrom, period: forcedPeriod, dryRun } = await ipcRenderer.invoke('job');
  const refImg = imageData(await loadImage(ref), OUT_W, OUT_H);
  const rb = bbox(refImg, OUT_W, OUT_H, 40);
  const refMask = mask(refImg);
  const groundY = rb.maxY;

  // ---- start video: stand -> run
  const A = await openVideo(startFile);
  const placeA = placeOn(bbox(await A.keyed(0), A.W, A.H, 40), rb);
  const aImgs = [];
  for (let i = 0; i < A.frames; i++) aImgs.push(await A.render(i, placeA));
  const aMasks = aImgs.map(mask);
  let first = 0;
  while (first < A.frames - 1 && diff(aMasks[first + 1], aMasks[first]) < STILL_TOL && diff(aMasks[first + 1], aMasks[0]) < STILL_TOL) first++;
  await log(`start video: ${A.W}x${A.H}, ${A.frames} frames, scale ${placeA.s.toFixed(4)}; moving from frame ${first}; matches her pose ${(iou(aMasks[first], refMask) * 100).toFixed(1)}%`);

  // ---- the loop: frames a..a+P-1 with frame a+P (and a+P+1) matching a (and a+1)
  let loop = null;
  const lo = loopFrom ?? Math.floor(A.frames / 2);
  for (let a = lo; a + MIN_PERIOD + 1 < A.frames - 3; a++) {
    for (let P = MIN_PERIOD; P <= MAX_PERIOD && a + P + 1 < A.frames - 3; P++) {
      if (forcedPeriod && P !== forcedPeriod) continue;
      const score = (iou(aMasks[a], aMasks[a + P]) + iou(aMasks[a + 1], aMasks[a + P + 1])) / 2;
      if (!loop || score > loop.score) loop = { a, P, score };
    }
  }
  if (!loop) throw new Error('No repeating stride found in the start video');
  await log(`loop: source frames ${loop.a}..${loop.a + loop.P - 1} (${loop.P} frames), seam match ${(loop.score * 100).toFixed(1)}%`);

  // ---- stop video: run -> stand
  const B = await openVideo(stopFile);
  const placeB = placeOn(bbox(await B.keyed(B.frames - 1), B.W, B.H, 40), rb);
  await log(`stop video: ${B.W}x${B.H}, ${B.frames} frames, scale ${placeB.s.toFixed(4)} (start video ${placeA.s.toFixed(4)})`);
  const bImgs0 = [];
  for (let i = 0; i < B.frames; i++) bImgs0.push(await B.render(i, placeB));
  const bMasks0 = bImgs0.map(mask);
  let last = B.frames - 1;
  while (last > 0 && diff(bMasks0[last - 1], bMasks0[last]) < STILL_TOL && diff(bMasks0[last - 1], bMasks0[B.frames - 1]) < STILL_TOL) last--;
  // Where the stop video best continues the loop (allowing a sideways shift).
  let join = null;
  for (let k = 0; k < Math.min(last - 20, B.frames - 2); k++) {
    const m1 = iouShifted(bMasks0[k], aMasks[loop.a], 80);
    const m2 = iouShifted(bMasks0[k + 1], aMasks[loop.a + 1], 80);
    const score = (m1.iou + m2.iou) / 2;
    if (!join || score > join.score) join = { k, shift: m1.shift, score };
  }
  await log(`stop clip joins at stop-video frame ${join.k} (match ${(join.score * 100).toFixed(1)}%, shifted ${join.shift} px); ends at frame ${last}, matches her pose ${(iou(bMasks0[last], refMask) * 100).toFixed(1)}%`);
  if (dryRun) {
    await ipcRenderer.invoke('done', {});
    return;
  }

  // The stop video is shifted to line up with the loop at the join, easing
  // back to its own placement (her pose) by the time she has slowed down.
  const settle = join.k + Math.round((last - join.k) * 0.6);
  const bPlace = (i) => {
    const t = smooth((i - join.k) / Math.max(1, settle - join.k));
    return { ...placeB, tx: placeB.tx + join.shift * (1 - t) };
  };

  // ---- write the three clips and measure the paw slide
  // Where she would leave the clip frame (lunging ahead of the camera, or
  // her tail at the back), ease her back inside: a sideways nudge per frame
  // that fades in and out over FIT_EASE frames either side.
  const FIT_EASE = 8;
  // spans: her outline in clip pixels per frame, measured on the source
  // video (a clipped frame cannot show how far she sticks out).
  const fitShifts = (spans, fixedEnds) => {
    const need = spans.map((b) => ({ left: Math.max(0, 3 - b.minX), right: Math.min(0, OUT_W - 4 - b.maxX) }));
    return spans.map((_, i) => {
      let pos = 0, neg = 0;
      need.forEach((n, j) => {
        const w = smooth(1 - Math.abs(i - j) / FIT_EASE);
        pos = Math.max(pos, n.left * w);
        neg = Math.min(neg, n.right * w);
      });
      const atEnd = fixedEnds.some((e) => Math.abs(i - e) < 1);
      if (atEnd && (pos || neg)) throw new Error(`frame ${i} needs a nudge where it must join another clip`);
      return Math.round((pos + neg) * 4) / 4;
    });
  };

  const clips = { start: [], loop: [], stop: [] };
  const startSrc = [];
  for (let i = first; i < loop.a; i++) startSrc.push(i);
  const spanOf = async (V, i, p) => {
    const b = bbox(await V.keyed(i), V.W, V.H, 40);
    return { minX: b.minX * p.s + p.tx, maxX: (b.maxX + 1) * p.s + p.tx };
  };
  const startSpans = [];
  for (const i of startSrc) startSpans.push(await spanOf(A, i, placeA));
  const startShift = fitShifts(startSpans, [0, startSrc.length - 1]);
  for (let n = 0; n < startSrc.length; n++) {
    const i = startSrc[n];
    let img = startShift[n] ? await A.render(i, { ...placeA, tx: placeA.tx + startShift[n] }) : aImgs[i];
    if (n < BLEND_START) img = blend(img, refImg, n / BLEND_START);
    clips.start.push(img);
  }
  await log(`start clip nudged on ${startShift.filter(Boolean).length} frames (most ${Math.min(...startShift)}..${Math.max(...startShift)} px)`);
  for (let i = loop.a; i < loop.a + loop.P; i++) clips.loop.push(aImgs[i]);
  const stopSrc = [];
  for (let i = join.k; i <= last; i++) stopSrc.push(i);
  const stopPlain = [];
  for (const i of stopSrc) stopPlain.push(await B.render(i, bPlace(i)));
  const stopSpans = [];
  for (const i of stopSrc) stopSpans.push(await spanOf(B, i, bPlace(i)));
  const stopShift = fitShifts(stopSpans, [0, stopSrc.length - 1]);
  await log(`stop clip nudged on ${stopShift.filter(Boolean).length} frames (most ${Math.min(...stopShift)}..${Math.max(...stopShift)} px)`);
  for (let n = 0; n < stopSrc.length; n++) {
    const i = stopSrc[n];
    let img = stopShift[n] ? await B.render(i, { ...bPlace(i), tx: bPlace(i).tx + stopShift[n] }) : stopPlain[n];
    if (n < JOIN_BLEND) img = blend(img, aImgs[loop.a + n], n / JOIN_BLEND);
    const fromEnd = last - i;
    if (fromEnd < DEFAULT_BLEND_END) img = blend(img, refImg, fromEnd / DEFAULT_BLEND_END);
    clips.stop.push(img);
  }

  let reach = { minX: OUT_W, maxX: -1 };
  for (const imgs of Object.values(clips)) for (const img of imgs) {
    const b = bbox(img, OUT_W, OUT_H, 40);
    reach = { minX: Math.min(reach.minX, b.minX), maxX: Math.max(reach.maxX, b.maxX) };
  }
  await log(`her outline reaches x ${reach.minX}..${reach.maxX} of 0..${OUT_W - 1} (pose: ${rb.minX}..${rb.maxX})`);

  // Paw slide per frame: entry i = slide from the frame before to frame i.
  const measure = (imgs, before) => {
    const out = [];
    let prev = before ? pawProfile(before, groundY) : null;
    for (const img of imgs) {
      const cur = pawProfile(img, groundY);
      out.push(prev ? slide(prev, cur) : 0);
      prev = cur;
    }
    return out;
  };
  const rawStart = measure(clips.start, null);
  const rawLoop = measure(clips.loop, clips.loop[clips.loop.length - 1]);
  const rawStop = measure(clips.stop, clips.loop[clips.loop.length - 1]);
  await log(`raw paw slide start: ${rawStart.map((v) => (v === null ? '-' : v)).join(' ')}`);
  await log(`raw paw slide loop:  ${rawLoop.map((v) => (v === null ? '-' : v)).join(' ')}`);
  await log(`raw paw slide stop:  ${rawStop.map((v) => (v === null ? '-' : v)).join(' ')}`);
  // While galloping the camera keeps pace with her, so the ground slides at a
  // steady speed: the loop uses one value throughout, the median of what the
  // loop shows, or (when she is too much in the air to measure) of the last
  // readings of the start clip, once the camera has caught up. Start and stop
  // use the measured values with outliers removed, gaps while airborne filled
  // in, then smoothed.
  const loopReadings = rawLoop.filter((x) => x !== null && x > 0);
  const tail = rawStart.filter((x) => x !== null && x > 0).slice(-12);
  const v = median(loopReadings.length >= 4 ? loopReadings : tail);
  await log(`gallop speed ${v} px per frame (from ${loopReadings.length >= 4 ? 'the loop' : 'the end of the start clip'})`);
  const median5 = (xs) => xs.map((x, i) => median(xs.slice(Math.max(0, i - 2), i + 3)));
  const smooth3 = (xs) => median5(xs).map((x, i, m) => (i === 0 || i === m.length - 1 ? x : (m[i - 1] + x + m[i + 1]) / 3));
  const motion = {
    start: smooth3(fillGaps(rawStart)).map((x) => r2(Math.max(0, x))),
    loop: clips.loop.map(() => r2(v)),
    stop: smooth3(fillGaps(rawStop.map((x, i) => (i < Math.max(2, JOIN_BLEND) ? v : x)))).map((x) => r2(Math.max(0, x))),
  };
  motion.start[0] = 0;
  motion.stop[motion.stop.length - 1] = 0;

  for (const [part, imgs] of Object.entries(clips)) {
    const c = document.createElement('canvas');
    c.width = OUT_W; c.height = OUT_H;
    const cx = c.getContext('2d');
    for (let n = 0; n < imgs.length; n++) {
      cx.putImageData(imgs[n], 0, 0);
      await ipcRenderer.invoke('save', `${part}/${String(n).padStart(4, '0')}.png`, c.toDataURL('image/png'));
    }
  }
  await ipcRenderer.invoke('done', {
    frames: { start: clips.start.length, loop: clips.loop.length, stop: clips.stop.length },
    motion,
  });
})().catch((err) => ipcRenderer.invoke('fail', err.stack || err.message));
