// Rev 10 of the tasks-engine spec, fixes after review: unstartable tasks (needsAcceptance, invalid ids)
// never halt the run and are named exactly once, and a refused `finish` is reported with `locked`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `answers` overrides the canned answer per subcommand (a
// function of the parts after the ledger path and of the call count of that subcommand). `events`
// records ops lines and task agent calls (`impl T1`, `review T1`) in order.
async function runEngine(ledgerTasks, { answers = {} } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const events = [];
  const opsLines = [];
  const counts = {};
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: ledgerTasks }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };
  const agent = async (prompt, options) => {
    if (options.agentType !== undefined) {
      const isImpl = /^TASK: /.test(prompt);
      const id = isImpl ? prompt.match(/^TASK: (\S+)/)[1] : prompt.match(/^Review task (\S+)/)[1];
      events.push(`${isImpl ? 'impl' : 'review'} ${id}`);
      return isImpl ? 'done' : GOOD_REVIEW;
    }
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    events.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    counts[op] = (counts[op] || 0) + 1;
    return { stdout: JSON.stringify(canned[op] ? canned[op](...rest, counts[op]) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  const result = await run(args, agent, () => {}, () => {});
  return { result, events, opsLines };
}

const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);
const occurrences = (text, word) => text.split(/[\s:;,]+/).filter(w => w === word).length;
const blockedLines = (opsLines, id) => opsLines.filter(l => l.startsWith(`status "/tmp/ledger.json" ${id} blocked `));

// ---- amendment 10: unstartable tasks never halt the run ----------------------------------------

test('amendment 13: ids 1 and T1 where T1 fails, so stopped names both', async () => {
  const { result, events, opsLines } = await runEngine([task('1', ['lib/**']), task('T1', ['src/**'])], {
    answers: { merge: () => ({ ok: false, error: 'conflict' }) },
  });
  assert.ok(events.includes('impl T1'), events.join('\n'));
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(statusOf(result, '1'), ['blocked']);
  assert.match(result.stopped, /T1 blocked: merge failed: conflict/);
  // `1` is named on its own, not only as part of `T1`.
  assert.match(result.stopped, /invalid task ids: 1(;|$)/);
  assert.equal(occurrences(result.stopped, '1'), 1, result.stopped);
  assert.deepEqual(blockedLines(opsLines, '1'), []);
});

test('amendment 13: [T1 needsAcceptance, T2, T3 dependsOn T2]: T2 and T3 merge, T1 is blocked and named', async () => {
  const { result, events, opsLines } = await runEngine([
    task('T1', ['src/**'], [], { needsAcceptance: true }),
    task('T2', ['lib/**']),
    task('T3', ['doc/**'], ['T2']),
  ]);
  assert.deepEqual(statusOf(result, 'T2'), ['merged']);
  assert.deepEqual(statusOf(result, 'T3'), ['merged']);
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(result.blocked, ['T1']);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(blockedLines(opsLines, 'T1'), ['status "/tmp/ledger.json" T1 blocked "needs acceptance"']);
  assert.ok(!events.some(e => / T1$/.test(e)), events.join('\n'));
  assert.equal(result.stopped, 'T1 needs acceptance');
});

test('amendment 13: a needsAcceptance task whose prerequisite never merges is still blocked in the ledger', async () => {
  const { result, opsLines } = await runEngine([
    task('T1', ['src/**']),
    task('T2', ['lib/**'], ['T1'], { needsAcceptance: true }),
  ], { answers: { verify: () => ({ ok: false, error: 'tests failed' }) } });
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T2'), ['blocked']);
  assert.deepEqual(blockedLines(opsLines, 'T2'), ['status "/tmp/ledger.json" T2 blocked "needs acceptance"']);
  // Handled right after prepare, before T1 even got its worktree.
  assert.ok(
    opsLines.indexOf(blockedLines(opsLines, 'T2')[0]) < opsLines.findIndex(l => l.startsWith('worktree ')),
    opsLines.join('\n')
  );
  assert.equal(occurrences(result.stopped, 'T2'), 1, result.stopped);
  assert.match(result.stopped, /T2 needs acceptance/);
  assert.match(result.stopped, /T1 blocked: verification failed twice: tests failed/);
});

test('amendment 10: stopped names each unstartable task exactly once, as in the spec example', async () => {
  const { result, opsLines } = await runEngine([
    task('T4', ['src/**'], [], { needsAcceptance: true }),
    task(1, ['lib/**']),
    task('T2', ['doc/**']),
  ]);
  assert.deepEqual(statusOf(result, 'T2'), ['merged']);
  assert.equal(result.stopped, 'T4 needs acceptance; invalid task ids: 1');
  assert.deepEqual(result.blocked.sort(), ['1', 'T4']);
  assert.equal(opsLines.filter(l => l.startsWith('status ') && / (T4|1) blocked /.test(l)).length, 1, opsLines.join('\n'));
});

test('amendment 10: unstartable tasks reported by a sync are handled at once and do not halt the run', async () => {
  const { result, events, opsLines } = await runEngine([task('T1', ['src/**']), task('T3', ['doc/**'], ['T1'])], {
    answers: {
      // The first sync is the refresh right before T1's implementer.
      sync: (_runId, n) =>
        n === 1 ? { ok: true, tasks: [task('T5', ['x/**'], ['T9'], { needsAcceptance: true }), task('bad-2', ['y/**'])] } : { ok: true, tasks: [] },
    },
  });
  const firstSync = events.findIndex(e => e.startsWith('sync '));
  assert.equal(events[firstSync + 1], 'status "/tmp/ledger.json" T5 blocked "needs acceptance"', events.join('\n'));
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.deepEqual(statusOf(result, 'T3'), ['merged']);
  assert.deepEqual(statusOf(result, 'T5'), ['blocked']);
  assert.deepEqual(statusOf(result, 'bad-2'), ['blocked']);
  assert.equal(result.stopped, 'T5 needs acceptance; invalid task ids: bad-2');
  assert.ok(!opsLines.some(l => l.includes('bad-2') && !l.startsWith('finish ')), opsLines.join('\n'));
});

// ---- amendment 11: `locked` in the result --------------------------------------------------------

test('amendment 13: locked in the result, with finish failed: <error> after any earlier reason', async () => {
  const error = 'another run (other-run-1, 2 min old) holds the lock';
  const superseded = () => ({ ok: false, locked: true, error });
  const clean = await runEngine([task('T1', ['src/**'])], { answers: { finish: superseded } });
  assert.equal(clean.result.locked, true);
  assert.equal(clean.result.stopped, `finish failed: ${error}`);

  const failed = await runEngine([task('T1', ['src/**'])], {
    answers: { finish: superseded, merge: () => ({ ok: false, error: 'conflict' }) },
  });
  assert.equal(failed.result.locked, true);
  assert.equal(failed.result.stopped, `T1 blocked: merge failed: conflict; finish failed: ${error}`);

  const refused = await runEngine([task('T1', ['src/**'])], { answers: { finish: () => ({ ok: false, error: 'disk full' }) } });
  assert.equal(refused.result.locked, false);
  assert.equal(refused.result.stopped, 'finish failed: disk full');
});
