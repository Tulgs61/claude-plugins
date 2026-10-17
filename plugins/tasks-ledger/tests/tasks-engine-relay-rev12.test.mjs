// Rev 12: the engine takes a relayed helper answer only when its check holds. An answer the relay
// shortened, changed or sent without its check is a failed attempt and the command runs again; the
// task summary only schedules tasks, and what an agent is told comes from the task's dispatch record,
// fetched with `task <id>` right before the task is dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';
import { sealed, summaryOf } from './helpers/relay.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');
const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `records` are the ledger tasks: prepare lists their summary
// and `task <id>` returns the record. `answers` overrides the payload per subcommand (a function of
// the parts after the ledger path and of the call count). `relay(op, n, line)` turns the sealed
// answer line of the n-th call of `op` into the stdout the ops agent hands back (default: as is).
async function runEngine(records, { answers = {}, relay = (_op, _n, line) => line } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const opsLines = [];
  const prompts = [];
  const logs = [];
  const counts = {};
  const byId = new Map(records.map(r => [r.id, r]));
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: records.map(summaryOf) }),
    task: id => (byId.has(id) ? { ok: true, task: byId.get(id) } : { ok: false, error: `no task ${id}` }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    finish: () => ({ ok: true, runStatus: 'finished', tasks: records.map(summaryOf) }),
    ...answers,
  };
  const agent = async (prompt, options) => {
    if (options.agentType !== undefined) {
      prompts.push(prompt);
      return /^TASK: /.test(prompt) ? 'done' : GOOD_REVIEW;
    }
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    counts[op] = (counts[op] || 0) + 1;
    const payload = canned[op] ? canned[op](...rest, counts[op]) : { ok: true };
    return { stdout: relay(op, counts[op], sealed(payload), payload) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  const result = await run(args, agent, () => {}, message => logs.push(message));
  return { result, opsLines, prompts, logs, counts };
}

const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);
const noteOf = (result, id) => result.results.find(r => r.id === id).note;

// What the relay in production did: every task cut down to id, status, branch and base, with the
// helper's check left as it was.
function abridged(line) {
  const answer = JSON.parse(line);
  answer.tasks = answer.tasks.map(({ id, status, branch, base }) => ({ id, status, branch, base }));
  return JSON.stringify(answer);
}

test('an abridged prepare answer fails its check and prepare runs again; the intact answer drives the run', async () => {
  const { result, counts, logs } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'])], {
    relay: (op, n, line) => (op === 'prepare' && n === 1 ? abridged(line) : line),
  });
  assert.equal(counts.prepare, 2);
  assert.equal(result.stopped, null, logs.join('\n'));
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.deepEqual(statusOf(result, 'T2'), ['merged']);
  assert.ok(logs.some(l => /helper answer failed its check \(prepare, attempt 1 of 3\)/.test(l)), logs.join('\n'));
});

test('a prepare answer abridged in every attempt stops the run before any task agent', async () => {
  const { result, counts, prompts } = await runEngine([task('T1', ['src/**'])], {
    relay: (op, _n, line) => (op === 'prepare' ? abridged(line) : line),
  });
  assert.equal(counts.prepare, 3);
  assert.deepEqual(prompts, []);
  assert.deepEqual(result.results, []);
  assert.match(result.stopped, /^prepare failed: helper answer was altered in transit: 3 of 3 relayed answers to prepare failed their check/);
});

test('a tampered value fails the check: a changed worktree path is never used', async () => {
  const { result, counts, prompts } = await runEngine([task('T1', ['src/**'])], {
    relay: (op, n, line) => (op === 'worktree' && n <= 2 ? line.replace('/tmp/wt-T1', '/tmp/elsewhere') : line),
  });
  assert.equal(counts.worktree, 3);
  assert.equal(result.stopped, null);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  for (const p of prompts) assert.doesNotMatch(p, /elsewhere/);
  assert.ok(prompts.some(p => p.includes('Worktree: /tmp/wt-T1')));
});

test('a tampered ok:false answer is not final, and a tampered value in every attempt blocks the task', async () => {
  // A relayed failure whose check fails is retried like any altered answer.
  const flipped = await runEngine([task('T1', ['src/**'])], {
    answers: { verify: (_id, n) => (n === 1 ? { ok: false, error: 'real failure' } : { ok: true, tail: 'ok' }) },
    relay: (op, n, line) => (op === 'verify' && n === 1 ? line.replace('real failure', 'fake failure') : line),
  });
  assert.equal(flipped.counts.verify, 2);
  assert.deepEqual(statusOf(flipped.result, 'T1'), ['merged']);

  const always = await runEngine([task('T1', ['src/**'])], {
    relay: (op, _n, line) => (op === 'merge' ? line.replace('def456', 'bad000') : line),
  });
  assert.equal(always.counts.merge, 3);
  assert.deepEqual(statusOf(always.result, 'T1'), ['blocked']);
  assert.match(noteOf(always.result, 'T1'), /^merge failed: helper answer was altered in transit: 3 of 3 relayed answers to merge failed their check/);
});

