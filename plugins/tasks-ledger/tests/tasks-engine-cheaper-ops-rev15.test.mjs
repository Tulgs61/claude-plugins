// Engine changes that make a run cheaper: ops agents on a small model, long commands detached,
// restarted tasks verified before an implementer starts, one retry of a merge that failed in passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from './helpers/relay.mjs';

const task = (id, files = [`src/${id}/**`]) => ({
  id,
  title: `task ${id}`,
  acceptance: `acceptance ${id}`,
  proof: 'true',
  budget: '5 turns',
  files,
  dependsOn: [],
  status: 'todo',
});
const implementerPrompts = prompts => prompts.filter(p => /^TASK: /.test(p));
const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);

test('ops calls run on the small model at low effort; the last attempt inherits the session model', async () => {
  const { opsCalls } = await runEngine([task('T1')], {
    relay: (op, n, line) => (op === 'prepare' && n < 3 ? line.replace(/"sum":"[0-9a-f]{8}"/, '"sum":"00000000"') : line),
  });
  const prepares = opsCalls.filter(c => c.op === 'prepare');
  assert.equal(prepares.length, 3);
  assert.deepEqual([prepares[0].options.model, prepares[0].options.effort], ['haiku', 'low']);
  assert.deepEqual([prepares[1].options.model, prepares[1].options.effort], ['haiku', 'low']);
  assert.equal(prepares[2].options.model, undefined);
  assert.equal(prepares[2].options.effort, undefined);
  for (const c of opsCalls) assert.equal(c.options.agentType, undefined, `${c.op} uses the plain workflow agent`);
});

test('verify and merge run detached through ops-detach.js next to the helper; short commands do not', async () => {
  const { opsCalls } = await runEngine([task('T1')]);
  for (const c of opsCalls) {
    if (c.op === 'verify' || c.op === 'merge') {
      assert.match(c.prompt, /node "\/tmp\/ops-detach\.js" start "\/tmp\/ledger\.ops-(verify|merge)-T1\.out" "\/tmp\/tasks-git\.js" (verify|merge) "\/tmp\/ledger\.json" T1\n/);
      assert.match(c.prompt, /node "\/tmp\/ops-detach\.js" wait "\/tmp\/ledger\.ops-(verify|merge)-T1\.out"\n/);
    } else {
      assert.doesNotMatch(c.prompt, /ops-detach/);
    }
  }
  assert.ok(opsCalls.some(c => c.op === 'verify') && opsCalls.some(c => c.op === 'merge'));
});

