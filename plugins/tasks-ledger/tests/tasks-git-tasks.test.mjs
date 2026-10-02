// tasks-git.js worktree, verify, status and merge against throwaway repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const wtPath = (sb, name) => path.join(sb.repo, '.claude', 'worktrees', `${TOPIC}-${name}`);
const isAncestor = (sb, a, b) => sb.tryGit(sb.repo, 'merge-base', '--is-ancestor', a, b) === 0;

// ---- worktree ------------------------------------------------------------------------------

test('worktree: a task without prerequisites branches from origin/<baseBranch>', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  assert.deepEqual(w, { ok: true, id: 'T1', branch: `task/${TOPIC}/T1`, base: 'main', worktree: wtPath(sb, 'T1') });
  assert.equal(sb.git(w.worktree, 'branch', '--show-current'), `task/${TOPIC}/T1`);
  assert.equal(sb.sha(w.worktree, 'HEAD'), sb.sha(sb.repo, 'origin/main'));
  const T1 = sb.taskOf('T1');
  assert.equal(T1.status, 'in_progress');
  assert.equal(T1.branch, `task/${TOPIC}/T1`);
  assert.equal(T1.base, 'main');
  assert.equal(T1.worktree, wtPath(sb, 'T1'));
});

test('worktree: refuses while a prerequisite is not merged, and an unknown id', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2', [], ['T1'])] });
  sb.ok('prepare', 'run-one');
  const r = sb.run('worktree', 'T2');
  assert.equal(r.ok, false);
  assert.match(r.error, /prerequisite T1 is todo, not merged/);
  assert.match(sb.run('worktree', 'T9').error, /no task T9/);
});

test('worktree: a single prerequisite makes the task branch from that prerequisite\'s branch', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2', [], ['T1'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  const w = sb.ok('worktree', 'T2');
  assert.equal(w.base, `task/${TOPIC}/T1`);
  assert.equal(sb.sha(w.worktree, 'HEAD'), sb.sha(sb.repo, `task/${TOPIC}/T1`));
  assert.ok(existsSync(path.join(w.worktree, 'T1.txt')));
});

test('worktree: two prerequisites are combined in task/<topic>/<id>-base; a rerun is idempotent', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2'), task('T3', [], ['T1', 'T2'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  const w = sb.ok('worktree', 'T3');
  const base = `task/${TOPIC}/T3-base`;
  assert.equal(w.base, base);
  assert.ok(isAncestor(sb, `task/${TOPIC}/T1`, base), 'T1 is in the -base branch');
  assert.ok(isAncestor(sb, `task/${TOPIC}/T2`, base), 'T2 is in the -base branch');
  assert.equal(sb.sha(sb.repo, `${base}^2`), sb.sha(sb.repo, `task/${TOPIC}/T2`), 'prerequisites merged with --no-ff');
  assert.equal(sb.sha(w.worktree, 'HEAD'), sb.sha(sb.repo, base));
  assert.ok(existsSync(path.join(w.worktree, 'T1.txt')) && existsSync(path.join(w.worktree, 'T2.txt')));
  assert.equal(existsSync(wtPath(sb, 'T3-base')), false, 'the temporary -base worktree is removed');

  // Work already started in the worktree survives a rerun.
  const head = sb.commit(w.worktree, 'T3.txt', 'T3\n');
  const worktreesBefore = sb.git(sb.repo, 'worktree', 'list', '--porcelain');
  const baseBefore = sb.sha(sb.repo, base);
  const again = sb.ok('worktree', 'T3');
  assert.deepEqual(again, w);
  assert.equal(sb.sha(w.worktree, 'HEAD'), head);
  assert.equal(sb.sha(sb.repo, base), baseBefore);
  assert.equal(sb.git(sb.repo, 'worktree', 'list', '--porcelain'), worktreesBefore);
});

test('worktree: rerun for a task without prerequisites reuses the worktree', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  const head = sb.commit(w.worktree, 'a.txt', 'a\n');
  assert.deepEqual(sb.ok('worktree', 'T1'), w);
  assert.equal(sb.sha(w.worktree, 'HEAD'), head);
});

// ---- verify --------------------------------------------------------------------------------

test('verify fails without commits beyond the base', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('worktree', 'T1');
  const r = sb.run('verify', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /no commits on task\/demo\/T1 beyond origin\/main/);
});

test('verify fails on a dirty tree', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.write(w.worktree, 'stray.txt', 'not committed\n');
  const r = sb.run('verify', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /uncommitted changes/);
  assert.ok(r.dirty.some(l => l.includes('stray.txt')));
});

test('verify fails when verify.cmd fails', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'FAIL_VERIFY', 'x\n');
  const r = sb.run('verify', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /verify\.cmd exited 1/);
});

test('verify fails when the worktree is missing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  assert.match(sb.run('verify', 'T1').error, /worktree for T1 missing/);
});

test('verify passes with commits, a clean tree and a passing verify.cmd', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.commit(w.worktree, 'b.txt', 'b\n');
  const r = sb.ok('verify', 'T1');
  assert.equal(r.commits, 2);
  assert.equal(r.verify, 'passed');
});

