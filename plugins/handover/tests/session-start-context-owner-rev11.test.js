'use strict';
// A marker owned by someone other than the current user is neither honoured nor deleted by the
// SessionStart hook. Without root no second owner can be created, so the hook runs under a preload
// that makes process.getuid() report a chosen uid ($FAKE_UID); the hook checks ownership through it.
// Every spawn gets an isolated HOME and TMPDIR, as in session-start-context.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const { markerPath } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-hook-owner-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

// Replaces process.getuid, defining it even where the platform has none.
const PRELOAD = path.join(base, 'fake-uid.js');
fs.writeFileSync(PRELOAD, `'use strict';
const uid = Number(process.env.FAKE_UID);
process.getuid = function getuid() { return uid; };
`);

let n = 0;
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  for (const d of [path.join(repo, '.git'), home, tmp]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const marker = path.join(tmp, path.basename(markerPath(repo)));
  return { repo, env, marker };
}

function runHook(env, fakeUid, input) {
  const r = spawnSync(process.execPath, ['--require', PRELOAD, HOOK], {
    input: JSON.stringify(input), env: { ...env, FAKE_UID: String(fakeUid) }, encoding: 'utf8', timeout: 10000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function context(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  return out.hookSpecificOutput.additionalContext;
}

// Writes HANDOVER.md and a fresh, valid marker for the repository; returns the marker's owner uid.
function prepare({ repo, marker }) {
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), '# H\n\n## Next action\nNEXT\n');
  fs.writeFileSync(marker, JSON.stringify({ createdAt: Date.now() }), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(marker, 0o600);
  return fs.statSync(marker).uid;
}

test('a marker owned by another user is not honoured and is left in place, without root', () => {
  const box = sandbox();
  const owner = prepare(box);
  const before = fs.readFileSync(box.marker);
  const r = runHook(box.env, owner + 1, { source: 'clear', cwd: box.repo });
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r.stdout);
  assert.doesNotMatch(ctx, /Continuing from/);
  assert.match(ctx, /\/pickup/, 'falls back to startup behaviour');
  assert.ok(fs.existsSync(box.marker), 'another user\'s marker is not deleted');
  assert.deepEqual(fs.readFileSync(box.marker), before, 'another user\'s marker is unchanged');
});

test('a marker owned by the reported user is honoured and deleted under the same preload', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const box = sandbox();
  const owner = prepare(box);
  const r = runHook(box.env, owner, { source: 'clear', cwd: box.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r.stdout), /Continuing from/);
  assert.ok(!fs.existsSync(box.marker), 'the honoured marker is deleted');
});
