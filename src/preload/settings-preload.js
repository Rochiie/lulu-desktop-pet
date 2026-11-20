'use strict';

// Bridge for the Settings window: read settings, change them, reset them.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luluSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  reset: () => ipcRenderer.invoke('settings:reset'),
  onChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onChanged needs a callback');
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
