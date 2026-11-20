'use strict';

// Runs the real behaviour state machine against a fake player that "plays"
// clips at 24 fps as fast as possible, so whole walks and naps take
// milliseconds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.self = globalThis;
class Interrupt extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'Interrupt';
  }
}
globalThis.LuluInterrupt = Interrupt;
globalThis.LuluLogic = require('../src/renderer/logic.js');
require('../src/renderer/root-motion.js');
require('../src/renderer/config.js');
require('../src/renderer/behaviour.js');
const L = globalThis.LuluLogic;

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'manifest.json'), 'utf8'));
const EXTENTS = { back: 200, front: 150 }; // clip pixels

class FakePlayer {
  constructor() {
    this.active = null;
    this.history = [];
    this.listeners = [];
    this.rates = [];
  }

  get playing() {
    return this.active ? this.active.name : null;
  }

  showPose() {
    if (this.active) throw new Error('showPose while a clip is playing');
    if (this.turning) throw new Error('showPose while turning');
  }

  draw() {}

  setProp(prop) {
    this.prop = prop ? { ...prop, eaten: 0 } : null;
    if (prop) (this.boneDrops = this.boneDrops || []).push(this.history.length);
  }

  setPropEaten(amount) {
    if (this.prop) this.prop.eaten = amount;
  }

  moveProp(x) {
    if (this.prop) this.prop.x = x;
  }

  setShadows(on) {
    this.shadows = on;
  }

  setBowl(bowl) {
    this.bowl = bowl ? { x: bowl.x, drinking: false } : null;
  }

  setBowlDrinking(drinking) {
    if (this.bowl) this.bowl.drinking = drinking;
    if (drinking) {
      this.drinks = (this.drinks || 0) + 1;
      if (this.onDrink) this.onDrink();
    }
  }

  endLoop() {
    if (this.active) this.active.loop = false;
  }

  turn({ onFlip }) {
    if (this.active || this.turning) return Promise.reject(new Error('turn while busy'));
    this.history.push('(turn)');
    return new Promise((resolve, reject) => {
      const t = { resolve, reject, done: false };
      this.turning = t;
      setImmediate(() => {
        if (t.done) return;
        onFlip();
        setImmediate(() => this.endTurn(t, null));
      });
    });
  }

  endTurn(t, err) {
    if (t.done) return;
    t.done = true;
    this.turning = null;
    if (err) t.reject(err);
    else t.resolve();
  }

  stop() {
    if (this.turning) this.endTurn(this.turning, new Interrupt());
    if (this.active) this.finish(this.active, new Interrupt());
  }

  play(name, { loop = false, onFrame = null, rate = 1 } = {}) {
    if (this.active) return Promise.reject(new Error(`play ${name} while ${this.active.name} plays`));
    if (this.turning) return Promise.reject(new Error(`play ${name} while turning`));
    this.history.push(name);
    this.listeners.forEach((fn) => fn(name));
    this.rates.push(rate);
    const frames = manifest.clips[name].frames;
    return new Promise((resolve, reject) => {
      const a = { name, loop, resolve, reject, done: false, index: -1 };
      this.active = a;
      const tick = () => {
        if (a.done) return;
        let next = a.index + 1;
        let wrapped = false;
        if (next >= frames) {
          if (!a.loop) {
            this.finish(a, null);
            return;
          }
          next = 0;
          wrapped = true;
        }
        try {
          if (onFrame) onFrame({ prevIndex: a.index, index: next, wrapped, frames });
        } catch (err) {
          this.finish(a, err);
          return;
        }
        a.index = next;
        setImmediate(tick);
      };
      setImmediate(tick);
    });
  }

  finish(a, err) {
    if (a.done) return;
    a.done = true;
    if (this.active === a) this.active = null;
    if (err) a.reject(err);
    else a.resolve();
  }

  // Resolves when `name` starts playing (counting from now).
  next(name) {
    return new Promise((resolve) => {
      const fn = (n) => {
        if (n !== name) return;
        this.listeners = this.listeners.filter((f) => f !== fn);
        resolve();
      };
      this.listeners.push(fn);
    });
  }
}

