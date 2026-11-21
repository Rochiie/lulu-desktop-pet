// Lulu's behaviour. Standing is the hub: she holds still, then picks an
// action. Requests (clicks, menu commands) are taken at safe points (the end
// of a clip, or the end of a walk or breathing cycle) so a clip is never cut
// mid-way and there is no visible jump. Only drags, hiding and moving screens
// interrupt immediately.
(function (root) {
  'use strict';

  const L = root.LuluLogic;
  const RM = root.LuluRootMotion;
  // A gait is a start, a repeating loop and a stop, with root motion for each.
  const GAITS = Object.freeze({
    walk: Object.freeze({ start: 'walk_start', loop: 'walk_loop', stop: 'walk_stop' }),
    run: Object.freeze({ start: 'run_start', loop: 'run_loop', stop: 'run_stop' }),
  });
  const Interrupt = root.LuluInterrupt;

  const COMMANDS = new Set(['walk', 'sit', 'nap', 'wake', 'come', 'treat', 'trick', 'throw']);
  const TRICKS = Object.freeze(['head_tilt', 'play', 'roll_over', 'paw', 'beg', 'spin', 'yawn', 'scratch', 'dig']);
  const PICKUP_CLIPS = Object.freeze(['pickup_lift', 'pickup_held', 'pickup_down']);
  const GAZE_CLIPS = Object.freeze(['gaze_in', 'gaze_loop', 'gaze_out']);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class Behaviour {
    constructor({
      player, manifest, config, api, extents, prefs, tune, prepareLayout, sleepExtents = null,
      rng = Math.random, clock = () => new Date(),
    }) {
      this.player = player;
      this.manifest = manifest;
      this.config = config;
      this.api = api;
      this.clipExtents = extents; // clip pixels, facing right
      this.sleepExtents = sleepExtents || extents; // her lying pose, clip pixels, facing right
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
      this.carrying = false; // being picked up, held or put down (carry())
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
      this.thirst = 0; // clip pixels walked since her last drink
      this.bowlMoves = 0; // counts bowl drags, so a trip to it can notice a move
      this.bedMoves = 0; // the same for her bed
      this.toyMoves = 0; // and for her ball
      this.toyThrown = false; // a throw is in the air: fetch it when it stops
      this.fetchToy = false; // it has stopped: go and get it at the next chance
      this.deepSleep = false;
      this.player.onToyRest = (x) => this.toyRested(x);

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

    // Root motion (clip pixels per frame) for a gait. The run's is eased off
    // at gallop speed (see config.runSpeedShare).
    motion(gait) {
      if (gait !== 'run') return RM;
      if (!this.runMotion) {
        const { runFullSpeedBelow: v0, runSpeedShare: c } = this.config;
        const ease = (v) => (v <= v0 ? v : v0 + (v - v0) * c);
        this.runMotion = {
          start: RM.run.start.map(ease),
          loop: RM.run.loop.map(ease),
          stop: RM.run.stop.map(ease),
        };
      }
      return this.runMotion;
    }

    // How far each clip of a gait carries her, in window pixels.
    distances(gait = 'walk') {
      const s = this.layout.scale;
      const m = this.motion(gait);
      return {
        start: L.clipDistance(m.start) * s,
        loop: L.clipDistance(m.loop) * s,
        stop: L.clipDistance(m.stop) * s,
      };
    }

    canRun() {
      return Object.values(GAITS.run).every((clip) => this.hasClip(clip));
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
      this.player.setShadows(prefs.shadow);
      this.syncProps();
      this.syncSnow();
    }

    // Bowl, bed and ball, after a layout or preference change. moved: she is
    // on a different screen (or it changed size), so the ball goes back to
    // its saved spot.
    syncProps({ moved = false } = {}) {
      this.syncBowl();
      this.syncBed();
      this.syncToy(moved);
    }

    // Snow in December (setting 'auto'), always ('on') or never ('off').
    syncSnow() {
      const mode = this.prefs.snow;
      const on = mode === 'on' || (mode === 'auto' && this.config.snowMonths.includes(this.clock().getMonth()));
      this.player.setSnow(on);
    }

    // The ambient animation (rolling ball, snow) rests while she is hidden or
    // in a deep sleep, so it costs nothing while nobody is watching.
    syncAmbient() {
      this.player.setAmbientPaused(!this.running || this.deepSleep);
    }

    // ------------------------------------------------------------ water bowl

    bowlX() {
      const edge = this.config.bowlEdgePx * this.layout.scale;
      return L.clamp(this.prefs.bowlX * this.layout.width, edge, this.layout.width - edge);
    }

    syncBowl() {
      if (!this.layout) return;
      this.player.setBowl(this.prefs.waterBowl ? { x: this.bowlX() } : null);
    }

    // The bowl is being dragged to window x.
    moveBowl(x) {
      const edge = this.config.bowlEdgePx * this.layout.scale;
      const clamped = L.clamp(x, edge, this.layout.width - edge);
      this.prefs = { ...this.prefs, bowlX: clamped / this.layout.width };
      this.bowlMoves += 1;
      this.syncBowl();
      return this.prefs.bowlX;
    }

    bowlRoute() {
      return this.routeTo(this.bowlX(), this.config.treatNoseReach * this.layout.scale);
    }

    // Walks (one or two, strides stretched a little) that end with her centre
    // exactly `reach` short of window x, facing it.
    routeTo(x, reach) {
      const D = this.distances();
      const [fMin, fMax] = this.config.strideRange;
      return L.bowlRoute({
        from: this.cx,
        bowl: x,
        reach,
        start: D.start,
        loop: D.loop,
        stop: D.stop,
        range: this.range(),
        fMin,
        fMax,
      });
    }

    // Walk to window x, ending `reach` short of it and facing it. Returns
    // true once she is there, false if there is no route, something else came
    // up on the way, or it was moved (moves() changed) or put away (still()
    // false) meanwhile; a moved target is planned again once.
    async walkUpTo(getX, reach, moves, still) {
      const tol = 3 * this.layout.scale;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = moves();
        const x = getX();
        if (Math.abs(this.cx - (x - this.dir * reach)) <= tol) return true;
        if (Math.abs(this.cx - (x + this.dir * reach)) <= tol) {
          await this.turnTo(-this.dir);
          return true;
        }
        const route = this.routeTo(x, reach);
        if (!route) return false;
        let replan = false;
        for (const leg of route) {
          if (Math.abs(leg.stop - this.cx) > 1) await this.doWalk({ target: leg.stop, strideScale: leg.f });
          if (this.pending || !still() || Math.abs(leg.stop - this.cx) > 1) return false;
          if (moves() !== before) {
            replan = true;
            break;
          }
        }
        if (!replan) return Math.abs(this.cx - (getX() - this.dir * reach)) <= tol;
      }
      return false;
    }

    // ------------------------------------------------------------ dog bed

    // Half the bed's width, clip pixels: her lying body plus some padding.
    bedHalfWidth() {
      const e = this.sleepExtents;
      return ((e.back + e.front) / 2) * this.config.lyingSize + this.config.bedPadPx;
    }

    // Lying down, the middle of her body is this far ahead of her centre
    // point (window pixels), so this is how far short of the bed she stops.
    bedReach() {
      const e = this.sleepExtents;
      return ((e.front - e.back) / 2) * this.config.lyingSize * this.layout.scale;
    }

    bedX() {
      const w = this.layout.width;
      const edge = (this.bedHalfWidth() + this.config.bedEdgePx) * this.layout.scale;
      if (edge * 2 > w) return w / 2;
      return L.clamp(this.prefs.bedX * w, edge, w - edge);
    }

    syncBed() {
      if (!this.layout) return;
      this.player.setBed(this.prefs.dogBed ? { x: this.bedX(), halfWidth: this.bedHalfWidth() } : null);
    }

    // The bed is being dragged to window x.
    moveBed(x) {
      const w = this.layout.width;
      this.prefs = { ...this.prefs, bedX: L.clamp(x / w, 0, 1) };
      this.bedMoves += 1;
      this.syncBed();
      return this.bedX() / w;
    }

    // Walk to the bed so that lying down puts her exactly in it.
    goToBed() {
      return this.walkUpTo(() => this.bedX(), this.bedReach(), () => this.bedMoves, () => this.prefs.dogBed);
    }

    // ------------------------------------------------------------ her ball

    syncToy(moved) {
      if (!this.layout) return;
      if (!this.prefs.toy) {
        this.player.setToy(null);
        return;
      }
      if (this.player.toy && !moved) return;
      const edge = 30 * this.layout.scale;
      const w = this.layout.width;
      this.player.setToy({ x: L.clamp(this.prefs.toyX * w, edge, w - edge) });
    }

    // Dragging the ball (window coordinates).
    holdToy(x, y) {
      this.toyMoves += 1;
      this.player.holdToy(x, y);
    }

    // Let go of the ball with this velocity (window px/s, vy up). A real
    // throw sends her after it once it stops; a gentle drop does not.
    releaseToy(vx, vy) {
      this.toyMoves += 1;
      this.toyThrown = Math.hypot(vx, vy) > 150 * this.layout.scale;
      this.player.launchToy(vx, vy);
    }

    // The ball was clicked: it squeaks and she comes to play.
    pokeToy() {
      this.player.squeakToy();
      if (this.pose !== 'sleep') this.request('toy');
    }

    // "Throw her ball" from the menu: off towards the side with more room.
    throwToy() {
      const t = this.player.toy;
      if (!t || !this.layout) return;
      const sc = this.layout.scale;
      const dir = t.x < this.layout.width / 2 ? 1 : -1;
      this.toyMoves += 1;
      this.toyThrown = true;
      this.player.launchToy(dir * L.randRange(this.rng, 450, 800) * sc, L.randRange(this.rng, 250, 450) * sc);
    }

    toyRested(x) {
      if (!this.layout) return;
      this.prefs = { ...this.prefs, toyX: L.clamp(x / this.layout.width, 0, 1) };
      this.api.savePlace('toyX', this.prefs.toyX);
      if (!this.toyThrown) return;
      this.toyThrown = false;
      if (this.pose === 'sleep' || this.dragging) return; // a sleeping dog lets it lie
      this.fetchToy = true;
      this.notify();
    }

    // Walk up to the ball and play with it (play-bow and nudges, which send
    // it rolling a little). If she cannot reach it, she just looks at it.
    async playWithToy() {
      const t = this.player.toy;
      if (!t || !t.resting) return;
      const reach = this.config.toyNoseReach * this.layout.scale;
      const there = await this.walkUpTo(
        () => this.player.toy.x, reach, () => this.toyMoves,
        () => Boolean(this.prefs.toy && this.player.toy && this.player.toy.resting),
      );
      if (!there) {
        if (this.pending || !this.player.toy) return;
        await this.turnTo(this.player.toy.x >= this.cx ? 1 : -1);
        this.lastAction = 'look';
        await this.playClip('look');
        return;
      }
      this.lastAction = 'toy';
      await this.playClip('play', { onFrame: (f) => this.nudgeToy(f) });
    }

    nudgeToy(f) {
      for (const [frame, push] of this.config.toyNudgeFrames) {
        if (f.prevIndex < frame && f.index >= frame && this.player.toy && this.player.toy.resting) {
          this.player.squeakToy();
          this.player.launchToy(this.dir * push * this.layout.scale, 0);
        }
      }
    }

    // Walk to the bowl (one or two walks, lined up so her nose lands in it)
    // and drink. Gives up quietly if something else comes up on the way.
    async drink() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const moves = this.bowlMoves;
        const route = this.bowlRoute();
        if (!route) {
          this.thirst = 0;
          return;
        }
        let arrived = true;
        for (const leg of route) {
          if (Math.abs(leg.stop - this.cx) > 1) await this.doWalk({ target: leg.stop, strideScale: leg.f });
          if (this.pending || !this.prefs.waterBowl || Math.abs(leg.stop - this.cx) > 1) return; // interrupted
          if (this.bowlMoves !== moves) {
            arrived = false; // the bowl was moved: plan again
            break;
          }
        }
        if (!arrived) continue;
        await this.turnTo(this.bowlX() >= this.cx ? 1 : -1);
        this.player.setBowlDrinking(true);
        try {
          await this.playClip('sniff');
        } finally {
          this.player.setBowlDrinking(false);
        }
        this.thirst = 0;
        this.lastAction = 'drink';
        return;
      }
    }

    hasClip(name) {
      return Boolean(this.manifest.clips[name]);
    }

    // Tune mode: do the next trick in the list (for trying them out).
    nextTrick() {
      const available = [...TRICKS.filter((trick) => this.hasClip(trick)), ...(this.canRun() ? ['zoomies'] : [])];
      if (!available.length) return;
      this.trickIndex = ((this.trickIndex ?? -1) + 1) % available.length;
      this.request(available[this.trickIndex]);
    }

    // Sometimes swap a reaction for a trick (when that trick's clip exists).
    maybeTrick(trick, share, usual) {
      return this.hasClip(trick) && this.rng() < share ? trick : usual;
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
      this.syncProps({ moved: layout.reason !== 'edges' });
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
      this.request(this.maybeTrick('paw', this.config.pawShare, 'happy'));
    }

    command(name, args = {}) {
      if (!COMMANDS.has(name)) throw new Error(`Unknown command: ${name}`);
      if (name === 'come' || name === 'treat') {
        if (!Number.isFinite(args.x)) throw new Error(`${name} needs an x position`);
        if (name === 'come') this.request('come', { x: args.x });
        else if (this.config.begForTreats && this.hasClip('beg')) this.request('beg_treat', { x: args.x });
        else this.dropTreat(args.x);
        return;
      }
      if (name === 'trick') {
        if (!TRICKS.includes(args.trick) && args.trick !== 'zoomies') throw new Error(`Unknown trick: ${args.trick}`);
        this.request(args.trick, { asked: true });
        return;
      }
      if (name === 'throw') {
        this.throwToy();
        return;
      }
      this.request(name);
    }

    // The mouse is near her: she looks up at you at the next natural break.
    notice() {
      if (!this.prefs.noticeMouse || this.follow || this.treat) return;
      if (this.dragging || this.pose === 'sleep' || this.pending) return;
      if (this.pose === 'gaze') return; // already looking at you
      if (this.walk && this.walk.target !== null) return; // already coming to you
      const now = Date.now();
      if (now - this.lastNotice < this.config.noticeCooldownMs) return;
      this.lastNotice = now;
      this.request(this.maybeTrick('head_tilt', this.config.headTiltShare, 'look'));
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
    dropTreat(x, { queue = true } = {}) {
      const edge = 30 * this.layout.scale;
      let bx = L.clamp(x, edge, this.layout.width - edge);
      if (!this.walk) {
        const plan = this.planTreat(bx);
        if (plan) bx = plan.boneX;
      }
      this.treat = { x: bx };
      this.player.setProp({ kind: 'bone', x: bx });
      if (queue) this.request('treat');
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
      if (this.prefs.waterBowl) base.drink = this.config.drinkWeight;
      for (const [trick, weight] of Object.entries(this.config.trickWeights)) {
        if (this.hasClip(trick)) base[trick] = weight;
      }
      if (this.canGaze()) base.gaze = this.config.gazeWeight;
      if (this.canRun()) base.zoomies = this.config.zoomiesWeight;
      if (this.prefs.toy) base.toy = this.config.toyWeight;
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
      this.syncAmbient();
      if (running) this.openGate();
      else this.interrupt();
    }

    // Dragging her. Standing, she is picked up (lifted, held while you move
    // her, put back down); asleep, she slides along the floor as before.
    beginDrag() {
      this.dragging = true;
      if (this.carrying) return; // grabbed again while being put down: carry() lifts her again
      this.interrupt();
      // Sitting and gazing at you counts as standing here: she is lifted from it.
      if ((this.pose === 'stand' || this.pose === 'gaze') && PICKUP_CLIPS.every((c) => this.hasClip(c))) {
        this.carrying = true;
        this.carry().catch((err) => this.api.reportError(`Pick-up stopped: ${err && err.stack ? err.stack : err}`));
        return;
      }
      this.player.showPose(this.pose);
    }

    dragTo(x) {
      const r = this.range();
      this.cx = L.clamp(x, r.min, r.max);
      this.player.draw();
    }

    endDrag() {
      this.dragging = false;
      if (this.carrying) {
        // Let go: she finishes being lifted (quickly) or her current wriggle,
        // then carry() puts her down.
        this.player.endLoop();
        if (this.player.playing === 'pickup_lift') this.player.setRate(this.config.letGoRate);
        return;
      }
      this.dropped();
    }

    dropped() {
      this.savePosition();
      if (this.pose === 'sleep') this.pending = { type: 'wake' };
      this.openGate();
    }

    async carry() {
      try {
        do {
          await this.playClip('pickup_lift', { rate: this.config.pickupRate });
          while (this.dragging) await this.playClip('pickup_held', { loop: true });
          await this.playClip('pickup_down', { rate: this.config.putDownRate });
        } while (this.dragging);
      } catch (err) {
        if (!(err instanceof Interrupt)) throw err;
        this.pose = 'stand'; // stopped part-way (hidden, say): back on the floor
      } finally {
        this.carrying = false;
        if (!this.dragging) this.dropped();
      }
    }

    // Rubbed with the mouse. Awake: she wags (happy). Asleep: she stays
    // asleep and her nap gets a little longer.
    pet() {
      if (this.dragging || this.carrying) return;
      const now = Date.now();
      if (this.pose === 'sleep') {
        if (!this.idleSleep) this.napEnds = Math.max(this.napEnds, now + this.config.petNapExtendMs);
        return;
      }
      if (now - this.lastPet < this.config.petCooldownMs) return;
      this.lastPet = now;
      this.request(this.maybeTrick('roll_over', this.config.rollOverShare, 'happy'));
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
      while (!this.running || this.dragging || this.carrying) {
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
            if (this.running && !this.dragging && !this.carrying) this.player.showPose(this.pose);
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
      this.lastPlayed = name;
    }

    // ------------------------------------------------------------ standing

    async standStep(req) {
      // "Come here" and treats may start her just out of sight (walking in);
      // everything else starts on screen.
      const walksIn = (req && ['come', 'treat', 'drink'].includes(req.type)) || (!req && this.treat);
      if (!walksIn) this.clampIntoView();
      this.player.showPose('stand');
      if (req) {
        await this.perform(req.type, req);
        return;
      }
      if (this.fetchToy) {
        this.fetchToy = false;
        await this.playWithToy();
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
      if (this.prefs.waterBowl && this.thirst >= this.config.thirstClipPx) {
        await this.drink();
        return;
      }
      const mood = this.tune ? null : this.mood();
      const [lo, hi] = this.tune ? this.config.tuneHoldSeconds : this.config.holdSeconds;
      const holdScale = mood ? mood.hold : 1;
      const why = await this.hold(L.randRange(this.rng, lo, hi) * holdScale * 1000);
      if (why !== 'timeout') return; // a request or idle change: handle it next step
      const weights = this.tune ? this.config.tuneWeights : this.weightsFor(mood);
      await this.perform(L.pickAction(this.rng, weights, this.lastAction));
    }

    // Stands for ms. In most holds long enough for it she breathes (the
    // stand_idle clip) part-way through instead of standing frozen. Like
    // wait(), resolves 'notify' early when something needs her, cutting the
    // breathing short.
    async hold(ms) {
      const clip = this.manifest.clips.stand_idle;
      if (!clip || ms < clip.seconds * 1000 || this.rng() >= this.config.idleClipChance) return this.wait(ms);
      const end = Date.now() + ms;
      const before = await this.wait(this.rng() * (ms - clip.seconds * 1000));
      if (before !== 'timeout') return before;
      const breathing = await this.breatheStanding();
      if (breathing !== 'timeout') return breathing;
      return this.wait(Math.max(0, end - Date.now()));
    }

    async breatheStanding() {
      let cut = false;
      this.onNotify = () => {
        cut = true;
        this.onNotify = null;
        this.player.stop();
      };
      try {
        await this.playClip('stand_idle');
      } catch (err) {
        if (!cut || !(err instanceof Interrupt)) throw err;
      } finally {
        if (!cut) this.onNotify = null;
      }
      return cut ? 'notify' : 'timeout';
    }

    async perform(type, req = {}) {
      if (TRICKS.includes(type)) {
        if (!this.hasClip(type)) return; // that trick's clip is not installed
        this.lastAction = type;
        await this.playClip(type);
        return;
      }
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
        case 'drink':
          if (this.prefs.waterBowl) await this.drink();
          return;
        case 'toy':
          if (this.prefs.toy) await this.playWithToy();
          return;
        case 'zoomies':
          if (await this.zoomies(Boolean(req.asked))) {
            this.lastAction = 'zoomies';
          } else if (req.asked && this.hasClip('play')) {
            this.lastAction = 'play'; // no room to run: a play-bow instead
            await this.playClip('play');
          }
          return;
        case 'beg_treat':
          // Beg, then the bone drops near where you asked, and she eats it.
          this.lastAction = 'beg';
          await this.playClip('beg');
          this.dropTreat(req.x, { queue: false });
          await this.eatTreat();
          return;
        case 'gaze':
          if (!this.canGaze()) return;
          this.lastAction = 'gaze';
          await this.gaze();
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

    canGaze() {
      return GAZE_CLIPS.every((c) => this.hasClip(c));
    }

    // Sits down, turns and gazes at you for a while (gazeSeconds), then turns
    // back and stands up. Anything that needs her (a click, a call, you going
    // idle) ends the gaze at the end of the current loop, and she gets up a
    // little quicker.
    async gaze() {
      const [lo, hi] = this.config.gazeSeconds;
      const end = Date.now() + L.randRange(this.rng, lo, hi) * 1000;
      try {
        await this.playClip('gaze_in');
        let called = Boolean(this.pending || this.userIdle);
        if (!called) {
          const timer = setTimeout(() => this.player.endLoop(), Math.max(0, end - Date.now()));
          this.onNotify = () => {
            called = true;
            this.player.endLoop();
          };
          try {
            await this.playClip('gaze_loop', { loop: true });
          } finally {
            clearTimeout(timer);
            this.onNotify = null;
          }
        }
        await this.playClip('gaze_out', { rate: called ? this.config.gazeHurryRate : 1 });
      } catch (err) {
        if (err instanceof Interrupt) this.pose = 'stand'; // cut short (a grab, hidden): back on her feet
        throw err;
      }
    }

    // ------------------------------------------------------------ sleeping

    async goToSleep(untilUserReturns) {
      this.idleSleep = untilUserReturns;
      const [lo, hi] = this.config.napSeconds;
      const napScale = this.tune ? 1 : this.mood().nap;
      this.napEnds = Date.now() + L.randRange(this.rng, lo, hi) * napScale * 1000;
      // Off to bed first, if she has one; if something comes up on the way,
      // that comes first (an idle nap is tried again afterwards).
      if (this.prefs.dogBed && !(await this.goToBed()) && this.pending) return;
      if (this.hasClip('yawn') && this.rng() < this.config.yawnBeforeNap) await this.playClip('yawn');
      // Circle before lying down (not straight after turning round: two
      // rotations in a row look odd).
      if (this.hasClip('spin') && this.lastPlayed !== 'turn' && this.rng() < this.config.spinBeforeNap) {
        await this.playClip('spin');
      }
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
        this.deepSleep = true;
        this.syncAmbient();
        try {
          await this.wait(Infinity);
        } finally {
          this.deepSleep = false;
          this.syncAmbient();
        }
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

    // A dash at full gallop. Heads for another screen when there is one (and
    // sometimes even when there is room here), otherwise needs room on this
    // screen for the whole run. Returns false if there is nowhere to run.
    // asked: from the menu. If there is no room from where she is, she trots
    // to a spot near one end first, then dashes across.
    async zoomies(asked = false) {
      if (!this.canRun()) return false;
      if (await this.doWalk({ gait: 'run' })) return true;
      if (!asked) return false;
      const spot = this.runUpSpot();
      if (spot === null) return false;
      // Walks normally stop on a whole step; this lands exactly on the spot.
      const there = await this.walkUpTo(() => spot, 0, () => 0, () => true);
      if (!there || this.pending) return false;
      return this.doWalk({ gait: 'run' });
    }

    // The nearest spot from which a whole run (start and stop) fits on this
    // screen, or null if the screen is too small for one.
    runUpSpot() {
      const D = this.distances('run');
      const need = D.start + D.stop + 2;
      const r = this.range();
      if (r.max - r.min < need) return null;
      const runRight = Math.min(this.cx, r.max - need);
      const runLeft = Math.max(this.cx, r.min + need);
      return Math.abs(runRight - this.cx) <= Math.abs(runLeft - this.cx) ? runRight : runLeft;
    }

    // toward: 'left' | 'right' walks off that side to the next screen.
    // strideScale stretches or shortens her steps a little for this walk only
    // (used to land exactly at her bowl).
    async doWalk({ target = null, follow = false, toward = null, strideScale = 1, gait = 'walk' } = {}) {
      const D = this.distances(gait);
      const clips = GAITS[gait];
      const rate = gait === 'walk' ? this.pace : 1;
      const run = gait === 'run';
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
        if (exits.length > 0 && !this.tune && this.rng() < (run ? 0.6 : this.prefs.tripChance)) {
          trip = true;
          dir = exits[Math.floor(this.rng() * exits.length)] === 'right' ? 1 : -1;
        } else {
          dir = L.chooseDirection(this.rng, this.cx - this.range().min, this.range().max - this.cx);
        }
        const fits = (d) => L.canStartWalk({
          cx: this.cx, dir: d, range: this.range(), aheadIsWall: this.aheadIsWall(d),
          startDist: D.start, loopDist: run ? 0 : D.loop, stopDist: D.stop,
        });
        if (!fits(dir)) {
          dir = -dir;
          trip = false;
          if (!fits(dir)) return false;
        }
      }
      await this.turnTo(dir); // turn only while standing

      const w = {
        gait,
        trip,
        target,
        follow,
        strideScale,
        cyclesLeft: target !== null ? Infinity : L.randInt(this.rng, ...(run ? this.config.runLoops : this.config.walkLoops)),
        hitWall: false,
        ending: false,
        loopIndex: -1,
      };
      this.walk = w;
      try {
        await this.playClip(clips.start, { rate, onFrame: (f) => this.walkFrame('start', f) });
        if (!this.stopRightAfterStart()) {
          const looping = this.playClip(clips.loop, {
            loop: true, rate, onFrame: (f) => this.walkFrame('loop', f),
          });
          this.onNotify = () => this.reconsiderWalk(null);
          this.reconsiderWalk(-1);
          await looping;
          this.onNotify = null;
        }
        await this.playClip(clips.stop, { rate, onFrame: (f) => this.walkFrame('stop', f) });
      } finally {
        this.walk = null;
        this.onNotify = null;
      }
      // Reached the edge: turn around (not when she was walking to a spot,
      // where the way she faces on arrival matters).
      if (w.hitWall && target === null) await this.turnTo(-this.dir);
      this.savePosition();
      return true;
    }

    // Turn around on the spot (standing pose only). With the turn clip she
    // turns round for real; its last frame is her standing pose mirrored, so
    // flipping her facing as it ends shows exactly the same picture.
    async turnTo(dir) {
      if (dir === this.dir) return;
      this.player.showPose('stand');
      const clip = this.manifest.clips.turn;
      if (clip && clip.flipsFacing) {
        await this.playClip('turn', { rate: this.config.turnClipRate });
        this.dir = dir;
        this.player.showPose('stand');
        return;
      }
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
      const gait = this.walk ? this.walk.gait : 'walk';
      const dx = this.motion(gait)[phase];
      if (dx.length !== f.frames) throw new Error(`Root motion for ${GAITS[gait][phase]} has ${dx.length} entries, clip has ${f.frames} frames`);
      const stride = this.walk ? this.walk.strideScale : 1;
      const d = L.stepDistance(dx, f.prevIndex, f.index, f.wrapped) * stride;
      this.cx += this.dir * d * this.layout.scale;
      this.thirst += d;
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
      const D = this.distances(this.walk.gait);
      const k = this.walk.strideScale;
      const r = L.shouldEndWalk({
        cx: this.cx, dir: this.dir, range: this.range(), aheadIsWall: this.aheadIsWall(),
        remaining: 0, loopDist: D.loop * k, stopDist: D.stop * k,
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
      const D = this.distances(w.gait);
      const k = w.strideScale;
      const remaining = L.remainingDistance(this.motion(w.gait).loop, index === null ? w.loopIndex : index) * this.layout.scale * k;
      const r = L.shouldEndWalk({
        cx: this.cx, dir: this.dir, range: this.range(), aheadIsWall: this.aheadIsWall(),
        remaining, loopDist: D.loop * k, stopDist: D.stop * k,
        cyclesLeft: w.trip ? Infinity : w.cyclesLeft,
        wantStop: this.pending !== null || (this.fetchToy && w.target === null),
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
            this.syncProps({ moved: true });
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
