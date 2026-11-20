'use strict';

// Publishes the version in package.json to GitHub Releases, where installed
// copies of Lulu pick it up as an update.
//
//   1. Bump "version" in package.json and commit.
//   2. npm run release
//
// It runs the tests, tags the commit (v<version>), pushes main and the tag,
// creates a hidden draft release, builds and uploads the installer, latest.yml
// and blockmap into it, checks all three arrived, then makes it public.
// If it stops part-way, fix the problem and run it again: it carries on from
// the draft.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { version } = require('../package.json');
const tag = `v${version}`;
const BLOCKMAP = 'Lulu-Setup.exe.blockmap';

function findGh() {
  const candidates = ['gh', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('GitHub CLI (gh) not found. Install it and run "gh auth login".');
}

function out(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (exit ${r.status})`);
}

// The release for this tag, or null if there is none yet.
function releaseInfo(gh) {
  const r = spawnSync(gh, ['release', 'view', tag, '--json', 'assets,isDraft'], { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

// Release notes: one line per commit since the previous release's tag.
function releaseNotes() {
  const prev = spawnSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' });
  const range = prev.status === 0 ? `${prev.stdout.trim()}..HEAD` : 'HEAD';
  return out('git', ['log', range, '--format=- %s']) || `Lulu ${version}`;
}

// Uploads a file from dist/ under the asset name the updater expects.
function uploadAs(gh, source, name) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-release-'));
  const file = path.join(dir, name);
  fs.copyFileSync(path.join(ROOT, 'dist', source), file);
  run(gh, ['release', 'upload', tag, file, '--clobber']);
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  if (out('git', ['status', '--porcelain'])) throw new Error('Commit your changes first.');
  const branch = out('git', ['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Release from main (you are on ${branch}).`);

  const gh = findGh();
  const token = process.env.GH_TOKEN || out(gh, ['auth', 'token']);
  const existing = releaseInfo(gh);
  if (existing && !existing.isDraft) {
    throw new Error(`${tag} is already released. Bump "version" in package.json first.`);
  }
  const remoteTag = out('git', ['ls-remote', '--tags', 'origin', tag]);
  if (remoteTag && !remoteTag.startsWith(out('git', ['rev-parse', 'HEAD']))) {
    throw new Error(`${tag} already exists on GitHub for a different commit.`);
  }

  console.log(`\nTesting ${tag}…`);
  run(process.execPath, ['--test', 'test/*.test.js']);

  console.log(`\nTagging and pushing ${tag}…`);
  if (!out('git', ['tag', '--list', tag])) run('git', ['tag', tag]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  // Create the release ourselves, as a hidden draft. electron-builder's
  // parallel uploads otherwise race to create it and one of them fails.
  // While it is a draft, no installed Lulu can see a half-uploaded release.
  if (!existing) {
    run(gh, ['release', 'create', tag, '--draft', '--verify-tag', '--title', `Lulu ${version}`, '--notes', releaseNotes()]);
  }

  console.log(`\nBuilding and uploading ${tag}…`);
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  const cli = require.resolve('electron-builder/cli.js');
  run(process.execPath, [cli, '--win', 'nsis', '--publish', 'always'], {
    env: { ...process.env, GH_TOKEN: token },
  });

  // Fill in anything that did not arrive.
  let release = releaseInfo(gh);
  const has = (name) => release.assets.some((a) => a.name === name);
  if (!has('latest.yml')) uploadAs(gh, 'latest.yml', 'latest.yml');
  if (!has(BLOCKMAP)) uploadAs(gh, 'Lulu Setup.exe.blockmap', BLOCKMAP);
  release = releaseInfo(gh);
  for (const needed of ['latest.yml', 'Lulu-Setup.exe', BLOCKMAP]) {
    if (!has(needed)) throw new Error(`Release ${tag} is missing ${needed}; it is still a hidden draft.`);
  }

  console.log(`\nPublishing ${tag}…`);
  run(gh, ['release', 'edit', tag, '--draft=false', '--latest']);
  release = releaseInfo(gh);
  if (release.isDraft) throw new Error(`Release ${tag} is still a draft`);
  console.log(`\nReleased ${tag}: ${release.assets.map((a) => a.name).join(', ')}`);
}

try {
  main();
} catch (err) {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
}
