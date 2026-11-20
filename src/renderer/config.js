// Behaviour tunables, all in one place.
(function (root) {
  'use strict';

  root.LuluConfig = Object.freeze({
    // Standing still between actions.
    holdSeconds: [3, 8],
    // Weighted random action after a hold. Never the same non-walk action twice.
    // "look" (turning to look at you) is the most common thing she does
    // besides walking.
    weights: Object.freeze({ walk: 32, look: 30, sniff: 12, sit: 10, stretch: 8, nap: 8 }),

    // Moods through the day. weights multiply the action weights above; hold
    // and nap multiply how long she stands still and how long she naps.
    moods: Object.freeze([
      Object.freeze({ name: 'morning', from: 6, to: 11, weights: { walk: 1.3, stretch: 1.6, nap: 0.3 }, hold: 0.8, nap: 0.8 }),
      Object.freeze({ name: 'day', from: 11, to: 18, weights: {}, hold: 1, nap: 1 }),
      Object.freeze({ name: 'evening', from: 18, to: 22, weights: { walk: 0.7, sit: 1.3, nap: 2.5 }, hold: 1.3, nap: 1.5 }),
      Object.freeze({ name: 'night', from: 22, to: 6, weights: { walk: 0.4, look: 0.6, sniff: 0.5, nap: 6 }, hold: 1.5, nap: 3 }),
    ]),

    // She notices the mouse coming near (within this many window pixels of
    // her nose or tail, at Large) and looks up at you, at most once per cooldown.
    noticeRadiusPx: 200,
    noticeCooldownMs: 30 * 1000,

    // Follow me: she walks when the mouse is more than this far from her
    // (window pixels at Large), and looks up once the mouse has been still
    // this long.
    followSlackPx: 200,
    followLookAfterMs: 2500,

    // Treats: in the sniff clip her nose touches the ground 223 clip pixels in
    // front of her centre (measured from sniff.webm around 2–2.5 s), and the
    // bone is "eaten" between these clip times (s).
    treatNoseReach: 223,
    treatEatFrom: 1.6,
    treatEatTo: 2.7,
    // Walk cycles per walk. Her real stride is long (about 322 px per cycle
    // at Large), so a few cycles already cover a good stretch of screen.
    walkLoops: [1, 3],
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

    // Turning around: she narrows to this share of her width, flips, and
    // widens again, with a small hop (clip pixels).
    turnMs: 420,
    turnMinSquash: 0.08,
    turnLiftPx: 7,

    // Petting: rub the mouse back and forth over her. A rub is this many
    // changes of direction, each after at least minTravel px, within windowMs.
    petMinTravelPx: 10,
    petReversals: 3,
    petWindowMs: 1500,
    petCooldownMs: 6000, // at most one wag per this long while you keep petting
    petNapExtendMs: 30 * 1000, // petting a napping Lulu lets her sleep at least this much longer

    // Tune mode (npm run tune).
    tuneHoldSeconds: [1, 2],
    tuneWeights: Object.freeze({ walk: 1 }),
    walkPaceRange: [0.7, 1.3],
  });
})(self);
