// Rev 10, amendments 20, 22 and 25: a guard that names no owner, or cannot be read, is abandoned only
// by the 10-minute age, judged from the creation time the guard names; a guard naming another host
// is judged by age only; releasing removes only a guard carrying the releaser's own token; waiting
// removes private guard files of dead owners; without hard links the error says `cannot create guard`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const MIN = 60 * 1000;
const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;
const delay = ms => new Promise(r => setTimeout(r, ms));
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const ownerGuard = (pid, token, extra = {}) => JSON.stringify({ token, pid, host: hostname(), at: Date.now(), ...extra }) + '\n';
const age = (file, ms) => {
  const old = new Date(Date.now() - ms);
  utimesSync(file, old, old);
};

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

function runSync(sb, preload, ...args) {
  const r = spawnSync(process.execPath, ['--require', preload, SCRIPT, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

// Starts a prepare while the guard is in place and asserts it is still waiting after `ms`: no lock
// is written and the guard is untouched. Then removes the guard and returns the answer.
async function assertWaits(sb, ms = 1500) {
  const before = readFileSync(guardOf(sb));
  let done = false;
  const pending = runAsync(sb, null, {}, 'prepare', sb.ledgerFile, 'run-one').finally(() => (done = true));
  await delay(ms);
  assert.equal(done, false, 'prepare waits for the guard');
  assert.equal(existsSync(sb.lockFile), false, 'no lock is written while the guard is held');
  assert.deepEqual(readFileSync(guardOf(sb)), before, 'the guard is not broken');
  rmSync(guardOf(sb), { force: true });
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('amendment 20: an unreadable guard younger than 10 minutes is not broken, nor one that names no owner', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(guardOf(sb), 'crashed-caller');
  age(guardOf(sb), 60 * 1000);
  await assertWaits(sb);
  sb.ok('finish', 'stopped');

  if (process.getuid?.() === 0) return;
  writeFileSync(guardOf(sb), ownerGuard(deadPid(), 'unreadable'));
  age(guardOf(sb), 60 * 1000);
  chmodSync(guardOf(sb), 0o000);
  let done = false;
  const pending = runAsync(sb, null, {}, 'prepare', sb.ledgerFile, 'run-one').finally(() => (done = true));
  await delay(1500);
  assert.equal(done, false, 'prepare waits for the unreadable guard');
  assert.equal(existsSync(guardOf(sb)), true);
  assert.equal(existsSync(sb.lockFile), false);
  rmSync(guardOf(sb), { force: true });
  assert.equal((await pending).ok, true);
});

test('amendment 20: a readable guard that names no owner is broken once older than 10 minutes', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(guardOf(sb), 'crashed-caller');
  age(guardOf(sb), 11 * MIN);
  const started = Date.now();
  sb.ok('prepare', 'run-one');
  assert.ok(Date.now() - started < 8000, 'prepare did not wait for the guard');
  assert.equal(lockOf(sb).runId, 'run-one');
});

test('amendment 20: a guard whose owner is alive but which is older than 10 minutes is broken', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  // The test process is alive; the guard names a creation time 11 minutes ago.
  writeFileSync(guardOf(sb), ownerGuard(process.pid, 'old-but-alive', { at: Date.now() - 11 * MIN }));
  const started = Date.now();
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Date.now() - started < 8000, 'prepare did not wait for the guard');
  assert.equal(lockOf(sb).runId, 'run-one');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('amendment 20: a guard naming another host is judged by age only', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const pid = deadPid();
  // Without a token, and with one: a process id of another host says nothing about this machine.
  writeFileSync(guardOf(sb), JSON.stringify({ pid, host: 'another-host.example' }) + '\n');
  age(guardOf(sb), 60 * 1000);
  await assertWaits(sb);
  sb.ok('finish', 'stopped');
  writeFileSync(guardOf(sb), ownerGuard(pid, 'remote', { host: 'another-host.example' }));
  age(guardOf(sb), 60 * 1000);
  await assertWaits(sb);

  writeFileSync(guardOf(sb), ownerGuard(pid, 'remote', { host: 'another-host.example', at: Date.now() - 11 * MIN }));
  age(guardOf(sb), 11 * MIN);
  sb.ok('prepare', 'run-two', 'takeover');
  assert.equal(lockOf(sb).runId, 'run-two');
});

// Right after the helper first opens or reads its own guard (that is, on release), another
// caller's guard replaces it, as if the holder had been broken in between.
const SWAP_PRELOAD = `
const fs = require('node:fs');
const realRead = fs.readFileSync;
const realOpen = fs.openSync;
const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
const E = process.env;
let swapped = false;
function maybeSwap() {
  if (swapped) return;
  let own = false;
  try { own = JSON.parse(realRead.call(fs, E.A3_GUARD, 'utf8')).pid === process.pid; } catch {}
  if (!own) return;
  swapped = true;
  realWrite.call(fs, E.A3_GUARD + '.swap', E.A3_OTHER);
  realRename.call(fs, E.A3_GUARD + '.swap', E.A3_GUARD);
}
fs.openSync = function (file) {
  const r = realOpen.apply(this, arguments);
  if (String(file) === E.A3_GUARD) maybeSwap();
  return r;
};
fs.readFileSync = function (file) {
  const r = realRead.apply(this, arguments);
  if (String(file) === E.A3_GUARD) maybeSwap();
  return r;
};
`;

test('amendment 22: releasing never removes a guard that replaced the releaser\'s own', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const preload = path.join(sb.tmp, 'swap-preload.cjs');
  writeFileSync(preload, SWAP_PRELOAD);
  const other = ownerGuard(process.pid, 'another-caller');
  const r = spawnSync(process.execPath, ['--require', preload, SCRIPT, 'sync', sb.ledgerFile, 'run-one'], {
    cwd: sb.repo,
    env: { ...sb.env, A3_GUARD: guardOf(sb), A3_OTHER: other },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
  assert.equal(existsSync(guardOf(sb)), true, 'the other caller\'s guard is still there');
  assert.equal(readFileSync(guardOf(sb), 'utf8'), other);
});

test('amendment 25: waiting for a guard removes private guard files of dead owners and keeps live ones', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const gone = deadPid();
  const dir = path.dirname(sb.lockFile);
  const deadFile = `${guardOf(sb)}-new-${gone}-1-dead`;
  const liveFile = `${guardOf(sb)}-new-${process.pid}-1-live`;
  const oldFile = `${guardOf(sb)}-new-${process.pid}-1-old`;
  writeFileSync(deadFile, ownerGuard(gone, `${gone}-1-dead`));
  writeFileSync(liveFile, ownerGuard(process.pid, `${process.pid}-1-live`));
  writeFileSync(oldFile, ownerGuard(process.pid, `${process.pid}-1-old`, { at: Date.now() - 11 * MIN }));
  age(oldFile, 11 * MIN);
  // A crash-left guard of a dead owner makes the helper wait and break it.
  writeFileSync(guardOf(sb), ownerGuard(gone, `${gone}-1-dead`));
  sb.ok('prepare', 'run-one');
  const left = readdirSync(dir).filter(f => f.includes('.guard-new-'));
  assert.deepEqual(left, [path.basename(liveFile)], `leftovers: ${left}`);
});

// Hard links are not supported on this file system.
const NOLINK_PRELOAD = `
const fs = require('node:fs');
fs.linkSync = function () {
  const e = new Error('EPERM: operation not permitted, link');
  e.code = 'EPERM';
  throw e;
};
`;

test('amendment 25: without hard links guarded commands fail with cannot create guard', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = path.join(sb.tmp, 'nolink-preload.cjs');
  writeFileSync(preload, NOLINK_PRELOAD);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  for (const args of [['sync', sb.ledgerFile], ['prepare', sb.ledgerFile, 'run-one'], ['status', sb.ledgerFile, 'T1', 'blocked']]) {
    const r = runSync(sb, preload, ...args);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /cannot create guard/);
    assert.doesNotMatch(r.error, /unexpected/);
  }
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.equal(existsSync(sb.lockFile), false);
  assert.deepEqual(readdirSync(path.dirname(sb.lockFile)).filter(f => f.includes('.guard')), []);
});
