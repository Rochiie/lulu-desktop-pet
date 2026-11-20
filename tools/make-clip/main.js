'use strict';

// Turns a green-screen video of Lulu into a clip she can use:
//   - removes the green background (and the green fringe on her coat) and the
//     generator's watermark in the bottom-right corner
//   - scales and positions her exactly over her standing pose
//   - undoes any slow camera zoom, keeping her feet on her ground line
//   - trims the still frames at both ends
//   - blends the first/last frames into her exact poses so it joins seamlessly
//   - encodes a 532x312, 24 fps, transparent VP9 WebM into assets/
//
// Usage (from the project folder):
//   npm run make-clip -- <video.mp4> <clip_name> [--ends-facing left]
// The video must start on her standing pose facing right, and end on it
// (or on the mirrored pose with --ends-facing left, as for a turn).

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const REFS = path.join(ROOT, 'clip-references');

function parseArgs() {
  // Arguments after this script's path (which Electron may pass as relative).
  const self = process.argv.findIndex((a) => path.resolve(a) === __filename);
  if (self < 0) throw new Error('Could not find this script in the command line');
  const raw = process.argv.slice(self + 1);
  const positional = [];
  let endsFacing = 'right';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '--ends-facing') endsFacing = raw[++i];
    else if (!raw[i].startsWith('--')) positional.push(raw[i]);
  }
  const [video, name] = positional;
  if (!video || !name) throw new Error('Usage: npm run make-clip -- <video.mp4> <clip_name> [--ends-facing left]');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Clip name: lowercase letters, digits and _ only');
  if (!['left', 'right'].includes(endsFacing)) throw new Error('--ends-facing must be left or right');
  if (!fs.existsSync(video)) throw new Error(`Video not found: ${video}`);
  return { video: path.resolve(video), name, endsFacing };
}

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'];
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(winget)) {
    for (const pkg of fs.readdirSync(winget).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of fs.readdirSync(path.join(winget, pkg))) {
        candidates.push(path.join(winget, pkg, build, 'bin', 'ffmpeg.exe'));
      }
    }
  }
  for (const c of candidates.filter(Boolean)) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('ffmpeg not found. Install it (winget install Gyan.FFmpeg) or set FFMPEG.');
}

let job;
let framesDir;
try {
  job = parseArgs();
  framesDir = fs.mkdtempSync(path.join(os.tmpdir(), `lulu-clip-${job.name}-`));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
// Electron's own data goes elsewhere: it stays locked until exit, and the
// frames folder is deleted before then.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-clip-electron-')));

ipcMain.handle('job', () => ({
  video: job.video,
  startRef: path.join(REFS, 'stand_facing_right.png'),
  endRef: path.join(REFS, job.endsFacing === 'left' ? 'stand_facing_left.png' : 'stand_facing_right.png'),
}));
ipcMain.handle('save', (_e, file, dataUrl) => {
  fs.writeFileSync(path.join(framesDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
});
ipcMain.handle('log', (_e, line) => console.log(line));
ipcMain.handle('fail', (_e, message) => {
  console.error(`Failed: ${message}`);
  app.exit(1);
});
ipcMain.handle('done', (_e, report) => {
  try {
    const out = path.join(ROOT, 'assets', `${job.name}.webm`);
    const ffmpeg = findFfmpeg();
    const r = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '24',
      '-i', path.join(framesDir, '%04d.png'),
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30',
      '-row-mt', '1', '-auto-alt-ref', '0', '-deadline', 'good', '-cpu-used', '1',
      '-metadata:s:v:0', 'alpha_mode=1', out,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    const entry = {
      file: `${job.name}.webm`,
      frames: report.frames,
      seconds: Number((report.frames / 24).toFixed(3)),
      startPose: 'stand',
      endPose: 'stand',
      ...(job.endsFacing === 'left' ? { flipsFacing: true } : {}),
      loop: false,
    };
    console.log(`Wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    console.log(`Manifest entry for "${job.name}":`);
    console.log(JSON.stringify(entry, null, 2));
    fs.rmSync(framesDir, { recursive: true, force: true });
    app.exit(0);
  } catch (err) {
    console.error(err.message);
    app.exit(1);
  }
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'page.html'));
});
