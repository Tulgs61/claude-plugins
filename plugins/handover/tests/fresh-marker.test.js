'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { markerPath, findRoot } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-test-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function hasGitAncestor(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

test('markerPath is stable for one root', () => {
  const root = path.join(base, 'repo-a');
  assert.equal(markerPath(root), markerPath(root));
  assert.equal(markerPath(root), markerPath(root + path.sep), 'trailing separator does not change the key');
});

test('markerPath differs for two roots', () => {
  assert.notEqual(markerPath(path.join(base, 'repo-a')), markerPath(path.join(base, 'repo-b')));
});

test('markerPath lies inside os.tmpdir() and is named claude-fresh-<hash>.json', () => {
  const p = markerPath(path.join(base, 'repo-a'));
  assert.equal(path.dirname(p), os.tmpdir());
  assert.match(path.basename(p), /^claude-fresh-[0-9a-f]{16}\.json$/);
});

test('findRoot finds the git root from a nested directory', () => {
  const repo = path.join(base, 'repo');
  const nested = path.join(repo, 'src', 'deep', 'er');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRoot(nested), repo);
  assert.equal(findRoot(repo), repo);
});

test('findRoot also accepts a .git file (worktrees, submodules)', () => {
  const repo = path.join(base, 'worktree');
  const nested = path.join(repo, 'a');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /somewhere/else\n');
  assert.equal(findRoot(nested), repo);
});

test('findRoot falls back to the directory itself outside a repository', t => {
  const plain = path.join(base, 'plain', 'sub');
  fs.mkdirSync(plain, { recursive: true });
  if (hasGitAncestor(plain)) return t.skip('os.tmpdir() is inside a git repository on this machine');
  assert.equal(findRoot(plain), plain);
});

const { spawnSync } = require('node:child_process');
const { markerTrusted, markerFresh, MARKER_MAX_AGE_MS } = require('../scripts/fresh-marker.js');
const ARM = path.resolve(__dirname, '..', 'scripts', 'fresh-marker.js');
const POSIX = process.platform !== 'win32';

// Stand-in for fs.Stats with just the fields markerTrusted reads.
const stat = (uid, mode, file = true) => ({ uid, mode, isFile: () => file });

test('markerTrusted accepts an own, private regular file', () => {
  assert.equal(markerTrusted(stat(1000, 0o100600), 1000), true);
  assert.equal(markerTrusted(stat(1000, 0o100644), 1000), true);
});

test('markerTrusted rejects a marker owned by another user', () => {
  assert.equal(markerTrusted(stat(1001, 0o100600), 1000), false);
  assert.equal(markerTrusted(stat(0, 0o100600), 1000), false);
});

test('markerTrusted rejects group- or world-writable markers', () => {
  assert.equal(markerTrusted(stat(1000, 0o100620), 1000), false);
  assert.equal(markerTrusted(stat(1000, 0o100602), 1000), false);
  assert.equal(markerTrusted(stat(1000, 0o100666), 1000), false);
});

test('markerTrusted rejects anything that is not a regular file', () => {
  assert.equal(markerTrusted(stat(1000, 0o120777, false), 1000), false);
  assert.equal(markerTrusted(null, 1000), false);
});

test('markerTrusted skips ownership checks when there is no uid (win32)', () => {
  assert.equal(markerTrusted(stat(undefined, 0o100666), null), true);
  assert.equal(markerTrusted(stat(undefined, 0o100666, false), null), false);
});

test('markerFresh accepts only a past createdAt less than 12 hours old', () => {
  const now = 1_800_000_000_000;
  assert.equal(markerFresh(now, now), true);
  assert.equal(markerFresh(now - 60_000, now), true);
  assert.equal(markerFresh(now - MARKER_MAX_AGE_MS, now), false);
  assert.equal(markerFresh(now + 1, now), false, 'future createdAt');
  assert.equal(markerFresh(now + 365 * 24 * 3600 * 1000, now), false, 'far future never expires otherwise');
  for (const bad of [undefined, null, '1', NaN, Infinity, {}]) assert.equal(markerFresh(bad, now), false);
});

// Arms a marker in an isolated temp directory; returns the marker path inside it.
function arm(name) {
  const dir = path.join(base, `arm-${name}`);
  const repo = path.join(dir, 'repo');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const marker = path.join(tmp, path.basename(markerPath(repo)));
  return { repo, tmp, marker, run: () => spawnSync(process.execPath, [ARM, repo], { env, encoding: 'utf8' }) };
}

test('the marker is written with mode 0600 and carries no handover path', () => {
  const { marker, tmp, run } = arm('mode');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  if (POSIX) assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(typeof m.createdAt, 'number');
  assert.equal(m.handover, undefined);
  assert.deepEqual(fs.readdirSync(tmp), [path.basename(marker)], 'no temp file left behind');
});

test('arming does not follow a symlink at the marker path (POSIX)', { skip: !POSIX && 'symlinks need privileges on win32' }, () => {
  const { marker, tmp, run } = arm('symlink');
  const victim = path.join(tmp, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL');
  fs.symlinkSync(victim, marker);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'symlink target unchanged');
  assert.ok(!fs.lstatSync(marker).isSymbolicLink(), 'symlink replaced by a regular file');
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
});
