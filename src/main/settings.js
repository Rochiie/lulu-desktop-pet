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

// Number preferences shown as sliders in the Settings window: [min, max].
const RANGES = Object.freeze({
  walkPace: Object.freeze([0.7, 1.3]), // walk animation speed; 1 = as animated
  tripChance: Object.freeze([0, 0.6]), // share of walks that visit another screen
  lookMultiplier: Object.freeze([0.25, 2]), // how often she looks at you, x normal
  moodStrength: Object.freeze([0, 1]), // 0 = same all day, 1 = full daily rhythm
  followSeconds: Object.freeze([30, 300]), // how long "Follow me" lasts
  bowlX: Object.freeze([0, 1]), // where her water bowl sits, as a share of the screen width
});

const DEFAULTS = Object.freeze({
  size: 0.8,
  startWithWindows: false,
  walkBetweenScreens: true,
  avoidFullscreen: true,
  displayId: null,
  xFraction: 0.5,
  walkPace: 1,
  tripChance: 0.25,
  lookMultiplier: 1,
  moodStrength: 1,
  followSeconds: 60,
  noticeMouse: true,
  walkIn: true,
  waterBowl: true,
  bowlX: 0.85,
  shadow: true,
});

// Settings the user can change in the Settings window (and reset).
const USER_KEYS = Object.freeze([
  'size', 'startWithWindows', 'walkBetweenScreens', 'avoidFullscreen', 'walkPace',
  'tripChance', 'lookMultiplier', 'moodStrength', 'followSeconds', 'noticeMouse', 'walkIn',
  'waterBowl', 'shadow',
]);

const SAVE_DELAY_MS = 500;

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (SIZE_OPTIONS.some((o) => o.value === raw.size)) out.size = raw.size;
  for (const key of ['startWithWindows', 'walkBetweenScreens', 'avoidFullscreen', 'noticeMouse', 'walkIn', 'waterBowl', 'shadow']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    if (Number.isFinite(raw[key]) && raw[key] >= lo && raw[key] <= hi) out[key] = raw[key];
  }
  out.followSeconds = Math.round(out.followSeconds);
  if (Number.isSafeInteger(raw.displayId)) out.displayId = raw.displayId;
  if (Number.isFinite(raw.xFraction) && raw.xFraction >= 0 && raw.xFraction <= 1) {
    out.xFraction = raw.xFraction;
  }
  return out;
}

// What the pet window needs to know about the user's preferences.
function prefsFor(values) {
  return {
    walkPace: values.walkPace,
    tripChance: values.tripChance,
    lookMultiplier: values.lookMultiplier,
    moodStrength: values.moodStrength,
    followSeconds: values.followSeconds,
    noticeMouse: values.noticeMouse,
    walkIn: values.walkIn,
    waterBowl: values.waterBowl,
    bowlX: values.bowlX,
    shadow: values.shadow,
  };
}

class Settings {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.values = { ...DEFAULTS };
    this.timer = null;
    this.onChange = null;
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
      // Editors such as Notepad may add a byte-order mark; JSON.parse rejects it.
      this.values = sanitize(JSON.parse(text.replace(/^﻿/, '')));
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
    if (this.onChange) this.onChange(this.values);
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

module.exports = { Settings, sanitize, prefsFor, DEFAULTS, USER_KEYS, RANGES, SIZE_OPTIONS };