test('a restarted task whose unreviewed branch passes verify goes straight to review', async () => {
  const { result, prompts, counts, logs } = await runEngine([task('T1')], {
    answers: { worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main', commits: 2, head: 'aaa', reviewedHead: null }) },
  });
  assert.equal(implementerPrompts(prompts).length, 0, 'no implementer runs');
  assert.equal(prompts.length, 1, 'the reviewer runs');
  assert.equal(counts.verify, 1);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.ok(logs.some(l => /already passes verification; going straight to review/.test(l)));
});

test('a restarted task whose verify fails gets the implementer with that failure', async () => {
  const { result, prompts, counts } = await runEngine([task('T1')], {
    answers: {
      worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main', commits: 1, head: 'aaa', reviewedHead: null }),
      verify: (_id, n) => (n === 1 ? { ok: false, error: 'T1: verify.cmd exited 1', tail: 'smoke FAIL' } : { ok: true, tail: 'ok' }),
    },
  });
  const impl = implementerPrompts(prompts);
  assert.equal(impl.length, 1);
  assert.match(impl[0], /PREVIOUS ATTEMPT:[\s\S]*smoke FAIL/);
  assert.equal(counts.verify, 2);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
});

test('a branch head a review already judged gets the implementer, without a verify first', async () => {
  const { prompts, counts } = await runEngine([task('T1')], {
    answers: { worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main', commits: 3, head: 'bbb', reviewedHead: 'bbb' }) },
  });
  assert.equal(implementerPrompts(prompts).length, 1);
  assert.doesNotMatch(implementerPrompts(prompts)[0], /PREVIOUS ATTEMPT/);
  assert.equal(counts.verify, 1, 'only the verify after the implementer');
});

test('a fresh task (no commits) runs the implementer first, as before', async () => {
  const { prompts, counts } = await runEngine([task('T1')]);
  assert.equal(implementerPrompts(prompts).length, 1);
  assert.equal(counts.verify, 1);
});

test('a review that blocks the task passes the reviewed flag; other blocks do not', async () => {
  const rejected = await runEngine([task('T1')], {
    taskAgent: (prompt) => (/^TASK: /.test(prompt) ? 'done' : { verdict: 'rejected', acceptance_met: false, scope_ok: true, constraints_ok: true, findings: [{ message: 'missing test' }], evidence: 'x' }),
  });
  const blockedLine = rejected.opsLines.find(l => /^status "\/tmp\/ledger\.json" T1 blocked /.test(l));
  assert.match(blockedLine, / reviewed$/);

  const verifyFails = await runEngine([task('T1')], { answers: { verify: () => ({ ok: false, error: 'boom' }) } });
  const line = verifyFails.opsLines.find(l => /^status "\/tmp\/ledger\.json" T1 blocked /.test(l));
  assert.doesNotMatch(line, / reviewed$/);

  const inconsistent = await runEngine([task('T1')], {
    taskAgent: prompt => (/^TASK: /.test(prompt) ? 'done' : { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [{ message: 'x', severity: 'high' }], evidence: 'x' }),
  });
  const judged = inconsistent.opsLines.find(l => /^status "\/tmp\/ledger\.json" T1 blocked /.test(l));
  assert.match(judged, /review inconsistent.* reviewed$/);
});

test('the detached prompt tells the ops agent to stop on NOT RUNNING', async () => {
  const { opsCalls } = await runEngine([task('T1')]);
  const verify = opsCalls.find(c => c.op === 'verify');
  assert.match(verify.prompt, /When it prints NOT RUNNING, stop and answer with that\./);
});

test('a backslashed Windows drive path from the helper is used with forward slashes; other backslashes stay unsafe', async () => {
  const drive = await runEngine([task('T1')], {
    answers: { worktree: id => ({ ok: true, worktree: `C:\\repo\\.claude\\worktrees\\t-${id}`, branch: `task/t/${id}`, base: 'main' }) },
  });
  assert.deepEqual(statusOf(drive.result, 'T1'), ['merged']);
  assert.match(drive.prompts[0], /^Worktree: C:\/repo\/\.claude\/worktrees\/t-T1$/m);

  const bad = await runEngine([task('T1')], {
    answers: { worktree: id => ({ ok: true, worktree: `/tmp/a\\b-${id}`, branch: `task/t/${id}`, base: 'main' }) },
  });
  assert.deepEqual(statusOf(bad.result, 'T1'), ['blocked']);
});

test('a merge without an answer is tried once more; a conflict or failed check is not', async () => {
  const lost = await runEngine([task('T1')], {
    relay: (op, n, line) => (op === 'merge' && n <= 3 ? 'no output' : line),
  });
  assert.equal(lost.counts.merge, 4, 'three attempts, then one retry round that succeeds at once');
  assert.deepEqual(statusOf(lost.result, 'T1'), ['merged']);

  for (const answer of [
    { ok: false, error: 'T1 conflicts with already-merged tasks', conflicts: ['a.txt'] },
    { ok: false, error: 'T1: combined check failed after merging (x, exit 1); merge aborted' },
    { ok: false, error: 'T1: untracked files in the integration worktree block the merge: x' },
    { ok: false, error: 'another merge is running in /tmp/int (pid 7); try again when it has finished', locked: true },
  ]) {
    const { counts, result } = await runEngine([task('T1')], { answers: { merge: () => answer } });
    assert.equal(counts.merge, 1, answer.error);
    assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  }
});