test('an answer without its check, or with a malformed one, is rejected', async () => {
  const variants = {
    'no check': line => {
      const { len, sum, ...payload } = JSON.parse(line);
      return JSON.stringify(payload);
    },
    'len as text': line => line.replace(/"len":(\d+)/, '"len":"$1"'),
    'wrong sum': line => line.replace(/"sum":"[0-9a-f]{8}"/, '"sum":"00000000"'),
    'wrong len': line => line.replace(/"len":(\d+)/, (_m, n) => `"len":${Number(n) + 1}`),
    'keys reordered': line => {
      const { ok, ...rest } = JSON.parse(line);
      return JSON.stringify({ ...rest, ok });
    },
  };
  for (const [label, change] of Object.entries(variants)) {
    const { result, counts } = await runEngine([task('T1', ['src/**'])], { relay: (op, _n, line) => (op === 'prepare' ? change(line) : line) });
    assert.equal(counts.prepare, 3, label);
    assert.match(result.stopped, /^prepare failed: helper answer was altered in transit/, label);
  }
});

test('a copy that differs only in whitespace or surrounding lines passes the check', async () => {
  const { result, counts } = await runEngine([task('T1', ['src/**'])], {
    relay: (_op, _n, line) => `Command output:\n${JSON.stringify(JSON.parse(line), null, 0).replace(/,"/g, ', "').replace(/":/g, '": ')}\n`,
  });
  assert.equal(counts.prepare, 1);
  assert.equal(result.stopped, null);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
});

test('the dispatch record is fetched right before each task starts and feeds the implementer and reviewer prompts', async () => {
  const { result, opsLines, prompts } = await runEngine([
    task('T1', ['src/**'], [], { title: 'Rename the API', acceptance: 'the API is renamed', proof: 'npm test -- api', budget: '7 turns', constraints: ['keep v1 routes'] }),
  ]);
  assert.equal(result.stopped, null);
  const fetched = opsLines.indexOf('task "/tmp/ledger.json" T1');
  assert.ok(fetched > 0 && fetched < opsLines.indexOf('worktree "/tmp/ledger.json" T1'), opsLines.join('\n'));
  const [impl, review] = prompts;
  assert.match(impl, /^TASK: T1 Rename the API/);
  assert.match(impl, /OUTCOME:\nthe API is renamed/);
  assert.match(impl, /Run `npm test -- api`/);
  assert.match(impl, /- keep v1 routes/);
  assert.match(impl, /BUDGET:\n7 turns\./);
  assert.match(review, /^Review task T1 of a tasks-ledger run: Rename the API/);
  assert.match(review, /Acceptance: the API is renamed/);
  assert.match(review, /Proof the implementer had to run: npm test -- api/);
  assert.match(review, /- keep v1 routes/);
});

test('a task is blocked as not dispatchable only when its fetched record lacks a proof or a budget', async () => {
  // The summary never carries proof or budget; a record with both dispatches.
  const fine = await runEngine([task('T1', ['src/**'])]);
  assert.deepEqual(statusOf(fine.result, 'T1'), ['merged']);

  const { result, prompts, opsLines } = await runEngine([
    task('T1', ['src/**'], [], { proof: '' }),
    task('T2', ['lib/**'], [], { budget: '  ' }),
    task('T3', ['doc/**']),
  ]);
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T2'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T3'), ['merged']);
  assert.equal(noteOf(result, 'T1'), 'not dispatchable: the task has no proof or no budget');
  assert.equal(noteOf(result, 'T2'), 'not dispatchable: the task has no proof or no budget');
  assert.ok(!prompts.some(p => /^(TASK|Review task) T[12]\b/.test(p)));
  assert.ok(!opsLines.some(l => /^worktree .* T[12]$/.test(l)));
});

test('a record that turns out title-only is set aside as needs acceptance, not a failure', async () => {
  const records = [task('T1', ['src/**'], [], { acceptance: '', proof: '' }), task('T2', ['lib/**'])];
  // A summary that did not mark T1 (an older ledger state): the fetched record decides.
  const { result, opsLines } = await runEngine(records, {
    answers: { prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: records.map(r => ({ ...summaryOf(r), needsAcceptance: false })) }) },
  });
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(statusOf(result, 'T2'), ['merged']);
  assert.ok(opsLines.includes('status "/tmp/ledger.json" T1 blocked "needs acceptance"'), opsLines.join('\n'));
  assert.equal(result.stopped, 'T1 needs acceptance');
});

test('a task whose record cannot be read, or names another task, is blocked without an agent', async () => {
  const unreadable = await runEngine([task('T1', ['src/**'])], { answers: { task: () => ({ ok: false, error: 'no task T1' }) } });
  assert.deepEqual(statusOf(unreadable.result, 'T1'), ['blocked']);
  assert.equal(noteOf(unreadable.result, 'T1'), 'could not read the task record: no task T1');
  assert.deepEqual(unreadable.prompts, []);

  const other = await runEngine([task('T1', ['src/**'])], { answers: { task: () => ({ ok: true, task: task('T2', ['src/**']) }) } });
  assert.deepEqual(statusOf(other.result, 'T1'), ['blocked']);
  assert.equal(noteOf(other.result, 'T1'), 'could not read the task record: the helper returned no record for T1');
  assert.deepEqual(other.prompts, []);
});

test('the ops prompt asks for a verbatim copy and names the check', async () => {
  let prompt = null;
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  await run(
    { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' },
    async p => {
      prompt = prompt || p;
      return { stdout: sealed({ ok: false, error: 'stop here' }) };
    },
    () => {},
    () => {}
  );
  assert.match(prompt, /copied verbatim/);
  assert.match(prompt, /however long it is/);
  assert.match(prompt, /Do not summarise, shorten, abridge or truncate it/);
  assert.match(prompt, /do not drop, rename or add any field/);
  assert.match(prompt, /`len` and\s+`sum`/);
});