function makeLayout(seq, width, edges = { left: false, right: false }, reason = 'init') {
  return { seq, reason, width, height: 312, scale: 1, displayId: seq, edges };
}

const NOON = () => new Date(2026, 0, 1, 12, 0, 0);

// Every Lulu a test starts is stopped afterwards, even if the test fails, so
// a failure can never leave her running and keep the test process alive.
const running = new Set();
test.afterEach(() => {
  for (const stop of running) stop();
  running.clear();
});
const PREFS = {
  walkPace: 1, tripChance: 0.25, lookMultiplier: 1, moodStrength: 1,
  followSeconds: 60, noticeMouse: true, walkIn: true,
  waterBowl: false, bowlX: 0.85, shadow: true,
};

function setup({ config = {}, layout = makeLayout(1, 1500), xFraction = 0.5, cross = null, clock = NOON, prefs = {} } = {}) {
  const player = new FakePlayer();
  const errors = [];
  const positions = [];
  const api = {
    reportError: (msg) => errors.push(msg),
    savePosition: (f) => positions.push({ f, cx: behaviour.cx, dir: behaviour.dir, width: behaviour.layout.width }),
    cross: cross || (async () => null),
  };
  const behaviour = new globalThis.LuluBehaviour({
    player,
    manifest,
    config: {
      ...globalThis.LuluConfig,
      holdSeconds: [0.001, 0.002],
      napSeconds: [0.05, 0.1],
      // Tricks are off unless a test turns them on, so older tests keep
      // checking exactly what they were written for.
      trickWeights: {},
      headTiltShare: 0,
      rollOverShare: 0,
      pawShare: 0,
      spinBeforeNap: 0,
      begForTreats: false,
      ...config,
    },
    api,
    extents: EXTENTS,
    prefs: { ...PREFS, ...prefs },
    tune: false,
    prepareLayout: () => {},
    clock,
  });
  behaviour.applyLayout(layout, { xFraction });
  behaviour.setPrefs(behaviour.prefs);
  behaviour.start();
  behaviour.setRunning(true);
  const stop = () => behaviour.setRunning(false);
  running.add(stop);
  return { player, behaviour, api, errors, positions, stop };
}

const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function inRange(p) {
  const range = L.walkRange(p.width, EXTENTS, globalThis.LuluConfig.edgeMarginPx);
  return p.cx >= range.min - 1e-6 && p.cx <= range.max + 1e-6;
}

test('walks stay on screen and turn around at the edges', async () => {
  const t = setup({ config: { weights: { walk: 1 } }, xFraction: 0.2 });
  // Every change of facing must happen inside a turn animation.
  let dir = t.behaviour.dir;
  const instantFlips = [];
  Object.defineProperty(t.behaviour, 'dir', {
    get: () => dir,
    set: (v) => {
      // Allowed: during the squash turn, or as the turn clip finishes.
      const justTurned = !t.player.playing && t.player.history[t.player.history.length - 1] === 'turn';
      if (v !== dir && !t.player.turning && !justTurned) instantFlips.push(t.player.history.length);
      dir = v;
    },
  });
  await until(() => t.positions.length >= 25);
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.deepEqual(instantFlips, [], 'she flipped without turning');
  assert.ok(t.player.history.includes('turn'), 'used the turn clip');
  assert.equal(t.player.history.includes('(turn)'), false, 'no squash-flip when the clip exists');
  // A turn only ever happens while standing: never inside a walk.
  assert.doesNotMatch(t.player.history.join(' '), /walk_start turn|walk_loop turn/);
  for (const p of t.positions) assert.ok(inRange(p), `off screen: ${JSON.stringify(p)}`);
  // She must have used both directions.
  assert.ok(t.positions.some((p) => p.dir > 0) && t.positions.some((p) => p.dir < 0));
  // Every walk is start -> loop (optional) -> stop.
  const h = t.player.history.join(' ');
  assert.doesNotMatch(h, /walk_start (?!walk_loop|walk_stop)/);
  assert.doesNotMatch(h, /walk_loop (?!walk_stop)/);
});

