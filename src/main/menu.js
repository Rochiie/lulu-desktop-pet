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
    { type: 'separator' },
    { label: 'Hide for 1 hour', enabled: !s.hiddenByUser, click: () => a.hideForAnHour() },
    { label: 'Show Lulu', enabled: s.hiddenByUser, click: () => a.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => a.quit() },
  );

  return template;
}

module.exports = { buildMenuTemplate };
