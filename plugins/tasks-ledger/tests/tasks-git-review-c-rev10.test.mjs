// Rev 10, group C (amendments 27-33): an unreadable lock without takeover, `finish` checking the lock
// path before it writes, checked files read through one open file, no failure after prepare's ledger
// write, accurate guard errors, every untracked merge refusal, and a lock owned by another uid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const asRoot = process.getuid?.() === 0;
const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));

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

test('amendment 27: a plain prepare over a lock that cannot be parsed is refused and leaves it untouched', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, '{"runId": "run-old", "at": ');
  const lockBefore = readFileSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const r = sb.run('prepare', 'run-new');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);

  // A bare takeover replaces it as before.
  sb.ok('prepare', 'run-new', 'takeover');
  assert.equal(lockOf(sb).runId, 'run-new');
});

test('amendment 27: a plain prepare over a lock that cannot be read or is a directory is refused', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  chmodSync(sb.lockFile, 0o000);
  const r = sb.run('prepare', 'run-new');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.equal(statSync(sb.lockFile).mode & 0o777, 0);
  chmodSync(sb.lockFile, 0o600);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);

  rmSync(sb.lockFile);
  mkdirSync(sb.lockFile);
  for (const args of [['prepare', 'run-new'], ['prepare', 'run-new', 'takeover']]) {
    const d = sb.run(...args);
    assert.equal(d.ok, false, JSON.stringify(d));
    assert.match(d.error, /^another run \(/);
    assert.equal(d.locked, true);
    assert.ok(statSync(sb.lockFile).isDirectory());
  }
  rmSync(sb.lockFile, { recursive: true });
});

test('amendment 27: a failed bare takeover puts back the exact bytes of a lock that cannot be parsed', t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'exit 3' });
  // Not valid UTF-8 and not JSON.
  const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x80, 0x0a]);
  writeFileSync(sb.lockFile, bytes);
  const r = sb.run('prepare', 'run-new', 'takeover');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 3/);
  assert.deepEqual(readFileSync(sb.lockFile), bytes);
});

test('amendment 27: a failed bare takeover puts back a lock that cannot be read', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'exit 3' });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  chmodSync(sb.lockFile, 0o000);
  const r = sb.run('prepare', 'run-new', 'takeover');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 3/);
  assert.equal(existsSync(sb.lockFile), true, 'the unreadable lock is back');
  assert.equal(statSync(sb.lockFile).mode & 0o777, 0);
  chmodSync(sb.lockFile, 0o600);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);
  assert.deepEqual(readdirSync(path.dirname(sb.lockFile)).filter(f => f.includes('.lock.')), [], 'no copy is left aside');
});

test('amendment 28: finish refuses a lock path that is no regular file before writing anything', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const ledgerBefore = readFileSync(sb.ledgerFile);

  mkdirSync(sb.lockFile);
  for (const args of [['finish', 'stopped'], ['finish', 'finished', 'done', 'run-one']]) {
    const r = sb.run(...args);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /not a regular file/);
    assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
    assert.ok(statSync(sb.lockFile).isDirectory());
  }
  rmSync(sb.lockFile, { recursive: true });

  const target = path.join(sb.tmp, 'elsewhere.lock');
  writeFileSync(target, JSON.stringify({ runId: 'run-one', at: Date.now() }) + '\n');
  symlinkSync(target, sb.lockFile);
  const r = sb.run('finish', 'stopped');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /symbolic link/);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.ok(lstatSync(sb.lockFile).isSymbolicLink());
  assert.equal(existsSync(target), true);
});

// Right after the first call that checks or opens SWAP_PATH, it is replaced by SWAP_WITH (a symlink
// or a FIFO), as an attacker racing the helper would do.
const SWAP_PRELOAD = `
const fs = require('node:fs');
const E = process.env;
const realRename = fs.renameSync;
let swapped = false;
for (const name of ['lstatSync', 'statSync', 'openSync', 'existsSync']) {
  const real = fs[name];
  fs[name] = function (file) {
    const r = real.apply(this, arguments);
    if (!swapped && String(file) === E.SWAP_PATH) {
      swapped = true;
      realRename.call(fs, E.SWAP_WITH, E.SWAP_PATH);
    }
    return r;
  };
}
`;

