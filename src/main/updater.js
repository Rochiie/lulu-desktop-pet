'use strict';

// Self-updating from GitHub Releases, in the installed app only.
// Lulu checks a minute after start and then every 6 hours. A new version
// downloads quietly in the background and installs the next time Lulu quits,
// or straight away from "Restart to update" in her menu.

const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// status: 'idle' | 'checking' | 'downloading' | 'ready'
function createUpdater({ app, log, onChange, notify, loadUpdater = () => require('electron-updater').autoUpdater }) {
  if (!app.isPackaged) return null;

  let autoUpdater;
  try {
    autoUpdater = loadUpdater();
  } catch (err) {
    log.warn('Updates are unavailable: electron-updater did not load', err);
    return null;
  }

  autoUpdater.logger = {
    info: (msg) => log.info(`Updater: ${msg}`),
    warn: (msg) => log.warn(`Updater: ${msg}`),
    error: (msg) => log.error(`Updater: ${msg}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true; // we ship the full installer only

  const state = { status: 'idle', version: null, manual: false };
  const set = (patch) => {
    Object.assign(state, patch);
    onChange();
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    if (state.manual) notify(`Downloading Lulu ${info.version}…`);
    set({ status: 'downloading', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    if (state.manual) notify(`Lulu is up to date (version ${app.getVersion()}).`);
    set({ status: 'idle', manual: false });
  });
  autoUpdater.on('update-downloaded', (info) => {
    notify(`Lulu ${info.version} is ready. It installs next time Lulu restarts, or choose "Restart to update" in her menu.`);
    set({ status: 'ready', version: info.version, manual: false });
  });
  autoUpdater.on('error', (err) => {
    log.warn('Update check failed', err);
    if (state.manual) notify('Lulu could not check for updates. Is the internet connected?');
    // A finished download stays ready even if a later check fails.
    set({ status: state.status === 'ready' ? 'ready' : 'idle', manual: false });
  });

  function check(manual) {
    if (state.status === 'ready') {
      if (manual) notify(`Lulu ${state.version} is already downloaded. Choose "Restart to update" to install it.`);
      return;
    }
    if (state.status !== 'idle') return; // a check or download is already running
    state.manual = manual;
    // Failures are reported through the 'error' event above.
    autoUpdater.checkForUpdates().catch(() => {});
  }

  const firstCheck = setTimeout(() => check(false), FIRST_CHECK_DELAY_MS);
  const repeatCheck = setInterval(() => check(false), CHECK_EVERY_MS);

  return {
    get status() {
      return state.status;
    },
    get version() {
      return state.version;
    },
    checkNow: () => check(true),
    installNow: () => {
      if (state.status !== 'ready') throw new Error('No update is ready to install');
      autoUpdater.quitAndInstall(true, true); // silent install, then start Lulu again
    },
    stop: () => {
      clearTimeout(firstCheck);
      clearInterval(repeatCheck);
    },
  };
}

module.exports = { createUpdater };