test('verify counts commits from the prerequisite branch for a stacked task', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2', [], ['T1'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  const w = sb.ok('worktree', 'T2');
  assert.match(sb.run('verify', 'T2').error, /no commits on task\/demo\/T2 beyond task\/demo\/T1/);
  sb.commit(w.worktree, 'T2.txt', 'T2\n');
  assert.equal(sb.ok('verify', 'T2').commits, 1);
});

// ---- status --------------------------------------------------------------------------------

test('status writes the status and the evidence', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  assert.deepEqual(sb.ok('status', 'T1', 'blocked', 'needs a decision'), { ok: true, id: 'T1', status: 'blocked' });
  assert.equal(sb.taskOf('T1').status, 'blocked');
  assert.equal(sb.taskOf('T1').evidence, 'needs a decision');
  sb.ok('status', 'T1', 'todo');
  assert.equal(sb.taskOf('T1').status, 'todo');
  assert.equal(sb.taskOf('T1').evidence, 'needs a decision', 'no evidence argument keeps the old evidence');
  sb.ok('status', 'T1', 'verified', 'x'.repeat(5000));
  assert.equal(sb.taskOf('T1').evidence.length, 4000, 'evidence is capped');
});

test('status rejects an unknown id or status and leaves the ledger unchanged', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const before = sb.ledger();
  const unknownId = sb.run('status', 'T7', 'verified');
  assert.equal(unknownId.ok, false);
  assert.match(unknownId.error, /no task T7/);
  for (const s of ['merged', 'bogus']) {
    const r = sb.run('status', 'T1', s);
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`status ${s} not settable`));
  }
  assert.deepEqual(sb.ledger(), before);
});

// ---- merge ---------------------------------------------------------------------------------

test('merge: a verified task is merged into integration and the sha recorded', t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'echo ran >> .setup-count' });
  const prep = sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  const m = sb.ok('merge', 'T1');
  assert.equal(m.sha, sb.git(prep.integration, 'rev-parse', '--short', 'HEAD'));
  assert.ok(isAncestor(sb, `task/${TOPIC}/T1`, `task/${TOPIC}/integration`));
  assert.equal(sb.git(prep.integration, 'log', '-1', '--format=%s'), 'merge T1: task T1');
  assert.equal(sb.git(prep.integration, 'rev-list', '--count', '--merges', 'origin/main..HEAD'), '1', '--no-ff merge commit');
  const T1 = sb.taskOf('T1');
  assert.equal(T1.status, 'merged');
  assert.match(T1.evidence, new RegExp(`^reviewed \\| merged into task/${TOPIC}/integration @ ${m.sha}; checks: `));
  assert.equal(sb.git(prep.integration, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('merge refuses a task that is not verified', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  const r = sb.run('merge', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /T1 is in_progress, only verified tasks merge/);
  assert.equal(isAncestor(sb, `task/${TOPIC}/T1`, `task/${TOPIC}/integration`), false);
});

test('merge: a conflicting task is aborted, integration stays clean and ok is false', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')] });
  const prep = sb.ok('prepare', 'run-one');
  sb.complete('T1', 'shared.txt', 'from T1\n');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T2');
  sb.commit(w.worktree, 'shared.txt', 'from T2\n');
  sb.ok('status', 'T2', 'verified');
  const r = sb.run('merge', 'T2');
  assert.equal(r.ok, false);
  assert.match(r.error, /T2 conflicts with already-merged tasks/);
  assert.equal(sb.git(prep.integration, 'status', '--porcelain'), '');
  assert.equal(sb.tryGit(prep.integration, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'), 1, 'no merge in progress');
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead);
  assert.equal(sb.taskOf('T2').status, 'verified');
});

test('merge: a failing combined check aborts the merge', t => {
  const sb = sandbox(t, { tasks: [task('T1')], ledgerExtra: { suite: 'test ! -e T1.txt' } });
  const prep = sb.ok('prepare', 'run-one');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'T1.txt', 'T1\n');
  sb.ok('status', 'T1', 'verified');
  const r = sb.run('merge', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /combined check failed after merging \(test ! -e T1\.txt, exit 1\); merge aborted/);
  assert.equal(sb.git(prep.integration, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead);
});

test('merge: a repeated merge of an already merged task reports already', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const prep = sb.ok('prepare', 'run-one');
  const first = sb.complete('T1');
  const intHead = sb.sha(prep.integration, 'HEAD');
  // A run that died between the merge and recording it leaves the task verified.
  sb.ok('status', 'T1', 'verified');
  const again = sb.ok('merge', 'T1');
  assert.equal(again.already, true);
  assert.equal(again.sha, first.sha);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead, 'nothing re-merged');
  assert.equal(sb.taskOf('T1').status, 'merged');
  assert.match(sb.taskOf('T1').evidence, /already in task\/demo\/integration @ /);
});

test('merge fails without an integration worktree', t => {
  const sb = sandbox(t, { tasks: [task('T1', [], [], { status: 'verified', branch: `task/${TOPIC}/T1` })] });
  const r = sb.run('merge', 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /integration worktree missing/);
});