test('never plays the same non-walk action twice in a row', async () => {
  const t = setup({ config: { weights: { look: 1, sniff: 1, sit: 1, stretch: 1 } } });
  await until(() => t.player.history.length >= 40);
  t.stop();
  const h = t.player.history;
  for (let i = 1; i < h.length; i += 1) assert.notEqual(h[i], h[i - 1], `repeat at ${i}: ${h[i]}`);
});

test('a click while walking finishes the cycle, stops, then plays happy', async () => {
  const t = setup({ config: { weights: { walk: 1 }, walkLoops: [6, 6] }, xFraction: 0.5, layout: makeLayout(1, 4000) });
  await t.player.next('walk_loop');
  t.behaviour.click();
  await t.player.next('happy');
  t.stop();
  const h = t.player.history;
  const i = h.lastIndexOf('happy');
  assert.deepEqual(h.slice(i - 2, i + 1), ['walk_loop', 'walk_stop', 'happy']);
  assert.deepEqual(t.errors, []);
});

test('user idle: lies down, sleeps until the user is back, then wakes', async () => {
  const t = setup({ config: { weights: { look: 1, sniff: 1 } } });
  await until(() => t.player.history.length >= 1);
  t.behaviour.setUserIdle(true);
  await t.player.next('sleep_loop');
  // Long after a normal nap would have ended she is still asleep.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.player.history.includes('wake_up'), false);
  t.behaviour.setUserIdle(false);
  await t.player.next('wake_up');
  t.stop();
  assert.deepEqual(t.errors, []);
});

test('clicking a sleeping Lulu plays wake_up then happy', async () => {
  const t = setup({ config: { weights: { nap: 1 }, napSeconds: [60, 60] } });
  await t.player.next('sleep_loop');
  t.behaviour.click();
  await t.player.next('happy');
  t.stop();
  const h = t.player.history;
  const i = h.lastIndexOf('happy');
  assert.deepEqual(h.slice(i - 2, i + 1), ['sleep_loop', 'wake_up', 'happy']);
});

test('petting an awake Lulu makes her wag, but not over and over', async () => {
  const t = setup({ config: { weights: { look: 1, sniff: 1 } } });
  await until(() => t.player.history.length >= 1);
  t.behaviour.pet();
  t.behaviour.pet(); // still rubbing: within the cooldown
  await t.player.next('happy');
  await new Promise((r) => setTimeout(r, 100));
  t.stop();
  assert.equal(t.player.history.filter((c) => c === 'happy').length, 1);
});

test('petting a napping Lulu keeps her asleep a bit longer', async () => {
  const t = setup({ config: { weights: { nap: 1 }, napSeconds: [0.05, 0.05], petNapExtendMs: 300 } });
  await t.player.next('sleep_loop');
  const before = t.behaviour.napEnds;
  t.behaviour.pet();
  assert.ok(t.behaviour.napEnds >= before + 200);
  assert.equal(t.behaviour.pending, null); // no wake-up, no wag
  await t.player.next('wake_up');
  t.stop();
});

test('trips cross to the next screen and come in from the other side', async () => {
  let seq = 1;
  const crosses = [];
  const t = setup({
    config: { weights: { walk: 1 } },
    prefs: { tripChance: 1 },
    layout: makeLayout(seq, 1500, { left: false, right: true }),
    xFraction: 0.3,
    cross: async (side) => {
      crosses.push(side);
      seq += 1;
      // Screen B is to the right of A, and A is to the left of B.
      return side === 'right'
        ? makeLayout(seq, 1200, { left: true, right: false }, 'cross')
        : makeLayout(seq, 1500, { left: false, right: true }, 'cross');
    },
  });
  await until(() => crosses.length >= 3 && t.positions.length >= 4);
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.deepEqual(crosses.slice(0, 3), ['right', 'left', 'right']);
  for (const p of t.positions) assert.ok(inRange(p), `stopped off screen: ${JSON.stringify(p)}`);
});

