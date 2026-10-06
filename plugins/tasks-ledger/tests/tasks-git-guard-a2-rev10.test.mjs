// Rev 10, amendments 13, 14 and 17: a guard is created complete, by linking a private file that
// already names its owner; it counts as abandoned only when its owner process is gone or it is older
// than 10 minutes, so a live holder is never broken however slow it is; a guard is released only
// while it carries the releaser's own token; a named takeover never replaces an unreadable lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(10);
  }
}

// Runs the helper, optionally with `node --require <preload>`, and resolves with its answer.
function runAsync(sb, preload, env, ...args) {
  const pre = preload ? ['--require', preload] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...pre, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env } });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0);
        const lines = out.split('\n').filter(Boolean);
        assert.equal(lines.length, 1, out);
        resolve(JSON.parse(lines[0]));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Pauses the helper right after its first read of A2_PAUSE_ON (the lock file, read only inside the
// guard) until A2_RELEASE exists, whether it is read by path or through a file it opened. Before
// pausing it writes A2_SNAP: its pid, the guard's content and how often it wrote straight to the
// guard path. Every rename of the guard path is logged to A2_RENAMES.
const HOLD_PRELOAD = `
const fs = require('node:fs');
const realRead = fs.readFileSync;
const realOpen = fs.openSync;
const realClose = fs.closeSync;
const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
const E = process.env;
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const opened = new Map();
let paused = false;
let directWrites = 0;
fs.openSync = function (file) {
  const fd = realOpen.apply(this, arguments);
  opened.set(fd, String(file));
  return fd;
};
fs.closeSync = function (fd) {
  opened.delete(fd);
  return realClose.apply(this, arguments);
};
fs.writeFileSync = function (file) {
  if (String(file) === E.A2_GUARD) directWrites++;
  return realWrite.apply(this, arguments);
};
fs.readFileSync = function (file) {
  const r = realRead.apply(this, arguments);
  const name = typeof file === 'number' ? opened.get(file) : String(file);
  if (!paused && name === E.A2_PAUSE_ON) {
    paused = true;
    let guard = null;
    try { guard = realRead.call(fs, E.A2_GUARD, 'utf8'); } catch {}
    realWrite.call(fs, E.A2_SNAP, JSON.stringify({ pid: process.pid, guard, directWrites }));
    const end = Date.now() + 60000;
    while (!fs.existsSync(E.A2_RELEASE) && Date.now() < end) wait(10);
  }
  return r;
};
fs.renameSync = function (src) {
  if (String(src) === E.A2_GUARD && E.A2_RENAMES) fs.appendFileSync(E.A2_RENAMES, 'renamed\\n');
  return realRename.apply(this, arguments);
};
`;

function holder(sb) {
  const preload = path.join(sb.tmp, 'hold-preload.cjs');
  writeFileSync(preload, HOLD_PRELOAD);
  const files = {
    snap: path.join(sb.tmp, 'snap.json'),
    release: path.join(sb.tmp, 'release'),
    renames: path.join(sb.tmp, 'renames.log'),
  };
  const env = { A2_GUARD: guardOf(sb), A2_PAUSE_ON: sb.lockFile, A2_SNAP: files.snap, A2_RELEASE: files.release, A2_RENAMES: files.renames };
  return { preload, env, ...files };
}

const ownerGuard = (pid, token) => JSON.stringify({ token, pid, host: hostname(), at: Date.now() }) + '\n';

test('amendment 13: a guard exists only complete, naming its token, owner pid and creation time', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const h = holder(sb);
  const before = Date.now();
  const pending = runAsync(sb, h.preload, h.env, 'prepare', sb.ledgerFile, 'run-one');
  await until(() => existsSync(h.snap), 'the helper to hold the guard');
  const snap = JSON.parse(readFileSync(h.snap, 'utf8'));
  writeFileSync(h.release, '');
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(snap.directWrites, 0, 'the guard is linked from a written file, never written in place');
  const g = JSON.parse(snap.guard);
  assert.equal(typeof g.token, 'string');
  assert.ok(g.token.length > 0);
  assert.equal(g.pid, snap.pid);
  assert.ok(Number.isFinite(g.at) && g.at >= before - 1000 && g.at <= Date.now(), `creation time ${g.at}`);
  assert.equal(existsSync(guardOf(sb)), false, 'the guard is released');
});

test('amendment 14: a fresh guard whose owner process is gone is broken at once', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(guardOf(sb), ownerGuard(gone, 'crashed-owner'));
  const started = Date.now();
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Date.now() - started < 8000, 'prepare did not wait for the guard');
  assert.equal(lockOf(sb).runId, 'run-one');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('amendment 14: a guard whose content cannot be read is broken once it is older than 10 minutes', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(guardOf(sb), ownerGuard(process.pid, 'unreadable'));
  chmodSync(guardOf(sb), 0o000);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(guardOf(sb), old, old);
  const started = Date.now();
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Date.now() - started < 8000, 'prepare did not wait for the guard');
  assert.equal(lockOf(sb).runId, 'run-one');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('amendment 14: a live holder slower than the old abandon time is never broken', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const h = holder(sb);
  const slow = runAsync(sb, h.preload, h.env, 'sync', sb.ledgerFile, 'run-one');
  await until(() => existsSync(h.snap), 'the slow holder to hold the guard');
  const held = JSON.parse(readFileSync(h.snap, 'utf8')).guard;
  assert.ok(held, 'the holder has a guard');

  let waiterDone = false;
  const waiter = runAsync(sb, null, {}, 'sync', sb.ledgerFile, 'run-one').finally(() => (waiterDone = true));
  // Longer than the old 10-second abandon time.
  const end = Date.now() + 12500;
  while (Date.now() < end) {
    assert.equal(readFileSync(guardOf(sb), 'utf8'), held, 'the live holder\'s guard stays in place');
    assert.equal(waiterDone, false, 'the waiter does not get in while the guard is held');
    await delay(20);
  }
  writeFileSync(h.release, '');
  const [a, b] = await Promise.all([slow, waiter]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(existsSync(h.renames), false, 'nobody moved the guard');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('amendment 14: releasing leaves alone a guard that no longer carries the releaser\'s token', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const h = holder(sb);
  const pending = runAsync(sb, h.preload, h.env, 'sync', sb.ledgerFile, 'run-one');
  await until(() => existsSync(h.snap), 'the helper to hold the guard');
  // Another caller's guard replaces it (as if it had been broken in the meantime).
  const other = ownerGuard(process.pid, 'another-caller');
  const tmp = path.join(sb.tmp, 'other-guard');
  writeFileSync(tmp, other);
  renameSync(tmp, guardOf(sb));
  writeFileSync(h.release, '');
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(guardOf(sb), 'utf8'), other, 'the other guard is still in place');
  assert.equal(existsSync(h.renames), false, 'the other guard was never moved');
});

test('amendment 17: a named takeover over an unreadable lock is refused and changes nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, '{"runId": "run-old", "at": ');
  const ledgerBefore = readFileSync(sb.ledgerFile, 'utf8');
  const lockBefore = readFileSync(sb.lockFile, 'utf8');
  const r = sb.run('prepare', 'run-new', 'takeover', 'run-old');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), lockBefore);
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), ledgerBefore);
  assert.equal(existsSync(guardOf(sb)), false);
});

test('amendment 17: a named takeover without any lock file simply takes the lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-new', 'takeover', 'run-old');
  assert.equal(lockOf(sb).runId, 'run-new');
});
