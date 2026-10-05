'use strict';
// Spec rev 4, amendments 1 (arming without a directory argument) and 4 (markerTrusted with undefined).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { markerPath, markerTrusted, resolvedRoot } = require('../scripts/fresh-marker.js');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const POSIX = process.platform !== 'win32';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev4-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'repo');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  return { dir, repo, tmp, env };
}

test('amendment 1: without a directory argument the marker is armed for the cwd repository', () => {
  const { repo, tmp, env } = sandbox();
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  delete env.PWD;
  const r = spawnSync(process.execPath, [ARM], { cwd: nested, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // process.cwd() resolves symlinks, so compare against the real repository path.
  const marker = path.join(tmp, path.basename(markerPath(resolvedRoot(repo))));
  assert.ok(fs.existsSync(marker), `marker armed at ${marker}`);
});

test('amendment 1: a $PWD naming the cwd keeps its lexical spelling (POSIX)', { skip: !POSIX && 'symlinks need privileges on win32' }, () => {
  const { dir, repo, tmp, env } = sandbox();
  const link = path.join(dir, 'link');
  fs.symlinkSync(repo, link);
  const r = spawnSync(process.execPath, [ARM], { cwd: link, env: { ...env, PWD: link }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Spec rev 10, amendment 6: the success line keeps the shell's spelling, and the single marker sits
  // under the resolved root, where the hook's second lookup finds it.
  assert.match(r.stdout, new RegExp(`^fresh marker armed for ${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`));
  assert.deepEqual(fs.readdirSync(tmp), [path.basename(markerPath(resolvedRoot(repo)))]);
});

test('amendment 1: a $PWD naming another directory is ignored', () => {
  const { repo, tmp, env } = sandbox();
  const other = sandbox().repo;
  const r = spawnSync(process.execPath, [ARM], { cwd: repo, env: { ...env, PWD: other }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(tmp, path.basename(markerPath(resolvedRoot(repo))))));
  assert.ok(!fs.existsSync(path.join(tmp, path.basename(markerPath(other)))));
});

test('amendment 1: the fresh skill runs the marker script without a directory argument', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'fresh', 'SKILL.md'), 'utf8');
  const calls = skill.split('\n').filter(l => l.includes('scripts/fresh-marker.js'));
  assert.ok(calls.length > 0, 'the skill runs the marker script');
  for (const line of calls) {
    assert.match(line.trim(), /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fresh-marker\.js"$/, line);
  }
  assert.match(skill, /session's project\s+directory/);
});

const stat = (uid, mode, file = true) => ({ uid, mode, isFile: () => file });

test('amendment 4: markerTrusted(stat, undefined) behaves like an omitted uid', { skip: !POSIX && 'no uid on win32' }, () => {
  const me = process.getuid();
  const cases = [
    stat(me, 0o100600),
    stat(me, 0o100644),
    stat(me + 1, 0o100600),
    stat(me, 0o100620),
    stat(me, 0o100666),
    stat(me, 0o100600, false),
  ];
  for (const s of cases) assert.equal(markerTrusted(s, undefined), markerTrusted(s), `mode ${s.mode.toString(8)} uid ${s.uid}`);
  assert.equal(markerTrusted(stat(me, 0o100600), undefined), true);
  assert.equal(markerTrusted(stat(me + 1, 0o100600), undefined), false, 'another owner is not trusted');
  assert.equal(markerTrusted(stat(me, 0o100666), undefined), false, 'world-writable is not trusted');
});

test('amendment 4: only an explicit null turns the ownership checks off', () => {
  assert.equal(markerTrusted(stat(12345, 0o100666), null), true);
});
