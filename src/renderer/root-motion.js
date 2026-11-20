// How far Lulu moves on each frame of the walk clips, in clip pixels (size
// Large), so her planted feet stay exactly where they touch the ground.
//
// Measured from the clips themselves: for each frame, the bottom band of the
// image (her feet, just above the ground line) was compared with the previous
// frame at quarter-pixel shifts; the best match is how far her planted feet
// slid backwards in the clip, which is how far she must move forwards.
// Entry i is the movement from frame i-1 to frame i (entry 0: from the end of
// the clip before; for walk_loop that measured 13.5 after walk_start and 14
// after its own last frame, so 13.75 is used for both). One value in
// walk_start (frame 25) measured -2.25 where
// both neighbours are ~7; it is replaced by their average.
//
// Totals: walk_start 155 px, walk_loop 322 px per cycle (about 297 px/s),
// walk_stop 219 px.
(function (root) {
  'use strict';

  root.LuluRootMotion = Object.freeze({
    // Walking (the walk_* clips):
    start: Object.freeze([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.5, 0.75, 1.25, 1.5, 2.25, 2.5, 3, 3.25,
      4, 4.25, 5, 6, 5.5, 7.25, 9, 8.75, 9.75, 9.75, 10.75, 11.5, 12.25, 11, 11.75, 13.25,
    ]),
    loop: Object.freeze([
      13.75, 11.5, 11.25, 12.25, 14, 11.5, 12, 12.75, 13.5, 11.75, 12, 13.5, 13.25,
      12.5, 11.75, 10.25, 10.75, 12.75, 13, 12.75, 12.5, 12.75, 12.75, 13, 12, 12,
    ]),
    stop: Object.freeze([
      12.5, 12.25, 11.5, 9.75, 10.75, 11.5, 11, 9.5, 10.25, 11, 10.25, 9.25, 9.25, 8.75, 7.75,
      7, 7.5, 7, 6.25, 4.75, 3.5, 5.5, 4.25, 3.75, 3.25, 2.25, 2, 2, 1.5, 1.25, 1, 0.75, 0.25,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
    // Running (zoomies), measured by make-clip --run the same way from the
    // run clips (filmed with the camera tracking her). While she is fully in
    // the air nothing touches the ground, so those frames were filled in from
    // their neighbours; the loop uses one steady speed (the camera keeps pace
    // with her). Totals: run_start 1734.5 px, run_loop 450 px per
    // stride (about 900 px/s), run_stop 969.5 px.
    run: Object.freeze({
      start: Object.freeze([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 1.25, 2.5, 3.75,
      5.25, 6.5, 7.5, 8.5, 8.75, 8.75, 8.75, 9.25, 11.5, 16.75, 21.75, 25, 24.25, 23.25, 22.25, 22, 22, 22.25, 22.5, 23.5,
      25, 27.75, 31, 33.75, 35.25, 36, 36.25, 36.75, 37.25, 37.75, 38, 37.5, 37, 36.5, 37.5, 38.25, 39, 39.25, 39.75, 40,
      39.5, 38, 36.75, 35.5, 35.5, 36, 37.25, 38.25, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39,
      ]),
      loop: Object.freeze([
      37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5, 37.5,
      ]),
      stop: Object.freeze([
      37.5, 37.5, 37.25, 36.75, 36.25, 35.75, 35.25, 34.75, 34.25, 33.75, 33.25, 31, 29, 27, 26.75, 26.75, 26.5, 26.5, 26.25, 25.75,
      24.75, 23.5, 22, 20.75, 19.5, 18, 17, 15.75, 15, 14, 13, 12.25, 11.25, 10.25, 9.25, 8.5, 7.5, 7, 6.25, 5.75,
      5.25, 5, 4.5, 4.25, 3.5, 3, 2.5, 2, 2.25, 2.5, 2.5, 2.5, 2.5, 2, 1.5, 1.25, 1, 0.75, 0.5, 0.25,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.25,
      0.25, 0.25, 0,
      ]),
    }),
  });
})(self);
