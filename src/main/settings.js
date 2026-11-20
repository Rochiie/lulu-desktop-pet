'use strict';

// Settings stored as JSON in app.getPath('userData'). Every value is checked on
// load; anything missing or invalid falls back to its default, and a corrupt
// file falls back to defaults entirely. Writes go to a temp file first and are
// then renamed over the real file, so a crash mid-write cannot corrupt it.

const fs = require('node:fs');
const path = require('node:path');

const SIZE_OPTIONS = Object.freeze([
  Object.freeze({ label: 'Small', value: 0.6 }),
  Object.freeze({ label: 'Medium', value: 0.8 }),
  Object.freeze({ label: 'Large', value: 1.0 }),
]);

const WALK_SPEED_RANGE = Object.freeze([20, 400]);

const DEFAULTS = Object.freeze({
  size: 0.8,
  startWithWindows: false,
  walkBetweenScreens: true,
  avoidFullscreen: true,
  displayId: null,
  xFraction: 0.5,
  walkSpeed: null, // null = use walkSpeedPxPerSec from the manifest
});

const SAVE_DELAY_MS = 500;

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (SIZE_OPTIONS.some((o) => o.value === raw.size)) out.size = raw.size;
  for (const key of ['startWithWindows', 'walkBetweenScreens', 'avoidFullscreen']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (Number.isSafeInteger(raw.displayId)) out.displayId = raw.displayId;
  if (Number.isFinite(raw.xFraction) && raw.xFraction >= 0 && raw.xFraction <= 1) {
    out.xFraction = raw.xFraction;
  }
  if (
    Number.isFinite(raw.walkSpeed) &&
    raw.walkSpeed >= WALK_SPEED_RANGE[0] &&
    raw.walkSpeed <= WALK_SPEED_RANGE[1]
  ) {
    out.walkSpeed = raw.walkSpeed;
  }
  return out;
}

class Settings {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.values = { ...DEFAULTS };
    this.timer = null;
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn('Could not read settings; using defaults', err);
      return this.values;
    }
    try {
      this.values = sanitize(JSON.parse(text));
    } catch (err) {
      this.log.warn('Settings file is corrupt; using defaults', err);
      this.values = { ...DEFAULTS };
    }
    return this.values;
  }

  get() {
    return this.values;
  }

  update(patch) {
    this.values = sanitize({ ...this.values, ...patch });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    return this.values;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.values, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error('Could not save settings', err);
    }
  }
}

module.exports = { Settings, sanitize, DEFAULTS, SIZE_OPTIONS, WALK_SPEED_RANGE };
