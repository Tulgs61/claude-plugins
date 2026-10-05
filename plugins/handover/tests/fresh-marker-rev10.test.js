'use strict';
// Spec rev 10, amendments 1 (the marker lists no roots) and 2 (single link).
// Outcomes are judged by running the hook.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { markerPath, markerTrusted } = require('../scripts/fresh-marker.js');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const SH = { skip: process.platform === 'win32' && 'needs /bin/sh and symlinks' };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev10-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const HANDOVER = '# Handover: rev10\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

let n = 0;
// A repository at <dir>/real/repo, reached through the symlink <dir>/link.
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'real', 'repo');
  const link = path.join(dir, 'link');
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  for (const d of [path.join(repo, '.git'), tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(repo, link);
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { dir, repo, real: fs.realpathSync(repo), link, tmp, env };
}

// Runs the bare marker command from `dir`, PWD set as a shell sets it.
function armInShell(env, dir) {
  return spawnSync('/bin/sh', ['-c', 'cd "$1" && exec "$0" "$2"', process.execPath, dir, ARM], { env, encoding: 'utf8' });
}

// The marker file for `root` inside the sandbox temp directory.
function markerIn(tmp, root) {
  return path.join(tmp, path.basename(markerPath(root)));
}

function writeMarker(tmp, root, data) {
  const p = markerIn(tmp, root);
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

function hook(env, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// --- Amendment 1: the marker lists no roots ---

test('amendment 1: armed from the symlinked directory, the marker holds only createdAt', SH, () => {
  const { real, link, tmp, env } = sandbox();
  const r = armInShell(env, link);
  assert.equal(r.status, 0, r.stderr);
  // Spec rev 10, amendment 6: only the marker under the resolved root is written.
  const p = markerIn(tmp, real);
  assert.ok(fs.lstatSync(p).isFile(), `a marker under ${real}`);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(Object.keys(data), ['createdAt']);
  assert.equal(typeof data.createdAt, 'number');
});

test('amendment 1: a roots key naming a third spelling of the same root is ignored, its marker is kept', SH, () => {
  const { dir, repo, link, tmp, env } = sandbox();
  const third = path.join(dir, 'third');
  fs.symlinkSync(repo, third);
  writeMarker(tmp, link, { createdAt: Date.now(), roots: [link, third] });
  const thirdMarker = writeMarker(tmp, third, { createdAt: Date.now() });
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(fs.existsSync(thirdMarker), 'only the two candidate paths the hook works out are touched');
});

test('amendment 1: a roots key never makes a marker under a listed spelling count', SH, () => {
  const { dir, repo, real, link, tmp, env } = sandbox();
  const third = path.join(dir, 'third');
  fs.symlinkSync(repo, third);
  // A fresh marker exists only under the third spelling; the candidates name nothing.
  writeMarker(tmp, third, { createdAt: Date.now(), roots: [link, real, third] });
  assert.doesNotMatch(hook(env, link), /Continuing from/);
});

test('amendment 1: the other candidate is removed only when it passes the trust check', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, () => {
  const { real, link, tmp, env } = sandbox();
  writeMarker(tmp, link, { createdAt: Date.now() });
  const other = writeMarker(tmp, real, { createdAt: Date.now() });
  fs.chmodSync(other, 0o666);
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(fs.existsSync(other), 'an untrusted marker at the other candidate path is left alone');
});

test('amendment 1: armed from the symlinked directory and resumed through it, nothing is left', SH, () => {
  const { real, link, tmp, env } = sandbox();
  const r = armInShell(env, link);
  assert.equal(r.status, 0, r.stderr);
  assert.match(hook(env, link), /Continuing from /);
  assert.deepEqual(fs.readdirSync(tmp), []);
  for (const cwd of [link, real]) assert.doesNotMatch(hook(env, cwd), /Continuing from/, cwd);
});

// --- Amendment 2: single link ---

test('amendment 2: markerTrusted rejects a stat with nlink 2, also with the ownership checks off', () => {
  const stat = { uid: 501, mode: 0o100600, nlink: 2, isFile: () => true };
  assert.equal(markerTrusted(stat, 501), false);
  assert.equal(markerTrusted(stat, null), false);
});

test('amendment 2: markerTrusted accepts nlink 1 and a stat without a numeric nlink', () => {
  assert.equal(markerTrusted({ uid: 501, mode: 0o100600, nlink: 1, isFile: () => true }, 501), true);
  assert.equal(markerTrusted({ uid: 501, mode: 0o100600, isFile: () => true }, 501), true);
  assert.equal(markerTrusted({ uid: 501, mode: 0o100600, nlink: '2', isFile: () => true }, 501), true);
});

test('amendment 2: a marker with a second hard link at the other candidate path is not removed', SH, () => {
  const { dir, real, link, tmp, env } = sandbox();
  writeMarker(tmp, link, { createdAt: Date.now() });
  const other = writeMarker(tmp, real, { createdAt: Date.now() });
  fs.linkSync(other, path.join(dir, 'hard-link'));
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(fs.existsSync(other), 'a hard-linked marker is not trusted, so it is not removed');
});

// The amendment 4 tests (alias copy failure) are replaced by the single-copy test of amendment 6 in
// fresh-marker-single-copy-rev10.test.js: there is no alias copy any more.
