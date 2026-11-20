'use strict';

// The Settings window: an ordinary small window with sliders and switches.
// Changes are sent to main as they happen and apply to Lulu straight away.

const { app, BrowserWindow } = require('electron');

function openSettingsWindow({ icon, preload, page, log }) {
  const win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 480,
    show: false,
    title: 'Lulu settings',
    icon,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f3ee',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(page).catch((err) => log.error('Could not open the Settings window', err));
  return win;
}

module.exports = { openSettingsWindow };