test('if the next screen refuses, she turns back and stays on screen', async () => {
  const t = setup({
    config: { weights: { walk: 1 } },
    prefs: { tripChance: 1 },
    layout: makeLayout(1, 1500, { left: false, right: true }),
    xFraction: 0.5,
    cross: async () => null,
  });
  await until(() => t.positions.length >= 3);
  t.stop();
  assert.deepEqual(t.errors, []);
  // After a refused crossing she walks back in; the hub then clamps if needed.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(t.positions.slice(1).every((p) => inRange(p) || p.cx > p.width));
});

const RM = globalThis.LuluRootMotion;
const D_LOOP = globalThis.LuluLogic.clipDistance(RM.loop); // one walk cycle at scale 1

test('"Come here" walks her to the spot, then she looks at you', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.2 });
  await until(() => t.player.history.length >= 1);
  t.behaviour.command('come', { x: 2200 });
  await until(() => t.player.history.includes('walk_stop') && t.player.history.includes('look'));
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.ok(Math.abs(t.behaviour.cx - 2200) <= D_LOOP / 2 + 1, `stopped at ${t.behaviour.cx}, wanted ~2200`);
  const h = t.player.history.join(' ');
  assert.match(h, /walk_stop look/);
});

test('"Come here" when she is already close just turns and looks', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.5 });
  await until(() => t.player.history.length >= 1);
  const before = t.player.history.length;
  t.behaviour.command('come', { x: 1450 }); // 50 px to her left
  await t.player.next('look');
  t.stop();
  assert.equal(t.player.history.slice(before).includes('walk_start'), false);
  assert.equal(t.behaviour.dir, -1);
});

test('"Come here" from another screen: she walks in from the side', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 3000) });
  await until(() => t.player.history.length >= 1);
  t.behaviour.applyLayout({ ...makeLayout(2, 2000), reason: 'move', place: 'enter-right', comeX: 1500 });
  assert.ok(t.behaviour.cx > 2000, 'starts out of sight on the right');
  await t.player.next('look');
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.ok(Math.abs(t.behaviour.cx - 1500) <= D_LOOP / 2 + 1, `stopped at ${t.behaviour.cx}`);
  assert.equal(t.behaviour.dir, -1);
});

test('she notices the mouse and looks up, but not again within the cooldown', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } } });
  await until(() => t.player.history.length >= 1);
  t.behaviour.notice();
  await t.player.next('look');
  const looks = () => t.player.history.filter((c) => c === 'look').length;
  t.behaviour.notice();
  t.behaviour.notice();
  await new Promise((r) => setTimeout(r, 200));
  t.stop();
  assert.equal(looks(), 1);
});

test('after you come back she wakes up and looks at you', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } } });
  await until(() => t.player.history.length >= 1);
  t.behaviour.setUserIdle(true);
  await t.player.next('sleep_loop');
  t.behaviour.setUserIdle(false);
  await t.player.next('wake_up');
  await t.player.next('look');
  t.stop();
  assert.match(t.player.history.join(' '), /wake_up look/);
});

test('at night she naps far more than at midday', async () => {
  const count = async (hour) => {
    const t = setup({ config: { napSeconds: [0.001, 0.001] }, layout: makeLayout(1, 4000), clock: () => new Date(2026, 0, 1, hour, 0, 0) });
    await until(() => t.player.history.filter((c) => c === 'walk_start' || c === 'lie_down' || c === 'look' || c === 'sit' || c === 'sniff' || c === 'stretch').length >= 60, 20000);
    t.stop();
    return t.player.history.filter((c) => c === 'lie_down').length;
  };
  const noon = await count(12);
  const night = await count(2);
  assert.ok(night > noon * 2, `night naps ${night} vs noon ${noon}`);
});

test('"near" is measured from her body, either way she faces', () => {
  const t = setup({ layout: makeLayout(1, 3000), xFraction: 0.5 });
  t.stop();
  const cx = t.behaviour.cx; // 1500; body 1300..1650 facing right (back 200, front 150)
  t.behaviour.dir = 1;
  assert.equal(t.behaviour.isNear(1650 + 190), true);
  assert.equal(t.behaviour.isNear(1650 + 210), false);
  assert.equal(t.behaviour.isNear(1300 - 190), true);
  t.behaviour.dir = -1; // body 1350..1700
  assert.equal(t.behaviour.isNear(1700 + 190), true);
  assert.equal(cx, 1500);
});

