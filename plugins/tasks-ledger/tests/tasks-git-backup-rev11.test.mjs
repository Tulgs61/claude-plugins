// The moved-aside copy of an unreadable lock never outlives a bare takeover, and guard errors name the
// system error code once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const asRoot = process.getuid?.() === 0;
const noChmod = asRoot || process.platform === 'win32';

// Runs the helper, optionally with a preload and extra environment, under a time limit.
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

// The user's own lock with readable-looking content, made unreadable.
function unreadableLock(sb) {
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  const bytes = readFileSync(sb.lockFile);
  const ino = statSync(sb.lockFile).ino;
  chmodSync(sb.lockFile, 0o000);
  return { bytes, ino };
}

const backups = sb => readdirSync(path.dirname(sb.lockFile)).filter(f => f.includes('.lock.replaced-'));

const tmpFiles = sb => readdirSync(path.dirname(sb.lockFile)).filter(f => f.includes('.tmp-'));

const occurrences = (text, word) => text.split(word).length - 1;

// Writing the new lock fails: the temporary file is created, then there is no space left on the device.
const ENOSPC_PRELOAD = `
const fs = require('node:fs');
const real = fs.writeFileSync;
fs.writeFileSync = function (file) {
  if (typeof file === 'string' && file.startsWith(process.env.LOCK_PATH + '.tmp-')) {
    real.call(this, file, '');
    const e = new Error('ENOSPC: no space left on device, open ' + JSON.stringify(file));
    e.code = 'ENOSPC';
    throw e;
  }
  return real.apply(this, arguments);
};
`;

test('a takeover whose lock write fails puts the unreadable lock back and leaves no copy aside', { skip: noChmod }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const { bytes, ino } = unreadableLock(sb);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'enospc-preload.cjs', ENOSPC_PRELOAD);
  const r = runWith(sb, ['prepare', sb.ledgerFile, 'run-new', 'takeover'], { preload, env: { LOCK_PATH: sb.lockFile } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /ENOSPC/);
  assert.deepEqual(tmpFiles(sb), [], 'a failed write leaves no temporary file');
  const st = statSync(sb.lockFile);
  assert.ok(st.isFile(), 'the lock path is a regular file again');
  assert.equal(st.ino, ino, 'it is the original lock file');
  chmodSync(sb.lockFile, 0o600);
  assert.deepEqual(readFileSync(sb.lockFile), bytes);
  assert.deepEqual(backups(sb), []);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

test('a failed takeover whose lock another run replaced meanwhile keeps that lock and leaves no copy aside', { skip: noChmod }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const other = JSON.stringify({ runId: 'run-other', at: Date.now() }) + '\n';
  const otherFile = path.join(sb.tmp, 'other.lock');
  writeFileSync(otherFile, other);
  const L = sb.ledger();
  L.setup = `cp '${otherFile}' '${sb.lockFile}' && exit 4`;
  sb.writeLedger(L);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  unreadableLock(sb);
  const r = sb.run('prepare', 'run-new', 'takeover');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 4/);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), other);
  assert.deepEqual(backups(sb), []);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

test('a failed takeover whose lock path became a symbolic link leaves the link and removes the copy aside', { skip: noChmod }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const target = path.join(sb.tmp, 'link-target');
  writeFileSync(target, 'not a lock\n');
  const L = sb.ledger();
  L.setup = `rm -f '${sb.lockFile}' && ln -s '${target}' '${sb.lockFile}' && exit 4`;
  sb.writeLedger(L);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  unreadableLock(sb);
  const r = sb.run('prepare', 'run-new', 'takeover');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 4/);
  assert.doesNotMatch(r.error, /previous lock is kept/);
  assert.ok(lstatSync(sb.lockFile).isSymbolicLink(), 'the link is left at the lock path');
  assert.equal(readlinkSync(sb.lockFile), target);
  assert.deepEqual(backups(sb), []);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

// The first guard is taken; every later attempt to link a guard fails.
const LATE_NOLINK_PRELOAD = `
const fs = require('node:fs');
const real = fs.linkSync;
let guards = 0;
fs.linkSync = function (from, to) {
  if (String(to).endsWith('.guard') && ++guards > 1) {
    const e = new Error('EPERM: operation not permitted, link');
    e.code = 'EPERM';
    throw e;
  }
  return real.apply(this, arguments);
};
`;

test('a failed takeover that cannot take the guard to restore keeps the copy aside and says where', { skip: noChmod }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const { bytes } = unreadableLock(sb);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'late-nolink-preload.cjs', LATE_NOLINK_PRELOAD);
  const r = runWith(sb, ['prepare', sb.ledgerFile, 'run-new', 'takeover'], { preload });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /cannot create guard/);
  const kept = backups(sb);
  assert.equal(kept.length, 1, `exactly one copy aside: ${kept}`);
  const backup = path.join(path.dirname(sb.lockFile), kept[0]);
  assert.ok(r.error.endsWith(`; the previous lock is kept at ${backup}`), r.error);
  assert.equal(occurrences(r.error, 'the previous lock is kept'), 1, r.error);
  chmodSync(backup, 0o600);
  assert.deepEqual(readFileSync(backup), bytes);
  assert.equal(JSON.parse(readFileSync(sb.lockFile, 'utf8')).runId, 'run-new', 'the lock still holds this call');
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

test('a successful takeover of an unreadable lock leaves no copy aside', { skip: noChmod }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  unreadableLock(sb);
  sb.ok('prepare', 'run-new', 'takeover');
  assert.equal(JSON.parse(readFileSync(sb.lockFile, 'utf8')).runId, 'run-new');
  assert.deepEqual(backups(sb), []);
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

test('a guard error names the system error code once', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const runs = path.dirname(sb.ledgerFile);
  chmodSync(runs, 0o555);
  let r;
  try {
    r = sb.run('status', 'T1', 'blocked');
  } finally {
    chmodSync(runs, 0o755);
  }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /cannot create guard/);
  assert.equal(occurrences(r.error, 'EACCES'), 1, r.error);

  const preload = writePreload(sb, 'nolink-preload.cjs', NOLINK_PRELOAD);
  const l = runWith(sb, ['status', sb.ledgerFile, 'T1', 'blocked'], { preload });
  assert.equal(l.ok, false, JSON.stringify(l));
  assert.match(l.error, /cannot create guard/);
  assert.equal(occurrences(l.error, 'EPERM'), 1, l.error);
});
