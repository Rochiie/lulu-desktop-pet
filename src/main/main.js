'use strict';

// Main process: owns the window, tray, menu, settings, monitors, fullscreen
// detection and idle detection. The renderer owns the animation and the
// behaviour state machine; the two talk through the narrow bridge in preload.

const path = require('node:path');
const fs = require('node:fs');
const {
  app, Menu, Tray, ipcMain, screen, powerMonitor, globalShortcut, dialog,
} = require('electron');

const log = require('./log');
const { Settings } = require('./settings');
const { validateManifest } = require('./manifest');
const displaysLib = require('./displays');
const { createPetWindow } = require('./window');
const { createFullscreenDetector } = require('./fullscreen');
const { buildMenuTemplate } = require('./menu');

const TUNE = process.argv.includes('--tune');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const ICON_PATH = path.join(ASSETS_DIR, 'lulu_icon.ico');

const IDLE_THRESHOLD_SEC = 5 * 60;
const IDLE_POLL_MS = 2000;
const FULLSCREEN_POLL_MS = 2000;
const HIDE_FOR_MS = 60 * 60 * 1000;
const RELOCATE_SHOW_DELAY_MS = 150;
const DISPLAY_CHANGE_DEBOUNCE_MS = 250;
const MAX_RENDERER_RESTARTS = 3;
const RENDERER_RESTART_WINDOW_MS = 60 * 1000;
const COMMANDS = new Set(['walk', 'sit', 'nap', 'wake']);

const state = {
  manifest: null,
  settings: null,
  win: null,
  tray: null,
  detector: null,
  displayId: null,
  layoutSeq: 0,
  rendererReady: false,
  running: null,
  hiddenByUser: false,
  hideTimer: null,
  fullscreenHidden: false,
  locked: false,
  suspended: false,
  userIdle: false,
  busy: new Set(),
  intervals: [],
  displayChangeTimer: null,
  rendererRestarts: [],
  quitting: false,
};

// ---------------------------------------------------------------- helpers

function fatal(err) {
  log.error('Fatal error', err);
  if (app.isReady()) dialog.showErrorBox('Lulu could not start', String(err && err.message ? err.message : err));
  state.quitting = true;
  app.exit(1);
}

function windowAlive() {
  return state.win !== null && !state.win.isDestroyed();
}

function send(channel, payload) {
  if (windowAlive()) state.win.webContents.send(channel, payload);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------- displays

function snapshotDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    primary: d.id === primaryId,
    bounds: d.bounds,
    workArea: d.workArea,
    phys: screen.dipToScreenRect(null, d.bounds),
  }));
}

function currentDisplay(displays) {
  return (
    displays.find((d) => d.id === state.displayId) ||
    displays.find((d) => d.primary) ||
    displays[0]
  );
}

// Which sides she may walk off: there must be a screen there, walking between
// screens must be on, and that screen must not be showing a fullscreen app.
function edgesFor(display, displays) {
  if (!state.settings.get().walkBetweenScreens) return { left: false, right: false };
  const n = displaysLib.neighbours(displays, display.id);
  return {
    left: n.left !== null && !state.busy.has(n.left),
    right: n.right !== null && !state.busy.has(n.right),
  };
}

function computeLayout(reason, extra = {}) {
  const displays = snapshotDisplays();
  const display = currentDisplay(displays);
  state.displayId = display.id;
  const scale = state.settings.get().size;
  const bounds = displaysLib.windowBounds(display, scale, state.manifest);
  return {
    bounds,
    layout: {
      seq: ++state.layoutSeq,
      reason,
      width: bounds.width,
      height: bounds.height,
      scale,
      displayId: display.id,
      edges: edgesFor(display, displays),
      ...extra,
    },
  };
}

function setWindowBounds(bounds) {
  if (!windowAlive()) return;
  state.win.setBounds(bounds);
  // Moving between monitors with different scaling can leave the size off by
  // the DPI ratio on the first call; applying it again settles it.
  const got = state.win.getBounds();
  if (got.x !== bounds.x || got.y !== bounds.y || got.width !== bounds.width || got.height !== bounds.height) {
    state.win.setBounds(bounds);
  }
}

// Recompute the layout, move the window, and (normally) tell the renderer.
function place(reason, extra = {}, { broadcast = true } = {}) {
  const { bounds, layout } = computeLayout(reason, extra);
  setWindowBounds(bounds);
  if (broadcast) send('lulu:layout', layout);
  return layout;
}

