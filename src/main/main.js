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
const { Settings, prefsFor, DEFAULTS, USER_KEYS, PLACE_KEYS } = require('./settings');
const { validateManifest } = require('./manifest');
const displaysLib = require('./displays');
const { createPetWindow } = require('./window');
const { createFullscreenDetector } = require('./fullscreen');
const { buildMenuTemplate, availableTricks } = require('./menu');
const { createUpdater } = require('./updater');
const { openSettingsWindow } = require('./settings-window');

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
const COME_HERE_KEY = 'CommandOrControl+Alt+L';
const FOLLOW_POLL_MS = 250;

const state = {
  manifest: null,
  settings: null,
  win: null,
  tray: null,
  detector: null,
  updater: null,
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
  settingsWin: null,
  following: false,
  followTimer: null,
  followEnd: null,
  lastFollowX: null,
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
  const wasHidden = state.hiddenByUser;
  state.hiddenByUser = false;
  if (wasHidden && state.settings.get().walkIn) {
    enterOn(state.displayId, state.settings.get().xFraction);
    return;
  }
  refreshVisibility();
}

// Put her just out of sight on the nearer side of a screen and have her walk
// in to xFraction of its width. Without "walk in", she just appears there.
function enterOn(displayId, xFraction) {
  const displays = snapshotDisplays();
  const display = displays.find((d) => d.id === displayId) || currentDisplay(displays);
  if (!state.settings.get().walkIn) {
    relocate(display.id, 'move', { place: 'center' });
    return;
  }
  const x = xFraction * display.workArea.width;
  relocate(display.id, 'move', { place: xFraction < 0.5 ? 'enter-left' : 'enter-right', comeX: x });
}

// "Come here" (purpose 'come') and "Give a treat" (purpose 'treat'): she
// walks to where the mouse is. If the mouse is on another screen, she moves to
// that screen and walks in from its nearer side.
function comeHere(purpose = 'come') {
  showByUser();
  const point = screen.getCursorScreenPoint();
  const target = screen.getDisplayNearestPoint(point);
  const displays = snapshotDisplays();
  const cur = currentDisplay(displays);
  const targetBlocked = state.settings.get().avoidFullscreen && state.busy.has(target.id);
  if (target.id !== cur.id && !targetBlocked) {
    const x = point.x - target.workArea.x;
    const place = x < target.workArea.width / 2 ? 'enter-left' : 'enter-right';
    log.info(`${purpose === 'treat' ? 'Treat' : 'Come here'}: Lulu moves to screen ${target.id}`);
    relocate(target.id, 'move', { place, comeX: x, purpose });
    return;
  }
  // Same screen (or the mouse's screen is fullscreen): as close as she can.
  send('lulu:command', { name: purpose, x: point.x - cur.workArea.x });
}

// ---------------------------------------------------------------- follow me

function setFollow(on) {
  clearInterval(state.followTimer);
  clearTimeout(state.followEnd);
  state.followTimer = null;
  state.followEnd = null;
  state.lastFollowX = null;
  state.following = on;
  if (on) {
    if (state.hiddenByUser) showByUser();
    state.followEnd = setTimeout(() => setFollow(false), state.settings.get().followSeconds * 1000);
    state.followTimer = setInterval(() => {
      try {
        sendFollow();
      } catch (err) {
        log.error('Follow me update failed', err);
      }
    }, FOLLOW_POLL_MS);
    sendFollow();
  } else {
    send('lulu:follow', { active: false });
  }
  refreshTray();
}

// Tell her where the mouse is, relative to her screen. x may be off either
// side when the mouse is on another screen; she heads that way.
function sendFollow() {
  const point = screen.getCursorScreenPoint();
  const cur = currentDisplay(snapshotDisplays());
  const x = point.x - cur.workArea.x;
  if (x === state.lastFollowX) return;
  state.lastFollowX = x;
  send('lulu:follow', { active: true, x });
}

