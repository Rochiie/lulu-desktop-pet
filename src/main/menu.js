'use strict';

// One menu template, used both for right-clicking Lulu and for the tray icon.

const { SIZE_OPTIONS } = require('./settings');

function buildMenuTemplate(s, a) {
  const template = [
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

module.exports = { buildMenuTemplate };