// Move her to another monitor. The window is hidden while it moves so she
// never flashes at the old spot on the new screen.
function relocate(displayId, reason, extra = {}) {
  state.displayId = displayId;
  state.settings.update({ displayId });
  const wasVisible = windowAlive() && state.win.isVisible();
  if (wasVisible) state.win.hide();
  place(reason, extra);
  if (wasVisible) setTimeout(refreshVisibility, RELOCATE_SHOW_DELAY_MS);
  else refreshVisibility();
}

function handleDisplayChange() {
  const displays = snapshotDisplays();
  if (!displays.some((d) => d.id === state.displayId)) {
    const primary = displays.find((d) => d.primary) || displays[0];
    log.info('Lulu\'s screen went away; moving her to the main screen');
    relocate(primary.id, 'move', { place: 'center' });
  } else {
    place('resize');
  }
  scanFullscreen({ force: true });
  refreshTray();
}

function watchDisplays() {
  const onChange = () => {
    clearTimeout(state.displayChangeTimer);
    state.displayChangeTimer = setTimeout(() => {
      try {
        handleDisplayChange();
      } catch (err) {
        log.error('Handling a display change failed', err);
      }
    }, DISPLAY_CHANGE_DEBOUNCE_MS);
  };
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
  screen.on('display-metrics-changed', onChange);
}

// ---------------------------------------------------------------- visibility

function refreshVisibility() {
  if (!windowAlive()) return;
  const show = state.rendererReady && !state.hiddenByUser && !state.fullscreenHidden;
  if (show && !state.win.isVisible()) {
    state.win.showInactive();
    state.win.setAlwaysOnTop(true, 'screen-saver');
  } else if (!show && state.win.isVisible()) {
    state.win.hide();
  }
  // She only animates when she can actually be seen.
  const running = show && !state.locked && !state.suspended;
  if (running !== state.running) {
    state.running = running;
    send('lulu:run-state', running);
  }
  refreshTray();
}

function hideForAnHour() {
  clearTimeout(state.hideTimer);
  state.hiddenByUser = true;
  state.hideTimer = setTimeout(showByUser, HIDE_FOR_MS);
  log.info('Hidden for 1 hour');
  refreshVisibility();
}

function showByUser() {
  clearTimeout(state.hideTimer);
  state.hideTimer = null;
  state.hiddenByUser = false;
  refreshVisibility();
}

function bringBackToCentre() {
  showByUser();
  const primary = screen.getPrimaryDisplay();
  relocate(primary.id, 'move', { place: 'center' });
  scanFullscreen({ force: true });
}

// ---------------------------------------------------------------- fullscreen

// force: react even if the set of fullscreen screens has not changed (used
// after she has been moved, in case she was moved onto a fullscreen screen).
function scanFullscreen({ force = false } = {}) {
  const busy = new Set();
  const s = state.settings.get();
  if (state.detector && s.avoidFullscreen && !state.locked && !state.suspended) {
    const displays = snapshotDisplays();
    try {
      const covered = state.detector.coveredDisplays(displays.map((d) => d.phys));
      covered.forEach((isCovered, i) => {
        if (isCovered) busy.add(displays[i].id);
      });
    } catch (err) {
      log.error('Fullscreen check failed; turning it off for this session', err);
      state.detector = null;
      refreshTray();
    }
  }
  if (sameSet(busy, state.busy)) {
    if (force) reactToBusy();
    return;
  }
  state.busy = busy;
  log.info(`Screens showing a fullscreen app: ${busy.size ? [...busy].join(', ') : 'none'}`);
  reactToBusy();
}

function reactToBusy() {
  const displays = snapshotDisplays();
  const cur = currentDisplay(displays);
  if (state.busy.has(cur.id)) {
    const target = displaysLib.nearestFree(displays, cur.id, state.busy);
    if (target) {
      log.info(`Fullscreen app on Lulu's screen; she hops to ${target.id}`);
      state.fullscreenHidden = false;
      relocate(target.id, 'hop', { place: 'random' });
      return;
    }
    state.fullscreenHidden = true;
  } else {
    state.fullscreenHidden = false;
  }
  send('lulu:layout', computeLayout('edges').layout);
  refreshVisibility();
}

// ---------------------------------------------------------------- idle & power

function pollIdle() {
  const idle = powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SEC;
  if (idle === state.userIdle) return;
  state.userIdle = idle;
  log.info(idle ? 'User is idle; Lulu naps' : 'User is back');
  send('lulu:idle', idle);
}

