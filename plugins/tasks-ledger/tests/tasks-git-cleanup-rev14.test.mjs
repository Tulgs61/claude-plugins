// Rev 14: tasks-git.js cleanup [dry-run]. It removes the worktrees and local branches of the ledger's
// topic whose work is confirmed merged: (a) the tip is in the base, or (b) the recorded request is
// merged at exactly the local tip (squash merges). Dirty worktrees, worktrees outside
// .claude/worktrees/ and unconfirmed branches are kept with a reason. It holds the run lock, never
// writes the ledger and never touches remote branches or requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const b = id => `task/${TOPIC}/${id}`;

const branches = sb => sb.git(sb.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
const worktreePaths = sb =>
  sb.git(sb.repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length));
const names = list => list.map(x => x.branch).sort();
const reasonOf = (r, branch) => (r.kept.find(x => x.branch === branch) || {}).reason;

// T1 and T2 merged into the integration branch; the run finished, so no lock is held.
function finishedRun(t, opts = {}) {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**']), task('T2', ['b/**'])], ...opts });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  sb.ok('finish', 'finished');
  return sb;
}

// One task merged and its draft request opened; the fake forge reports one head for every request.
function oneRequest(t) {
  const sb = sandbox(t, { prs: true, tasks: [task('T1', ['a/**'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.ok('finish', 'finished');
  sb.ok('prs');
  sb.env.FAKE_GH_STATE = 'merged';
  return sb;
}

const integrationPath = sb => path.join(sb.repo, '.claude', 'worktrees', `${TOPIC}-integration`);

// Lands the integration branch on main the way a merge commit does.
const landOnMain = sb => sb.git(sb.repo, 'merge', '-q', '--no-ff', '-m', 'land', b('integration'));

test('a dry run lists the items and changes nothing', t => {
  const sb = finishedRun(t);
  landOnMain(sb);
  const before = { branches: branches(sb), worktrees: worktreePaths(sb), ledger: readFileSync(sb.ledgerFile, 'utf8') };
  const r = sb.ok('cleanup', 'dry-run');
  assert.equal(r.dryRun, true);
  assert.deepEqual(names(r.removable), [b('T1'), b('T2'), b('integration')].sort());
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(branches(sb), before.branches);
  assert.deepEqual(worktreePaths(sb), before.worktrees);
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), before.ledger, 'the ledger is never written');
  assert.equal(existsSync(sb.lockFile), false, 'no lock is left behind');
});

test('a real run removes tasks merged by merge commit, their -base branch and the integration branch', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**']), task('T2', ['b/**']), task('T3', ['c/**'], ['T1', 'T2'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  sb.complete('T3');
  sb.ok('finish', 'finished');
  assert.ok(branches(sb).includes(b('T3-base')));
  landOnMain(sb);

  const r = sb.ok('cleanup');
  assert.equal(r.dryRun, false);
  assert.deepEqual(names(r.removed), [b('T1'), b('T2'), b('T3'), b('T3-base'), b('integration')].sort());
  assert.deepEqual(r.kept, []);
  assert.deepEqual(branches(sb), ['main']);
  assert.deepEqual(worktreePaths(sb), [sb.repo], 'only the main worktree is left, and prune ran');
  assert.equal(existsSync(sb.lockFile), false);
  assert.deepEqual(sb.originHeads(), ['main'], 'remote branches are never touched');
});

test('a squash-merged task is removed when the local tip is the merged request head', t => {
  const sb = oneRequest(t);
  // A head the local tip does not contain: a parentless commit of the same tree.
  sb.env.FAKE_GH_HEAD = sb.git(sb.repo, 'commit-tree', `${b('T1')}^{tree}`, '-m', 'squashed elsewhere');
  const r1 = sb.ok('cleanup', 'dry-run');
  assert.equal(reasonOf(r1, b('T1')), 'unconfirmed: the local tip is not the merged head');

  sb.env.FAKE_GH_HEAD = sb.sha(sb.repo, b('T1'));
  const r = sb.ok('cleanup');
  assert.ok(names(r.removed).includes(b('T1')), JSON.stringify(r));
  assert.equal(branches(sb).includes(b('T1')), false);
  assert.ok(sb.ghCalls().some(c => c[0] === 'pr' && c[1] === 'view'), 'the forge was asked');
  assert.ok(sb.originHeads().includes(b('T1')), 'the pushed branch stays on the remote');
});

test('a commit after the merged head keeps the branch as unconfirmed, and so the integration branch', t => {
  const sb = finishedRun(t, { prs: true });
  sb.ok('prs');
  const head = sb.sha(sb.repo, b('T1'));
  sb.commit(sb.taskOf('T1').worktree, 'a/late.txt', 'late\n', 'late work');
  sb.env.FAKE_GH_STATE = 'merged';
  sb.env.FAKE_GH_HEAD = head;
  const r = sb.ok('cleanup');
  assert.equal(reasonOf(r, b('T1')), 'unconfirmed: local commits after the merge');
  assert.equal(reasonOf(r, b('integration')), 'unconfirmed: not every task branch is confirmed');
  assert.ok(branches(sb).includes(b('T1')));
  assert.ok(existsSync(sb.taskOf('T1').worktree));
});

test('an open request keeps the branch as pr open', t => {
  const sb = finishedRun(t, { prs: true });
  sb.ok('prs');
  sb.env.FAKE_GH_STATE = 'open';
  sb.env.FAKE_GH_HEAD = sb.sha(sb.repo, b('T1'));
  const r = sb.ok('cleanup');
  assert.equal(reasonOf(r, b('T1')), 'pr open');
  assert.equal(reasonOf(r, b('T2')), 'pr open');
  assert.deepEqual(r.removed, []);
});

test('a dirty worktree is kept, for a modified tracked file and for an untracked file', t => {
  for (const make of [
    w => writeFileSync(path.join(w, 'T1.txt'), 'changed\n'),
    w => writeFileSync(path.join(w, 'stray.txt'), 'new\n'),
  ]) {
    const sb = finishedRun(t);
    landOnMain(sb);
    const w = sb.taskOf('T1').worktree;
    make(w);
    const r = sb.ok('cleanup');
    assert.equal(reasonOf(r, b('T1')), 'dirty');
    assert.ok(existsSync(w), 'the worktree stays');
    assert.ok(branches(sb).includes(b('T1')), 'its branch stays');
    assert.ok(names(r.removed).includes(b('T2')), 'the other task is still removed');
  }
});

test('a worktree outside .claude/worktrees/ is kept as outside with its branch', t => {
  const sb = finishedRun(t);
  landOnMain(sb);
  sb.git(sb.repo, 'worktree', 'remove', sb.taskOf('T1').worktree);
  const review = path.join(sb.tmp, 'review');
  sb.git(sb.repo, 'worktree', 'add', '-q', review, b('T1'));
  const r = sb.ok('cleanup');
  assert.equal(reasonOf(r, b('T1')), 'outside');
  assert.ok(existsSync(review));
  assert.ok(branches(sb).includes(b('T1')));
});

test('the integration branch: kept with a direct commit, removed once its tip is in the base', t => {
  const sb = oneRequest(t);
  sb.commit(integrationPath(sb), 'direct.txt', 'direct\n', 'direct commit');
  // The request squash-merged at its tip: only the direct commit is unexplained.
  sb.env.FAKE_GH_HEAD = sb.sha(sb.repo, b('T1'));
  const r = sb.ok('cleanup', 'dry-run');
  assert.ok(names(r.removable).includes(b('T1')));
  assert.equal(reasonOf(r, b('integration')), 'unconfirmed: commits on the integration branch that come from no task');

  landOnMain(sb);
  const after = sb.ok('cleanup');
  assert.ok(names(after.removed).includes(b('integration')), JSON.stringify(after));
});

test('only task commits on the integration branch: it goes with its confirmed tasks (squash landing)', t => {
  const sb = oneRequest(t);
  sb.env.FAKE_GH_HEAD = sb.sha(sb.repo, b('T1'));
  const r = sb.ok('cleanup');
  assert.deepEqual(names(r.removed), [b('T1'), b('integration')].sort());
});

test('a live run lock refuses cleanup and removes nothing; a prepare during cleanup is refused', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a/**'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  landOnMain(sb);
  const before = branches(sb);
  const r = sb.run('cleanup');
  assert.equal(r.ok, false);
  assert.equal(r.locked, true);
  assert.deepEqual(branches(sb), before);

  sb.ok('finish', 'finished');
  // The lock cleanup holds while it runs: marked preparing, naming a live process.
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'cleanup-1-2', at: Date.now(), pid: process.pid, preparing: true }) + '\n');
  for (const extra of [[], ['takeover']]) {
    const p = sb.run('prepare', 'run-two', ...extra);
    assert.equal(p.ok, false, extra.join(' '));
    assert.equal(p.locked, true, extra.join(' '));
  }
});

test('the main worktree and branches outside task/<topic>/ are never items', t => {
  const sb = finishedRun(t);
  landOnMain(sb);
  sb.git(sb.repo, 'branch', 'feature/x');
  sb.git(sb.repo, 'branch', 'task/other/T1');
  sb.git(sb.repo, 'branch', `${b('notes')}`);
  const r = sb.ok('cleanup');
  const all = [...names(r.removed), ...names(r.kept)];
  for (const name of ['main', 'feature/x', 'task/other/T1', b('notes')]) {
    assert.equal(all.includes(name), false, name);
    assert.ok(branches(sb).includes(name), `${name} stays`);
  }
  assert.ok(worktreePaths(sb).includes(sb.repo));
});

test('a mode other than dry-run is refused', t => {
  const sb = finishedRun(t);
  const r = sb.run('cleanup', 'force');
  assert.equal(r.ok, false);
  assert.match(r.error, /bad cleanup mode "force"/);
});