test('a treat: the bone drops, she walks over, eats it and wags', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.2 });
  await until(() => t.player.history.length >= 1);
  const before = t.player.history.length;
  t.behaviour.command('treat', { x: 2000 });
  const bone = t.player.prop.x; // dropped straight away, near the mouse
  assert.ok(Math.abs(bone - 2000) <= D_LOOP / 2 + 1, `bone at ${bone}`);
  await until(() => t.player.history.slice(before).includes('happy'));
  t.stop();
  assert.deepEqual(t.errors, []);
  const h = t.player.history.slice(before).join(' ');
  assert.match(h, /walk_stop .*sniff happy/);
  assert.equal(t.player.prop, null, 'bone eaten');
  assert.equal(t.behaviour.dir, 1);
  // Her nose (while eating) ended exactly on the bone.
  const nose = t.behaviour.cx + globalThis.LuluConfig.treatNoseReach;
  assert.ok(Math.abs(nose - bone) < 0.5, `nose at ${nose}, bone at ${bone}`);
});

test('a treat dropped on top of her lands a short walk away', async () => {
  const t = setup({ config: { weights: { sit: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.5 });
  await until(() => t.player.history.length >= 1);
  t.behaviour.command('treat', { x: t.behaviour.cx + 10 });
  const gap = Math.abs(t.player.prop.x - t.behaviour.cx);
  t.stop();
  assert.ok(gap > 300, `bone only ${gap} px away`);
});

test('a treat survives being dragged away: she still goes back for it', async () => {
  const t = setup({ config: { weights: { sit: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.2 });
  await until(() => t.player.history.length >= 1);
  t.behaviour.command('treat', { x: 2200 });
  await t.player.next('walk_loop');
  t.behaviour.beginDrag();
  t.behaviour.dragTo(500);
  t.behaviour.endDrag();
  await until(() => t.player.prop === null, 8000);
  t.stop();
  assert.deepEqual(t.errors, []);
});

test('follow me: she walks after the mouse and stops near it', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 3000), xFraction: 0.2 });
  await until(() => t.player.history.length >= 1);
  t.behaviour.setFollow({ active: true, x: 2400 });
  await until(() => Math.abs(t.behaviour.cx - 2400) < 260 && !t.player.playing, 8000);
  // The mouse goes back the other way.
  t.behaviour.setFollow({ active: true, x: 900 });
  await until(() => Math.abs(t.behaviour.cx - 900) < 260 && !t.player.playing, 8000);
  t.behaviour.setFollow({ active: false });
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.equal(t.behaviour.follow, null);
});

test('follow me with the mouse on the next screen: she walks over to it', async () => {
  let crossed = null;
  const t = setup({
    config: { weights: { sit: 1 } },
    layout: makeLayout(1, 1500, { left: false, right: true }),
    xFraction: 0.5,
    cross: async (side) => {
      crossed = side;
      return makeLayout(2, 1500, { left: true, right: false }, 'cross');
    },
  });
  await until(() => t.player.history.length >= 1);
  t.behaviour.setFollow({ active: true, x: 2200 });
  await until(() => crossed !== null, 8000);
  // Main now reports the mouse relative to the new screen.
  t.behaviour.setFollow({ active: true, x: 1100 });
  await until(() => !t.player.playing && Math.abs(t.behaviour.cx - 1100) < 200, 8000);
  t.stop();
  assert.equal(crossed, 'right');
  // One walk: she did not stop short after crossing and set off again.
  assert.equal(t.player.history.filter((c) => c === 'walk_start').length, 1);
});

