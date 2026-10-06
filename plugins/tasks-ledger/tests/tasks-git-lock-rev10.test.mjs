// Rev 10, amendments 1-4: only the guard judged abandoned is ever removed; a takeover naming a held
// run replaces only that run's lock; sync without a run id never refreshes the lock; a failed inbox
// move leaves ledger and inbox byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;
const delay = ms => new Promise(r => setTimeout(r, ms));

// Runs the helper with `node --require <preload>` so a test can step into its file operations.
function runAsync(sb, preload, env, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env } });
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

async function until(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(10);
  }
}

// Pauses the helper's first move of the guard aside (after it judged the guard abandoned, before
// the move) until the test removes the marker file. With REV10_OCCUPY, another caller takes the
// guard path right after the move.
const GUARD_PRELOAD = `
const fs = require('node:fs');
const realRename = fs.renameSync;
const guard = process.env.REV10_GUARD;
const marker = process.env.REV10_MARKER;
let paused = false;
fs.renameSync = function (src, dst) {
  if (!paused && src === guard && String(dst).startsWith(guard + '.')) {
    paused = true;
    fs.writeFileSync(marker, '');
    const end = Date.now() + 20000;
    while (fs.existsSync(marker) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const r = realRename.apply(this, arguments);
    if (process.env.REV10_OCCUPY) fs.writeFileSync(guard, 'third-caller', { flag: 'wx' });
    return r;
  }
  return realRename.apply(this, arguments);
};
`;

function crashLeftGuard(sb) {
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(guardOf(sb), JSON.stringify({ token: 'crashed-caller', pid: gone, host: hostname(), at: Date.now() }) + '\n');
  const old = new Date(Date.now() - 60 * 1000);
  utimesSync(guardOf(sb), old, old);
  const preload = path.join(sb.tmp, 'guard-preload.cjs');
  writeFileSync(preload, GUARD_PRELOAD);
  return { preload, marker: path.join(sb.tmp, 'judged') };
}

const runsFiles = sb => readdirSync(path.dirname(sb.lockFile));

test('a crash-left guard re-created in place between being judged and being moved is not deleted', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const { preload, marker } = crashLeftGuard(sb);
  const pending = runAsync(sb, preload, { REV10_GUARD: guardOf(sb), REV10_MARKER: marker }, 'prepare', sb.ledgerFile, 'run-one');
  await until(() => existsSync(marker), 'the helper to judge the guard abandoned');
  // Another caller's guard on the reused inode: same file, new token, fresh time.
  writeFileSync(guardOf(sb), 'other-caller');
  unlinkSync(marker);
  await delay(1000);
  assert.equal(readFileSync(guardOf(sb), 'utf8'), 'other-caller', 'the newer guard is still in place');
  assert.equal(existsSync(sb.lockFile), false, 'the helper waits while the newer guard is held');
  assert.deepEqual(runsFiles(sb).filter(f => f.includes('.guard.')), [], 'nothing is left aside');
  rmSync(guardOf(sb));
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lockOf(sb).runId, 'run-one');
});

test('a re-created guard moved aside is left alone, not deleted, when the guard path is taken again', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const { preload, marker } = crashLeftGuard(sb);
  const env = { REV10_GUARD: guardOf(sb), REV10_MARKER: marker, REV10_OCCUPY: '1' };
  const pending = runAsync(sb, preload, env, 'prepare', sb.ledgerFile, 'run-one');
  await until(() => existsSync(marker), 'the helper to judge the guard abandoned');
  unlinkSync(guardOf(sb));
  writeFileSync(guardOf(sb), 'other-caller');
  unlinkSync(marker);
  await delay(1000);
  assert.equal(readFileSync(guardOf(sb), 'utf8'), 'third-caller');
  const dir = path.dirname(sb.lockFile);
  const kept = runsFiles(sb).filter(f => f.includes('.guard.') && readFileSync(path.join(dir, f), 'utf8') === 'other-caller');
  assert.equal(kept.length, 1, `the moved guard survives: ${runsFiles(sb)}`);
  assert.equal(existsSync(sb.lockFile), false);
  rmSync(guardOf(sb));
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lockOf(sb).runId, 'run-one');
});

test('a takeover naming a run the lock no longer holds is refused and changes nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('prepare', 'run-two', 'takeover');
  const ledgerBefore = readFileSync(sb.ledgerFile, 'utf8');
  const lockBefore = readFileSync(sb.lockFile, 'utf8');
  const r = sb.run('prepare', 'run-three', 'takeover', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /^another run \(run-two/);
  assert.equal(r.locked, true);
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), ledgerBefore);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), lockBefore);
  assert.equal(existsSync(guardOf(sb)), false);
});

test('of two takeovers naming the same held run, one second apart, the second is refused', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  sb.ok('prepare', 'run-a', 'takeover', 'run-old');
  assert.equal(lockOf(sb).runId, 'run-a');
  await delay(1000);
  const lockBefore = readFileSync(sb.lockFile, 'utf8');
  const r = sb.run('prepare', 'run-b', 'takeover', 'run-old');
  assert.equal(r.ok, false);
  assert.match(r.error, /^another run \(run-a/);
  assert.equal(r.locked, true);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), lockBefore);
});

test('sync without a run id leaves the lock time unchanged', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const lock = JSON.stringify({ runId: 'run-one', at: Date.now() - 60 * 1000 }) + '\n';
  writeFileSync(sb.lockFile, lock);
  sb.ok('sync');
  assert.equal(readFileSync(sb.lockFile, 'utf8'), lock);
});

// Makes every move of the inbox aside fail.
const INBOX_PRELOAD = `
const fs = require('node:fs');
const realRename = fs.renameSync;
fs.renameSync = function (src) {
  if (String(src).endsWith('.inbox.jsonl')) {
    const e = new Error('EACCES: permission denied, rename');
    e.code = 'EACCES';
    throw e;
  }
  return realRename.apply(this, arguments);
};
`;

function failingInbox(sb) {
  const preload = path.join(sb.tmp, 'inbox-preload.cjs');
  writeFileSync(preload, INBOX_PRELOAD);
  const lines = [{ title: 'first' }, { id: 'T7', title: 'second' }, { title: 'third' }];
  writeFileSync(sb.inboxFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return preload;
}

const ingestedCopies = sb => runsFiles(sb).filter(f => f.includes('.inbox.jsonl.ingested-'));

test('sync: a failed inbox move leaves ledger and inbox byte-identical; a later sync ingests each line once', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = failingInbox(sb);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const inboxBefore = readFileSync(sb.inboxFile);
  const r = runSync(sb, preload, 'sync', sb.ledgerFile);
  assert.equal(r.ok, false);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
  assert.deepEqual(ingestedCopies(sb), []);

  assert.deepEqual(sb.ok('sync').added, ['T2', 'T7', 'T3']);
  assert.deepEqual(sb.ledger().tasks.map(x => x.id), ['T1', 'T2', 'T7', 'T3']);
  assert.deepEqual(sb.ok('sync').added, []);
});

test('prepare: a failed inbox move leaves ledger and inbox byte-identical and no lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = failingInbox(sb);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const inboxBefore = readFileSync(sb.inboxFile);
  const r = runSync(sb, preload, 'prepare', sb.ledgerFile, 'run-one');
  assert.equal(r.ok, false);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
  assert.equal(existsSync(sb.lockFile), false);

  assert.deepEqual(sb.ok('prepare', 'run-one').added, ['T2', 'T7', 'T3']);
  assert.deepEqual(sb.ledger().tasks.map(x => x.id), ['T1', 'T2', 'T7', 'T3']);
});
