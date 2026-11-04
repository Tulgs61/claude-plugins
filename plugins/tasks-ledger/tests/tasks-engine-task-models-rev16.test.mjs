// Per-task models: a task's `model` picks its implementer's model and `reviewModel` its reviewer's;
// unset leaves the agent definition's model. The helper hands both through `task` and refuses a ledger
// that names any other model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from './helpers/relay.mjs';
import { sandbox, task as sandboxTask } from './helpers/git-sandbox.mjs';

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

// Runs the engine and records the options of every implementer and reviewer call per task.
async function taskAgentCalls(records) {
  const calls = [];
  await runEngine(records, {
    taskAgent: (prompt, options) => {
      const id = (/\b(T[0-9]+)\b/.exec(prompt) || [])[1];
      const role = /^TASK: /.test(prompt) ? 'implementer' : 'reviewer';
      calls.push({ id, role, options });
      if (role === 'implementer') return 'done';
      return {
        verdict: 'verified',
        acceptance_met: true,
        scope_ok: true,
        constraints_ok: true,
        findings: [],
        evidence: 'ok',
      };
    },
  });
  return calls;
}

test('a task model goes to the implementer and a review model to the reviewer', async () => {
  const calls = await taskAgentCalls([task('T1', { model: 'haiku', reviewModel: 'sonnet' })]);
  const impl = calls.filter(c => c.role === 'implementer');
  const rev = calls.filter(c => c.role === 'reviewer');
  assert.equal(impl.length, 1);
  assert.equal(rev.length, 1);
  assert.equal(impl[0].options.model, 'haiku');
  assert.equal(impl[0].options.agentType, 'tasks-ledger:task-implementer');
  assert.equal(rev[0].options.model, 'sonnet');
  assert.equal(rev[0].options.agentType, 'tasks-ledger:reviewer');
  assert.ok(rev[0].options.schema, 'the reviewer keeps its schema');
});

test('without task models no model option is passed, so the agent definitions decide', async () => {
  const calls = await taskAgentCalls([task('T1'), task('T2', { model: null, reviewModel: null })]);
  assert.equal(calls.length, 4);
  for (const c of calls) assert.ok(!('model' in c.options), `${c.id} ${c.role} passes no model`);
});

test('a model of one task does not leak into another task', async () => {
  const calls = await taskAgentCalls([task('T1', { model: 'opus', reviewModel: 'opus' }), task('T2')]);
  for (const c of calls.filter(x => x.id === 'T1')) assert.equal(c.options.model, 'opus');
  for (const c of calls.filter(x => x.id === 'T2')) assert.ok(!('model' in c.options));
});

test('an unknown model in a record is ignored by the engine', async () => {
  const calls = await taskAgentCalls([task('T1', { model: 'gpt', reviewModel: 'claude-opus' })]);
  for (const c of calls) assert.ok(!('model' in c.options));
});

test('the implementer retry after a failed verify keeps the task model', async () => {
  const calls = [];
  await runEngine([task('T1', { model: 'sonnet' })], {
    answers: { verify: (_id, n) => (n === 1 ? { ok: false, error: 'verify.cmd exited 1', tail: 'FAIL' } : { ok: true, tail: 'ok' }) },
    taskAgent: (prompt, options) => {
      calls.push({ prompt, options });
      return /^TASK: /.test(prompt)
        ? 'done'
        : { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };
    },
  });
  const impl = calls.filter(c => /^TASK: /.test(c.prompt));
  assert.equal(impl.length, 2);
  for (const c of impl) assert.equal(c.options.model, 'sonnet');
});

test('helper: task hands model and reviewModel through, null when unset', t => {
  const sb = sandbox(t, {
    tasks: [sandboxTask('T1', ['a/**'], [], { model: 'haiku', reviewModel: 'opus' }), sandboxTask('T2', ['b/**'])],
  });
  sb.ok('prepare', 'run-models');
  const one = sb.ok('task', 'T1').task;
  assert.equal(one.model, 'haiku');
  assert.equal(one.reviewModel, 'opus');
  const two = sb.ok('task', 'T2').task;
  assert.equal(two.model, null);
  assert.equal(two.reviewModel, null);
});

test('helper: a ledger naming any other model is refused', t => {
  for (const [field, value] of [['model', 'gpt-4'], ['reviewModel', 'Opus'], ['model', 3]]) {
    const sb = sandbox(t, { tasks: [sandboxTask('T1', ['a/**'], [], { [field]: value })] });
    const r = sb.run('prepare', 'run-bad');
    assert.equal(r.ok, false, `${field} ${JSON.stringify(value)} is refused`);
    assert.match(r.error, new RegExp(`invalid ${field} .* of T1: expected one of haiku, sonnet, opus`));
  }
});
