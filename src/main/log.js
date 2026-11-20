'use strict';

// Small file + console logger. The log lives next to the settings file in
// userData so problems on Cody's machine can be diagnosed after the fact.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;

let logFile = null;

function init(dir) {
  logFile = path.join(dir, 'lulu.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { size } = fs.statSync(logFile);
    if (size > MAX_BYTES) fs.renameSync(logFile, `${logFile}.old`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not rotate log file', err);
  }
}

function write(level, message, err) {
  const detail = err ? ` ${err.stack || err}` : '';
  const line = `${new Date().toISOString()} [${level}] ${message}${detail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch (writeErr) {
    console.error('Could not write log file', writeErr);
  }
}

module.exports = {
  init,
  info: (message) => write('info', message),
  warn: (message, err) => write('warn', message, err),
  error: (message, err) => write('error', message, err),
};
