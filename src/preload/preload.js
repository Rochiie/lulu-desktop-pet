'use strict';

// The only bridge between the page and the main process. Each function maps
// to exactly one IPC channel; the page gets no other access to Electron.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError(`${channel} needs a callback`);
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lulu', {
  init: () => ipcRenderer.invoke('lulu:init'),
  ready: () => ipcRenderer.send('lulu:ready'),
  cross: (side) => ipcRenderer.invoke('lulu:cross', side),
  setInteractive: (interactive) => ipcRenderer.send('lulu:set-interactive', interactive === true),
  showMenu: () => ipcRenderer.send('lulu:show-menu'),
  savePosition: (xFraction) => ipcRenderer.send('lulu:save-position', Number(xFraction)),
  saveWalkPace: (pace) => ipcRenderer.send('lulu:save-walk-pace', Number(pace)),
  reportError: (message) => ipcRenderer.send('lulu:error', String(message)),
  reportFatal: (message) => ipcRenderer.send('lulu:fatal', String(message)),
  onLayout: (callback) => subscribe('lulu:layout', callback),
  onCommand: (callback) => subscribe('lulu:command', callback),
  onIdle: (callback) => subscribe('lulu:idle', callback),
  onRunState: (callback) => subscribe('lulu:run-state', callback),
  onTune: (callback) => subscribe('lulu:tune', callback),
  onPrefs: (callback) => subscribe('lulu:prefs', callback),
  onFollow: (callback) => subscribe('lulu:follow', callback),
});
