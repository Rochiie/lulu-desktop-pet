'use strict';

// Pure helpers for working with monitors. Each display passed in looks like
//   { id, primary, bounds, workArea, phys }
// where bounds/workArea are Electron DIP rectangles and phys is the same
// display in physical pixels (screen.dipToScreenRect). Physical pixels are
// used for adjacency because DIP rectangles of mixed-DPI monitors can leave
// gaps or overlaps between screens that physically touch.

const EDGE_TOLERANCE_PX = 2;

function verticalOverlap(a, b) {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

// The screens directly to the left and right of `id` (sharing a vertical
// edge), or null. If several touch the same edge, the one sharing the most
// edge length wins.
function neighbours(displays, id) {
  const result = { left: null, right: null };
  const d = displays.find((x) => x.id === id);
  if (!d) return result;
  let bestLeft = 0;
  let bestRight = 0;
  for (const e of displays) {
    if (e.id === id) continue;
    const overlap = verticalOverlap(d.phys, e.phys);
    if (overlap <= 0) continue;
    const touchesLeft = Math.abs(e.phys.x + e.phys.width - d.phys.x) <= EDGE_TOLERANCE_PX;
    const touchesRight = Math.abs(e.phys.x - (d.phys.x + d.phys.width)) <= EDGE_TOLERANCE_PX;
    if (touchesLeft && overlap > bestLeft) {
      result.left = e.id;
      bestLeft = overlap;
    }
    if (touchesRight && overlap > bestRight) {
      result.right = e.id;
      bestRight = overlap;
    }
  }
  return result;
}

function centre(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// The display nearest to `fromId` that is not in `busy` (a Set of ids).
function nearestFree(displays, fromId, busy) {
  const from = displays.find((d) => d.id === fromId);
  const origin = from ? centre(from.phys) : { x: 0, y: 0 };
  let best = null;
  let bestDist = Infinity;
  for (const d of displays) {
    if (d.id === fromId || busy.has(d.id)) continue;
    const c = centre(d.phys);
    const dist = Math.hypot(c.x - origin.x, c.y - origin.y);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

// The pet window spans the display's work area horizontally, and is placed
// so the clip's ground line sits exactly on the top edge of the taskbar.
function windowBounds(display, scale, manifest) {
  const wa = display.workArea;
  const height = Math.round(manifest.height * scale);
  const ground = Math.round(manifest.groundY * scale);
  return { x: wa.x, y: wa.y + wa.height - ground, width: wa.width, height };
}

// Menu labels ordered left to right, e.g. "Left screen", "Middle screen (main)".
function menuEntries(displays) {
  const sorted = [...displays].sort((a, b) => a.phys.x - b.phys.x || a.phys.y - b.phys.y);
  let names;
  if (sorted.length === 2) names = ['Left screen', 'Right screen'];
  else if (sorted.length === 3) names = ['Left screen', 'Middle screen', 'Right screen'];
  else names = sorted.map((_, i) => `Screen ${i + 1}`);
  return sorted.map((d, i) => ({ id: d.id, label: d.primary ? `${names[i]} (main)` : names[i] }));
}

module.exports = { neighbours, nearestFree, windowBounds, menuEntries };
