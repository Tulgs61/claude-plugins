// Rev 20: the ledger's `removeWorktreeAfterMerge` removes a merged task's worktree (the branch stays, so a
// dependant still starts from it); a worktree with uncommitted tracked changes is kept with a reason, and
// without the flag nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const b = id => `task/${TOPIC}/${id}`;
const branches = sb => sb.git(sb.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');

test('a merged task loses its worktree and keeps its branch', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**']), task('T2', ['b/**'], ['T1'])], ledgerExtra: { removeWorktreeAfterMerge: true } });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1').worktree;
  writeFileSync(path.join(w, 'build.log'), 'untracked build output\n');
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
