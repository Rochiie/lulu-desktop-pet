// make-clip, in a hidden Electron page (Chromium decodes the MP4).
const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

const {
  FPS, OUT_W, OUT_H, STILL_TOL, BLEND_START, DEFAULT_BLEND_END,
  loadImage, imageData, key, bbox, mask, diff, iouShifted, iou, smooth, blend,
} = require('./common');

const log = (s) => ipcRenderer.invoke('log', s);

(async () => {
  const { video: file, startRef, endRef, from, to, zoom, zoomFrom, zoomTo, blendEnd, minMatch, dryRun, pickup } = await ipcRenderer.invoke('job');
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

  // Picked up: how far her feet are off the floor (clip pixels). The floor is
  // where her feet are in the first and last frames.
  const liftOf = (i, s) => {
    if (!pickup) return 0;
    const floor = boxes[0].maxY + (boxes[frames - 1].maxY - boxes[0].maxY) * (i / Math.max(1, frames - 1));
    return Math.max(0, (floor - boxes[i].maxY) * s);
  };
  const groundTransform = (i) => {
    const t = smooth((i - za) / Math.max(1, zb - za));
    const s = s0 * Math.pow(s1 / s0, t);
    const tx = tx0 + (tx1 - tx0) * t;
    const ty = rs.maxY + 1 - (boxes[i].maxY + 1) * s; // on the ground line
    return { s, tx, ty };
  };
  // Her clip has only so much room above her head: scale the lift down so the
  // top of her (ears flying) stays at least TOP_ROOM px inside the clip.
  const TOP_ROOM = 4;
  let liftScale = 1;
  let maxLift = 0;
  if (pickup) {
    for (let i = 0; i < frames; i++) {
      const { s, ty } = groundTransform(i);
      const lift = liftOf(i, s);
      maxLift = Math.max(maxLift, lift);
      const top = boxes[i].minY * s + ty - lift;
      if (lift > 0 && top < TOP_ROOM) liftScale = Math.min(liftScale, 1 - (TOP_ROOM - top) / lift);
    }
    if (maxLift < 10) throw new Error('She is never lifted off the floor in this video');
    if (liftScale < 0.3) throw new Error(`She is lifted too high to fit the clip (would need scaling to ${liftScale.toFixed(2)})`);
    await log(`lifted up to ${maxLift.toFixed(0)} clip px; scaled to ${(maxLift * liftScale).toFixed(0)} px to fit (x${liftScale.toFixed(2)})`);
  }
  const transformFor = (i) => {
    const g = groundTransform(i);
    return { ...g, ty: g.ty - liftOf(i, g.s) * liftScale };
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
  if (dryRun && !pickup) {
    await ipcRenderer.invoke('done', { frames: kept, startMatch, endMatch });
    return;
  }
  if (startMatch < minMatch || endMatch < minMatch) {
    throw new Error('The first or last frame is too different from her standing pose to join seamlessly');
  }
  if (pickup) {
    await splitPickup(start, end);
    return;
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

  // Picked up: cuts the kept frames into being lifted (start..a-1), a dangling
  // loop (a..b-1, where frame b looks like frame a) and being put down (b..end).
  // The loop is kept short, as she finishes its cycle before being put down.
  async function splitPickup(first0, last0) {
    const LOOP_MIN = 20; // frames
    const LOOP_MAX = 40;
    const SEAM_BLEND = 4; // loop's last frames eased into the frames before a
    const HIGH = 0.85; // share of her full height off the floor that counts as "up"
    const lifts = masks.map((_, i) => liftOf(i, groundTransform(i).s));
    const top = Math.max(...lifts);
    const up = [];
    for (let i = first0; i <= last0; i++) if (lifts[i] >= top * HIGH) up.push(i);
    const h0 = up[0], h1 = up[up.length - 1];
    let best = null;
    for (let a = h0 + SEAM_BLEND; a <= h1; a++) {
      for (let b = a + LOOP_MIN; b <= Math.min(h1, a + LOOP_MAX); b++) {
        const v = iou(masks[a], masks[b]);
        if (!best || v > best.iou) best = { a, b, iou: v };
      }
    }
    if (!best) throw new Error(`She is up for only ${h1 - h0 + 1} frames: too short for a ${LOOP_MIN}-frame loop`);
    const { a, b } = best;
    await log(`up between source frames ${srcFrame(h0)} and ${srcFrame(h1)}; loop ${srcFrame(a)}..${srcFrame(b - 1)} (${b - a} frames), seam match ${(best.iou * 100).toFixed(1)}%`);
    if (dryRun) {
      await ipcRenderer.invoke('done', { frames: { lift: a - first0, held: b - a, down: last0 - b + 1 } });
      return;
    }
    const save = async (part, n, img) => {
      octx.putImageData(img, 0, 0);
      await ipcRenderer.invoke('save', `${part}/${String(n).padStart(4, '0')}.png`, out.toDataURL('image/png'));
    };
    for (let i = first0, n = 0; i < a; i++, n++) {
      let img = await render(i);
      if (n < BLEND_START) img = blend(img, refStart, n / BLEND_START);
      await save('lift', n, img);
    }
    for (let i = a, n = 0; i < b; i++, n++) {
      let img = await render(i);
      const fromEnd = b - i; // 1 for the loop's last frame
      if (fromEnd <= SEAM_BLEND) img = blend(img, await render(a - fromEnd), (fromEnd - 1) / SEAM_BLEND);
      await save('held', n, img);
      if (n === 0) await ipcRenderer.invoke('save', 'held_pose.png', out.toDataURL('image/png'));
    }
    for (let i = b, n = 0; i <= last0; i++, n++) {
      let img = await render(i);
      const fromEnd = last0 - i;
      if (fromEnd < BLEND_END) img = blend(img, refEnd, fromEnd / BLEND_END);
      await save('down', n, img);
    }
    await ipcRenderer.invoke('done', { frames: { lift: a - first0, held: b - a, down: last0 - b + 1 }, seam: best.iou });
  }
})().catch((err) => ipcRenderer.invoke('fail', err.message));
