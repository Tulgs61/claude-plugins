// Rev 14: the engine runs at most `maxParallel` tasks at once (3 when prepare names none), and a
// finished run without PRs ends with a dry run of `cleanup`, whose lists it returns. A run with PRs
// gets the `/tasks cleanup` hint instead; a stopped run gets neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task } from './helpers/git-sandbox.mjs';
import { GOOD_REVIEW, runEngine } from './helpers/relay.mjs';

const five = () => ['T1', 'T2', 'T3', 'T4', 'T5'].map(id => task(id, [`${id.toLowerCase()}/**`]));

// Holds every implementer open for a while and records how many are in flight at once.
function counting() {
  const seen = { now: 0, max: 0 };
  const taskAgent = async prompt => {
    if (!/^TASK: /.test(prompt)) return GOOD_REVIEW;
    seen.now++;
    seen.max = Math.max(seen.max, seen.now);
    await new Promise(resolve => setTimeout(resolve, 30));
    seen.now--;
    return 'done';
  };
  return { seen, taskAgent };
}

const preparedWith = extra => () => ({
  ok: true,
  start: 'abc123',
  integration: '/tmp/int',
  prs: false,
  tasks: five().map(({ id, files, dependsOn, status }) => ({ id, files, dependsOn, status, needsAcceptance: false })),
  ...extra,
});

const merged = result => result.results.filter(r => r.status === 'merged').map(r => r.id).sort();

test('maxParallel 2: never more than 2 implementers in flight, and every task merges', async () => {
  const { seen, taskAgent } = counting();
  const { result } = await runEngine(five(), { taskAgent, answers: { prepare: preparedWith({ maxParallel: 2 }) } });
  assert.equal(seen.max, 2);
  assert.deepEqual(merged(result), ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.equal(result.stopped, null);
});

test('without maxParallel the engine runs at most 3 at once', async () => {
  const { seen, taskAgent } = counting();
  const { result } = await runEngine(five(), { taskAgent });
  assert.equal(seen.max, 3);
  assert.deepEqual(merged(result), ['T1', 'T2', 'T3', 'T4', 'T5']);
});

test('red control: with a cap above the task count all 5 run at once, so the count sees concurrency', async () => {
  const { seen, taskAgent } = counting();
  const { result } = await runEngine(five(), { taskAgent, answers: { prepare: preparedWith({ maxParallel: 99 }) } });
  assert.equal(seen.max, 5);
  assert.deepEqual(merged(result), ['T1', 'T2', 'T3', 'T4', 'T5']);
});

test('a finished run without PRs calls cleanup dry-run exactly once and returns its lists', async () => {
  const removable = [{ branch: 'task/t/T1', worktree: '/tmp/wt-T1' }];
  const kept = [{ branch: 'task/t/integration', worktree: '/tmp/int', reason: 'dirty' }];
  const { result, opsLines, counts } = await runEngine([task('T1', ['a/**'])], {
    answers: { cleanup: () => ({ ok: true, dryRun: true, removable, removed: [], kept }) },
  });
  assert.equal(result.stopped, null);
  assert.equal(counts.cleanup, 1);
  assert.equal(opsLines.filter(l => l.startsWith('cleanup ')).length, 1);
  assert.match(opsLines.find(l => l.startsWith('cleanup ')), /^cleanup "\/tmp\/ledger\.json" dry-run$/);
  assert.ok(opsLines.indexOf(opsLines.find(l => l.startsWith('cleanup '))) > opsLines.findIndex(l => l.startsWith('finish ')), 'after finish');
  assert.deepEqual(result.cleanup, { removable, kept });
});

test('a failed cleanup dry run is logged and does not stop the run', async () => {
  const { result, counts, logs } = await runEngine([task('T1', ['a/**'])], {
    answers: { cleanup: () => ({ ok: false, error: 'another run holds this ledger', locked: true }) },
  });
  assert.equal(counts.cleanup, 1);
  assert.equal(result.stopped, null);
  assert.equal(result.cleanup, null);
  assert.ok(logs.some(l => /cleanup dry run failed: another run holds this ledger/.test(l)));
});

test('a finished run with PRs and a stopped run make no cleanup call', async () => {
  const withPrs = await runEngine([task('T1', ['a/**'])], {
    answers: {
      prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: true, tasks: [{ id: 'T1', files: ['a/**'], dependsOn: [], status: 'todo', needsAcceptance: false }] }),
      prs: () => ({ ok: true, results: [{ id: 'T1', pr: 'https://forge.example/o/r/pull/1', target: 'main' }] }),
    },
  });
  assert.equal(withPrs.result.stopped, null);
  assert.equal(withPrs.counts.cleanup, undefined);
  assert.equal(withPrs.result.cleanup, 'after the PRs merge: /tasks cleanup');

  const stopped = await runEngine([task('T1', ['a/**'])], {
    answers: { verify: () => ({ ok: false, error: 'verify.cmd exited 1', tail: 'boom' }) },
  });
  assert.notEqual(stopped.result.stopped, null);
  assert.equal(stopped.counts.cleanup, undefined);
  assert.equal(stopped.result.cleanup, null);
});
