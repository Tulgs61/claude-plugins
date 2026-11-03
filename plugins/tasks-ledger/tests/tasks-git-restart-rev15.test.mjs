// tasks-git.js support for restarted tasks: `worktree` reports what the branch already has, `status
// blocked ... reviewed` records the head a review judged, and `merge` undoes a merge a killed call left
// half done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

test('worktree: a rerun reports the commits beyond the base and the branch head', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.commit(w.worktree, 'b.txt', 'b\n');
  const again = sb.ok('worktree', 'T1');
  assert.equal(again.commits, 2);
  assert.equal(again.head, sb.sha(w.worktree, 'HEAD'));
  assert.equal(again.reviewedHead, null);
});

test('status blocked with reviewed records the judged head, which worktree reports back', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  const judged = sb.sha(w.worktree, 'HEAD');
  sb.ok('status', 'T1', 'blocked', 'review rejected: x', 'reviewed');
  assert.equal(sb.taskOf('T1').reviewedHead, judged);
  sb.ok('status', 'T1', 'todo', 'retry');
  assert.equal(sb.ok('worktree', 'T1').reviewedHead, judged, 'a reset to todo keeps the judged head');

  // A later commit makes the head differ from the judged one.
  sb.commit(w.worktree, 'b.txt', 'b\n');
  const again = sb.ok('worktree', 'T1');
  assert.notEqual(again.head, again.reviewedHead);
});

test('status refuses the reviewed flag except with blocked, and a blocked status without it records nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('worktree', 'T1');
  assert.match(sb.run('status', 'T1', 'todo', 'x', 'reviewed').error, /only blocked takes reviewed/);
  assert.match(sb.run('status', 'T1', 'blocked', 'x', 'other').error, /bad flag other/);
  sb.ok('status', 'T1', 'blocked', 'verification failed');
  assert.equal(sb.taskOf('T1').reviewedHead, undefined);
});

test('merge undoes a merge an earlier call left half done, then merges', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')] });
  const prep = sb.ok('prepare', 'run-one');
  const w1 = sb.ok('worktree', 'T1');
  sb.commit(w1.worktree, 'a.txt', 'a\n');
  const w2 = sb.ok('worktree', 'T2');
  sb.commit(w2.worktree, 'b.txt', 'b\n');
  // A killed merge of T2: MERGE_HEAD set and the index holding T2's change.
  sb.git(prep.integration, 'merge', '--no-ff', '--no-commit', '-q', `task/${TOPIC}/T2`);
  assert.equal(sb.tryGit(prep.integration, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 0);

  sb.ok('status', 'T1', 'verified', 'reviewed');
  const m = sb.ok('merge', 'T1');
  assert.equal(m.sha, sb.git(prep.integration, 'rev-parse', '--short', 'HEAD'));
  assert.notEqual(sb.tryGit(prep.integration, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 0);
  assert.equal(sb.git(prep.integration, 'log', '-1', '--format=%s'), 'merge T1: task T1');
  assert.equal(sb.tryGit(prep.integration, 'merge-base', '--is-ancestor', `task/${TOPIC}/T2`, 'HEAD'), 1, 'the half-done T2 merge is gone');
});

test('merge still refuses other uncommitted changes to tracked files in the integration worktree', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const prep = sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  writeFileSync(path.join(prep.integration, '.claude', 'verify.cmd'), 'echo changed\n');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  assert.match(sb.run('merge', 'T1').error, /has uncommitted changes to tracked files/);
});
