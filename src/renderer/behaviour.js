// Lulu's behaviour. Standing is the hub: she holds still, then picks an
// action. Requests (clicks, menu commands) are taken at safe points (the end
// of a clip, or the end of a walk or breathing cycle) so a clip is never cut
// mid-way and there is no visible jump. Only drags, hiding and moving screens
// interrupt immediately.
(function (root) {
  'use strict';

  const L = root.LuluLogic;
  const Interrupt = root.LuluInterrupt;

  const COMMANDS = new Set(['walk', 'sit', 'nap', 'wake', 'come']);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class Behaviour {
    constructor({
      player, manifest, config, api, extents, walkSpeed, tune, prepareLayout,
      rng = Math.random, clock = () => new Date(),
    }) {
      this.player = player;
      this.manifest = manifest;
      this.config = config;
      this.api = api;
      this.clipExtents = extents; // clip pixels, facing right
      this.tune = tune;
      this.prepareLayout = prepareLayout; // resizes the canvas for a new layout
      this.rng = rng;
      this.clock = clock;
      this.walkSpeed = this.clampSpeed(walkSpeed); // px/s at size 1.0

      this.layout = null;
      this.cx = 0; // her centre, in window pixels
      this.dir = 1; // 1 = facing right, -1 = facing left
      this.pose = 'stand'; // pose she is in (or started the current clip in)

      this.running = false;
      this.dragging = false;
      this.userIdle = false;
      this.idleSince = 0;
      this.idleSleep = false; // asleep because the user is away
      this.napEnds = 0;
      this.pending = null; // { type } waiting for the next safe point
      this.lastAction = null;
      this.lastPet = -Infinity;
      this.lastNotice = -Infinity;
      this.walk = null; // the walk in progress
      this.crossing = false;

      this.onNotify = null;
      this.cancelWait = null;
      this.gateWaiters = [];
    }

    // ------------------------------------------------------------ geometry

    view() {
      return { cx: this.cx, dir: this.dir, scale: this.layout ? this.layout.scale : 1 };
    }

    extents() {
      const s = this.layout.scale;
      return { back: this.clipExtents.back * s, front: this.clipExtents.front * s };
    }

    range() {
      return L.walkRange(this.layout.width, this.extents(), this.config.edgeMarginPx);
    }

    clampIntoView() {
      const r = this.range();
      this.cx = L.clamp(this.cx, r.min, r.max);
    }

    vmax() {
      return this.walkSpeed * this.layout.scale;
    }

    distances() {
      const v = this.vmax();
      return {
        start: L.phaseDistance('start', v, this.player.duration('walk_start')),
        loop: L.phaseDistance('loop', v, this.player.duration('walk_loop')),
        stop: L.phaseDistance('stop', v, this.player.duration('walk_stop')),
      };
    }

    aheadIsWall(dir = this.dir) {
      return !this.layout.edges[dir > 0 ? 'right' : 'left'];
    }

    clampSpeed(speed) {
      const [lo, hi] = this.config.walkSpeedRange;
      return L.clamp(Math.round(speed), lo, hi);
    }

    setWalkSpeed(speed) {
      this.walkSpeed = this.clampSpeed(speed);
    }

    savePosition() {
      if (this.layout) this.api.savePosition(L.clamp(this.cx / this.layout.width, 0, 1));
    }

    // ------------------------------------------------------------ layout

    applyLayout(layout, { xFraction = 0.5 } = {}) {
      if (this.layout && layout.seq <= this.layout.seq) return; // stale
      const prev = this.layout;
      this.layout = layout;
      switch (layout.reason) {
        case 'init':
          this.cx = xFraction * layout.width;
          this.clampIntoView();
          break;
        case 'resize':
          if (prev && prev.width !== layout.width) this.cx *= layout.width / prev.width;
          if (!this.walk) this.clampIntoView();
          break;
        case 'edges':
          break;
        case 'hop':
        case 'move':
          this.relocated(layout.place, layout.comeX);
          break;
        default:
          throw new Error(`Unknown layout reason: ${layout.reason}`);
      }
    }

    // She has been moved to another screen (fullscreen app, menu, tray, or
    // "Come here" pointing at another screen). 'enter-left'/'enter-right'
    // put her just out of sight on that side, ready to walk in to comeX.
    relocated(place, comeX) {
      this.interrupt();
      const r = this.range();
      if (place === 'enter-left' || place === 'enter-right') {
        this.dir = place === 'enter-left' ? 1 : -1; // out of sight, so no turn is needed
        this.cx = L.entryPosition({ dir: this.dir, width: this.layout.width, extents: this.extents() });
        this.pending = { type: 'come', x: comeX };
      } else if (place === 'random') {
        this.cx = L.randRange(this.rng, r.min, r.max);
      } else {
        this.cx = (r.min + r.max) / 2;
      }
      this.player.showPose(this.pose);
      this.savePosition();
    }

    // ------------------------------------------------------------ inputs

    request(type, extra = {}) {
      this.pending = { ...extra, type };
      this.notify();
    }

    click() {
      this.request('happy');
    }

    command(name, args = {}) {
      if (!COMMANDS.has(name)) throw new Error(`Unknown command: ${name}`);
      if (name === 'come') {
        if (!Number.isFinite(args.x)) throw new Error('come needs an x position');
        this.request('come', { x: args.x });
        return;
      }
      this.request(name);
    }

    // The mouse is near her: she looks up at you at the next natural break.
    notice() {
      if (this.dragging || this.pose === 'sleep' || this.pending) return;
      if (this.walk && this.walk.target !== null) return; // already coming to you
      const now = Date.now();
      if (now - this.lastNotice < this.config.noticeCooldownMs) return;
      this.lastNotice = now;
      this.request('look');
    }

    // Is window x within noticeRadiusPx of her body (not her centre)?
    isNear(x) {
      if (!this.layout) return false;
      const e = this.extents();
      const left = this.dir > 0 ? this.cx - e.back : this.cx - e.front;
      const right = this.dir > 0 ? this.cx + e.front : this.cx + e.back;
      const reach = this.config.noticeRadiusPx * this.layout.scale;
      return x >= left - reach && x <= right + reach;
    }

    mood() {
      return L.moodAt(this.clock().getHours(), this.config.moods);
    }

    setUserIdle(idle) {
      if (idle === this.userIdle) return;
      this.userIdle = idle;
      if (idle) this.idleSince = Date.now();
      this.notify();
    }

    setRunning(running) {
      if (running === this.running) return;
      this.running = running;
      if (running) this.openGate();
      else this.interrupt();
    }

    beginDrag() {
      this.dragging = true;
      this.interrupt();
      this.player.showPose(this.pose);
    }

    dragTo(x) {
      const r = this.range();
      this.cx = L.clamp(x, r.min, r.max);
      this.player.draw();
    }

    endDrag() {
      this.dragging = false;
      this.savePosition();
      if (this.pose === 'sleep') this.pending = { type: 'wake' };
      this.openGate();
    }

    // Rubbed with the mouse. Awake: she wags (happy). Asleep: she stays
    // asleep and her nap gets a little longer.
    pet() {
      if (this.dragging) return;
      const now = Date.now();
      if (this.pose === 'sleep') {
        if (!this.idleSleep) this.napEnds = Math.max(this.napEnds, now + this.config.petNapExtendMs);
        return;
      }
      if (now - this.lastPet < this.config.petCooldownMs) return;
      this.lastPet = now;
      this.request('happy');
    }

    // ------------------------------------------------------------ control flow

    notify() {
      if (this.onNotify) this.onNotify();
    }

    interrupt() {
      this.player.stop();
      if (this.cancelWait) this.cancelWait();
    }

    openGate() {
      const waiters = this.gateWaiters;
      this.gateWaiters = [];
      waiters.forEach((resolve) => resolve());
    }

    async gate() {
      while (!this.running || this.dragging) {
        await new Promise((resolve) => this.gateWaiters.push(resolve));
      }
    }

    // Resolves 'timeout' after ms, or 'notify' when something changes.
    // Rejects with Interrupt when interrupted.
    wait(ms) {
      return new Promise((resolve, reject) => {
        const timer = Number.isFinite(ms) ? setTimeout(() => done('timeout'), ms) : null;
        const done = (value, err) => {
          clearTimeout(timer);
          this.onNotify = null;
          this.cancelWait = null;
          if (err) reject(err);
          else resolve(value);
        };
        this.onNotify = () => done('notify');
        this.cancelWait = () => done(null, new Interrupt());
      });
    }

    takePending() {
      const req = this.pending;
      this.pending = null;
      return req;
    }

    start() {
      this.player.showPose(this.pose);
      this.loop().catch((err) => this.api.reportError(`Behaviour loop stopped: ${err && err.stack ? err.stack : err}`));
    }

    async loop() {
      for (;;) {
        await this.gate();
        try {
          await this.step();
        } catch (err) {
          this.walk = null;
          this.onNotify = null;
          this.cancelWait = null;
          if (err instanceof Interrupt) {
            if (this.running && !this.dragging) this.player.showPose(this.pose);
            continue;
          }
          this.api.reportError(`Behaviour error: ${err && err.stack ? err.stack : err}`);
          this.player.stop();
          this.player.showPose(this.pose);
          await delay(2000);
        }
      }
    }

    async step() {
      const req = this.takePending();
      if (this.pose === 'sleep') await this.sleepStep(req);
      else await this.standStep(req);
    }

    async playClip(name, options) {
      await this.player.play(name, options);
      this.pose = this.manifest.clips[name].endPose;
    }

    // ------------------------------------------------------------ standing

    async standStep(req) {
      // "Come here" may start her just out of sight; everything else starts on screen.
      if (!(req && req.type === 'come')) this.clampIntoView();
      this.player.showPose('stand');
      if (req) {
        await this.perform(req.type, req);
        return;
      }
      if (this.userIdle) {
        await this.goToSleep(true);
        return;
      }
      const mood = this.tune ? null : this.mood();
      const [lo, hi] = this.tune ? this.config.tuneHoldSeconds : this.config.holdSeconds;
      const holdScale = mood ? mood.hold : 1;
      const why = await this.wait(L.randRange(this.rng, lo, hi) * holdScale * 1000);
      if (why !== 'timeout') return; // a request or idle change: handle it next step
      const weights = this.tune ? this.config.tuneWeights : L.applyMood(this.config.weights, mood);
      await this.perform(L.pickAction(this.rng, weights, this.lastAction));
    }

    async perform(type, req = {}) {
      switch (type) {
        case 'walk':
          if (await this.doWalk()) this.lastAction = 'walk';
          return;
        case 'come':
          await this.comeTo(req.x);
          return;
        case 'nap':
          this.lastAction = 'nap';
          await this.goToSleep(false);
          return;
        case 'wake':
          return; // already awake
        case 'happy':
          await this.playClip('happy');
          return;
        case 'look':
        case 'sniff':
        case 'sit':
        case 'stretch':
          this.lastAction = type;
          await this.playClip(type);
          return;
        default:
          throw new Error(`Unknown action: ${type}`);
      }
    }

    // ------------------------------------------------------------ sleeping

    async goToSleep(untilUserReturns) {
      this.idleSleep = untilUserReturns;
      const [lo, hi] = this.config.napSeconds;
      const napScale = this.tune ? 1 : this.mood().nap;
      this.napEnds = Date.now() + L.randRange(this.rng, lo, hi) * napScale * 1000;
      await this.playClip('lie_down');
    }

    async wakeUp() {
      this.idleSleep = false;
      await this.playClip('wake_up');
    }

    async sleepStep(req) {
      if (req && req.type !== 'nap') {
        await this.wakeUp();
        if (req.type !== 'wake' && !this.pending) this.pending = req; // e.g. click: wake_up then happy
        return;
      }
      if (this.userIdle) {
        this.idleSleep = true; // a nap turns into sleeping until the user is back
      } else if (this.idleSleep) {
        await this.wakeUp(); // you're back: wake up and look at you
        if (!this.pending) this.pending = { type: 'look' };
        return;
      } else if (Date.now() >= this.napEnds) {
        await this.wakeUp();
        return;
      }
      if (this.idleSleep && Date.now() - this.idleSince >= this.config.deepSleepAfterMs) {
        this.player.showPose('sleep'); // still pose: no decoding while nobody is watching
        await this.wait(Infinity);
        return;
      }
      await this.breathe();
    }

    // Breathing loop until the nap is over or something needs her. The loop
    // always finishes its current breath, so waking up starts from the pose.
    async breathe() {
      const deadline = this.idleSleep ? this.idleSince + this.config.deepSleepAfterMs : this.napEnds;
      const timer = setTimeout(() => this.player.endLoop(), Math.max(0, deadline - Date.now()));
      this.onNotify = () => this.player.endLoop();
      try {
        await this.playClip('sleep_loop', { loop: true });
      } finally {
        clearTimeout(timer);
        this.onNotify = null;
      }
    }

    // ------------------------------------------------------------ walking

    // "Come here": walk to x (window pixels), then look up at you. If she is
    // already close she just turns that way.
    async comeTo(x) {
      const r = this.range();
      const target = L.clamp(x, r.min, r.max);
      const D = this.distances();
      const onScreen = this.cx >= r.min && this.cx <= r.max;
      const distance = target - this.cx;
      if (!onScreen || Math.abs(distance) >= D.start + D.stop) {
        await this.doWalk({ target });
      } else if (Math.abs(distance) > 1) {
        await this.turnTo(Math.sign(distance));
      }
      this.lastAction = 'look';
      await this.playClip('look');
    }

    async doWalk({ target = null } = {}) {
      const D = this.distances();
      const edges = this.layout.edges;
      const exits = ['left', 'right'].filter((side) => edges[side]);
      let trip = false;
      let dir;
      if (target !== null) {
        dir = target >= this.cx ? 1 : -1;
      } else {
        if (exits.length > 0 && !this.tune && this.rng() < this.config.tripChance) {
          trip = true;
          dir = exits[Math.floor(this.rng() * exits.length)] === 'right' ? 1 : -1;
        } else {
          dir = L.chooseDirection(this.rng, this.cx - this.range().min, this.range().max - this.cx);
        }
        const fits = (d) => L.canStartWalk({
          cx: this.cx, dir: d, range: this.range(), aheadIsWall: this.aheadIsWall(d),
          startDist: D.start, loopDist: D.loop, stopDist: D.stop,
        });
        if (!fits(dir)) {
          dir = -dir;
          trip = false;
          if (!fits(dir)) return false;
        }
      }
      await this.turnTo(dir); // turn only while standing

      const w = {
        trip,
        target,
        cyclesLeft: target !== null ? Infinity : L.randInt(this.rng, ...this.config.walkLoops),
        hitWall: false,
        ending: false,
        loopT: 0,
      };
      this.walk = w;
      try {
        await this.playClip('walk_start', { onFrame: (f) => this.walkFrame('start', f) });
        if (!this.stopRightAfterStart()) {
          const looping = this.playClip('walk_loop', { loop: true, onFrame: (f) => this.walkFrame('loop', f) });
          this.onNotify = () => this.reconsiderWalk(null);
          this.reconsiderWalk(0);
          await looping;
          this.onNotify = null;
        }
        await this.playClip('walk_stop', { onFrame: (f) => this.walkFrame('stop', f) });
      } finally {
        this.walk = null;
        this.onNotify = null;
      }
      if (w.hitWall) await this.turnTo(-this.dir); // reached the edge: turn around
      this.savePosition();
      return true;
    }

    // Turn around on the spot (standing pose only).
    async turnTo(dir) {
      if (dir === this.dir) return;
      this.player.showPose('stand');
      await this.player.turn({
        durationMs: this.config.turnMs,
        liftPx: this.config.turnLiftPx,
        minSquash: this.config.turnMinSquash,
        onFlip: () => {
          this.dir = dir;
        },
      });
      this.player.showPose('stand');
    }

    // Move her by exactly the distance the animation covered since the last
    // frame, so her feet stay planted.
    walkFrame(phase, f) {
      const v = this.vmax();
      const T = f.duration;
      const d = f.wrapped
        ? L.rampDistance(phase, v, T, f.prevT, T) + L.rampDistance(phase, v, T, 0, f.t)
        : L.rampDistance(phase, v, T, f.prevT, f.t);
      this.cx += this.dir * d;
      if (phase !== 'loop' || !this.walk) return;
      this.walk.loopT = f.t;
      if (f.wrapped) {
        this.walk.cyclesLeft -= 1;
        this.reconsiderWalk(f.t);
      }
      this.checkCrossing();
    }

    // At the end of walk_start: stop straight away only if asked to (or if
    // a wall leaves no room for a full cycle).
    stopRightAfterStart() {
      const D = this.distances();
      const r = L.shouldEndWalk({
        cx: this.cx, dir: this.dir, range: this.range(), aheadIsWall: this.aheadIsWall(),
        remaining: 0, loopDist: D.loop, stopDist: D.stop,
        cyclesLeft: Infinity, wantStop: this.pending !== null, target: this.walk.target,
      });
      if (r.hitWall) this.walk.hitWall = true;
      return r.end;
    }

    // Called at the start of each walk cycle and whenever a request arrives.
    reconsiderWalk(t) {
      const w = this.walk;
      if (!w || w.ending) return;
      const D = this.distances();
      const T = this.player.duration('walk_loop');
      const remaining = L.rampDistance('loop', this.vmax(), T, t === null ? w.loopT : t, T);
      const r = L.shouldEndWalk({
        cx: this.cx, dir: this.dir, range: this.range(), aheadIsWall: this.aheadIsWall(),
        remaining, loopDist: D.loop, stopDist: D.stop,
        cyclesLeft: w.trip ? Infinity : w.cyclesLeft,
        wantStop: this.pending !== null,
        target: w.target,
      });
      if (r.end) {
        w.ending = true;
        w.hitWall = r.hitWall;
        this.player.endLoop();
      }
    }

    // Once she is fully off the edge of a screen that leads to another one,
    // ask main to move the window there and bring her in from the other side.
    checkCrossing() {
      const w = this.walk;
      if (!w || this.crossing) return;
      const side = this.dir > 0 ? 'right' : 'left';
      if (!this.layout.edges[side]) return;
      if (!L.crossed({ cx: this.cx, dir: this.dir, width: this.layout.width, extents: this.extents() })) return;
      this.crossing = true;
      this.api.cross(side)
        .then((layout) => {
          if (layout && (!this.layout || layout.seq > this.layout.seq)) {
            this.prepareLayout(layout);
            this.layout = layout;
            this.cx = L.entryPosition({ dir: this.dir, width: layout.width, extents: this.extents() });
            if (this.walk === w) {
              w.trip = false;
              w.cyclesLeft = L.randInt(this.rng, 1, 3);
            } else {
              this.clampIntoView();
              if (!this.player.playing) this.player.showPose(this.pose);
            }
          } else if (this.walk === w) {
            // The other screen became unavailable: turn back while out of sight.
            this.dir = -this.dir;
            w.trip = false;
          }
        })
        .catch((err) => this.api.reportError(`Crossing screens failed: ${err && err.stack ? err.stack : err}`))
        .finally(() => {
          this.crossing = false;
        });
    }
  }

  root.LuluBehaviour = Behaviour;
})(self);
