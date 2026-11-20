'use strict';

// Checks assets/manifest.json up front so a broken asset folder fails loudly at
// start-up instead of halfway through an animation.

const REQUIRED_CLIPS = Object.freeze([
  'walk_start', 'walk_loop', 'walk_stop', 'sniff', 'look', 'sit',
  'stretch', 'happy', 'lie_down', 'sleep_loop', 'wake_up',
]);
const POSES = Object.freeze(['stand', 'sleep']);
const NUMBERS = Object.freeze([
  'fps', 'width', 'height', 'groundY', 'standingCenterX', 'walkSpeedPxPerSec',
]);

function validateManifest(m) {
  const fail = (msg) => {
    throw new Error(`assets/manifest.json: ${msg}`);
  };
  if (!m || typeof m !== 'object') fail('not a JSON object');
  for (const key of NUMBERS) {
    if (!(Number.isFinite(m[key]) && m[key] > 0)) fail(`"${key}" must be a positive number`);
  }
  if (m.groundY > m.height) fail('"groundY" is below the bottom of the clip');
  if (m.standingCenterX > m.width) fail('"standingCenterX" is outside the clip');
  if (!m.clips || typeof m.clips !== 'object') fail('"clips" is missing');
  for (const name of REQUIRED_CLIPS) {
    const clip = m.clips[name];
    if (!clip) fail(`clip "${name}" is missing`);
    if (typeof clip.file !== 'string' || !/^[\w.-]+\.webm$/.test(clip.file)) {
      fail(`clip "${name}" needs a .webm file name`);
    }
    if (!POSES.includes(clip.startPose) || !POSES.includes(clip.endPose)) {
      fail(`clip "${name}" needs startPose/endPose of "stand" or "sleep"`);
    }
    if (!(Number.isFinite(clip.seconds) && clip.seconds > 0)) fail(`clip "${name}" needs seconds`);
  }
  for (const [name, clip] of Object.entries(m.clips)) {
    if (REQUIRED_CLIPS.includes(name)) continue; // checked above
    if (!clip || typeof clip.file !== 'string' || !/^[\w.-]+\.webm$/.test(clip.file)) fail(`clip "${name}" needs a .webm file name`);
    if (!POSES.includes(clip.startPose) || !POSES.includes(clip.endPose)) fail(`clip "${name}" needs startPose/endPose of "stand" or "sleep"`);
    if (!(Number.isInteger(clip.frames) && clip.frames > 0)) fail(`clip "${name}" needs a frame count`);
    if ('flipsFacing' in clip && typeof clip.flipsFacing !== 'boolean') fail(`clip "${name}": flipsFacing must be true or false`);
  }
  if (!m.poses || typeof m.poses !== 'object') fail('"poses" is missing');
  for (const pose of POSES) {
    if (typeof m.poses[pose] !== 'string' || !/^[\w.-]+\.png$/.test(m.poses[pose])) {
      fail(`pose "${pose}" needs a .png file name`);
    }
  }
  return m;
}

module.exports = { validateManifest, REQUIRED_CLIPS, POSES };
