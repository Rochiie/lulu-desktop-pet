// Animation player: preloads every clip, draws the active one to the canvas
// each video frame, and switches clips with no gap.
//
// Seamless switching works because the canvas keeps showing the last frame
// drawn until the next clip presents its first frame, and every clip is
// parked at time 0, already decoded, waiting to play. Since every clip starts
// and ends on the same two poses, the hand-over is invisible.
(function (root) {
  'use strict';

  const LOAD_TIMEOUT_MS = 20000;
  const HAVE_CURRENT_DATA = 2;
  const BONE_DROP_MS = 700;
  const BOWL_SCALE = 1.25; // bowl drawing units per clip pixel
  // The next clip needs a few ms to show its first frame; start it this much early.
  const HANDOVER_LEAD_MS = 6;
  // Once a clip has played, Chromium keeps its decoder (about 4.5 MB) until the
  // video is reloaded. Reloading a clip that has sat unused this long frees it;
  // a reloaded clip still starts within a frame, so hand-overs stay seamless.
  const RELEASE_IDLE_MS = 20000;
  const AMBIENT_FPS = 30; // redraws for the rolling ball and a dropping bone
  const SNOW_FPS = 20; // the snow has its own layer, redrawn this often
  const BED_RIM_BACK = 44; // bed rim heights in clip pixels above her ground line
  const BED_RIM_FRONT = 18; // (both rims rise a little more at the ends)
  const TOY_R = 11; // ball radius, clip pixels
  // Ball physics in clip pixels and seconds (scaled with her size).
  const TOY = Object.freeze({
    gravity: 1500, bounce: 0.45, wallBounce: 0.5, rollDecel: 650, restSpeed: 6, maxSpeed: 1500,
  });
  const SNOW = Object.freeze({
    column: 6, // window pixels per snow-depth column
    maxDepth: 7, // clip pixels
    perFlake: 0.6, // clip pixels of depth a landing flake adds to its column
    meltPerSec: 0.6, // clip pixels per second once the snow stops
    fadeInPx: 40, // flakes fade in over the top of the window
  });

  // 0..1 -> 0..1 with a couple of small bounces at the end.
  function easeOutBounce(t) {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }

  // A soft oval shadow centred on (cx, cy) with radii rx, ry (device pixels).
  function drawShadow(ctx, cx, cy, rx, ry, alpha) {
    if (rx <= 0 || ry <= 0 || alpha <= 0) return;
    ctx.save();
    ctx.setTransform(rx, 0, 0, ry, cx, cy);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
    g.addColorStop(0.55, `rgba(0, 0, 0, ${alpha * 0.55})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Lulu's water bowl, base centred on (0, 0), about 50 x 18 units tall.
  // ripple: 0..1 how much the water is moving (she is drinking).
  function drawBowl(ctx, ripple) {
    // Body: a tapered bowl.
    ctx.beginPath();
    ctx.moveTo(-25, -15);
    ctx.lineTo(25, -15);
    ctx.lineTo(19.5, -1.5);
    ctx.quadraticCurveTo(19, 0, 17, 0);
    ctx.lineTo(-17, 0);
    ctx.quadraticCurveTo(-19, 0, -19.5, -1.5);
    ctx.closePath();
    const body = ctx.createLinearGradient(-25, 0, 25, 0);
    body.addColorStop(0, '#8e3a2c');
    body.addColorStop(0.35, '#c4553f');
    body.addColorStop(0.6, '#b34a37');
    body.addColorStop(1, '#7f3326');
    ctx.fillStyle = body;
    ctx.fill();
    // A little paw print on the front.
    ctx.fillStyle = 'rgba(255, 228, 210, 0.55)';
    ctx.beginPath();
    ctx.ellipse(0, -6, 3, 2.4, 0, 0, Math.PI * 2);
    for (const [x, y] of [[-3.6, -9.6], [-1.2, -10.8], [1.2, -10.8], [3.6, -9.6]]) {
      ctx.moveTo(x + 1.1, y);
      ctx.ellipse(x, y, 1.1, 1.3, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    // Rim and water.
    ctx.beginPath();
    ctx.ellipse(0, -15, 25, 4.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#d66a52';
    ctx.fill();
    const wobble = ripple * Math.sin(performance.now() / 70) * 0.9;
    ctx.beginPath();
    ctx.ellipse(0, -15.2 + wobble * 0.3, 21.5, 3.1 + wobble * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#86c8ec';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-7, -15.9, 6, 0.9, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fill();
  }

  // A bolster dog bed seen from the side, base centred on (0, 0), hw clip
  // pixels each side. Its rim is low in the middle and curls up into round
  // bolsters at both ends. part 'back' (the far rim and the cushion) is drawn
  // behind her, 'front' (the near rim) in front, so she lies inside it.
  function traceBedRim(ctx, hw, mid, ends, r) {
    const top = (x) => -(mid + (ends - mid) * Math.pow(Math.abs(x) / hw, 5));
    ctx.beginPath();
    ctx.moveTo(-hw, -2);
    ctx.lineTo(-hw, top(-hw) + r);
    ctx.quadraticCurveTo(-hw, top(-hw), -hw + r, top(-hw + r));
    for (let x = -hw + r; x <= hw - r; x += 4) ctx.lineTo(x, top(x));
    ctx.lineTo(hw - r, top(hw - r));
    ctx.quadraticCurveTo(hw, top(hw), hw, top(hw) + r);
    ctx.lineTo(hw, -2);
    ctx.quadraticCurveTo(hw, 0, hw - 3, 0);
    ctx.lineTo(-hw + 3, 0);
    ctx.quadraticCurveTo(-hw, 0, -hw, -2);
    ctx.closePath();
    return top;
  }

  function drawBed(ctx, hw, part) {
    if (part === 'back') {
      traceBedRim(ctx, hw - 6, BED_RIM_BACK, BED_RIM_BACK + 12, 16);
      const back = ctx.createLinearGradient(0, -BED_RIM_BACK - 12, 0, 0);
      back.addColorStop(0, '#8e5f45');
      back.addColorStop(1, '#5f3c2b');
      ctx.fillStyle = back;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -BED_RIM_FRONT + 3, hw - 22, 8, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#efe3cf';
      ctx.fill();
      return;
    }
    const top = traceBedRim(ctx, hw, BED_RIM_FRONT, BED_RIM_FRONT + 9, 10);
    const front = ctx.createLinearGradient(0, -BED_RIM_FRONT - 9, 0, 0);
    front.addColorStop(0, '#d29874');
    front.addColorStop(0.35, '#b27654');
    front.addColorStop(1, '#7f5139');
    ctx.fillStyle = front;
    ctx.fill();
    // Cream piping along the top of the rim.
    ctx.beginPath();
    for (let x = -hw + 14; x <= hw - 14; x += 4) {
      if (x === -hw + 14) ctx.moveTo(x, top(x) + 3);
      else ctx.lineTo(x, top(x) + 3);
    }
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f1e2c8';
    ctx.stroke();
  }

  // Her squeaky ball, centred on (0, 0), radius TOY_R; angle rolls the stripe.
  function drawToy(ctx, angle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, TOY_R, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(-3.5, -4, 1, 0, 0, TOY_R);
    g.addColorStop(0, '#ff8a7a');
    g.addColorStop(0.55, '#e8433a');
    g.addColorStop(1, '#b0261f');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    ctx.rotate(angle);
    ctx.fillStyle = '#ffd34d';
    ctx.fillRect(-TOY_R, -2.6, TOY_R * 2, 5.2);
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(-3.8, -4.6, 3, 1.8, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
  }

  // A cartoon bone centred on (0, 0), about 46 x 16 units.
  function traceBone(ctx) {
    const knob = 5.5;
    ctx.beginPath();
    for (const x of [-17, 17]) {
      for (const y of [-4, 4]) {
        ctx.moveTo(x + knob, y);
        ctx.arc(x, y, knob, 0, Math.PI * 2);
      }
    }
    ctx.moveTo(-17, -3.5);
    ctx.rect(-17, -3.5, 34, 7);
  }

  class Interrupt extends Error {
    constructor() {
      super('Interrupted');
      this.name = 'Interrupt';
    }
  }

  function mediaErrorText(el) {
    const e = el.error;
    return e ? `media error ${e.code}${e.message ? `: ${e.message}` : ''}` : 'unknown media error';
  }

  function waitForVideo(video, label) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        resolve();
        return;
      }
      const onReady = () => finish(null);
      const onError = () => finish(new Error(`Could not load ${label} (${mediaErrorText(video)})`));
      const timer = setTimeout(() => finish(new Error(`Timed out loading ${label}`)), LOAD_TIMEOUT_MS);
      function finish(err) {
        clearTimeout(timer);
        video.removeEventListener('canplaythrough', onReady);
        video.removeEventListener('error', onError);
        if (err) reject(err);
        else resolve();
      }
      video.addEventListener('canplaythrough', onReady);
      video.addEventListener('error', onError);
    });
  }

  function readPixels(source, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }

  class Player {
    constructor({ canvas, manifest, assetBase, view, mediaHost, sizeFor = () => 1, snowCanvas = null }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('2D canvas is not available');
      this.manifest = manifest;
      this.assetBase = assetBase;
      this.view = view; // () => ({ cx, dir, scale })
      this.sizeFor = sizeFor; // (clip, pose, frameIndex) => display size factor
      this.names = new Map(); // video or pose image -> { clip } / { pose }
      this.mediaHost = mediaHost;
      this.videos = new Map();
      this.releaseTimers = new Map(); // clip name -> timer that frees its decoder
      this.poses = new Map();
      this.active = null;
      this.turning = null;
      this.effect = null; // { squash, lift } while turning around
      this.prop = null; // { kind: 'bone', x, born, eaten } on the ground
      this.bowl = null; // { x, drinking } her water bowl, or null
      this.bed = null; // { x, halfWidth } her bed (window x, clip pixels), or null
      this.toy = null; // her ball: { x, h, vx, vy, angle, held, squash, resting } (window px)
      this.onToyRest = null; // (x) => void, when a moving ball comes to rest
      this.snow = { on: false, flakes: [], depth: new Float32Array(0), drawnAt: 0, shown: false };
      // Snow gets its own see-through layer over hers, so falling flakes never
      // redraw her (and the settled snow sits in front of her paws).
      this.snowCanvas = snowCanvas;
      this.snowCtx = snowCanvas ? snowCanvas.getContext('2d') : null;
      this.snowDensity = 4; // flakes per 100 px of width
      this.ambientRaf = null;
      this.ambientPaused = false;
      this.ambientLast = 0;
      this.lastDrawAt = 0;
      this.width = canvas.width;
      this.height = canvas.height;
      this.shadows = true;
      this.bodyExtent = null; // { back, front } clip pixels, for her shadow
      this.source = null; // what is on the canvas now: a <video> or a pose <img>
      this.dpr = 1;
      this.onDraw = null;
      this.useFrameCallback = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
    }

    async load() {
      const jobs = [];
      for (const [name, clip] of Object.entries(this.manifest.clips)) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.disablePictureInPicture = true;
        video.src = this.assetBase + clip.file;
        // Videos live in the page (1x1 px, invisible) so Chromium keeps
        // decoding them and delivers frame callbacks.
        this.mediaHost.appendChild(video);
        this.videos.set(name, video);
        this.names.set(video, { clip: name });
        jobs.push(waitForVideo(video, clip.file));
      }
      for (const [pose, file] of Object.entries(this.manifest.poses)) {
        const img = new Image();
        img.src = this.assetBase + file;
        this.poses.set(pose, img);
        this.names.set(img, { pose });
        jobs.push(img.decode().catch((err) => {
          throw new Error(`Could not load ${file}: ${err.message}`);
        }));
      }
      await Promise.all(jobs);
    }

    // Confirms the VP9 alpha channel is actually decoded on this machine. If
    // it is not, the background comes out solid and she would sit in a box.
    checkAlpha(threshold) {
      const { width, height } = this.manifest;
      let data;
      try {
        data = readPixels(this.videos.get('walk_start'), width, height);
      } catch (err) {
        return { ok: false, reason: `Cannot read video pixels: ${err.message}` };
      }
      let transparent = 0;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] === 0) transparent += 1;
        else if (data[i] > threshold) opaque += 1;
      }
      const total = width * height;
      if (transparent < total * 0.2) {
        return {
          ok: false,
          reason: 'This computer is not decoding the transparency in Lulu\'s videos (VP9 alpha), so she would appear in a solid box. The PNG-frame fallback is needed.',
        };
      }
      if (opaque < total * 0.01) {
        return { ok: false, reason: 'walk_start.webm decoded as an empty frame.' };
      }
      return { ok: true, transparentShare: transparent / total };
    }

    // How far her body reaches behind and in front of her centre, in clip
    // pixels (facing right), measured from both pose images.
    bodyExtents(threshold) {
      const { width, height, standingCenterX } = this.manifest;
      let minX = width;
      let maxX = -1;
      for (const img of ['stand', 'sleep'].map((p) => this.poses.get(p))) { // on the ground
        const data = readPixels(img, width, height);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] > threshold) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
      }
      if (maxX < 0) throw new Error('The pose images are empty');
      return { back: standingCenterX - minX, front: maxX + 1 - standingCenterX };
    }

    // How far a pose reaches behind and in front of her centre (clip pixels,
    // facing right), as drawn (before any display-size correction).
    poseExtents(pose, threshold) {
      const { width, height, standingCenterX } = this.manifest;
      const img = this.poses.get(pose);
      if (!img) throw new Error(`Unknown pose ${pose}`);
      const data = readPixels(img, width, height);
      let minX = width;
      let maxX = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (data[(y * width + x) * 4 + 3] > threshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      if (maxX < 0) throw new Error(`The ${pose} pose image is empty`);
      return { back: standingCenterX - minX, front: maxX + 1 - standingCenterX };
    }

    get playing() {
      return this.active ? this.active.name : null;
    }

    resize(layout) {
      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      const w = Math.max(1, Math.round(layout.width * dpr));
      const h = Math.max(1, Math.round(layout.height * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.canvas.style.width = `${layout.width}px`;
      this.canvas.style.height = `${layout.height}px`;
      this.width = layout.width;
      this.height = layout.height;
      if (this.snowCanvas) {
        if (this.snowCanvas.width !== w) this.snowCanvas.width = w;
        if (this.snowCanvas.height !== h) this.snowCanvas.height = h;
        this.snowCanvas.style.width = `${layout.width}px`;
        this.snowCanvas.style.height = `${layout.height}px`;
      }
      const columns = Math.ceil(layout.width / SNOW.column) + 1;
      if (this.snow.depth.length !== columns) {
        this.snow.depth = new Float32Array(columns);
        this.snow.flakes = [];
      }
    }

    showPose(pose) {
      if (this.active) throw new Error(`showPose(${pose}) while ${this.active.name} is playing`);
      if (this.turning) throw new Error(`showPose(${pose}) while turning`);
      const img = this.poses.get(pose);
      if (!img) throw new Error(`Unknown pose ${pose}`);
      this.source = img;
      this.draw();
    }

    // Plays a clip to its end. Resolves when it ends, rejects with Interrupt
    // if stop() is called. With loop: true it repeats until endLoop().
    // rate plays it faster or slower (legs and movement together).
    // onFrame({ prevIndex, index, wrapped, frames }) runs for every new frame,
    // before it is drawn, so movement stays locked to the animation. prevIndex
    // is -1 before the clip's first frame.
    play(name, { loop = false, onFrame = null, rate = 1 } = {}) {
      if (this.active) {
        return Promise.reject(new Error(`Cannot play ${name}: ${this.active.name} is still playing`));
      }
      if (this.turning) return Promise.reject(new Error(`Cannot play ${name} while turning`));
      const video = this.videos.get(name);
      if (!video) return Promise.reject(new Error(`Unknown clip ${name}`));
      clearTimeout(this.releaseTimers.get(name));
      this.releaseTimers.delete(name);
      return new Promise((resolve, reject) => {
        const a = {
          name, video, onFrame, resolve, reject, rate,
          frames: this.manifest.clips[name].frames,
          lastIndex: -1, lastShownAt: 0, callbackId: null, done: false,
        };
        a.onEnded = () => this._ended(a);
        a.onError = () => this._finish(a, new Error(`Playback of ${name} failed (${mediaErrorText(video)})`));
        video.addEventListener('ended', a.onEnded);
        video.addEventListener('error', a.onError);
        video.loop = loop;
        video.playbackRate = rate;
        this.active = a;
        this._schedule(a);
        video.play().catch((err) => {
          if (!a.done) this._finish(a, new Error(`Could not start ${name}: ${err.message}`));
        });
      });
    }

    // Let a looping clip finish its current cycle and then end.
    endLoop() {
      if (this.active) this.active.video.loop = false;
    }

    // Change how fast the playing clip plays from now on.
    setRate(rate) {
      if (!(rate > 0)) throw new RangeError(`Bad playback rate ${rate}`);
      if (!this.active) return;
      this.active.rate = rate;
      this.active.video.playbackRate = rate;
    }

    // Turn around on the spot, using the current (standing) pose: she narrows
    // as if rotating side-on to front-on, flips at the narrowest point, widens
    // again facing the other way, with a small hop. onFlip runs at the
    // midpoint and should change her facing. Rejects with Interrupt on stop().
    turn({ durationMs, liftPx, minSquash, onFlip }) {
      if (this.active) return Promise.reject(new Error(`Cannot turn while ${this.active.name} is playing`));
      if (this.turning) return Promise.reject(new Error('Already turning'));
      return new Promise((resolve, reject) => {
        const t = { resolve, reject, rafId: null, done: false };
        this.turning = t;
        let start = null;
        let flipped = false;
        const frame = (now) => {
          t.rafId = null;
          if (t.done) return;
          if (start === null) start = now;
          const p = Math.min(1, (now - start) / durationMs);
          const eased = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p); // ease in-out
          if (!flipped && eased >= 0.5) {
            flipped = true;
            try {
              onFlip();
            } catch (err) {
              this._endTurn(t, err);
              return;
            }
          }
          this.effect = {
            squash: minSquash + (1 - minSquash) * Math.abs(Math.cos(Math.PI * eased)),
            lift: liftPx * Math.sin(Math.PI * p),
          };
          this.draw();
          if (p >= 1) this._endTurn(t, null);
          else t.rafId = requestAnimationFrame(frame);
        };
        t.rafId = requestAnimationFrame(frame);
      });
    }

    _endTurn(t, err) {
      if (t.done) return;
      t.done = true;
      if (t.rafId !== null) cancelAnimationFrame(t.rafId);
      if (this.turning === t) this.turning = null;
      this.effect = null;
      this.draw();
      if (err) t.reject(err);
      else t.resolve();
    }

    stop() {
      if (this.active) this._finish(this.active, new Interrupt());
      if (this.turning) this._endTurn(this.turning, new Interrupt());
    }

    // A treat on the ground (null removes it). It drops in from above.
    setProp(prop) {
      this.prop = prop ? { ...prop, born: performance.now(), eaten: 0 } : null;
      this.draw();
      this._wakeAmbient();
    }

    // ------------------------------------------------ ambient animation
    // A light redraw loop for things that move by themselves: a bone
    // dropping, her ball rolling, snow. It stops when nothing is moving and
    // while paused (hidden, locked, or she is in a deep sleep).

    setAmbientPaused(paused) {
      this.ambientPaused = paused;
      if (paused && this.ambientRaf !== null) {
        cancelAnimationFrame(this.ambientRaf);
        this.ambientRaf = null;
      }
      // No flakes frozen in mid-air while paused: just the settled snow.
      if (paused && this.snowCtx) this._drawSnowLayer(performance.now(), { flakes: false });
      if (!paused) this._wakeAmbient();
    }

    // Something on her own canvas is moving (a dropping bone, the ball).
    _propsMoving(now) {
      if (this.prop && now - this.prop.born < BONE_DROP_MS) return true;
      const t = this.toy;
      return Boolean(t && !t.held && (!t.resting || t.squash > 0));
    }

    _snowActive() {
      return this.snow.on || this.snow.depth.some((d) => d > 0);
    }

    _ambientBusy(now) {
      return this._propsMoving(now) || this._snowActive();
    }

    _wakeAmbient() {
      if (this.ambientRaf !== null || this.ambientPaused) return;
      this.ambientLast = performance.now();
      const tick = (now) => {
        this.ambientRaf = null;
        const dt = Math.min(0.05, Math.max(0, (now - this.ambientLast) / 1000));
        this.ambientLast = now;
        const moving = this._propsMoving(now);
        this._stepToy(dt);
        this._stepSnow(dt);
        // A playing clip redraws on its own frames too; keep to about AMBIENT_FPS.
        if ((moving || !this.snowCtx) && now - this.lastDrawAt >= 1000 / AMBIENT_FPS - 4) this.draw();
        if (this.snowCtx && now - this.snow.drawnAt >= 1000 / SNOW_FPS - 4) this._drawSnowLayer(now);
        if (!this.ambientPaused && this._ambientBusy(now)) this.ambientRaf = requestAnimationFrame(tick);
      };
      this.ambientRaf = requestAnimationFrame(tick);
    }

    // ------------------------------------------------ bed

    // Her bed (null hides it). halfWidth in clip pixels.
    setBed(bed) {
      this.bed = bed ? { x: bed.x, halfWidth: bed.halfWidth } : null;
      if (!this.active) this.draw();
    }

    bedHit(x, y) {
      if (!this.bed) return false;
      const { scale } = this.view();
      const ground = this.manifest.groundY * scale;
      return Math.abs(x - this.bed.x) <= this.bed.halfWidth * scale
        && y >= ground - BED_RIM_BACK * scale && y <= ground + 4 * scale;
    }

    _drawBed(ctx, part) {
      const { scale } = this.view();
      const k = this.dpr * scale;
      ctx.save();
      ctx.setTransform(k, 0, 0, k, this.dpr * this.bed.x, this.dpr * this.manifest.groundY * scale);
      drawBed(ctx, this.bed.halfWidth, part);
      ctx.restore();
    }

    // ------------------------------------------------ ball

    // Her ball (null hides it), resting on the ground at window x.
    setToy(toy) {
      this.toy = toy ? { x: toy.x, h: 0, vx: 0, vy: 0, angle: 0, held: false, squash: 0, resting: true } : null;
      if (!this.active) this.draw();
    }

    toyHit(x, y) {
      const t = this.toy;
      if (!t) return false;
      const { scale } = this.view();
      const cy = this.manifest.groundY * scale - TOY_R * scale - t.h;
      return Math.hypot(x - t.x, y - cy) <= (TOY_R + 7) * scale;
    }

    // Centre of the ball, window pixels.
    toyCentre() {
      const t = this.toy;
      const { scale } = this.view();
      return { x: t.x, y: this.manifest.groundY * scale - TOY_R * scale - t.h };
    }

    // Being dragged: centre at window (x, y), never below the ground.
    holdToy(x, y) {
      const t = this.toy;
      if (!t) return;
      const { scale } = this.view();
      const r = TOY_R * scale;
      t.held = true;
      t.resting = false;
      t.vx = 0;
      t.vy = 0;
      t.x = Math.min(Math.max(x, r), this.width - r);
      t.h = Math.max(0, this.manifest.groundY * scale - r - y);
      this.draw();
    }

    // Let go or nudge: velocity in window px/s (vy positive = upwards).
    launchToy(vx, vy) {
      const t = this.toy;
      if (!t) return;
      const { scale } = this.view();
      const max = TOY.maxSpeed * scale;
      t.held = false;
      t.resting = false;
      t.vx = Math.max(-max, Math.min(max, vx));
      t.vy = Math.max(-max, Math.min(max, vy));
      this._wakeAmbient();
    }

    // A squeak: the ball squashes for a moment.
    squeakToy() {
      if (!this.toy) return;
      this.toy.squash = 1;
      this._wakeAmbient();
    }

    _stepToy(dt) {
      const t = this.toy;
      if (!t || t.held) return;
      t.squash = Math.max(0, t.squash - dt * 5);
      if (t.resting) return;
      const { scale } = this.view();
      const r = TOY_R * scale;
      t.vy -= TOY.gravity * scale * dt;
      t.h += t.vy * dt;
      if (t.h <= 0) {
        t.h = 0;
        t.vy = t.vy < -60 * scale ? -t.vy * TOY.bounce : 0;
      }
      if (t.h === 0 && t.vy === 0) {
        const slow = TOY.rollDecel * scale * dt;
        t.vx = Math.abs(t.vx) <= slow ? 0 : t.vx - Math.sign(t.vx) * slow;
      }
      t.x += t.vx * dt;
      if (t.x < r || t.x > this.width - r) {
        t.x = Math.min(Math.max(t.x, r), this.width - r);
        t.vx = -t.vx * TOY.wallBounce;
      }
      t.angle += (t.vx * dt) / r;
      if (t.h === 0 && t.vy === 0 && Math.abs(t.vx) < TOY.restSpeed * scale) {
        t.vx = 0;
        t.resting = true;
        if (this.onToyRest) this.onToyRest(t.x);
      }
    }

    _drawToy(ctx) {
      const t = this.toy;
      const { scale } = this.view();
      const k = this.dpr * scale;
      const sq = 1 - 0.22 * t.squash;
      const cy = this.manifest.groundY * scale - TOY_R * scale * sq - t.h;
      ctx.save();
      ctx.setTransform(k * (2 - sq), 0, 0, k * sq, this.dpr * t.x, this.dpr * cy);
      drawToy(ctx, t.angle);
      ctx.restore();
    }

    // ------------------------------------------------ snow

    setSnow(on) {
      if (on === this.snow.on) return;
      this.snow.on = on;
      if (on) {
        // Start with flakes already on their way down, not a wall of them at the top.
        const { scale } = this.view();
        const want = Math.round((this.width / 100) * this.snowDensity);
        this.snow.flakes = Array.from({ length: want }, () => this._newFlake(scale, true));
        this._wakeAmbient();
      }
    }

    _newFlake(scale, anywhere) {
      const ground = this.manifest.groundY * scale;
      return {
        x: Math.random() * this.width,
        y: anywhere ? Math.random() * ground : -4,
        r: (1 + Math.random() * 1.6) * scale,
        vy: (22 + Math.random() * 26) * scale,
        sway: (6 + Math.random() * 10) * scale,
        phase: Math.random() * Math.PI * 2,
      };
    }

    _stepSnow(dt) {
      const snow = this.snow;
      const depth = snow.depth;
      const { scale } = this.view();
      if (!snow.on) {
        snow.flakes = [];
        const melt = SNOW.meltPerSec * scale * dt;
        for (let i = 0; i < depth.length; i += 1) depth[i] = Math.max(0, depth[i] - melt);
        return;
      }
      const ground = this.manifest.groundY * scale;
      const cap = SNOW.maxDepth * scale;
      const add = SNOW.perFlake * scale;
      for (const f of snow.flakes) {
        f.phase += dt * 1.3;
        f.y += f.vy * dt;
        f.x += Math.sin(f.phase) * f.sway * dt;
        const col = Math.max(0, Math.min(depth.length - 1, Math.round(f.x / SNOW.column)));
        if (f.y >= ground - depth[col]) {
          depth[col] = Math.min(cap, depth[col] + add);
          if (col > 0) depth[col - 1] = Math.min(cap, depth[col - 1] + add * 0.5);
          if (col < depth.length - 1) depth[col + 1] = Math.min(cap, depth[col + 1] + add * 0.5);
          Object.assign(f, this._newFlake(scale, false));
        }
      }
    }

    _drawSnowLayer(now, { flakes = true } = {}) {
      const ctx = this.snowCtx;
      this.snow.drawnAt = now;
      const active = this._snowActive();
      if (!active && !this.snow.shown) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.snowCanvas.width, this.snowCanvas.height);
      this.snow.shown = active;
      if (!active) return;
      this._drawSnowPile(ctx);
      if (flakes) this._drawFlakes(ctx);
    }

    _drawSnowPile(ctx) {
      const depth = this.snow.depth;
      if (!depth.some((v) => v > 0.05)) return;
      const { scale } = this.view();
      const ground = this.manifest.groundY * scale;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.moveTo(0, ground);
      for (let i = 0; i < depth.length; i += 1) {
        const prev = depth[Math.max(0, i - 1)];
        const next = depth[Math.min(depth.length - 1, i + 1)];
        ctx.lineTo(i * SNOW.column, ground - (prev + 2 * depth[i] + next) / 4);
      }
      ctx.lineTo(this.width, ground);
      ctx.closePath();
      ctx.fillStyle = 'rgba(250, 252, 255, 0.95)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(180, 200, 225, 0.6)';
      ctx.stroke();
      ctx.restore();
    }

    _drawFlakes(ctx) {
      const flakes = this.snow.flakes;
      if (!flakes.length) return;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      for (const f of flakes) {
        if (f.y < 0) continue;
        ctx.globalAlpha = 0.9 * Math.min(1, f.y / SNOW.fadeInPx);
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // The water bowl (null hides it).
    setBowl(bowl) {
      this.bowl = bowl ? { x: bowl.x, drinking: false } : null;
      if (!this.active) this.draw();
    }

    setBowlDrinking(drinking) {
      if (this.bowl) this.bowl.drinking = drinking;
    }

    // Is window point (x, y) on the bowl (with a little slack)?
    bowlHit(x, y) {
      if (!this.bowl) return false;
      const { scale } = this.view();
      const ground = this.manifest.groundY * scale;
      return Math.abs(x - this.bowl.x) <= 29 * BOWL_SCALE * scale && y >= ground - 23 * BOWL_SCALE * scale && y <= ground + 4 * scale;
    }

    setShadows(on) {
      this.shadows = on;
      if (!this.active) this.draw();
    }

    // Shift the bone sideways without dropping it again.
    moveProp(x) {
      if (!this.prop) return;
      this.prop.x = x;
      if (!this.active) this.draw();
    }

    // 0 = whole, 1 = gone.
    setPropEaten(amount) {
      if (this.prop) this.prop.eaten = amount;
    }

    _drawProp(ctx) {
      const p = this.prop;
      const { scale } = this.view();
      const k = this.dpr * scale;
      const fall = Math.min(1, (performance.now() - p.born) / BONE_DROP_MS);
      const restY = this.manifest.groundY * scale - 11 * scale; // lying on the ground
      const y = -20 * scale + (restY + 20 * scale) * easeOutBounce(fall);
      const size = 1.3 * (1 - 0.6 * p.eaten);
      ctx.save();
      ctx.setTransform(k * size, 0, 0, k * size, this.dpr * p.x, this.dpr * y);
      ctx.rotate(-0.08);
      ctx.globalAlpha = 1 - p.eaten;
      traceBone(ctx);
      ctx.fillStyle = '#f4ead4';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#a88c5c';
      ctx.stroke();
      ctx.restore();
    }

    // Display size of what is on screen now (see config.lyingSize).
    displaySize() {
      const src = this.source;
      if (!src) return 1;
      const who = this.names.get(src) || {};
      let index = 0;
      if (who.clip) {
        index = this.active && this.active.video === src && this.active.lastIndex >= 0
          ? this.active.lastIndex
          : Math.round(src.currentTime * this.manifest.fps);
      }
      return this.sizeFor(who.clip || null, who.pose || null, index);
    }

    _drawShadows(ctx) {
      const { cx, dir, scale } = this.view();
      const k = this.dpr * scale;
      const groundY = this.dpr * this.manifest.groundY * scale;
      if (this.source && this.bodyExtent) {
        const { back, front } = this.bodyExtent;
        const lift = this.effect ? this.effect.lift : 0;
        const centre = this.dpr * cx + dir * ((front - back) / 2) * k;
        const size = this.displaySize();
        drawShadow(ctx, centre, groundY - 1.5 * k, (front + back) * 0.36 * k * size * (1 - lift / 40), 7.5 * k, 0.3 * (1 - lift / 25));
      }
      if (this.prop && this.prop.eaten < 1 && performance.now() - this.prop.born > BONE_DROP_MS * 0.6) {
        drawShadow(ctx, this.dpr * this.prop.x, groundY - k, 30 * k * (1 - 0.6 * this.prop.eaten), 3.5 * k, 0.22);
      }
      if (this.bowl) drawShadow(ctx, this.dpr * this.bowl.x, groundY - k, 31 * BOWL_SCALE * k, 4 * k, 0.26);
      if (this.bed) drawShadow(ctx, this.dpr * this.bed.x, groundY - k, (this.bed.halfWidth + 6) * k, 5 * k, 0.26);
      if (this.toy) {
        const up = Math.min(1, this.toy.h / (60 * scale)); // fainter and smaller as it flies
        drawShadow(ctx, this.dpr * this.toy.x, groundY - k, TOY_R * 1.2 * k * (1 - 0.5 * up), 2.6 * k, 0.24 * (1 - 0.7 * up));
      }
    }

    _drawBowl(ctx) {
      const { scale } = this.view();
      const k = this.dpr * scale;
      ctx.save();
      ctx.setTransform(k * BOWL_SCALE, 0, 0, k * BOWL_SCALE, this.dpr * this.bowl.x, this.dpr * this.manifest.groundY * scale);
      drawBowl(ctx, this.bowl.drinking ? 1 : 0);
      ctx.restore();
    }

    draw() {
      const ctx = this.ctx;
      this.lastDrawAt = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.snowCtx) this._drawSnowPile(ctx);
      if (this.shadows) this._drawShadows(ctx);
      if (this.bed) this._drawBed(ctx, 'back'); // she lies in it...
      if (this.prop) this._drawProp(ctx); // behind her, so she stands over it
      const src = this.source;
      if (src && !(src instanceof HTMLVideoElement && src.readyState < HAVE_CURRENT_DATA)) {
        const { cx, dir, scale } = this.view();
        const k = this.dpr * scale;
        const squash = this.effect ? this.effect.squash : 1;
        const lift = this.effect ? this.effect.lift * k : 0;
        const size = this.displaySize();
        const keepFeetDown = k * this.manifest.groundY * (1 - size); // resize about her feet
        // Flip around her centre point so turning never shifts her sideways.
        ctx.setTransform(k * dir * squash * size, 0, 0, k * size, this.dpr * cx, keepFeetDown - lift);
        ctx.drawImage(src, -this.manifest.standingCenterX, 0, this.manifest.width, this.manifest.height);
      }
      if (this.bed) this._drawBed(ctx, 'front'); // ...behind its front rim
      if (this.bowl) this._drawBowl(ctx); // in front of her, so her snout dips into it
      if (this.toy) this._drawToy(ctx);
      if (!this.snowCtx) this._drawFlakes(ctx);
      if (this.onDraw) this.onDraw();
    }

    _schedule(a) {
      if (this.useFrameCallback) {
        a.callbackId = a.video.requestVideoFrameCallback((now, meta) => this._frame(a, meta.mediaTime, now));
      } else {
        a.callbackId = requestAnimationFrame((now) => this._frame(a, a.video.currentTime, now));
      }
    }

    _cancel(a) {
      if (a.callbackId === null) return;
      if (this.useFrameCallback) a.video.cancelVideoFrameCallback(a.callbackId);
      else cancelAnimationFrame(a.callbackId);
      a.callbackId = null;
    }

    _frame(a, mediaTime, now) {
      a.callbackId = null;
      if (a.done) return;
      const index = Math.min(a.frames - 1, Math.max(0, Math.round(mediaTime * this.manifest.fps)));
      if (index !== a.lastIndex) {
        const wrapped = a.lastIndex !== -1 && index < a.lastIndex;
        try {
          if (a.onFrame) a.onFrame({ prevIndex: a.lastIndex, index, wrapped, frames: a.frames });
          a.lastIndex = index;
          a.lastShownAt = now;
          this.source = a.video;
          this.draw();
        } catch (err) {
          this._finish(a, err);
          return;
        }
      }
      this._schedule(a);
    }

    _ended(a) {
      if (a.done) return;
      try {
        // Account for the final frame if it was never reported.
        if (a.onFrame && a.lastIndex < a.frames - 1) {
          a.onFrame({ prevIndex: a.lastIndex, index: a.frames - 1, wrapped: false, frames: a.frames });
          a.lastIndex = a.frames - 1;
          a.lastShownAt = performance.now();
        }
        this.source = a.video;
        this.draw();
      } catch (err) {
        this._finish(a, err);
        return;
      }
      // 'ended' can arrive just as the last frame appears; keep that frame on
      // screen for its full time before the next clip starts, so the hand-over
      // has no short frame (a visible hitch).
      const frameMs = 1000 / this.manifest.fps / a.rate;
      const wait = a.lastShownAt + frameMs - HANDOVER_LEAD_MS - performance.now();
      if (wait > 0) setTimeout(() => this._finish(a, null), wait);
      else this._finish(a, null);
    }

    _finish(a, err) {
      if (a.done) return;
      a.done = true;
      this._cancel(a);
      a.video.removeEventListener('ended', a.onEnded);
      a.video.removeEventListener('error', a.onError);
      if (this.active === a) this.active = null;
      // The canvas keeps the last frame; future redraws use the matching pose,
      // because the video itself is about to be rewound.
      const clip = this.manifest.clips[a.name];
      this.source = this.poses.get(err ? clip.startPose : clip.endPose);
      a.video.pause();
      a.video.loop = false;
      a.video.playbackRate = 1;
      a.video.currentTime = 0; // park it at the start, ready for next time
      this._releaseLater(a.name);
      if (err) a.reject(err);
      else a.resolve();
    }

    // Reload a clip that stays unused for RELEASE_IDLE_MS, freeing its decoder.
    _releaseLater(name) {
      clearTimeout(this.releaseTimers.get(name));
      this.releaseTimers.set(name, setTimeout(() => {
        this.releaseTimers.delete(name);
        if (this.active && this.active.name === name) return;
        this.videos.get(name).load();
      }, RELEASE_IDLE_MS));
    }
  }

  // Tests whether the cursor is over an opaque part of the current frame.
  class HitTester {
    constructor({ manifest, threshold, radiusPx }) {
      this.manifest = manifest;
      this.threshold = threshold;
      this.radius = radiusPx;
      this.size = radiusPx * 2 + 1;
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.size;
      this.canvas.height = this.size;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }

    // x, y: cursor position in window pixels.
    hit(source, view, x, y) {
      if (!source) return false;
      if (source instanceof HTMLVideoElement && source.readyState < HAVE_CURRENT_DATA) return false;
      const { cx, dir, scale } = view;
      const size = view.size ?? 1;
      const { width, height, standingCenterX, groundY } = this.manifest;
      const k = scale * size;
      const r = this.radius / k;
      const lx = (x - cx) / (dir * k) + standingCenterX;
      const ly = (y - scale * groundY * (1 - size)) / k;
      if (lx < -r || ly < -r || lx > width + r || ly > height + r) return false;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.size, this.size);
      ctx.drawImage(source, lx - r, ly - r, 2 * r, 2 * r, 0, 0, this.size, this.size);
      const data = ctx.getImageData(0, 0, this.size, this.size).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > this.threshold) return true;
      }
      return false;
    }
  }

  root.LuluInterrupt = Interrupt;
  root.LuluPlayer = Player;
  root.LuluHitTester = HitTester;
})(self);
