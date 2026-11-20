'use strict';

// The one transparent, frameless, always-on-top window Lulu lives in.

const { app, BrowserWindow } = require('electron');

function createPetWindow({ bounds, preload, page, icon, tune }) {
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    // Clicking Lulu should not steal keyboard focus from whatever you are
    // typing in. Tune mode uses global shortcuts, so it never needs focus.
    focusable: false,
    thickFrame: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    title: 'Lulu',
    icon,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
      devTools: !app.isPackaged || tune,
    },
  });

  // 'screen-saver' keeps her above the taskbar, which she overlaps by a few
  // pixels (the gap between the ground line and the bottom of the clip).
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  return { win, loaded: win.loadFile(page) };
}

module.exports = { createPetWindow };
