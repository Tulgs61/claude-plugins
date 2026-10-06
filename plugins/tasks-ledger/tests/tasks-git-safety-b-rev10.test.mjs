// Rev 10, amendment 12: unsafe ledger paths, a stale lock, which refs prs pushes, the check time
// limit, the owner and file-type checks on the ledger and lock files, and an invalid topic, each
// tested by running the helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const HOUR = 60 * 60 * 1000;
const b = id => `task/${TOPIC}/${id}`;
const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));

// Runs the helper with a time limit, so a call that blocks fails the test instead of hanging it.
function runLimited(sb, args, { preload, ms = 15000 } = {}) {
  const pre = preload ? ['--require', preload] : [];
  const r = spawnSync(process.execPath, [...pre, SCRIPT, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8', timeout: ms });
  assert.equal(r.status, 0, `tasks-git ${args.join(' ')} did not answer within ${ms} ms: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

test('unsafe ledger paths are refused: outside the runs directory, with .., or through a symlink', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const runs = path.dirname(sb.ledgerFile);
  const name = path.basename(sb.ledgerFile);
  const before = readFileSync(sb.ledgerFile);

  const outside = path.join(sb.repo, '.claude', 'other', name);
  mkdirSync(path.dirname(outside));
  copyFileSync(sb.ledgerFile, outside);
  const r1 = sb.runRaw('sync', outside);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /not in <repo>\/\.claude\/runs\//);

  const dotted = `${runs}/../runs/${name}`;
  const r2 = sb.runRaw('sync', dotted);
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.match(r2.error, /\.\./);

  const link = path.join(runs, 'link.json');
  symlinkSync(sb.ledgerFile, link);
  const r3 = sb.runRaw('status', link, 'T1', 'blocked');
  assert.equal(r3.ok, false, JSON.stringify(r3));
  assert.match(r3.error, /symbolic link/);

  const elsewhere = path.join(sb.tmp, 'elsewhere', '.claude');
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(runs, path.join(elsewhere, 'runs'));
  const r4 = sb.runRaw('status', path.join(elsewhere, 'runs', name), 'T1', 'blocked');
  assert.equal(r4.ok, false, JSON.stringify(r4));
  assert.match(r4.error, /symbolic link/);

  assert.deepEqual(readFileSync(sb.ledgerFile), before);
  assert.equal(existsSync(sb.lockFile), false);
});

test('a stale lock is replaced without takeover', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 7 * HOUR }) + '\n');
  const r = sb.run('prepare', 'run-new');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lockOf(sb).runId, 'run-new');

  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - HOUR }) + '\n');
  const live = sb.run('prepare', 'run-newer');
  assert.equal(live.ok, false);
  assert.equal(live.locked, true);
  assert.equal(lockOf(sb).runId, 'run-old');
});

test('prs pushes a merged task\'s -base branch only when the task needs it', t => {
  const sb = sandbox(t, {
    prs: true,
    tasks: [
      task('T1', ['a/**']),
      task('T2', ['b/**']),
      task('T3', ['c/**'], ['T1', 'T2']),
      task('T4', ['d/**'], ['T1']),
      task('T5', ['e/**'], ['T1', 'T2']),
    ],
  });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  sb.complete('T3');
  sb.complete('T4');
  // T5 has its -base branch locally but is only verified, so nothing of it is pushed.
  const w = sb.ok('worktree', 'T5');
  sb.commit(w.worktree, 'e/x.txt', 'x\n');
  sb.ok('status', 'T5', 'verified', 'reviewed');
  assert.equal(sb.tryGit(sb.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b('T5-base')}`), 0);

  sb.ok('prs');
  assert.deepEqual(sb.originHeads(), ['main', b('T1'), b('T2'), b('T3'), b('T3-base'), b('T4')].sort());
  for (const ref of [b('T1'), b('T2'), b('T3'), b('T3-base'), b('T4')]) assert.equal(sb.sha(sb.origin, ref), sb.sha(sb.repo, ref), ref);
  const targets = Object.fromEntries(sb.ledger().tasks.filter(x => x.pr).map(x => [x.id, x.base]));
  assert.deepEqual(targets, { T1: 'main', T2: 'main', T3: b('T3-base'), T4: b('T1') });
});

test('checkTimeoutMin ends a slow setup', t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'echo setup-started; sleep 60', ledgerExtra: { checkTimeoutMin: 0.03 } });
  const started = Date.now();
  const r = runLimited(sb, ['prepare', sb.ledgerFile, 'run-one'], { ms: 30000 });
  assert.ok(Date.now() - started < 20000, `prepare took ${Date.now() - started} ms`);
  assert.equal(r.ok, false);
  assert.match(r.error, /setup .* failed .* exit/);
  assert.match(r.tail, /setup-started/);
  assert.equal(existsSync(sb.lockFile), false);
});

// Makes the helper believe it runs as another user than the one owning the files.
const OTHER_UID_PRELOAD = `
const real = process.getuid;
process.getuid = () => real() + 1;
`;

test('a ledger owned by another user is refused', { skip: typeof process.getuid !== 'function' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = path.join(sb.tmp, 'uid-preload.cjs');
  writeFileSync(preload, OTHER_UID_PRELOAD);
  const before = readFileSync(sb.ledgerFile);
  for (const args of [['sync', sb.ledgerFile], ['prepare', sb.ledgerFile, 'run-one'], ['status', sb.ledgerFile, 'T1', 'blocked']]) {
    const r = runLimited(sb, args, { preload });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /owned by/);
  }
  assert.deepEqual(readFileSync(sb.ledgerFile), before);
  assert.equal(existsSync(sb.lockFile), false);
});

const mkfifo = file => {
  const r = spawnSync('mkfifo', [file]);
  return r.status === 0;
};

test('a ledger that is a FIFO is refused without blocking', { skip: process.platform === 'win32' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  rmSync(sb.ledgerFile);
  assert.ok(mkfifo(sb.ledgerFile), 'mkfifo');
  const r = runLimited(sb, ['sync', sb.ledgerFile]);
  assert.equal(r.ok, false);
  assert.match(r.error, /not a regular file/);
});

test('a lock that is a FIFO is refused without blocking', { skip: process.platform === 'win32' }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  assert.ok(mkfifo(sb.lockFile), 'mkfifo');
  const before = readFileSync(sb.ledgerFile);
  for (const args of [['sync', sb.ledgerFile, 'run-one'], ['prepare', sb.ledgerFile, 'run-one'], ['finish', sb.ledgerFile, 'stopped', '', 'run-one']]) {
    const r = runLimited(sb, args);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /not a regular file/);
  }
  assert.deepEqual(readFileSync(sb.ledgerFile), before);
});

test('a ledger whose topic is invalid fails with an error naming topic', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  for (const topic of ['Bad_Topic', '../x', '-x']) {
    sb.writeLedger({ ...sb.ledger(), topic });
    const before = readFileSync(sb.ledgerFile);
    for (const args of [['prepare', 'run-one'], ['sync'], ['worktree', 'T1']]) {
      const r = sb.run(...args);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.error, /topic/);
    }
    assert.deepEqual(readFileSync(sb.ledgerFile), before);
    assert.equal(existsSync(sb.lockFile), false);
  }
});
