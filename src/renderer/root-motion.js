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
  });
})(self);
