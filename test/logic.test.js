'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/logic.js');

// Deterministic "random" numbers.
function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('pickAction never repeats the last non-walk action', () => {
  const weights = { walk: 40, look: 15, sniff: 15, sit: 12, stretch: 10, nap: 8 };
  for (let i = 0; i < 2000; i += 1) {
    assert.notEqual(L.pickAction(Math.random, weights, 'sniff'), 'sniff');
  }
});

test('pickAction may repeat walk', () => {
  assert.equal(L.pickAction(() => 0, { walk: 1, look: 1 }, 'walk'), 'walk');
});

test('pickAction roughly follows the weights', () => {
  const weights = { walk: 40, look: 15, sniff: 15, sit: 12, stretch: 10, nap: 8 };
  const counts = {};
  const n = 50000;
  for (let i = 0; i < n; i += 1) {
    const a = L.pickAction(Math.random, weights, null);
    counts[a] = (counts[a] || 0) + 1;
  }
  assert.ok(Math.abs(counts.walk / n - 0.4) < 0.02);
  assert.ok(Math.abs(counts.nap / n - 0.08) < 0.01);
});

test('randInt is inclusive and stays in range', () => {
  assert.equal(L.randInt(() => 0, 2, 6), 2);
  assert.equal(L.randInt(() => 0.999999, 2, 6), 6);
});

test('ramp distances: start and stop cover half of full speed', () => {
  assert.equal(L.phaseDistance('start', 100, 1.5), 75);
  assert.equal(L.phaseDistance('loop', 100, 1.5), 150);
  assert.ok(Math.abs(L.phaseDistance('stop', 100, 2.458) - 122.9) < 1e-9);
});

test('ramp distances add up across frames', () => {
  const T = 2.458;
  let sum = 0;
  for (let f = 0; f < 59; f += 1) sum += L.rampDistance('stop', 125, T, (f * T) / 59, ((f + 1) * T) / 59);
  assert.ok(Math.abs(sum - L.phaseDistance('stop', 125, T)) < 1e-9);
});

test('ramp start speed rises, stop speed falls', () => {
  const T = 1;
  const early = L.rampDistance('start', 100, T, 0, 0.1);
  const late = L.rampDistance('start', 100, T, 0.9, 1);
  assert.ok(late > early);
  assert.ok(L.rampDistance('stop', 100, T, 0, 0.1) > L.rampDistance('stop', 100, T, 0.9, 1));
});

test('rampDistance rejects unknown phases', () => {
  assert.throws(() => L.rampDistance('jog', 1, 1, 0, 1), /Unknown walk phase/);
});

const extents = { back: 200, front: 150 };

test('walkRange leaves room to turn around at either edge', () => {
  assert.deepEqual(L.walkRange(1000, extents, 10), { min: 210, max: 790 });
});

test('walkRange on a tiny screen collapses to the middle', () => {
  assert.deepEqual(L.walkRange(100, extents, 0), { min: 50, max: 50 });
});

const base = { range: { min: 200, max: 800 }, loopDist: 100, stopDist: 80, remaining: 100 };

test('shouldEndWalk ends early before a wall', () => {
  // After this cycle + one more + stop she would be at 400 + 280 = 680 + 100 > 800? no: 400+100+80+100 = 680, fine.
  const ok = L.shouldEndWalk({ ...base, cx: 400, dir: 1, aheadIsWall: true, cyclesLeft: 5, wantStop: false });
  assert.deepEqual(ok, { end: false, hitWall: false });
  const tight = L.shouldEndWalk({ ...base, cx: 600, dir: 1, aheadIsWall: true, cyclesLeft: 5, wantStop: false });
  assert.deepEqual(tight, { end: true, hitWall: true });
});

test('shouldEndWalk ends when the cycles run out or someone asks', () => {
  assert.equal(L.shouldEndWalk({ ...base, cx: 300, dir: 1, aheadIsWall: true, cyclesLeft: 1, wantStop: false }).end, true);
  assert.equal(L.shouldEndWalk({ ...base, cx: 300, dir: 1, aheadIsWall: true, cyclesLeft: 3, wantStop: true }).end, true);
});

test('shouldEndWalk never stops her half off a screen that leads somewhere', () => {
  // Stop position would be 650 + 180 = 830 > 800: she keeps walking and crosses.
  const r = L.shouldEndWalk({ ...base, cx: 650, dir: 1, aheadIsWall: false, cyclesLeft: 1, wantStop: true });
  assert.deepEqual(r, { end: false, hitWall: false });
});

test('shouldEndWalk keeps going after entering until fully on screen', () => {
  // Entering from the left: still behind the left limit.
  const r = L.shouldEndWalk({ ...base, cx: -100, dir: 1, aheadIsWall: true, cyclesLeft: 1, wantStop: false });
  assert.equal(r.end, false);
});

test('shouldEndWalk works facing left', () => {
  const r = L.shouldEndWalk({ ...base, cx: 400, dir: -1, aheadIsWall: true, cyclesLeft: 5, wantStop: false });
  assert.deepEqual(r, { end: true, hitWall: true });
});

test('canStartWalk needs room for start, one cycle and stop before a wall', () => {
  const args = { range: { min: 200, max: 800 }, startDist: 50, loopDist: 100, stopDist: 80 };
  assert.equal(L.canStartWalk({ ...args, cx: 500, dir: 1, aheadIsWall: true }), true);
  assert.equal(L.canStartWalk({ ...args, cx: 600, dir: 1, aheadIsWall: true }), false);
  assert.equal(L.canStartWalk({ ...args, cx: 600, dir: 1, aheadIsWall: false }), true);
});

test('chooseDirection heads for more room', () => {
  assert.equal(L.chooseDirection(() => 0, 100, 900), 1);
  assert.equal(L.chooseDirection(() => 0, 900, 100), -1);
  assert.equal(L.chooseDirection(seq(0.2), 500, 500), -1);
  assert.equal(L.chooseDirection(seq(0.8), 500, 500), 1);
});

test('crossed and entryPosition put her just out of sight', () => {
  assert.equal(L.crossed({ cx: 1199, dir: 1, width: 1000, extents }), false);
  assert.equal(L.crossed({ cx: 1201, dir: 1, width: 1000, extents }), true);
  assert.equal(L.crossed({ cx: -199, dir: -1, width: 1000, extents }), false);
  assert.equal(L.crossed({ cx: -201, dir: -1, width: 1000, extents }), true);
  // Entering the next screen from the left, facing right: nose just off-screen.
  const enterRight = L.entryPosition({ dir: 1, width: 1000, extents });
  assert.ok(enterRight + extents.front < 0);
  const enterLeft = L.entryPosition({ dir: -1, width: 1000, extents });
  assert.ok(enterLeft - extents.front > 1000);
});