test('walk-in: she starts out of sight and walks to her spot', async () => {
  const t = setup({ config: { weights: { sit: 1 } }, layout: makeLayout(1, 2000), xFraction: 0.7 });
  t.stop(); // pause while we set her up
  t.behaviour.walkInTo(1400);
  assert.ok(t.behaviour.cx > 2000, 'starts off the right edge');
  t.behaviour.setRunning(true);
  await until(() => t.player.history.includes('look'));
  t.stop();
  assert.ok(Math.abs(t.behaviour.cx - 1400) <= D_LOOP / 2 + 1, `stopped at ${t.behaviour.cx}`);
});

test('preferences: looks at you more, and moods can be turned off', () => {
  const t = setup({ prefs: { lookMultiplier: 2, moodStrength: 0 }, clock: () => new Date(2026, 0, 1, 2, 0, 0) });
  t.stop();
  const w = t.behaviour.weightsFor(t.behaviour.mood());
  assert.equal(w.look, globalThis.LuluConfig.weights.look * 2);
  assert.equal(w.nap, globalThis.LuluConfig.weights.nap); // night has no effect at strength 0
  t.behaviour.setPrefs({ ...PREFS, walkPace: 1.2 });
  assert.equal(t.behaviour.pace, 1.2);
  t.behaviour.setPrefs({ ...PREFS, walkPace: 9 });
  assert.equal(t.behaviour.pace, 1.3); // clamped
});

test('noticing can be switched off', async () => {
  const t = setup({ prefs: { noticeMouse: false } });
  t.behaviour.notice();
  t.stop();
  assert.equal(t.behaviour.pending, null);
});

test('a treat on another screen: she walks in from the side to eat it', async () => {
  const t = setup({ config: { weights: { sit: 1 } }, layout: makeLayout(1, 3000) });
  await until(() => t.player.history.length >= 1);
  const before = t.player.history.length;
  t.behaviour.applyLayout({ ...makeLayout(2, 1920), reason: 'move', place: 'enter-right', comeX: 1200, purpose: 'treat' });
  assert.ok(t.behaviour.cx > 1920, 'starts out of sight');
  await until(() => t.player.history.slice(before).includes('happy'), 8000);
  t.stop();
  const h = t.player.history.slice(before).join(' ');
  assert.match(h, /walk_start .*walk_stop .*sniff happy/);
  const nose = t.behaviour.cx - globalThis.LuluConfig.treatNoseReach; // facing left
  assert.ok(Math.abs(nose - 1200) <= D_LOOP / 2 + 1, `nose at ${nose}, wanted ~1200`);
});

test('the water bowl: she walks over and drinks with her nose exactly in it', async () => {
  const reach = globalThis.LuluConfig.treatNoseReach;
  for (const [x0, bowlX] of [[0.15, 0.85], [0.8, 0.3], [0.5, 0.55]]) {
    const t = setup({ config: { weights: { sit: 1, sniff: 1 } }, layout: makeLayout(1, 2560), xFraction: x0, prefs: { waterBowl: true, bowlX } });
    await until(() => t.player.history.length >= 1);
    const before = t.player.history.length;
    // She may already have had a drink of her own accord; count from here.
    let at = null; // where she is the moment she starts drinking
    t.behaviour.request('drink');
    t.player.onDrink = () => { at = { cx: t.behaviour.cx, dir: t.behaviour.dir, bowl: t.player.bowl.x }; };
    await until(() => at !== null, 8000);
    t.stop();
    assert.deepEqual(t.errors, []);
    const bowl = at.bowl;
    const nose = at.cx + at.dir * reach;
    assert.ok(Math.abs(nose - bowl) < 0.5, `start ${x0}: nose ${nose.toFixed(1)}, bowl ${bowl.toFixed(1)}`);
    assert.match(t.player.history.slice(before).join(' '), /sniff/);
  }
});

test('she gets thirsty after a lot of walking and goes for a drink', async () => {
  const t = setup({ config: { weights: { walk: 1 }, thirstClipPx: 1500 }, layout: makeLayout(1, 2560), prefs: { waterBowl: true, bowlX: 0.5 } });
  await until(() => (t.player.drinks || 0) >= 1, 15000);
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.ok(t.behaviour.thirst < 1500);
});

