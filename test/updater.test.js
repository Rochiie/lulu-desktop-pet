'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/main/updater');
const { buildMenuTemplate } = require('../src/main/menu');

function setup({ packaged = true, checkResult = 'none' } = {}) {
  const fake = new EventEmitter();
  fake.checks = 0;
  fake.installs = [];
  fake.checkForUpdates = async () => {
    fake.checks += 1;
    fake.emit('checking-for-update');
    if (checkResult === 'none') fake.emit('update-not-available', { version: '1.2.0' });
    else if (checkResult === 'new') fake.emit('update-available', { version: '1.3.0' });
    else if (checkResult === 'fail') {
      const err = new Error('offline');
      fake.emit('error', err);
      throw err;
    }
    return null;
  };
  fake.quitAndInstall = (...args) => fake.installs.push(args);
  const notes = [];
  let changes = 0;
  const log = { info() {}, warn() {}, error() {} };
  const app = { isPackaged: packaged, getVersion: () => '1.2.0' };
  const u = createUpdater({ app, log, onChange: () => { changes += 1; }, notify: (m) => notes.push(m), loadUpdater: () => fake });
  return { u, fake, notes, changes: () => changes };
}

test('no updater when running from source', () => {
  assert.equal(setup({ packaged: false }).u, null);
});

test('manual check when up to date says so', async () => {
  const t = setup();
  t.u.checkNow();
  await new Promise(setImmediate);
  assert.equal(t.u.status, 'idle');
  assert.deepEqual(t.notes, ['Lulu is up to date (version 1.2.0).']);
  t.u.stop();
});

test('new version downloads, then offers restart to update', async () => {
  const t = setup({ checkResult: 'new' });
  t.u.checkNow();
  await new Promise(setImmediate);
  assert.equal(t.u.status, 'downloading');
  t.fake.emit('update-downloaded', { version: '1.3.0' });
  assert.equal(t.u.status, 'ready');
  assert.equal(t.u.version, '1.3.0');
  assert.match(t.notes.at(-1), /1\.3\.0 is ready/);
  t.u.installNow();
  assert.deepEqual(t.fake.installs, [[true, true]]);
  // Checking again does not start another download.
  t.u.checkNow();
  assert.equal(t.fake.checks, 1);
  t.u.stop();
});

test('failures are quiet for background checks and reported for manual ones', async () => {
  const t = setup({ checkResult: 'fail' });
  t.fake.checkForUpdates().catch(() => {}); // a background check
  await new Promise(setImmediate);
  assert.deepEqual(t.notes, []);
  t.u.checkNow();
  await new Promise(setImmediate);
  assert.equal(t.notes.length, 1);
  assert.equal(t.u.status, 'idle');
  t.u.stop();
});

test('install without a downloaded update is refused', () => {
  const t = setup();
  assert.throws(() => t.u.installNow(), /No update is ready/);
  t.u.stop();
});

test('menu shows the right update item and the version', () => {
  const base = {
    size: 0.8, startWithWindows: false, canStartWithWindows: true, walkBetweenScreens: true,
    avoidFullscreen: true, fullscreenAvailable: true, hiddenByUser: false, displays: [], version: '1.2.0',
    tricks: [], toy: false,
  };
  const noop = new Proxy({}, { get: () => () => {} });
  const labels = (s) => buildMenuTemplate({ ...base, ...s }, noop).map((i) => i.label).filter(Boolean);
  assert.ok(labels({ updatesAvailable: false }).includes('Check for updates (installed app only)'));
  assert.ok(labels({ updatesAvailable: true, updateStatus: 'idle' }).includes('Check for updates'));
  assert.ok(labels({ updatesAvailable: true, updateStatus: 'ready', updateVersion: '1.3.0' }).includes('Restart to update (1.3.0)'));
  assert.ok(labels({ updatesAvailable: true, updateStatus: 'idle' }).includes('Lulu 1.2.0'));
});
