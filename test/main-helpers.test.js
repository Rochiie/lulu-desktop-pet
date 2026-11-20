'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const displays = require('../src/main/displays');
const { Settings, sanitize, DEFAULTS } = require('../src/main/settings');
const { validateManifest } = require('../src/main/manifest');

// Cody's layout: 1080p on the left (lower), two 1440p screens side by side.
const LAYOUT = [
  { id: 3, primary: false, phys: { x: -1920, y: 186, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 186, width: 1920, height: 1032 } },
  { id: 1, primary: true, phys: { x: 0, y: 0, width: 2560, height: 1440 },
    workArea: { x: 0, y: 0, width: 2560, height: 1392 } },
  { id: 2, primary: false, phys: { x: 2560, y: 0, width: 2560, height: 1440 },
    workArea: { x: 2560, y: 0, width: 2560, height: 1392 } },
];

test('neighbours follow the physical arrangement', () => {
  assert.deepEqual(displays.neighbours(LAYOUT, 3), { left: null, right: 1 });
  assert.deepEqual(displays.neighbours(LAYOUT, 1), { left: 3, right: 2 });
  assert.deepEqual(displays.neighbours(LAYOUT, 2), { left: 1, right: null });
  assert.deepEqual(displays.neighbours(LAYOUT, 99), { left: null, right: null });
});

test('stacked screens are not walking neighbours', () => {
  const stacked = [
    { id: 1, phys: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, phys: { x: 0, y: 1080, width: 1920, height: 1080 } },
  ];
  assert.deepEqual(displays.neighbours(stacked, 1), { left: null, right: null });
});

test('nearestFree skips busy screens', () => {
  assert.equal(displays.nearestFree(LAYOUT, 1, new Set([1])).id, 3);
  assert.equal(displays.nearestFree(LAYOUT, 1, new Set([1, 3])).id, 2);
  assert.equal(displays.nearestFree(LAYOUT, 1, new Set([1, 2, 3])), null);
});

test('window sits with the ground line on the taskbar', () => {
  const manifest = { height: 312, groundY: 305 };
  const b = displays.windowBounds(LAYOUT[1], 0.8, manifest);
  assert.deepEqual(b, { x: 0, y: 1392 - 244, width: 2560, height: 250 });
  assert.equal(b.y + Math.round(305 * 0.8), 1392);
});

test('menu labels run left to right and mark the main screen', () => {
  assert.deepEqual(displays.menuEntries(LAYOUT).map((e) => e.label), [
    'Left screen', 'Middle screen (main)', 'Right screen',
  ]);
});

test('settings sanitize rejects bad values', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize([1, 2]), DEFAULTS);
  const s = sanitize({ size: 0.7, xFraction: 4, walkPace: 5000, avoidFullscreen: 'yes', displayId: 1.5 });
  assert.deepEqual(s, DEFAULTS);
  const good = sanitize({ size: 1.0, xFraction: 0.25, walkPace: 0.9, avoidFullscreen: false, displayId: 2528732444 });
  assert.equal(good.size, 1.0);
  assert.equal(good.xFraction, 0.25);
  assert.equal(good.walkPace, 0.9);
  assert.equal(good.avoidFullscreen, false);
  assert.equal(good.displayId, 2528732444);
});

test('settings survive a corrupt file and save atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-settings-'));
  const file = path.join(dir, 'settings.json');
  const log = { warn() {}, error(msg, err) { throw err || new Error(msg); } };
  fs.writeFileSync(file, '{ not json');
  const s = new Settings(file, log);
  assert.deepEqual(s.load(), DEFAULTS);
  s.update({ size: 0.6, xFraction: 0.1 });
  s.flush();
  const again = new Settings(file, log);
  assert.equal(again.load().size, 0.6);
  assert.equal(again.get().xFraction, 0.1);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings files saved with a byte-order mark still load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '﻿{"size": 1.0}');
  const s = new Settings(file, { warn(msg) { throw new Error(msg); }, error() {} });
  assert.equal(s.load().size, 1.0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real manifest is valid', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'manifest.json'), 'utf8'));
  assert.equal(validateManifest(m), m);
});

test('manifest validation names the problem', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'manifest.json'), 'utf8'));
  delete m.clips.sniff;
  assert.throws(() => validateManifest(m), /clip "sniff" is missing/);
});