test('amendment 29: an inbox swapped for a symlink after its check is not read through the link', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.inboxFile, JSON.stringify({ title: 'REAL', acceptance: 'a' }) + '\n');
  const foreign = path.join(sb.tmp, 'foreign.jsonl');
  writeFileSync(foreign, JSON.stringify({ title: 'FOREIGN', acceptance: 'a' }) + '\n');
  const swap = `${sb.inboxFile}.swap`;
  symlinkSync(foreign, swap);
  const preload = writePreload(sb, 'swap-preload.cjs', SWAP_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile], { preload, env: { SWAP_PATH: sb.inboxFile, SWAP_WITH: swap } });
  assert.equal(existsSync(swap), false, 'the swap happened');
  const titles = sb.ledger().tasks.map(x => x.title);
  assert.ok(!titles.includes('FOREIGN'), `the linked file was ingested: ${JSON.stringify(r)}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(titles, ['task T1', 'REAL']);
});

test('amendment 29: a ledger swapped for a FIFO after its check never blocks the read', { skip: process.platform === 'win32' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const swap = `${sb.ledgerFile}.swap`;
  assert.equal(spawnSync('mkfifo', [swap]).status, 0, 'mkfifo');
  const preload = writePreload(sb, 'swap-preload.cjs', SWAP_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile], { preload, env: { SWAP_PATH: sb.ledgerFile, SWAP_WITH: swap }, ms: 15000 });
  assert.equal(existsSync(swap), false, 'the swap happened');
  if (!r.ok) assert.match(r.error, /not a regular file/);
});

test('amendment 30: prepare checks the fresh ledger before writing it, so nothing fails after the write', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  // While setup runs, someone gives the ledger agents that fail the check.
  const changed = path.join(sb.tmp, 'changed.json');
  writeFileSync(changed, JSON.stringify({ ...sb.ledger(), agents: { implementer: 'not a valid name!' } }, null, 2) + '\n');
  const L = sb.ledger();
  L.setup = `cp '${changed}' '${sb.ledgerFile}'`;
  sb.writeLedger(L);
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /agents/);
  assert.deepEqual(readFileSync(sb.ledgerFile), readFileSync(changed), 'the ledger was not written');
  assert.equal(existsSync(sb.lockFile), false);
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

test('amendment 31: a guard error names hard links only when linking failed, otherwise the system error', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const runs = path.dirname(sb.ledgerFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  chmodSync(runs, 0o555);
  let r;
  try {
    r = sb.run('status', 'T1', 'blocked');
  } finally {
    chmodSync(runs, 0o755);
  }
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /cannot create guard/);
  assert.match(r.error, /EACCES/);
  assert.doesNotMatch(r.error, /hard link/);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);

  const preload = writePreload(sb, 'nolink-preload.cjs', NOLINK_PRELOAD);
  const l = runWith(sb, ['status', sb.ledgerFile, 'T1', 'blocked'], { preload });
  assert.equal(l.ok, false, JSON.stringify(l));
  assert.match(l.error, /cannot create guard/);
  assert.match(l.error, /EPERM/);
  assert.match(l.error, /hard link/);
});

test('amendment 32: a directory that would lose untracked files gives the untracked refusal', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.commit(sb.repo, 'dir/a.txt', 'a\n');
  sb.git(sb.repo, 'push', '-q', 'origin', 'main');
  const { integration } = sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.git(w.worktree, 'rm', '-q', '-r', 'dir');
  sb.commit(w.worktree, 'dir', 'now a file\n', 'T1: dir becomes a file');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  sb.write(integration, 'dir/u.txt', 'untracked\n');
  const head = sb.sha(integration, 'HEAD');
  const before = readFileSync(sb.ledgerFile);

  const r = sb.run('merge', 'T1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'T1: untracked files in the integration worktree block the merge: dir');
  assert.deepEqual(readFileSync(sb.ledgerFile), before);
  assert.equal(sb.sha(integration, 'HEAD'), head);
  assert.equal(sb.git(integration, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(readFileSync(path.join(integration, 'dir', 'u.txt'), 'utf8'), 'untracked\n');
  assert.equal(readFileSync(path.join(integration, 'dir', 'a.txt'), 'utf8'), 'a\n');
});

// Makes the file with inode FOREIGN_INO look as if another user owned it.
const FOREIGN_PRELOAD = `
const fs = require('node:fs');
const ino = Number(process.env.FOREIGN_INO);
for (const name of ['fstatSync', 'lstatSync', 'statSync']) {
  const real = fs[name];
  fs[name] = function () {
    const st = real.apply(this, arguments);
    if (st && Number(st.ino) === ino) st.uid = st.uid + 1;
    return st;
  };
}
`;

test('amendment 33: a lock owned by another uid refuses sync, prepare and finish and keeps the ledger', { skip: typeof process.getuid !== 'function' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-one', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const env = { FOREIGN_INO: String(statSync(sb.lockFile).ino) };
  const preload = writePreload(sb, 'foreign-preload.cjs', FOREIGN_PRELOAD);
  for (const args of [
    ['sync', sb.ledgerFile, 'run-one'],
    ['prepare', sb.ledgerFile, 'run-one'],
    ['prepare', sb.ledgerFile, 'run-two', 'takeover'],
    ['finish', sb.ledgerFile, 'stopped', '', 'run-one'],
    ['finish', sb.ledgerFile, 'stopped'],
  ]) {
    const r = runWith(sb, args, { preload, env });
    assert.equal(r.ok, false, `${args.join(' ')}: ${JSON.stringify(r)}`);
    assert.match(r.error, /owned by/);
    assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
    assert.deepEqual(readFileSync(sb.lockFile), lockBefore);
  }
});