function watchPower() {
  const set = (key, value) => () => {
    state[key] = value;
    refreshVisibility();
    if (!value) scanFullscreen();
  };
  powerMonitor.on('lock-screen', set('locked', true));
  powerMonitor.on('unlock-screen', set('locked', false));
  powerMonitor.on('suspend', set('suspended', true));
  powerMonitor.on('resume', set('suspended', false));
}

function startPolling() {
  const guarded = (name, fn) => () => {
    try {
      fn();
    } catch (err) {
      log.error(`${name} failed`, err);
    }
  };
  state.intervals.push(setInterval(guarded('Idle check', pollIdle), IDLE_POLL_MS));
  state.intervals.push(setInterval(guarded('Fullscreen check', scanFullscreen), FULLSCREEN_POLL_MS));
}

// ---------------------------------------------------------------- settings actions

function setSize(size) {
  state.settings.update({ size });
  place('resize');
  refreshTray();
}

function setWalkBetweenScreens(on) {
  state.settings.update({ walkBetweenScreens: on });
  send('lulu:layout', computeLayout('edges').layout);
  refreshTray();
}

function setAvoidFullscreen(on) {
  state.settings.update({ avoidFullscreen: on });
  scanFullscreen();
  refreshTray();
}

function syncLoginItem() {
  if (!app.isPackaged) return;
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== state.settings.get().startWithWindows) {
    state.settings.update({ startWithWindows: actual });
  }
}

function setStartWithWindows(on) {
  if (!app.isPackaged) {
    log.warn('Start with Windows only works in the installed app');
    refreshTray();
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on });
  state.settings.update({ startWithWindows: on });
  refreshTray();
}

// ---------------------------------------------------------------- menu & tray

const menuActions = {
  command: (name) => {
    if (!COMMANDS.has(name)) throw new Error(`Unknown command ${name}`);
    send('lulu:command', name);
  },
  setSize,
  moveToDisplay: (id) => {
    showByUser();
    relocate(id, 'move', { place: 'center' });
    scanFullscreen({ force: true });
  },
  setWalkBetweenScreens,
  setAvoidFullscreen,
  setStartWithWindows,
  hideForAnHour,
  show: showByUser,
  quit: () => app.quit(),
};

function menuState() {
  const s = state.settings.get();
  return {
    size: s.size,
    startWithWindows: s.startWithWindows,
    canStartWithWindows: app.isPackaged,
    walkBetweenScreens: s.walkBetweenScreens,
    avoidFullscreen: s.avoidFullscreen,
    fullscreenAvailable: state.detector !== null,
    hiddenByUser: state.hiddenByUser,
    displays: displaysLib
      .menuEntries(snapshotDisplays())
      .map((d) => ({ ...d, current: d.id === state.displayId })),
  };
}

function buildMenu() {
  return Menu.buildFromTemplate(buildMenuTemplate(menuState(), menuActions));
}

function createTray() {
  state.tray = new Tray(ICON_PATH);
  state.tray.setToolTip('Lulu');
  state.tray.on('double-click', bringBackToCentre);
  refreshTray();
}

function refreshTray() {
  if (state.tray && !state.tray.isDestroyed()) state.tray.setContextMenu(buildMenu());
}

// ---------------------------------------------------------------- tune mode

function registerTuneShortcuts() {
  const keys = {
    'CommandOrControl+Alt+=': { delta: 5 },
    'CommandOrControl+Alt+-': { delta: -5 },
    'CommandOrControl+Alt+W': { walk: true },
    'CommandOrControl+Alt+S': { save: true },
  };
  for (const [accelerator, payload] of Object.entries(keys)) {
    if (!globalShortcut.register(accelerator, () => send('lulu:tune', payload))) {
      log.warn(`Could not register tune shortcut ${accelerator} (another app may own it)`);
    }
  }
}

// ---------------------------------------------------------------- IPC

function assertSender(event) {
  if (!windowAlive() || event.sender !== state.win.webContents) {
    throw new Error('IPC message from an unexpected sender');
  }
}

function on(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertSender(event);
      handler(...args);
    } catch (err) {
      log.error(`IPC ${channel} failed`, err);
    }
  });
}

