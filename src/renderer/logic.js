// Pure behaviour maths with no DOM access, shared by the page and the tests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LuluLogic = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function randRange(rng, min, max) {
    return min + rng() * (max - min);
  }

  // Inclusive of both ends.
  function randInt(rng, min, max) {
    return Math.min(max, min + Math.floor(rng() * (max - min + 1)));
  }

  function pickWeighted(rng, weights, exclude) {
    const entries = Object.entries(weights).filter(([key, w]) => key !== exclude && w > 0);
    if (entries.length === 0) throw new Error('pickWeighted: nothing to pick from');
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = rng() * total;
    for (const [key, w] of entries) {
      if (r < w) return key;
      r -= w;
    }
    return entries[entries.length - 1][0];
  }

  // Weighted random action that never repeats the previous non-walk action.
  function pickAction(rng, weights, lastAction) {
    const exclude = lastAction && lastAction !== 'walk' ? lastAction : null;
    return pickWeighted(rng, weights, exclude);
  }

  // Distance covered between clip times t1 and t2 (seconds) of a walk phase
  // lasting T seconds with top speed vmax:
  //   start: speed ramps linearly 0 -> vmax
  //   loop:  constant vmax
  //   stop:  speed ramps linearly vmax -> 0
  function rampDistance(phase, vmax, T, t1, t2) {
    const a = clamp(t1, 0, T);
    const b = clamp(t2, 0, T);
    if (b <= a) return 0;
    switch (phase) {
      case 'start':
        return (vmax * (b * b - a * a)) / (2 * T);
      case 'loop':
        return vmax * (b - a);
      case 'stop':
        return vmax * (b - a - (b * b - a * a) / (2 * T));
      default:
        throw new Error(`Unknown walk phase: ${phase}`);
    }
  }

  function phaseDistance(phase, vmax, T) {
    return rampDistance(phase, vmax, T, 0, T);
  }

  // extents: how far her body reaches behind (back) and in front of (front)
  // her centre point, in window pixels. Returns the range of centre positions
  // that keep her whole body on screen facing either way, so turning around
  // at an edge never swings her longer half off the screen.
  function walkRange(width, extents, margin) {
    const reach = Math.max(extents.back, extents.front) + margin;
    const range = { min: reach, max: width - reach };
    if (range.min > range.max) {
      const mid = width / 2;
      return { min: mid, max: mid };
    }
    return range;
  }

  function beyondAhead(position, dir, range) {
    return dir > 0 ? position > range.max : position < range.min;
  }

  function inRange(position, range) {
    return position >= range.min && position <= range.max;
  }

  // Decide whether the current walk_loop cycle should be the last one.
  //   remaining: distance still to cover in the current cycle
  //   aheadIsWall: true when there is no screen to walk onto in that direction
  // Never ends a walk where she would stop half off-screen; if the side ahead
  // leads to another screen she keeps going and crosses instead.
  //   target (optional): walking to a spot; end on whichever cycle stops
  //   her closest to it.
  function shouldEndWalk({ cx, dir, range, aheadIsWall, remaining, loopDist, stopDist, cyclesLeft, wantStop, target = null }) {
    const endIfLast = cx + dir * (remaining + stopDist);
    const endIfNext = endIfLast + dir * loopDist;
    if (aheadIsWall && beyondAhead(endIfNext, dir, range)) return { end: true, hitWall: true };
    if (!inRange(endIfLast, range)) return { end: false, hitWall: false };
    const atTarget = target !== null && Math.abs(target - endIfLast) <= Math.abs(target - endIfNext);
    return { end: cyclesLeft <= 1 || wantStop || atTarget, hitWall: false };
  }

  // The mood for an hour of the day (0-23). Each mood has from/to hours (to is
  // exclusive and may wrap past midnight), weight multipliers per action, and
  // multipliers for how long she holds still and how long she naps.
  const NEUTRAL_MOOD = Object.freeze({ name: 'neutral', weights: {}, hold: 1, nap: 1 });

  function moodAt(hour, moods) {
    for (const m of moods) {
      const inside = m.from <= m.to ? hour >= m.from && hour < m.to : hour >= m.from || hour < m.to;
      if (inside) return m;
    }
    return NEUTRAL_MOOD;
  }

  function applyMood(weights, mood) {
    const out = {};
    for (const [action, w] of Object.entries(weights)) {
      out[action] = w * (mood.weights[action] === undefined ? 1 : mood.weights[action]);
    }
    return out;
  }

  // Is there room to start a walk in this direction (start, one cycle, stop)?
  function canStartWalk({ cx, dir, range, aheadIsWall, startDist, loopDist, stopDist }) {
    if (!aheadIsWall) return true;
    return inRange(cx + dir * (startDist + loopDist + stopDist), range);
  }

  // Head towards the side with more room; a tie is a coin toss.
  function chooseDirection(rng, roomLeft, roomRight) {
    if (roomLeft === roomRight) return rng() < 0.5 ? -1 : 1;
    return roomRight > roomLeft ? 1 : -1;
  }

  // Facing right her body spans [cx - back, cx + front]; facing left it spans
  // [cx - front, cx + back]. True once she is completely past the edge ahead.
  function crossed({ cx, dir, width, extents }) {
    return dir > 0 ? cx - extents.back > width : cx + extents.back < 0;
  }

  // Centre position just out of sight on the side she enters a new screen from.
  function entryPosition({ dir, width, extents }) {
    return dir > 0 ? -extents.front - 1 : width + extents.front + 1;
  }

  // Spots petting: the mouse rubbed back and forth. Feed it x positions with
  // timestamps (ms); it returns true once it has seen `reversals` changes of
  // direction, each after at least `minTravelPx` of movement, within
  // `windowMs`, then starts counting afresh.
  function createRubDetector({ minTravelPx, reversals, windowMs }) {
    let dir = 0;
    let travel = 0;
    let lastX = null;
    let marks = [];
    const reset = () => {
      dir = 0;
      travel = 0;
      lastX = null;
      marks = [];
    };
    const move = (x, t) => {
      if (lastX === null) {
        lastX = x;
        return false;
      }
      const dx = x - lastX;
      lastX = x;
      if (dx === 0) return false;
      const d = Math.sign(dx);
      if (d === dir) {
        travel += Math.abs(dx);
        return false;
      }
      if (dir !== 0 && travel >= minTravelPx) marks.push(t);
      dir = d;
      travel = Math.abs(dx);
      marks = marks.filter((m) => t - m <= windowMs);
      if (marks.length >= reversals) {
        reset();
        return true;
      }
      return false;
    };
    return { move, reset };
  }

  return {
    moodAt,
    applyMood,
    createRubDetector,
    clamp,
    randRange,
    randInt,
    pickWeighted,
    pickAction,
    rampDistance,
    phaseDistance,
    walkRange,
    shouldEndWalk,
    canStartWalk,
    chooseDirection,
    crossed,
    entryPosition,
  };
});
