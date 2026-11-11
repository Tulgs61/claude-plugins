// Rev 20: the ledger's `removeWorktreeAfterMerge` removes a merged task's worktree (the branch stays, so a
// dependant still starts from it); a worktree with uncommitted tracked or untracked changes is kept with a
// reason (ignored build output does not count and goes with the worktree), and without the flag nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const b = id => `task/${TOPIC}/${id}`;
const branches = sb => sb.git(sb.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');

test('a merged task loses its worktree and keeps its branch', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**']), task('T2', ['b/**'], ['T1'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  sb.commit(w, '.gitignore', '*.log\n', 'T1: ignore build output');
  writeFileSync(path.join(w, 'build.log'), 'ignored build output\n');
  sb.commit(w, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  const r = sb.ok('merge', 'T1');
  assert.equal(path.normalize(r.worktreeRemoved), path.normalize(w));
  assert.equal(existsSync(w), false);
  assert.ok(branches(sb).includes(b('T1')));
  assert.equal(sb.taskOf('T1').worktree, null);
  assert.equal(sb.taskOf('T1').status, 'merged');
  const w2 = sb.ok('worktree', 'T2');
  assert.ok(existsSync(w2.worktree), 'a dependant still starts from the merged branch');
});

test('a worktree with uncommitted tracked changes is kept', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  sb.commit(w, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  writeFileSync(path.join(w, 'T1.txt'), 'changed after review\n');
  const r = sb.ok('merge', 'T1');
  assert.match(r.worktreeKept, /uncommitted/);
  assert.equal(existsSync(w), true);
});

test('a worktree with an untracked, non-ignored file is kept', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  sb.commit(w, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  writeFileSync(path.join(w, 'notes.txt'), 'untracked work\n');
  const r = sb.ok('merge', 'T1');
  assert.match(r.worktreeKept, /untracked/);
  assert.equal(r.worktreeRemoved, undefined);
  assert.equal(existsSync(path.join(w, 'notes.txt')), true);
  assert.match(sb.taskOf('T1').evidence, /worktree kept: /);
});

test('a locked worktree is refused by git and kept', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  sb.commit(w, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  sb.git(sb.repo, 'worktree', 'lock', w);
  const r = sb.ok('merge', 'T1');
  assert.match(r.worktreeKept, /git worktree remove failed/);
  assert.equal(r.worktreeRemoved, undefined);
  assert.equal(existsSync(w), true);
  assert.equal(sb.taskOf('T1').status, 'merged');
});

test('without the flag the worktree stays', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])] });
  sb.ok('prepare', 'run-one');
  const r = sb.complete('T1');
  assert.equal(r.worktreeRemoved, undefined);
  assert.ok(existsSync(sb.taskOf('T1').worktree));
});

test('a non-boolean flag is refused', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: 'yes' } });
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /removeWorktreeAfterMerge/);
});

test('a worktree on the task branch outside .claude/worktrees is kept', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const made = sb.ok('worktree', 'T1').worktree;
  const outside = path.join(sb.tmp, 'by-hand');
  sb.git(sb.repo, 'worktree', 'move', made, outside);
  sb.commit(outside, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  const r = sb.ok('merge', 'T1');
  assert.equal(r.worktreeKept, 'outside .claude/worktrees');
  assert.equal(r.worktreeRemoved, undefined);
  assert.equal(existsSync(outside), true);
  assert.match(sb.taskOf('T1').evidence, /worktree kept: outside \.claude\/worktrees/);
});

// git cannot delete a file inside a read-only directory: `git worktree remove` deletes what it can and
// the registration, then exits non-zero, leaving a plain folder.
test('a half-failed removal clears the task worktree and reports the leftover', { skip: process.platform === 'win32' }, t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  sb.commit(w, '.gitignore', 'locked/\n', 'T1: ignore locked');
  const dir = path.join(w, 'locked');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'held.txt'), 'ignored\n');
  chmodSync(dir, 0o555);
  t.after(() => { try { chmodSync(dir, 0o755); } catch {} });
  sb.commit(w, 'T1.txt', 'T1\n', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  const r = sb.ok('merge', 'T1');
  assert.equal(path.normalize(r.worktreeLeftover), path.normalize(w));
  assert.equal(path.normalize(r.worktreeRemoved), path.normalize(w));
  assert.equal(sb.taskOf('T1').worktree, null);
  assert.match(sb.taskOf('T1').evidence, /partly removed/);
});
