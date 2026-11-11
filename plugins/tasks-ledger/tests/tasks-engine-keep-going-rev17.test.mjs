// keepGoing: a failed task does not stop the run. Without it the first failure stops new starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, GOOD_REVIEW } from './helpers/relay.mjs';

const task = (id, extra = {}) => ({
  id,
  title: `task ${id}`,
  acceptance: `acceptance ${id}`,
  proof: 'true',
  budget: '5 turns',
  files: [`src/${id}/**`],
  dependsOn: [],
  status: 'todo',
  ...extra,
});

const REJECT = { verdict: 'rejected', acceptance_met: false, scope_ok: true, constraints_ok: true, findings: [{ severity: 'high', message: 'no' }], evidence: 'no' };

// T1 is rejected by its reviewer, every other task passes. One task at a time, so T1 fails before the
// others would start.
function rejectT1(prompt) {
  if (/^TASK: /.test(prompt)) return 'done';
  return /\bT1\b/.test(prompt) ? REJECT : GOOD_REVIEW;
}

const RECORDS = () => [task('T1'), task('T2', { dependsOn: ['T1'] }), task('T3'), task('T4', { dependsOn: ['T3'] })];
const PREPARE = records => ({ prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, maxParallel: 1, tasks: records.map(r => ({ id: r.id, status: r.status, dependsOn: r.dependsOn, files: r.files })) }) });

test('keepGoing: a rejected task does not stop the others; its dependents stay todo', async () => {
  const records = RECORDS();
  const { result, opsLines } = await runEngine(records, { answers: PREPARE(records), taskAgent: rejectT1, extraArgs: { keepGoing: true } });
  const status = Object.fromEntries(result.results.map(r => [r.id, r.status]));
  assert.equal(status.T1, 'blocked');
  assert.equal(status.T3, 'merged');
  assert.equal(status.T4, 'merged', 'a task after the failure, on another chain, still runs');
  assert.ok(!('T2' in status), 'the dependent of the blocked task never starts');
  assert.deepEqual(result.blocked, ['T1']);
  assert.deepEqual(result.waiting, ['T2']);
  assert.match(result.stopped, /^T1 blocked: review rejected/);
  assert.ok(opsLines.some(l => /^finish .*stopped/.test(l)), 'the run still ends as stopped');
});

test('default: the first failure stops new starts', async () => {
  const records = RECORDS();
  const { result } = await runEngine(records, { answers: PREPARE(records), taskAgent: rejectT1 });
  const status = Object.fromEntries(result.results.map(r => [r.id, r.status]));
  assert.equal(status.T1, 'blocked');
  assert.ok(!('T3' in status) && !('T4' in status), 'nothing starts after the failure');
  assert.deepEqual(result.waiting.sort(), ['T2', 'T3', 'T4']);
});

test('keepGoing: a run without failures finishes as before', async () => {
  const records = RECORDS();
  const { result } = await runEngine(records, { answers: PREPARE(records), extraArgs: { keepGoing: true } });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.blocked, []);
});

test('keepGoing must be a boolean', async () => {
  await assert.rejects(runEngine([task('T1')], { extraArgs: { keepGoing: 'yes' } }), /args\.keepGoing must be true or false/);
});

test('keepGoing never overrides an invalid start ref: no task starts', async () => {
  const records = RECORDS();
  const prepare = () => ({ ...PREPARE(records).prepare(), start: '..bad' });
  const { result, prompts } = await runEngine(records, { answers: { prepare }, extraArgs: { keepGoing: true } });
  assert.equal(prompts.length, 0, 'no implementer or reviewer ran');
  assert.match(result.stopped, /invalid start ref/);
});
