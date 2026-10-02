// tasks-git.js prs: pushes to a local bare origin and opens PRs through the fake gh/glab fixture
// (TASKS_GIT_GH / TASKS_GIT_GLAB, set by the sandbox); the real CLIs are never invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const b = id => `task/${TOPIC}/${id}`;
const flag = (args, name) => args[args.indexOf(name) + 1];

// T1 and T2 (stacked on T1) merged; T3 needs both, so its worktree created T3-base, but it is not merged.
function stackedRun(t, opts = {}) {
  const sb = sandbox(t, { prs: true, tasks: [task('T1'), task('T2', [], ['T1']), task('T3', [], ['T1', 'T2'])], ...opts });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  sb.ok('worktree', 'T3');
  assert.equal(sb.tryGit(sb.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b('T3-base')}`), 0, 'T3-base exists locally');
  return sb;
}

test('prs pushes only the merged task branches and records one draft PR per task', t => {
  const sb = stackedRun(t);
  const r = sb.ok('prs');
  assert.deepEqual(sb.originHeads(), ['main', b('T1'), b('T2')].sort(), 'integration and -base branches stay local');
  for (const id of ['T1', 'T2']) assert.equal(sb.sha(sb.origin, b(id)), sb.sha(sb.repo, b(id)));

  const calls = sb.ghCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ['pr', 'create', '--draft']);
  assert.equal(flag(calls[0], '--head'), b('T1'));
  assert.equal(flag(calls[0], '--base'), 'main');
  assert.equal(flag(calls[0], '--title'), 'task T1');
  assert.match(flag(calls[0], '--body'), /\*\*T1: task T1\*\*/);
  assert.equal(flag(calls[1], '--head'), b('T2'));
  assert.equal(flag(calls[1], '--base'), b('T1'), 'a stacked PR targets its prerequisite');
  assert.match(flag(calls[1], '--body'), /Stacked on T1 \(https:\/\/forge\.example\/o\/r\/pull\/1\)/);

  assert.deepEqual(r.results, [
    { id: 'T1', pr: 'https://forge.example/o/r/pull/1', target: 'main' },
    { id: 'T2', pr: 'https://forge.example/o/r/pull/2', target: b('T1') },
  ]);
  assert.equal(sb.taskOf('T1').pr, 'https://forge.example/o/r/pull/1');
  assert.equal(sb.taskOf('T2').pr, 'https://forge.example/o/r/pull/2');
  assert.equal(sb.taskOf('T3').pr ?? null, null);

  // A rerun skips tasks that already have a PR.
  const again = sb.ok('prs');
  assert.deepEqual(again.results.map(x => x.skipped), ['exists', 'exists']);
  assert.equal(sb.ghCalls().length, 2);
});

test('prs pushes nothing when the ledger did not ask for PRs', t => {
  const sb = sandbox(t, { prs: false, tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  const r = sb.run('prs');
  assert.equal(r.ok, false);
  assert.match(r.error, /prs is false/);
  assert.deepEqual(sb.originHeads(), ['main']);
  assert.equal(sb.ghCalls().length, 0);
});

test('prs refuses to push an integration or permanent branch named in a tampered ledger', t => {
  for (const branch of [b('integration'), 'main', 'task/other/T1', `${b('T1')}:refs/heads/main`]) {
    const sb = sandbox(t, { prs: true, tasks: [task('T1', [], [], { status: 'merged', branch, base: 'main' })] });
    const r = sb.run('prs');
    assert.equal(r.ok, false, branch);
    assert.match(r.error, /refusing to push/, branch);
    assert.deepEqual(sb.originHeads(), ['main'], branch);
    assert.equal(sb.ghCalls().length, 0, branch);
  }
});

test('a failing PR CLI stops prs with ok:false and records no PR', t => {
  const sb = stackedRun(t);
  sb.env.FAKE_GH_FAIL = '1';
  const r = sb.run('prs');
  assert.equal(r.ok, false);
  assert.match(r.error, /gh pr create failed for T1: fake-gh: failing on request/);
  assert.deepEqual(r.results, []);
  assert.equal(sb.taskOf('T1').pr ?? null, null);
});

test('a GitLab origin opens draft MRs through the glab stand-in', t => {
  const sb = stackedRun(t);
  const gitlab = path.join(sb.tmp, 'gitlab-origin.git');
  sb.git(sb.tmp, 'clone', '-q', '--bare', sb.origin, gitlab);
  sb.git(sb.repo, 'remote', 'set-url', 'origin', gitlab);
  const r = sb.ok('prs');
  assert.deepEqual(r.results.map(x => x.pr), [
    'https://forge.example/o/r/-/merge_requests/1',
    'https://forge.example/o/r/-/merge_requests/2',
  ]);
  const calls = sb.ghCalls();
  assert.deepEqual(calls[1].slice(0, 3), ['mr', 'create', '--draft']);
  assert.equal(flag(calls[1], '--source-branch'), b('T2'));
  assert.equal(flag(calls[1], '--target-branch'), b('T1'));
  const heads = sb.git(gitlab, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort();
  assert.deepEqual(heads, ['main', b('T1'), b('T2')].sort());
});
