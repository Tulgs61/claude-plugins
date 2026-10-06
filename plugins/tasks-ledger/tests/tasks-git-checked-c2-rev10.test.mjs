// Rev 10, group C (amendments 34-36): an unopenable checked file is still owner-checked, the moved
// inbox is read safely, and `finish` with a run id over a lock that cannot be read or parsed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const asRoot = process.getuid?.() === 0;

// Runs the helper, optionally with a preload and extra environment, under a time limit, so a call
// that blocks fails the test instead of hanging it.
function runWith(sb, args, { preload, env = {}, ms = 30000 } = {}) {
  const pre = preload ? ['--require', preload] : [];
  const r = spawnSync(process.execPath, [...pre, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: ms });
  assert.equal(r.status, 0, `tasks-git ${args.join(' ')} did not answer within ${ms} ms: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

const writePreload = (sb, name, source) => {
  const file = path.join(sb.tmp, name);
  writeFileSync(file, source);
  return file;
};

// FOREIGN_PATH looks as if another user owned it, and opening it fails with a permission error.
const FOREIGN_DENIED_PRELOAD = `
const fs = require('node:fs');
const target = process.env.FOREIGN_PATH;
const ino = Number(fs.lstatSync(target).ino);
for (const name of ['fstatSync', 'lstatSync', 'statSync']) {
  const real = fs[name];
  fs[name] = function () {
    const st = real.apply(this, arguments);
    if (st && Number(st.ino) === ino) st.uid = st.uid + 1;
    return st;
  };
}
const realOpen = fs.openSync;
fs.openSync = function (file) {
  if (String(file) === target) {
    const e = new Error('EACCES: permission denied, open ' + file);
    e.code = 'EACCES';
    throw e;
  }
  return realOpen.apply(this, arguments);
};
`;

test('amendment 34: a foreign lock that cannot be opened is refused as unsafe and never replaced', { skip: typeof process.getuid !== 'function' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-one', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  const inoBefore = statSync(sb.lockFile).ino;
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'foreign-denied-preload.cjs', FOREIGN_DENIED_PRELOAD);
  for (const args of [
    ['prepare', sb.ledgerFile, 'run-two'],
    ['prepare', sb.ledgerFile, 'run-two', 'takeover'],
    ['sync', sb.ledgerFile, 'run-one'],
    ['finish', sb.ledgerFile, 'stopped', '', 'run-one'],
  ]) {
    const r = runWith(sb, args, { preload, env: { FOREIGN_PATH: sb.lockFile } });
    assert.equal(r.ok, false, `${args.join(' ')}: ${JSON.stringify(r)}`);
    assert.match(r.error, /owned by/, args.join(' '));
    assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore, args.join(' '));
    assert.deepEqual(readFileSync(sb.lockFile), lockBefore, args.join(' '));
    assert.equal(statSync(sb.lockFile).ino, inoBefore, `${args.join(' ')}: the lock was moved`);
  }
});

test('amendment 34: a foreign inbox that cannot be opened is refused as unsafe and not moved', { skip: typeof process.getuid !== 'function' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.inboxFile, JSON.stringify({ title: 'X', acceptance: 'a' }) + '\n');
  const inboxBefore = readFileSync(sb.inboxFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'foreign-denied-preload.cjs', FOREIGN_DENIED_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile, 'run-one'], { preload, env: { FOREIGN_PATH: sb.inboxFile } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /owned by/);
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

test('amendment 34: a lock directory that cannot be opened is not replaced by a bare takeover', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  mkdirSync(sb.lockFile);
  chmodSync(sb.lockFile, 0o000);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  let r;
  try {
    r = sb.run('prepare', 'run-new', 'takeover');
  } finally {
    if (existsSync(sb.lockFile)) chmodSync(sb.lockFile, 0o755);
  }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /not a regular file/);
  assert.equal(r.locked, true);
  assert.ok(statSync(sb.lockFile).isDirectory(), 'the directory is still the lock path');
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  rmSync(sb.lockFile, { recursive: true });
});

// Right after the first open of SWAP_PATH (the inbox read), SWAP_WITH is renamed over it, so the
// file the helper then moves aside is not the one it read.
const SWAP_PRELOAD = `
const fs = require('node:fs');
const E = process.env;
const realRename = fs.renameSync;
const realOpen = fs.openSync;
let swapped = false;
fs.openSync = function (file) {
  const r = realOpen.apply(this, arguments);
  if (!swapped && String(file) === E.SWAP_PATH) {
    swapped = true;
    realRename.call(fs, E.SWAP_WITH, E.SWAP_PATH);
  }
  return r;
};
`;

test('amendment 35: an inbox swapped for a FIFO between the read and the move does not block', { skip: process.platform === 'win32' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.inboxFile, JSON.stringify({ title: 'REAL', acceptance: 'a' }) + '\n');
  const swap = `${sb.inboxFile}.swap`;
  assert.equal(spawnSync('mkfifo', [swap]).status, 0, 'mkfifo');
  const preload = writePreload(sb, 'swap-preload.cjs', SWAP_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile], { preload, env: { SWAP_PATH: sb.inboxFile, SWAP_WITH: swap }, ms: 15000 });
  assert.equal(existsSync(swap), false, 'the swap happened');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sb.ledger().tasks.map(x => x.title), ['task T1', 'REAL']);
  assert.ok(Array.isArray(r.warnings) && r.warnings.some(w => /not the file that was read/.test(w)), JSON.stringify(r));
});

test('amendment 35: lines of a different file swapped in before the move are not carried over', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const line = JSON.stringify({ title: 'REAL', acceptance: 'a' }) + '\n';
  writeFileSync(sb.inboxFile, line);
  const swap = `${sb.inboxFile}.swap`;
  writeFileSync(swap, line + JSON.stringify({ title: 'SMUGGLED', acceptance: 'a' }) + '\n');
  const preload = writePreload(sb, 'swap-preload.cjs', SWAP_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile], { preload, env: { SWAP_PATH: sb.inboxFile, SWAP_WITH: swap } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(sb.inboxFile), false, 'nothing was carried into a fresh inbox');
  assert.ok(r.warnings.some(w => /not the file that was read/.test(w)), JSON.stringify(r));
  assert.deepEqual(sb.ledger().tasks.map(x => x.title), ['task T1', 'REAL']);
});

// Opening DENIED_PATH fails with a permission error; its owner stays this user.
const DENIED_PRELOAD = `
const fs = require('node:fs');
const realOpen = fs.openSync;
fs.openSync = function (file) {
  if (String(file) === process.env.DENIED_PATH) {
    const e = new Error('EACCES: permission denied, open ' + file);
    e.code = 'EACCES';
    throw e;
  }
  return realOpen.apply(this, arguments);
};
`;

// A lock that is read but cannot be parsed keeps the behaviour that tasks-git-lock-rev7.test.mjs pins
// ("finish with a run id leaves an unreadable lock in place"); amendment 36 is applied to locks
// that cannot be read.
test('amendment 36: finish with a run id over an own lock whose open is denied fails before any write', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-one', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'denied-preload.cjs', DENIED_PRELOAD);
  const r = runWith(sb, ['finish', sb.ledgerFile, 'stopped', 'x', 'run-one'], { preload, env: { DENIED_PATH: sb.lockFile } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);
});

test('amendment 36: finish with a run id over an own lock that cannot be read fails before any write', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-one', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  chmodSync(sb.lockFile, 0o000);
  let r;
  try {
    r = sb.run('finish', 'stopped', 'x', 'run-one');
  } finally {
    chmodSync(sb.lockFile, 0o600);
  }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);

  // Without a run id, finish still removes it as before.
  chmodSync(sb.lockFile, 0o000);
  sb.ok('finish', 'stopped');
  assert.equal(existsSync(sb.lockFile), false);
});