test('new preferences have safe ranges and defaults', () => {
  const { prefsFor } = require('../src/main/settings');
  const bad = sanitize({ tripChance: 2, lookMultiplier: 0, moodStrength: -1, followSeconds: 9999, noticeMouse: 'no', walkIn: 1 });
  assert.equal(bad.tripChance, DEFAULTS.tripChance);
  assert.equal(bad.lookMultiplier, DEFAULTS.lookMultiplier);
  assert.equal(bad.moodStrength, DEFAULTS.moodStrength);
  assert.equal(bad.followSeconds, DEFAULTS.followSeconds);
  assert.equal(bad.noticeMouse, true);
  assert.equal(bad.walkIn, true);
  const good = sanitize({ tripChance: 0, lookMultiplier: 1.5, moodStrength: 0.3, followSeconds: 90.4, noticeMouse: false, walkIn: false });
  assert.deepEqual([good.tripChance, good.lookMultiplier, good.moodStrength, good.followSeconds, good.noticeMouse, good.walkIn], [0, 1.5, 0.3, 90, false, false]);
  assert.equal(prefsFor({ ...DEFAULTS }).walkPace, 1);
  assert.equal(sanitize({ walkPace: 1.2 }).walkPace, 1.2);
  assert.equal(sanitize({ walkPace: 3 }).walkPace, 1);
  // Old settings files with the retired px/s walkSpeed still load cleanly.
  assert.equal('walkSpeed' in sanitize({ walkSpeed: 110 }), false);
});

test('bowl and shadow settings', () => {
  assert.equal(DEFAULTS.waterBowl, true);
  assert.equal(DEFAULTS.shadow, true);
  const v = sanitize({ waterBowl: false, shadow: false, bowlX: 0.2 });
  assert.deepEqual([v.waterBowl, v.shadow, v.bowlX], [false, false, 0.2]);
  assert.equal(sanitize({ bowlX: 3 }).bowlX, DEFAULTS.bowlX);
});

test('bed, ball and snow settings', () => {
  const { prefsFor } = require('../src/main/settings');
  assert.deepEqual([DEFAULTS.dogBed, DEFAULTS.toy, DEFAULTS.snow], [true, true, 'auto']);
  const v = sanitize({ dogBed: false, toy: false, snow: 'on', bedX: 0.3, toyX: 0.9 });
  assert.deepEqual([v.dogBed, v.toy, v.snow, v.bedX, v.toyX], [false, false, 'on', 0.3, 0.9]);
  const bad = sanitize({ dogBed: 'yes', snow: 'blizzard', bedX: -1, toyX: 2 });
  assert.deepEqual([bad.dogBed, bad.snow, bad.bedX, bad.toyX], [true, 'auto', DEFAULTS.bedX, DEFAULTS.toyX]);
  const p = prefsFor(v);
  assert.deepEqual([p.dogBed, p.toy, p.snow, p.bedX, p.toyX], [false, false, 'on', 0.3, 0.9]);
});

test('the Tricks menu lists only tricks whose clips are installed', () => {
  const { availableTricks, buildMenuTemplate } = require('../src/main/menu');
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'manifest.json'), 'utf8'));
  const names = availableTricks(real.clips).map((t) => t.name);
  assert.deepEqual(names, ['paw', 'beg', 'roll_over', 'head_tilt', 'play', 'spin', 'yawn', 'scratch', 'dig', 'zoomies']);
  const noRun = { ...real.clips };
  delete noRun.run_loop;
  assert.equal(availableTricks(noRun).some((t) => t.name === 'zoomies'), false);
  const asked = [];
  const s = {
    following: false, toy: true, tricks: availableTricks(real.clips), size: 0.8, displays: [], fullscreenAvailable: true,
    avoidFullscreen: true, canStartWithWindows: false, startWithWindows: false, updatesAvailable: false,
    hiddenByUser: false, version: '1.7.0',
  };
  const a = new Proxy({}, { get: (_t, key) => (...args) => asked.push([key, ...args]) });
  const template = buildMenuTemplate(s, a);
  const tricks = template.find((i) => i.label === 'Tricks');
  assert.equal(tricks.submenu.length, 10);
  tricks.submenu.find((i) => i.label === 'Dig').click();
  template.find((i) => i.label === 'Throw her ball').click();
  assert.deepEqual(asked, [['trick', 'dig'], ['throwToy']]);
  assert.equal(buildMenuTemplate({ ...s, toy: false }, a).some((i) => i.label === 'Throw her ball'), false);
});