function bringBackToCentre() {
  clearTimeout(state.hideTimer);
  state.hideTimer = null;
  state.hiddenByUser = false;
  enterOn(screen.getPrimaryDisplay().id, 0.5);
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
      if (state.settings.get().walkIn) enterOn(target.id, 0.2 + Math.random() * 0.6);
      else relocate(target.id, 'hop', { place: 'random' });
      return;
    }
    state.fullscreenHidden = true;
  } else if (state.fullscreenHidden) {
    // A screen came free after every screen was fullscreen: walk back in.
    state.fullscreenHidden = false;
    enterOn(cur.id, state.settings.get().xFraction);
    return;
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

function sendPrefs() {
  send('lulu:prefs', prefsFor(state.settings.get()));
}

// Apply a change from the menu or the Settings window, with its side effects.
function applySettingsPatch(patch) {
  const unknown = Object.keys(patch).filter((k) => !USER_KEYS.includes(k));
  if (unknown.length) throw new Error(`Unknown settings: ${unknown.join(', ')}`);
  if ('startWithWindows' in patch && !app.isPackaged) {
    log.warn('Start with Windows only works in the installed app');
    delete patch.startWithWindows;
  }
  const before = state.settings.get();
  const after = state.settings.update(patch);
  if (after.startWithWindows !== before.startWithWindows) {
    app.setLoginItemSettings({ openAtLogin: after.startWithWindows });
  }
  if (after.size !== before.size) place('resize');
  if (after.walkBetweenScreens !== before.walkBetweenScreens) send('lulu:layout', computeLayout('edges').layout);
  if (after.avoidFullscreen !== before.avoidFullscreen) scanFullscreen();
  sendPrefs();
  refreshTray();
  return after;
}

function setSize(size) {
  applySettingsPatch({ size });
}

function setWalkBetweenScreens(on) {
  applySettingsPatch({ walkBetweenScreens: on });
}

function setAvoidFullscreen(on) {
  applySettingsPatch({ avoidFullscreen: on });
}

function syncLoginItem() {
  if (!app.isPackaged) return;
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== state.settings.get().startWithWindows) {
    state.settings.update({ startWithWindows: actual });
  }
}

function setStartWithWindows(on) {
  applySettingsPatch({ startWithWindows: on });
}

// ---------------------------------------------------------------- settings window

function openSettings() {
  if (state.settingsWin && !state.settingsWin.isDestroyed()) {
    if (state.settingsWin.isMinimized()) state.settingsWin.restore();
    state.settingsWin.focus();
    return;
  }
  state.settingsWin = openSettingsWindow({
    icon: ICON_PATH,
    preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
    page: path.join(__dirname, '..', 'settings', 'index.html'),
    log,
  });
  state.settingsWin.on('closed', () => {
    state.settingsWin = null;
  });
}

function settingsView() {
  return {
    values: state.settings.get(),
    defaults: DEFAULTS,
    meta: {
      canStartWithWindows: app.isPackaged,
      fullscreenAvailable: state.detector !== null,
      multipleScreens: screen.getAllDisplays().length > 1,
      version: app.getVersion(),
    },
  };
}

function assertSettingsSender(event) {
  if (!state.settingsWin || state.settingsWin.isDestroyed() || event.sender !== state.settingsWin.webContents) {
    throw new Error('Settings IPC from an unexpected sender');
  }
}

// ---------------------------------------------------------------- menu & tray

const menuActions = {
  command: (name) => {
    if (!COMMANDS.has(name)) throw new Error(`Unknown command ${name}`);
    send('lulu:command', { name });
  },
  comeHere: () => comeHere('come'),
  giveTreat: () => comeHere('treat'),
  trick: (name) => {
    if (!availableTricks(state.manifest.clips).some((t) => t.name === name)) throw new Error(`Unknown trick ${name}`);
    showByUser();
    send('lulu:command', { name: 'trick', trick: name });
  },
  throwToy: () => {
    showByUser();
    send('lulu:command', { name: 'throw' });
  },
  toggleFollow: () => setFollow(!state.following),
  openSettings,
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
  checkForUpdates: () => state.updater.checkNow(),
  installUpdate: () => state.updater.installNow(),
  quit: () => app.quit(),
};

