// Behaviour tunables, all in one place.
(function (root) {
  'use strict';

  root.LuluConfig = Object.freeze({
    // Standing still between actions.
    holdSeconds: [3, 8],
    // Weighted random action after a hold. Never the same non-walk action twice.
    weights: Object.freeze({ walk: 40, look: 15, sniff: 15, sit: 12, stretch: 10, nap: 8 }),
    walkLoops: [2, 6],
    napSeconds: [30, 120],
    // Share of walks that head off to the next screen (when there is one).
    tripChance: 0.25,
    // After 10 minutes of the user being away, the breathing loop stops and
    // she holds the still sleeping pose, so the animation uses no CPU.
    deepSleepAfterMs: 10 * 60 * 1000,

    // Mouse.
    alphaThreshold: 40, // a pixel counts as Lulu above this alpha
    hitRadiusPx: 4, // also count pixels this close to the cursor, so she is easy to grab
    hitCheckMs: 50, // at most one hit-test this often
    dragThresholdPx: 5,

    // Keep her this far (window pixels) from the screen edges.
    edgeMarginPx: 12,

    // Tune mode (npm run tune).
    tuneHoldSeconds: [1, 2],
    tuneWeights: Object.freeze({ walk: 1 }),
    walkSpeedRange: [20, 400],
  });
})(self);
