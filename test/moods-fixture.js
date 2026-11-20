'use strict';
// The real mood table from config.js, loaded without a browser.
globalThis.self = globalThis;
require('../src/renderer/config.js');
module.exports = globalThis.LuluConfig.moods;
