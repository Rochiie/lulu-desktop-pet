'use strict';

// One menu template, used both for right-clicking Lulu and for the tray icon.

const { SIZE_OPTIONS } = require('./settings');

// Tricks she can be asked for, in menu order, and the clips each one needs.
const TRICKS = Object.freeze([
  Object.freeze({ name: 'paw', label: 'Give paw', clips: ['paw'] }),
  Object.freeze({ name: 'beg', label: 'Beg', clips: ['beg'] }),
  Object.freeze({ name: 'roll_over', label: 'Roll over', clips: ['roll_over'] }),
  Object.freeze({ name: 'head_tilt', label: 'Head tilt', clips: ['head_tilt'] }),
  Object.freeze({ name: 'play', label: 'Play bow', clips: ['play'] }),
  Object.freeze({ name: 'spin', label: 'Spin', clips: ['spin'] }),
  Object.freeze({ name: 'yawn', label: 'Yawn', clips: ['yawn'] }),
  Object.freeze({ name: 'scratch', label: 'Scratch', clips: ['scratch'] }),
  Object.freeze({ name: 'dig', label: 'Dig', clips: ['dig'] }),
  Object.freeze({ name: 'zoomies', label: 'Zoomies!', clips: ['run_start', 'run_loop', 'run_stop'] }),
]);

// The tricks whose clips are all installed.
function availableTricks(clips) {
  return TRICKS.filter((t) => t.clips.every((c) => Boolean(clips[c])));
}

function buildMenuTemplate(s, a) {
  const template = [
    {
      label: 'Come here',
      accelerator: 'CommandOrControl+Alt+L',
      registerAccelerator: false, // the key works everywhere via a global shortcut
      click: () => a.comeHere(),
    },
    { label: 'Follow me', type: 'checkbox', checked: s.following, click: () => a.toggleFollow() },
    { label: 'Give a treat', click: () => a.giveTreat() },
    ...(s.toy ? [{ label: 'Throw her ball', click: () => a.throwToy() }] : []),
    ...(s.tricks.length ? [{
      label: 'Tricks',
      submenu: s.tricks.map((t) => ({ label: t.label, click: () => a.trick(t.name) })),
    }] : []),
    { type: 'separator' },
    { label: 'Walk', click: () => a.command('walk') },
    { label: 'Sit', click: () => a.command('sit') },
    { label: 'Nap', click: () => a.command('nap') },
    { label: 'Wake up', click: () => a.command('wake') },
    { type: 'separator' },
    {
      label: 'Size',
      submenu: SIZE_OPTIONS.map((o) => ({
        label: o.label,
        type: 'radio',
        checked: s.size === o.value,
        click: () => a.setSize(o.value),
      })),
    },
  ];

  if (s.displays.length > 1) {
    template.push(
      {
        label: 'Screen',
        submenu: s.displays.map((d) => ({
          label: d.label,
          type: 'radio',
          checked: d.current,
          click: () => a.moveToDisplay(d.id),
        })),
      },
      {
        label: 'Walk between screens',
        type: 'checkbox',
        checked: s.walkBetweenScreens,
        click: (item) => a.setWalkBetweenScreens(item.checked),
      },
    );
  }

  template.push(
    {
      label: s.fullscreenAvailable ? 'Avoid fullscreen apps' : 'Avoid fullscreen apps (unavailable)',
      type: 'checkbox',
      checked: s.fullscreenAvailable && s.avoidFullscreen,
      enabled: s.fullscreenAvailable,
      click: (item) => a.setAvoidFullscreen(item.checked),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => a.openSettings() },
    {
      label: s.canStartWithWindows ? 'Start with Windows' : 'Start with Windows (installed app only)',
      type: 'checkbox',
      checked: s.startWithWindows,
      enabled: s.canStartWithWindows,
      click: (item) => a.setStartWithWindows(item.checked),
    },
    updateItem(s, a),
    { type: 'separator' },
    { label: 'Hide for 1 hour', enabled: !s.hiddenByUser, click: () => a.hideForAnHour() },
    { label: 'Show Lulu', enabled: s.hiddenByUser, click: () => a.show() },
    { type: 'separator' },
    { label: `Lulu ${s.version}`, enabled: false },
    { label: 'Quit', click: () => a.quit() },
  );

  return template;
}

function updateItem(s, a) {
  if (!s.updatesAvailable) return { label: 'Check for updates (installed app only)', enabled: false };
  switch (s.updateStatus) {
    case 'ready':
      return { label: `Restart to update (${s.updateVersion})`, click: () => a.installUpdate() };
    case 'downloading':
      return { label: `Downloading update (${s.updateVersion})…`, enabled: false };
    case 'checking':
      return { label: 'Checking for updates…', enabled: false };
    default:
      return { label: 'Check for updates', click: () => a.checkForUpdates() };
  }
}

module.exports = { buildMenuTemplate, availableTricks, TRICKS };
