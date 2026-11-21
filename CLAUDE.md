# Lulu — Windows desktop pet

Build a small Windows desktop app that puts Lulu (Cody's black and tan miniature dachshund) on the desktop, Clippy-style. She walks along the bottom of the screen, stops to sniff, sit, look at the user, stretch and nap, and reacts when clicked.

**Before writing any code: read this file and `assets/manifest.json`, then show Cody a short plan and wait for him to say "go".**

## What's already done

All animation is finished and lives in `assets/`. Do not regenerate or edit the clips.

- 11 transparent video clips (VP9 WebM with alpha), 24 fps, all 532×312 px.
- Every clip uses the same canvas and the same ground line (`groundY` = 305 px from the top). Lulu faces **right** in every clip. Flip horizontally for left-facing.
- Every clip starts and ends on one of two poses — `stand` or `sleep` — so any clip that ends in a pose can be followed by any clip that starts in that pose with no visible jump.
- `manifest.json` lists each clip's frames, duration, start pose, end pose, whether it loops, and what it's for.
- `walk_start_first.png` / `sleep_loop_first.png` are still frames of the two poses (use for the idle hold and as posters).
- `lulu_icon.ico` / `lulu_icon.png` — app and tray icon.

| Clip | From → to | Use |
|---|---|---|
| walk_start | stand → stand | Start walking (speed ramps 0 → walk speed) |
| walk_loop | stand → stand | Loop while moving at walk speed |
| walk_stop | stand → stand | Stop walking (speed ramps walk speed → 0) |
| sniff | stand → stand | Nose to the ground, stationary |
| look | stand → stand | Turns to look at the user, small wag |
| sit | stand → stand | Sits, stays, stands back up |
| stretch | stand → stand | Play-bow stretch, then a shake |
| happy | stand → stand | Click reaction: tail wag and a small hop |
| lie_down | stand → sleep | Lies down and falls asleep |
| sleep_loop | sleep → sleep | Breathing loop |
| wake_up | sleep → stand | Wakes, stretches, stands |

## Tech stack

- Electron (current stable) + plain HTML/CSS/JS renderer. No framework needed.
- electron-builder → NSIS installer (`Lulu Setup.exe`), app icon `assets/lulu_icon.ico`.
- Windows 10/11, primary monitor only for v1.
- Keep the code modular: main process (window, tray, menu, settings, idle detection), preload (narrow IPC bridge), renderer (animation player, state machine, hit-testing). Strict error handling; no placeholder code.

## The window

- One transparent, frameless, always-on-top window: `transparent: true`, `frame: false`, `hasShadow: false`, `skipTaskbar: true`, `resizable: false`, `alwaysOnTop: true` (level `'floating'` or higher).
- Width = the primary display's **work area** width; height = clip height × current size scale. Position it so the clip's ground line sits on top of the taskbar (work area bottom). Reposition on `display-metrics-changed` and on taskbar/resolution changes.
- **Click-through everywhere except on Lulu herself.** Use `setIgnoreMouseEvents(true, { forward: true })`, and in the renderer hit-test the cursor against the alpha of the current frame (draw the frame to a small offscreen canvas and read the pixel). When the cursor is over an opaque pixel (alpha > 40), tell main to stop ignoring mouse events; when it leaves, ignore again.

## Rendering

- Preload all 11 clips as `<video muted playsinline preload="auto">` elements.
- Draw the active video to a `<canvas>` each frame at Lulu's x position, flipped with `scale(-1, 1)` when facing left. Drawing to canvas also gives the hit-test pixels. Wake for each frame with a timer aimed just past the frame's due time (from `currentTime`), not `requestVideoFrameCallback` or `requestAnimationFrame`: those tick on every display refresh (240×/s on a 240 Hz screen) and cost about a third of her animation CPU (measured 2026-11-21). The same goes for the turn, the cut-short fade and the ambient loop (ball, bone, snow): timers at 60/30/20 per second, never `requestAnimationFrame` (snow alone cost twice as much on it).
- Only Lulu and her shadow are redrawn every frame. Bed, bowl, ball and treat sit on their own canvases (`#back` behind her, `#front` in front) that are repainted only when they change.
- Switch clips on the `ended` event with zero gap. The next clip should already be loaded and seeked to 0. Loops (`walk_loop`, `sleep_loop`) play with `loop = true` until the state machine changes.
- During a static hold, draw the matching pose PNG.
- Keep hardware acceleration on. Pause the render loop entirely while hidden.
- If VP9 alpha doesn't render on Cody's machine, fall back to PNG frame sequences extracted with `ffmpeg -c:v libvpx-vp9 -i clip.webm frames/%04d.png` (the `-c:v libvpx-vp9` before `-i` is needed to keep the alpha).

## Behaviour (state machine)

Standing is the hub. From `stand` she holds still for 3–8 s, then picks a weighted random action:

- walk 40% — choose a direction (towards the side with more room; turn only while standing), play `walk_start` → `walk_loop` × 2–6 → `walk_stop`. Move x at `walkSpeedPxPerSec` (manifest, 125 px/s at scale 1.0 — multiply by size scale) during `walk_loop`, ramping linearly from 0 during `walk_start` and down to 0 during `walk_stop`. If she would pass the screen edge, end the walk early with `walk_stop`, then turn around. Keep this value easy to tune so her feet don't look like they're sliding.
- look 15%, sniff 15%, sit 12%, stretch 10%
- nap 8% — `lie_down` → `sleep_loop` for 30–120 s → `wake_up`

Avoid playing the same non-walk action twice in a row.

**User idle:** if the user has been idle for more than 5 minutes (`powerMonitor.getSystemIdleTime()`), she goes for a nap and keeps sleeping until the user is back, then `wake_up`.

## Interaction

- **Left-click on Lulu:** play `happy`. If she's asleep, play `wake_up` then `happy`. If she's walking, finish the current walk cycle, then `walk_stop` → `happy`.
- **Drag:** mouse down on her and move more than 5 px → drag her left/right along the taskbar (she stays on the ground). On release she resumes from `stand`.
- **Right-click on Lulu** and the **tray icon** show the same menu:
  - Walk · Sit · Nap · Wake up
  - Size ▸ Small (0.6) · Medium (0.8, default) · Large (1.0)
  - Start with Windows (checkbox — `app.setLoginItemSettings`)
  - Hide for 1 hour · Show Lulu
  - Quit
- Double-clicking the tray icon brings her back to the centre of the screen.

## Settings

Save size, start-with-Windows and last x position to a JSON file in `app.getPath('userData')`. Load on start; fall back to defaults if the file is missing or corrupt.

## Done when

1. `npm start` shows Lulu on the desktop above the taskbar with no box or background around her.
2. Clicks pass through to the desktop and windows everywhere except on her.
3. She cycles through all the behaviours on her own, with no visible jumps between clips, and turns around at the screen edges.
4. Click, drag, right-click menu, tray menu, sizes, hide/show, start-with-Windows and idle-nap all work.
5. CPU stays low while she's idle (check in Task Manager).
6. `npm run dist` produces a working `Lulu Setup.exe` that installs and runs.
