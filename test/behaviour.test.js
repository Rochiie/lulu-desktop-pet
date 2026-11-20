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
  }

  duration(name) {
    return manifest.clips[name].seconds;
  }

  get playing() {
    return this.active ? this.active.name : null;
  }

  showPose() {
    if (this.active) throw new Error('showPose while a clip is playing');
    if (this.turning) throw new Error('showPose while turning');
  }

  draw() {}

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

  play(name, { loop = false, onFrame = null } = {}) {
    if (this.active) return Promise.reject(new Error(`play ${name} while ${this.active.name} plays`));
    if (this.turning) return Promise.reject(new Error(`play ${name} while turning`));
    this.history.push(name);
    this.listeners.forEach((fn) => fn(name));
    const T = manifest.clips[name].seconds;
    return new Promise((resolve, reject) => {
      const a = { name, loop, resolve, reject, done: false, t: 0 };
      this.active = a;
      const tick = () => {
        if (a.done) return;
        let next = a.t + 1 / 24;
        let wrapped = false;
        try {
          if (next >= T - 1e-9) {
            if (!a.loop) {
              if (onFrame) onFrame({ prevT: a.t, t: T, wrapped: false, duration: T });
              this.finish(a, null);
              return;
            }
            next -= T;
            wrapped = true;
          }
          if (onFrame) onFrame({ prevT: a.t, t: next, wrapped, duration: T });
        } catch (err) {
          this.finish(a, err);
          return;
        }
        a.t = next;
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

function setup({ config = {}, layout = makeLayout(1, 1500), xFraction = 0.5, cross = null } = {}) {
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
      ...config,
    },
    api,
    extents: EXTENTS,
    walkSpeed: manifest.walkSpeedPxPerSec,
    tune: false,
    prepareLayout: () => {},
  });
  behaviour.applyLayout(layout, { xFraction });
  behaviour.start();
  behaviour.setRunning(true);
  const stop = () => behaviour.setRunning(false);
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
      if (v !== dir && !t.player.turning) instantFlips.push(t.player.history.length);
      dir = v;
    },
  });
  await until(() => t.positions.length >= 25);
  t.stop();
  assert.deepEqual(t.errors, []);
  assert.deepEqual(instantFlips, [], 'she flipped without turning');
  assert.ok(t.player.history.includes('(turn)'));
  // A turn only ever happens while standing: never inside a walk.
  assert.doesNotMatch(t.player.history.join(' '), /walk_start \(turn\)|walk_loop \(turn\)/);
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
    config: { weights: { walk: 1 }, tripChance: 1 },
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
    config: { weights: { walk: 1 }, tripChance: 1 },
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
