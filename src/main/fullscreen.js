'use strict';

// Finds which monitors are covered by a fullscreen window (a game, a
// fullscreen video, a presentation), using the Win32 API through koffi.
//
// A monitor counts as covered when a visible, non-minimised, non-cloaked
// top-level window from another process covers the whole monitor, including
// the taskbar. Maximised windows stop at the taskbar, so they do not count.
// Click-through overlays, tool windows and the desktop itself are ignored.

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const IGNORED_EX_STYLES = WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
const DWMWA_CLOAKED = 14;
const S_OK = 0;
const CLASS_NAME_CHARS = 256;
const IGNORED_CLASSES = new Set([
  'Progman', // desktop
  'WorkerW', // desktop wallpaper host
  'Shell_TrayWnd', // main taskbar
  'Shell_SecondaryTrayWnd', // taskbars on other monitors
]);

function createFullscreenDetector(log) {
  if (process.platform !== 'win32') return null;

  let koffi;
  try {
    koffi = require('koffi');
  } catch (err) {
    log.warn('Fullscreen detection is unavailable: koffi did not load', err);
    return null;
  }

  let api;
  try {
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    koffi.pointer('HWND', koffi.opaque());
    koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    koffi.proto('int __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');
    api = {
      EnumWindows: user32.func('int __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('int __stdcall IsWindowVisible(HWND hWnd)'),
      IsIconic: user32.func('int __stdcall IsIconic(HWND hWnd)'),
      GetWindowRect: user32.func('int __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)'),
      GetWindowThreadProcessId: user32.func(
        'uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)',
      ),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hWnd, void *lpClassName, int nMaxCount)'),
      DwmGetWindowAttribute: dwmapi.func(
        'int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)',
      ),
    };
  } catch (err) {
    log.warn('Fullscreen detection is unavailable: Win32 functions could not be bound', err);
    return null;
  }

  const ownPid = process.pid;
  const classBuf = Buffer.alloc(CLASS_NAME_CHARS * 2);

  function className(hwnd) {
    const len = api.GetClassNameW(hwnd, classBuf, CLASS_NAME_CHARS);
    return len > 0 ? classBuf.toString('utf16le', 0, len * 2) : '';
  }

  function isCloaked(hwnd) {
    const out = [0];
    return api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4) === S_OK && out[0] !== 0;
  }

  // rects: physical-pixel monitor rectangles {x, y, width, height}.
  // Returns an array of booleans, true where that monitor is covered.
  function coveredDisplays(rects) {
    const covered = rects.map(() => false);
    let failure = null;
    api.EnumWindows((hwnd) => {
      try {
        if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return 1;
        const r = {};
        if (!api.GetWindowRect(hwnd, r)) return 1;
        const hits = [];
        rects.forEach((m, i) => {
          if (
            !covered[i] &&
            r.left <= m.x &&
            r.top <= m.y &&
            r.right >= m.x + m.width &&
            r.bottom >= m.y + m.height
          ) {
            hits.push(i);
          }
        });
        if (hits.length === 0) return 1;
        if (Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & IGNORED_EX_STYLES) return 1;
        const pid = [0];
        api.GetWindowThreadProcessId(hwnd, pid);
        if (pid[0] === ownPid) return 1;
        if (IGNORED_CLASSES.has(className(hwnd))) return 1;
        if (isCloaked(hwnd)) return 1;
        for (const i of hits) covered[i] = true;
        return covered.every(Boolean) ? 0 : 1; // stop early once every monitor is covered
      } catch (err) {
        failure = err;
        return 0;
      }
    }, 0);
    if (failure) throw failure;
    return covered;
  }

  return { coveredDisplays };
}

module.exports = { createFullscreenDetector };