function registerIpc() {
  ipcMain.handle('lulu:init', (event) => {
    assertSender(event);
    const { bounds, layout } = computeLayout('init');
    setWindowBounds(bounds);
    const s = state.settings.get();
    return {
      manifest: state.manifest,
      settings: { walkSpeed: s.walkSpeed, xFraction: s.xFraction },
      layout,
      tune: TUNE,
    };
  });

  // She has walked off the edge of her screen: move the window to the next
  // screen and hand back the new layout, or null if that is no longer allowed.
  ipcMain.handle('lulu:cross', (event, side) => {
    assertSender(event);
    if (side !== 'left' && side !== 'right') throw new Error(`Bad side: ${side}`);
    const displays = snapshotDisplays();
    const cur = currentDisplay(displays);
    if (!edgesFor(cur, displays)[side]) return null;
    const target = displaysLib.neighbours(displays, cur.id)[side];
    state.displayId = target;
    state.settings.update({ displayId: target });
    const layout = place('cross', {}, { broadcast: false });
    refreshTray();
    return layout;
  });

  on('lulu:ready', () => {
    state.rendererReady = true;
    state.running = null; // force the run state to be sent again
    send('lulu:idle', state.userIdle);
    refreshVisibility();
  });

  on('lulu:set-interactive', (interactive) => {
    if (typeof interactive !== 'boolean') throw new TypeError('interactive must be a boolean');
    if (interactive) state.win.setIgnoreMouseEvents(false);
    else state.win.setIgnoreMouseEvents(true, { forward: true });
  });

  on('lulu:show-menu', () => {
    buildMenu().popup({ window: state.win });
  });

  on('lulu:save-position', (xFraction) => {
    if (!Number.isFinite(xFraction)) throw new TypeError('xFraction must be a number');
    state.settings.update({ xFraction, displayId: state.displayId });
  });

  on('lulu:save-walk-speed', (speed) => {
    if (!TUNE) throw new Error('Walk speed can only be saved in tune mode');
    if (!Number.isFinite(speed)) throw new TypeError('speed must be a number');
    state.settings.update({ walkSpeed: speed });
    state.settings.flush();
    log.info(`Walk speed saved: ${speed} px/s at size 1.0`);
  });

  on('lulu:error', (message) => log.error(`Renderer: ${String(message).slice(0, 4000)}`));

  on('lulu:fatal', (message) => fatal(new Error(String(message))));
}

// ---------------------------------------------------------------- start-up

function onRendererGone(details) {
  log.error(`Renderer stopped (${details.reason}, exit code ${details.exitCode})`);
  state.rendererReady = false;
  refreshVisibility();
  if (state.quitting || details.reason === 'clean-exit') return;
  const now = Date.now();
  state.rendererRestarts = state.rendererRestarts.filter((t) => now - t < RENDERER_RESTART_WINDOW_MS);
  if (state.rendererRestarts.length >= MAX_RENDERER_RESTARTS) {
    fatal(new Error('Lulu\'s animation crashed several times in a row. See lulu.log in the app data folder.'));
    return;
  }
  state.rendererRestarts.push(now);
  state.win.reload();
}

async function start() {
  log.init(app.getPath('userData'));
  log.info(`Starting Lulu ${app.getVersion()}${TUNE ? ' in tune mode' : ''}`);
  app.setAppUserModelId('com.cody.lulu');

  state.manifest = validateManifest(
    JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'manifest.json'), 'utf8')),
  );
  state.settings = new Settings(path.join(app.getPath('userData'), 'settings.json'), log);
  state.settings.load();
  state.displayId = state.settings.get().displayId;
  syncLoginItem();

  state.detector = createFullscreenDetector(log);
  registerIpc();

  const { bounds } = computeLayout('init');
  const { win, loaded } = createPetWindow({
    bounds,
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    page: path.join(__dirname, '..', 'renderer', 'index.html'),
    icon: ICON_PATH,
    tune: TUNE,
  });
  state.win = win;
  win.on('closed', () => {
    state.win = null;
    if (!state.quitting) app.quit();
  });
  win.webContents.on('render-process-gone', (_event, details) => onRendererGone(details));

  createTray();
  watchDisplays();
  watchPower();
  startPolling();
  if (TUNE) registerTuneShortcuts();

  await loaded;
  scanFullscreen();
}

process.on('uncaughtException', (err) => log.error('Uncaught exception', err));
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (windowAlive()) showByUser();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    state.quitting = true;
    state.intervals.forEach(clearInterval);
    clearTimeout(state.hideTimer);
    clearTimeout(state.displayChangeTimer);
    globalShortcut.unregisterAll();
    if (state.settings) state.settings.flush();
  });
  app.whenReady().then(start).catch(fatal);
}
