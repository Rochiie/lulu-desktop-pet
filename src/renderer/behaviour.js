// Lulu's behaviour. Standing is the hub: she holds still, then picks an
// action. Requests (clicks, menu commands) are taken at safe points (the end
// of a clip, or the end of a walk or breathing cycle) so a clip is never cut
// mid-way and there is no visible jump. Only drags, hiding and moving screens
// interrupt immediately.
(function (root) {
  'use strict';

  const L = root.LuluLogic;
  const RM = root.LuluRootMotion;
  const WALK_CLIPS = Object.freeze({ start: 'walk_start', loop: 'walk_loop', stop: 'walk_stop' });
  const Interrupt = root.LuluInterrupt;

  const COMMANDS = new Set(['walk', 'sit', 'nap', 'wake', 'come', 'treat']);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class Behaviour {
    constructor({
      player, manifest, config, api, extents, prefs, tune, prepareLayout,
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
      this.prefs = prefs;
      this.pace = this.clampPace(prefs.walkPace); // walk playback speed, 1 = as animated

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
      this.treat = null; // { x } a bone waiting to be eaten
      this.follow = null; // { x, movedAt, lookedAt } while "Follow me" is on

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

    // How far each walk clip carries her, in window pixels.
    distances() {
      const s = this.layout.scale;
      return {
        start: L.clipDistance(RM.start) * s,
        loop: L.clipDistance(RM.loop) * s,
        stop: L.clipDistance(RM.stop) * s,
      };
    }

    aheadIsWall(dir = this.dir) {
      return !this.layout.edges[dir > 0 ? 'right' : 'left'];
    }

    clampPace(pace) {
      const [lo, hi] = this.config.walkPaceRange;
      return L.clamp(Math.round(pace * 100) / 100, lo, hi);
    }

    setPace(pace) {
      this.pace = this.clampPace(pace);
    }

    // Preferences from the Settings window, applied live.
    setPrefs(prefs) {
      this.prefs = prefs;
      this.pace = this.clampPace(prefs.walkPace);
    }

    // Body edges in window pixels: [left, right].
    body() {
      const e = this.extents();
      return this.dir > 0 ? [this.cx - e.back, this.cx + e.front] : [this.cx - e.front, this.cx + e.back];
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
          this.relocated(layout.place, layout.comeX, layout.purpose);
          break;
        default:
          throw new Error(`Unknown layout reason: ${layout.reason}`);
      }
    }

    // She has been moved to another screen (fullscreen app, menu, tray, or
    // "Come here" pointing at another screen). 'enter-left'/'enter-right'
    // put her just out of sight on that side, ready to walk in to comeX.
    relocated(place, comeX, purpose) {
      this.interrupt();
      this.clearTreat(); // a bone on the old screen is left behind
      const r = this.range();
      if (place === 'enter-left' || place === 'enter-right') {
        this.dir = place === 'enter-left' ? 1 : -1; // out of sight, so no turn is needed
        this.cx = L.entryPosition({ dir: this.dir, width: this.layout.width, extents: this.extents() });
        if (purpose === 'treat') this.dropTreat(comeX);
        else this.pending = { type: 'come', x: comeX };
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
      if (name === 'come' || name === 'treat') {
        if (!Number.isFinite(args.x)) throw new Error(`${name} needs an x position`);
        if (name === 'treat') this.dropTreat(args.x);
        else this.request('come', { x: args.x });
        return;
      }
      this.request(name);
    }

    // The mouse is near her: she looks up at you at the next natural break.
    notice() {
      if (!this.prefs.noticeMouse || this.follow || this.treat) return;
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
      const [left, right] = this.body();
      const reach = this.config.noticeRadiusPx * this.layout.scale;
      return x >= left - reach && x <= right + reach;
    }

    // Start just out of sight on the nearer side and walk in to x.
    walkInTo(x) {
      this.dir = x < this.layout.width / 2 ? 1 : -1;
      this.cx = L.entryPosition({ dir: this.dir, width: this.layout.width, extents: this.extents() });
      this.pending = { type: 'come', x };
    }

    // ------------------------------------------------------------ treats

    // Plan where she stops so her nose lands on a bone near window x.
    planTreat(x) {
      const sc = this.layout.scale;
      const D = this.distances();
      return L.treatPlan({
        from: this.cx,
        bone: x,
        width: this.layout.width,
        range: this.range(),
        reach: this.config.treatNoseReach * sc,
        start: D.start,
        loop: D.loop,
        stop: D.stop,
        edge: 30 * sc,
      });
    }

    // Drop a bone as close to window x as possible, at a spot she can walk to
    // and eat from exactly. (If she is mid-walk, her stopping point is not
    // known yet, so it lands at x and is lined up when she sets off.)
    dropTreat(x) {
      const edge = 30 * this.layout.scale;
      let bx = L.clamp(x, edge, this.layout.width - edge);
      if (!this.walk) {
        const plan = this.planTreat(bx);
        if (plan) bx = plan.boneX;
      }
      this.treat = { x: bx };
      this.player.setProp({ kind: 'bone', x: bx });
      this.request('treat');
    }

    clearTreat() {
      this.treat = null;
      this.player.setProp(null);
    }

    // Walk up to the bone, eat it (sniff), and wag (happy).
    async eatTreat() {
      const t = this.treat;
      if (!t) return;
      const plan = this.planTreat(t.x);
      if (plan) {
        if (Math.abs(plan.boneX - t.x) > 1) {
          t.x = plan.boneX; // she moved since it dropped (a drag or a walk): line it up
          this.player.moveProp(t.x);
        }
        if (Math.abs(plan.stop - this.cx) > 1) await this.doWalk({ target: plan.stop });
      }
      if (this.treat !== t) return;
      await this.turnTo(t.x >= this.cx ? 1 : -1);
      const { treatEatFrom: from, treatEatTo: to } = this.config;
      await this.playClip('sniff', {
        onFrame: (f) => this.player.setPropEaten(L.clamp((f.t - from) / (to - from), 0, 1)),
      });
      this.clearTreat();
      this.lastAction = 'sniff';
      await this.playClip('happy');
    }

    // ------------------------------------------------------------ follow me

    setFollow(msg) {
      if (!msg.active) {
        this.follow = null;
        this.notify();
        return;
      }
      const now = Date.now();
      if (!this.follow) {
        this.follow = { x: msg.x, movedAt: now, lookedAt: 0 };
        if (this.pose === 'sleep' && !this.pending) this.pending = { type: 'wake' };
      } else {
        if (Math.abs(msg.x - this.follow.x) > 3) this.follow.movedAt = now;
        this.follow.x = msg.x;
      }
      if (this.walk && this.walk.follow) this.walk.target = this.followTarget();
      this.notify();
    }

    followTarget() {
      const r = this.range();
      return L.clamp(this.follow.x, r.min, r.max);
    }

    async followStep() {
      const f = this.follow;
      const off = f.x < 0 ? 'left' : f.x > this.layout.width ? 'right' : null;
      if (off && this.layout.edges[off]) {
        await this.doWalk({ toward: off }); // the mouse is on the next screen
        return;
      }
      const target = this.followTarget();
      if (Math.abs(target - this.cx) > this.config.followSlackPx * this.layout.scale) {
        await this.doWalk({ target, follow: true });
        return;
      }
      if (Date.now() - f.movedAt > this.config.followLookAfterMs && f.lookedAt < f.movedAt) {
        f.lookedAt = Date.now();
        this.lastAction = 'look';
        await this.playClip('look');
        return;
      }
      await this.wait(500);
    }

    mood() {
      return L.scaleMood(L.moodAt(this.clock().getHours(), this.config.moods), this.prefs.moodStrength);
    }

    weightsFor(mood) {
      const base = { ...this.config.weights, look: this.config.weights.look * this.prefs.lookMultiplier };
      return L.applyMood(base, mood);
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
      // "Come here" and treats may start her just out of sight (walking in);
      // everything else starts on screen.
      const walksIn = (req && (req.type === 'come' || req.type === 'treat')) || (!req && this.treat);
      if (!walksIn) this.clampIntoView();
      this.player.showPose('stand');
      if (req) {
        await this.perform(req.type, req);
        return;
      }
      if (this.treat) {
        await this.eatTreat(); // a bone is still waiting (e.g. after a drag)
        return;
      }
      if (this.follow) {
        await this.followStep();
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
      const weights = this.tune ? this.config.tuneWeights : this.weightsFor(mood);
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
        case 'treat':
          await this.eatTreat();
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
      await this.walkToSpot(x);
      this.lastAction = 'look';
      await this.playClip('look');
    }

    // Walk to window x (or just turn that way if it is too close to walk).
    async walkToSpot(x) {
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
    }

    // toward: 'left' | 'right' walks off that side to the next screen.
    async doWalk({ target = null, follow = false, toward = null } = {}) {
      const D = this.distances();
      const edges = this.layout.edges;
      const exits = ['left', 'right'].filter((side) => edges[side]);
      let trip = false;
      let dir;
      if (target !== null) {
        dir = target >= this.cx ? 1 : -1;
      } else if (toward !== null) {
        trip = true;
        dir = toward === 'right' ? 1 : -1;
      } else {
        if (exits.length > 0 && !this.tune && this.rng() < this.prefs.tripChance) {
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
        follow,
        cyclesLeft: target !== null ? Infinity : L.randInt(this.rng, ...this.config.walkLoops),
        hitWall: false,
        ending: false,
        loopIndex: -1,
      };
      this.walk = w;
      try {
        await this.playClip('walk_start', { rate: this.pace, onFrame: (f) => this.walkFrame('start', f) });
        if (!this.stopRightAfterStart()) {
          const looping = this.playClip('walk_loop', {
            loop: true, rate: this.pace, onFrame: (f) => this.walkFrame('loop', f),
          });
          this.onNotify = () => this.reconsiderWalk(null);
          this.reconsiderWalk(-1);
          await looping;
          this.onNotify = null;
        }
        await this.playClip('walk_stop', { rate: this.pace, onFrame: (f) => this.walkFrame('stop', f) });
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
      const dx = RM[phase];
      if (dx.length !== f.frames) throw new Error(`Root motion for ${WALK_CLIPS[phase]} has ${dx.length} entries, clip has ${f.frames} frames`);
      const d = L.stepDistance(dx, f.prevIndex, f.index, f.wrapped);
      this.cx += this.dir * d * this.layout.scale;
      if (phase !== 'loop' || !this.walk) return;
      this.walk.loopIndex = f.index;
      if (f.wrapped) {
        this.walk.cyclesLeft -= 1;
        this.reconsiderWalk(f.index);
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
    // index: the walk_loop frame just shown (-1 before the first); null = latest.
    reconsiderWalk(index) {
      const w = this.walk;
      if (!w || w.ending) return;
      const D = this.distances();
      const remaining = L.remainingDistance(RM.loop, index === null ? w.loopIndex : index) * this.layout.scale;
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
              if (this.follow) {
                // Following the mouse: keep going until she reaches it.
                w.follow = true;
                w.target = this.followTarget();
                w.cyclesLeft = Infinity;
              } else {
                w.cyclesLeft = L.randInt(this.rng, 1, 3);
              }
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