function notify(message) {
  if (!state.tray || state.tray.isDestroyed()) return;
  state.tray.displayBalloon({ title: 'Lulu', content: message, iconType: 'custom', icon: ICON_PATH });
}

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
    following: state.following,
    toy: s.toy,
    tricks: availableTricks(state.manifest.clips),
    version: app.getVersion(),
    updatesAvailable: state.updater !== null,
    updateStatus: state.updater ? state.updater.status : null,
    updateVersion: state.updater ? state.updater.version : null,
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
    'CommandOrControl+Alt+=': { delta: 0.05 },
    'CommandOrControl+Alt+-': { delta: -0.05 },
    'CommandOrControl+Alt+W': { walk: true },
    'CommandOrControl+Alt+S': { save: true },
    'CommandOrControl+Alt+K': { trick: true },
  };
  for (const [accelerator, payload] of Object.entries(keys)) {
    if (!globalShortcut.register(accelerator, () => send('lulu:tune', payload))) {
      log.warn(`Could not register tune shortcut ${accelerator} (another app may own it)`);
    }
  }
  const actions = {
    'CommandOrControl+Alt+T': () => comeHere('treat'),
    'CommandOrControl+Alt+F': () => setFollow(!state.following),
  };
  for (const [accelerator, action] of Object.entries(actions)) {
    if (!globalShortcut.register(accelerator, action)) {
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
      settings: { xFraction: s.xFraction },
      prefs: prefsFor(s),
      layout,
      tune: TUNE,
    };
  });

  ipcMain.handle('settings:get', (event) => {
    assertSettingsSender(event);
    return settingsView();
  });

  ipcMain.handle('settings:update', (event, patch) => {
    assertSettingsSender(event);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch must be an object');
    applySettingsPatch({ ...patch });
    return settingsView();
  });

  ipcMain.handle('settings:reset', (event) => {
    assertSettingsSender(event);
    const patch = {};
    for (const key of USER_KEYS) {
      if (key !== 'startWithWindows') patch[key] = DEFAULTS[key];
    }
    applySettingsPatch(patch);
    return settingsView();
  });

  // She has walked off the edge of her screen: move the window to the next
  // screen and hand back the new layout, or null if that is no longer allowed.
  ipcMain.handle('lulu:cross', (event, side) => {
    assertSender(event);
    if (side !== 'left' && side !== 'right') throw new Error(`Bad side: ${side}`);
    const displays = snapshotDisplays();
    const cur = currentDisplay(displays);
    if (!edgesFor(cur, displays)[side]) {
      log.info(`Lulu could not walk ${side}: that screen is unavailable`);
      return null;
    }
    const target = displaysLib.neighbours(displays, cur.id)[side];
    log.info(`Lulu walked ${side} onto screen ${target}`);
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

  // Where her bowl, bed or ball now sits (share of the screen width).
  on('lulu:save-place', (key, x) => {
    if (!PLACE_KEYS.includes(key)) throw new TypeError(`Not a place: ${key}`);
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new TypeError(`${key} must be between 0 and 1`);
    state.settings.update({ [key]: x });
  });

  on('lulu:save-position', (xFraction) => {
    if (!Number.isFinite(xFraction)) throw new TypeError('xFraction must be a number');
    state.settings.update({ xFraction, displayId: state.displayId });
  });

  on('lulu:save-walk-pace', (pace) => {
    if (!TUNE) throw new Error('Walk pace can only be saved in tune mode');
    if (!Number.isFinite(pace)) throw new TypeError('pace must be a number');
    state.settings.update({ walkPace: pace });
    state.settings.flush();
    sendPrefs();
    log.info(`Walk pace saved: ${pace}`);
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
  state.settings.onChange = () => {
    if (state.settingsWin && !state.settingsWin.isDestroyed()) {
      state.settingsWin.webContents.send('settings:changed', settingsView());
    }
  };
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
  state.updater = createUpdater({ app, log, onChange: refreshTray, notify });
  if (!globalShortcut.register(COME_HERE_KEY, comeHere)) {
    log.warn(`Could not register ${COME_HERE_KEY} for "Come here" (another app may own it)`);
  }
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
  // Opening Lulu again while she is running (e.g. her shortcut) opens Settings.
  app.on('second-instance', () => {
    if (!windowAlive()) return;
    showByUser();
    openSettings();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    state.quitting = true;
    state.intervals.forEach(clearInterval);
    clearTimeout(state.hideTimer);
    clearTimeout(state.displayChangeTimer);
    clearInterval(state.followTimer);
    clearTimeout(state.followEnd);
    globalShortcut.unregisterAll();
    if (state.updater) state.updater.stop();
    if (state.settings) state.settings.flush();
  });
  app.whenReady().then(start).catch(fatal);
}
