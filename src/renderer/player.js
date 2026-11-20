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
    constructor({ canvas, manifest, assetBase, view, mediaHost }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('2D canvas is not available');
      this.manifest = manifest;
      this.assetBase = assetBase;
      this.view = view; // () => ({ cx, dir, scale })
      this.mediaHost = mediaHost;
      this.videos = new Map();
      this.poses = new Map();
      this.active = null;
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
        jobs.push(waitForVideo(video, clip.file));
      }
      for (const [pose, file] of Object.entries(this.manifest.poses)) {
        const img = new Image();
        img.src = this.assetBase + file;
        this.poses.set(pose, img);
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
      for (const img of this.poses.values()) {
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

    duration(name) {
      const video = this.videos.get(name);
      if (!video) throw new Error(`Unknown clip ${name}`);
      return Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : this.manifest.clips[name].seconds;
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
    }

    showPose(pose) {
      if (this.active) throw new Error(`showPose(${pose}) while ${this.active.name} is playing`);
      const img = this.poses.get(pose);
      if (!img) throw new Error(`Unknown pose ${pose}`);
      this.source = img;
      this.draw();
    }

    // Plays a clip to its end. Resolves when it ends, rejects with Interrupt
    // if stop() is called. With loop: true it repeats until endLoop().
    // onFrame({ prevT, t, wrapped, duration }) runs for every new frame,
    // before it is drawn, so movement stays locked to the animation.
    play(name, { loop = false, onFrame = null } = {}) {
      if (this.active) {
        return Promise.reject(new Error(`Cannot play ${name}: ${this.active.name} is still playing`));
      }
      const video = this.videos.get(name);
      if (!video) return Promise.reject(new Error(`Unknown clip ${name}`));
      return new Promise((resolve, reject) => {
        const a = { name, video, onFrame, resolve, reject, lastT: 0, callbackId: null, done: false };
        a.onEnded = () => this._ended(a);
        a.onError = () => this._finish(a, new Error(`Playback of ${name} failed (${mediaErrorText(video)})`));
        video.addEventListener('ended', a.onEnded);
        video.addEventListener('error', a.onError);
        video.loop = loop;
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

    stop() {
      if (this.active) this._finish(this.active, new Interrupt());
    }

    draw() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const src = this.source;
      if (src && !(src instanceof HTMLVideoElement && src.readyState < HAVE_CURRENT_DATA)) {
        const { cx, dir, scale } = this.view();
        const k = this.dpr * scale;
        // Flip around her centre point so turning never shifts her sideways.
        ctx.setTransform(k * dir, 0, 0, k, this.dpr * cx, 0);
        ctx.drawImage(src, -this.manifest.standingCenterX, 0, this.manifest.width, this.manifest.height);
      }
      if (this.onDraw) this.onDraw();
    }

    _schedule(a) {
      if (this.useFrameCallback) {
        a.callbackId = a.video.requestVideoFrameCallback((_now, meta) => this._frame(a, meta.mediaTime));
      } else {
        a.callbackId = requestAnimationFrame(() => this._frame(a, a.video.currentTime));
      }
    }

    _cancel(a) {
      if (a.callbackId === null) return;
      if (this.useFrameCallback) a.video.cancelVideoFrameCallback(a.callbackId);
      else cancelAnimationFrame(a.callbackId);
      a.callbackId = null;
    }

    _frame(a, t) {
      a.callbackId = null;
      if (a.done) return;
      const prevT = a.lastT;
      const wrapped = t + 1e-4 < prevT;
      if (t !== prevT || wrapped) {
        a.lastT = t;
        try {
          if (a.onFrame) a.onFrame({ prevT, t, wrapped, duration: this.duration(a.name) });
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
      const duration = this.duration(a.name);
      try {
        // Account for any movement in the final frame interval.
        if (a.onFrame && a.lastT < duration) a.onFrame({ prevT: a.lastT, t: duration, wrapped: false, duration });
        this.source = a.video;
        this.draw();
      } catch (err) {
        this._finish(a, err);
        return;
      }
      this._finish(a, null);
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
      a.video.currentTime = 0; // park it at the start, ready for next time
      if (err) a.reject(err);
      else a.resolve();
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
      const { width, height, standingCenterX } = this.manifest;
      const r = this.radius / scale;
      const lx = (x - cx) / (dir * scale) + standingCenterX;
      const ly = y / scale;
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
