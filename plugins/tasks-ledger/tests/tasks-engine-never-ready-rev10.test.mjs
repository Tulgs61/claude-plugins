// Rev 10 of the tasks-engine spec, amendment 14: unstartable tasks are never ready. They are set
// aside in the engine's own state as soon as an answer reports them, so no scheduling step can start
// one, and a title-only task without proof or budget is set aside the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };
const MINUTE = 60 * 1000;

// Runs the engine against a fake helper and a fake clock that moves `agentMinutes` during every task
// agent call. `answers` overrides the canned answer per subcommand (a function of the parts after the
// ledger path and of the call count of that subcommand). `events` records ops lines and task agent
// calls (`impl T1`, `review T1`) in order.
async function runEngine(ledgerTasks, { answers = {}, agentMinutes = 0 } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const events = [];
  const opsLines = [];
  const counts = {};
  let now = Date.UTC(2026, 9, 5);
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
      now += agentMinutes * MINUTE;
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
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const result = await run(args, agent, () => {}, () => {});
    return { result, events, opsLines };
  } finally {
    Date.now = realNow;
  }
}

const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);
const FIVE = ['T11', 'T12', 'T13', 'T14', 'T15'];

test('amendment 14: five needsAcceptance tasks from a lock refresh during two running tasks are never started', async () => {
  const { result, events, opsLines } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'])], {
    agentMinutes: 11,
    answers: {
      // Every agent boundary refreshes; the sixth sync comes while T1 and T2 are both running, and
      // T2 finishes while the five are still being blocked in the ledger.
      sync: (_runId, n) =>
        n === 6 ? { ok: true, tasks: FIVE.map((id, i) => task(id, [`x${i}/**`], [], { needsAcceptance: true })) } : { ok: true, tasks: [] },
    },
  });
  // The report came while both tasks were running.
  const report = events.reduce((acc, e, i) => (e.startsWith('sync ') ? [...acc, i] : acc), [])[5];
  assert.ok(events.indexOf('impl T1') < report && events.indexOf('impl T2') < report, events.join('\n'));
  assert.ok(report < events.indexOf('merge "/tmp/ledger.json" T1') && report < events.indexOf('merge "/tmp/ledger.json" T2'), events.join('\n'));
  for (const id of FIVE) {
    for (const e of events) {
      assert.ok(e !== `impl ${id}` && e !== `review ${id}`, `${id} got an agent:\n${events.join('\n')}`);
    }
    for (const l of opsLines) {
      assert.ok(!l.startsWith(`status "/tmp/ledger.json" ${id} verified`), `${id} recorded verified:\n${opsLines.join('\n')}`);
      assert.ok(!l.startsWith(`merge "/tmp/ledger.json" ${id}`), `${id} merged:\n${opsLines.join('\n')}`);
      assert.ok(!l.startsWith(`worktree "/tmp/ledger.json" ${id}`), `${id} got a worktree:\n${opsLines.join('\n')}`);
    }
    assert.deepEqual(statusOf(result, id), ['blocked']);
    assert.deepEqual(
      opsLines.filter(l => l.startsWith(`status "/tmp/ledger.json" ${id} `)),
      [`status "/tmp/ledger.json" ${id} blocked "needs acceptance"`]
    );
  }
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.deepEqual(statusOf(result, 'T2'), ['merged']);
  assert.equal(result.stopped, FIVE.map(id => `${id} needs acceptance`).join('; '));
});

test('amendment 14: a title-only task without proof or budget is set aside as needs acceptance, not a failure', async () => {
  const { result, events, opsLines } = await runEngine([
    task('T1', ['src/**'], [], { acceptance: '', proof: '' }),
    task('T2', ['lib/**'], [], { acceptance: '', budget: undefined }),
    task('T3', ['doc/**']),
    task('T4', ['web/**'], ['T3']),
  ]);
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T2'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T3'), ['merged']);
  assert.deepEqual(statusOf(result, 'T4'), ['merged']);
  assert.deepEqual(opsLines.filter(l => / T[12] /.test(l) && l.startsWith('status ')), [
    'status "/tmp/ledger.json" T1 blocked "needs acceptance"',
    'status "/tmp/ledger.json" T2 blocked "needs acceptance"',
  ]);
  assert.ok(!events.some(e => / T[12]$/.test(e)), events.join('\n'));
  assert.equal(result.stopped, 'T1 needs acceptance; T2 needs acceptance');
});