test('the bowl can be moved and switched off', () => {
  const t = setup({ layout: makeLayout(1, 2000), prefs: { waterBowl: true, bowlX: 0.5 } });
  t.stop();
  assert.equal(t.player.bowl.x, 1000);
  t.behaviour.moveBowl(99999);
  assert.equal(t.player.bowl.x, 2000 - globalThis.LuluConfig.bowlEdgePx); // kept on screen
  t.behaviour.setPrefs({ ...t.behaviour.prefs, waterBowl: false });
  assert.equal(t.player.bowl, null);
  t.behaviour.setPrefs({ ...t.behaviour.prefs, shadow: false });
  assert.equal(t.player.shadows, false);
});

test('without a turn clip she falls back to the quick squash-and-flip', async () => {
  const saved = manifest.clips.turn;
  delete manifest.clips.turn;
  try {
    const t = setup({ config: { weights: { walk: 1 } }, xFraction: 0.2, layout: makeLayout(1, 3000) });
    await until(() => t.player.history.includes('(turn)'), 8000);
    t.stop();
    assert.deepEqual(t.errors, []);
  } finally {
    manifest.clips.turn = saved;
  }
});

test('tricks join her random actions, and never twice in a row', async () => {
  const t = setup({ config: { weights: { look: 1 }, trickWeights: { head_tilt: 1, play: 1, roll_over: 1, paw: 1, beg: 1 } } });
  await until(() => t.player.history.length >= 60);
  t.stop();
  assert.deepEqual(t.errors, []);
  const h = t.player.history;
  for (const trick of ['head_tilt', 'play', 'roll_over', 'paw', 'beg']) assert.ok(h.includes(trick), `never did ${trick}`);
  for (let i = 1; i < h.length; i += 1) assert.notEqual(h[i], h[i - 1], `repeat at ${i}: ${h[i]}`);
});

test('noticing you can be a head tilt; petting a roll-over; a click a paw', async () => {
  const t = setup({ config: { weights: { sit: 1, sniff: 1 }, headTiltShare: 1, rollOverShare: 1, pawShare: 1 } });
  await until(() => t.player.history.length >= 1);
  t.behaviour.notice();
  await t.player.next('head_tilt');
  t.behaviour.pet();
  await t.player.next('roll_over');
  t.behaviour.click();
  await t.player.next('paw');
  t.stop();
  assert.deepEqual(t.errors, []);
});

test('she spins around before lying down for a nap', async () => {
  const t = setup({ config: { weights: { nap: 1 }, spinBeforeNap: 1 } });
  await t.player.next('lie_down');
  t.stop();
  const h = t.player.history;
  assert.equal(h[h.lastIndexOf('lie_down') - 1], 'spin');
});

test('for a treat she begs first, then the bone drops and she eats it', async () => {
  const t = setup({ config: { weights: { sit: 1 }, begForTreats: true }, layout: makeLayout(1, 3000), xFraction: 0.2 });
  await until(() => t.player.history.length >= 1);
  const before = t.player.history.length;
  t.behaviour.command('treat', { x: 2000 });
  assert.ok(!t.player.prop, 'no bone until she has begged');
  await until(() => t.player.history.slice(before).includes('happy') && !t.player.prop, 8000);
  t.stop();
  assert.deepEqual(t.errors, []);
  // The bone dropped only after the beg clip had started (and finished).
  const begAt = t.player.history.indexOf('beg', before);
  assert.ok(t.player.boneDrops.length === 1 && t.player.boneDrops[0] > begAt);
  assert.match(t.player.history.slice(before).join(' '), /beg .*walk_start .*sniff happy/);
});

test('a missing trick clip is simply skipped', async () => {
  const saved = manifest.clips.play;
  delete manifest.clips.play;
  try {
    const t = setup({ config: { weights: { look: 1 }, trickWeights: { play: 100 } } });
    await until(() => t.player.history.length >= 10);
    t.stop();
    assert.deepEqual(t.errors, []);
    assert.equal(t.player.history.includes('play'), false);
  } finally {
    manifest.clips.play = saved;
  }
});
