'use strict';

// Publishes the version in package.json to GitHub Releases, where installed
// copies of Lulu pick it up as an update.
//
//   1. Bump "version" in package.json and commit.
//   2. npm run release
//
// It runs the tests, tags the commit (v<version>), pushes main and the tag,
// then builds the installer and uploads it with latest.yml. The tag is pushed
// first so the parallel uploads never race to create it.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { version } = require('../package.json');
const tag = `v${version}`;

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

function main() {
  if (out('git', ['status', '--porcelain'])) throw new Error('Commit your changes first.');
  const branch = out('git', ['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Release from main (you are on ${branch}).`);
  if (out('git', ['ls-remote', '--tags', 'origin', tag])) {
    throw new Error(`${tag} is already released. Bump "version" in package.json first.`);
  }

  const gh = findGh();
  const token = process.env.GH_TOKEN || out(gh, ['auth', 'token']);

  console.log(`\nTesting ${tag}…`);
  run(process.execPath, ['--test', 'test/*.test.js']);

  console.log(`\nTagging and pushing ${tag}…`);
  if (!out('git', ['tag', '--list', tag])) run('git', ['tag', tag]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  console.log(`\nBuilding and uploading ${tag}…`);
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  const cli = require.resolve('electron-builder/cli.js');
  run(process.execPath, [cli, '--win', 'nsis', '--publish', 'always'], {
    env: { ...process.env, GH_TOKEN: token },
  });

  const assets = JSON.parse(out(gh, ['release', 'view', tag, '--json', 'assets,isDraft'])) ;
  const names = assets.assets.map((a) => a.name);
  for (const needed of ['latest.yml', 'Lulu-Setup.exe']) {
    if (!names.includes(needed)) throw new Error(`Release ${tag} is missing ${needed}`);
  }
  if (assets.isDraft) throw new Error(`Release ${tag} is still a draft`);
  console.log(`\nReleased ${tag}: ${names.join(', ')}`);
}

try {
  main();
} catch (err) {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
}
