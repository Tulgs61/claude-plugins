// Rev 7, amendments 1-2 of the tasks-engine spec: `start` is checked once right after prepare (an
// invalid one starts no agent, blocks every task the run would drive and names itself in `stopped`),
// and `finish` carries the run's own run id as its last argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `answers` overrides the canned answer per subcommand
// (a function of the parts after the ledger path). `opsLines` records each helper command line
// exactly as prompted, `prompts` each ops prompt in full, `agentPrompts` each task agent prompt.
async function runEngine(ledgerTasks, { answers = {}, start = 'abc123', runId = 'test1' } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const opsLines = [];
  const prompts = [];
  const agentPrompts = [];
  const canned = {
    prepare: () => ({ ok: true, start, integration: '/tmp/int', prs: false, tasks: ledgerTasks }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };
  const agent = async (prompt, opts) => {
    if (opts.agentType !== undefined) {
      agentPrompts.push(prompt);
      return /^TASK: /.test(prompt) ? 'done' : GOOD_REVIEW;
    }
    prompts.push(prompt);
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    return { stdout: JSON.stringify(canned[op] ? canned[op](...rest) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId };
  const result = await run(args, agent, () => {}, () => {});
  return { result, opsLines, prompts, agentPrompts };
}

const linesOf = (opsLines, op) => opsLines.filter(l => l.startsWith(`${op} `));

// ---- amendment 1 -------------------------------------------------------------------------------

test('amendment 1: an invalid start starts no agent and blocks every todo and verified task', async () => {
  const ledger = [
    task('T1', ['src/**']),
    task('T2', ['src/**']), // overlaps T1: would not run in parallel, still blocked
    task('T3', ['lib/**'], ['T1']), // prerequisite not merged yet, still blocked
    task('T4', ['doc/**'], [], { status: 'verified' }),
    task('T5', ['etc/**'], [], { status: 'merged' }),
  ];
  const { result, opsLines, agentPrompts } = await runEngine(ledger, { start: 'a..b' });
  assert.equal(agentPrompts.length, 0);
  assert.deepEqual(result.results.map(r => r.id), ['T1', 'T2', 'T3', 'T4']);
  for (const r of result.results) {
    assert.equal(r.status, 'blocked', r.id);
    assert.doesNotMatch(r.note, /[\n\r]/, r.id);
    assert.match(r.note, /start/, r.id);
  }
  const blocked = linesOf(opsLines, 'status');
  assert.deepEqual(blocked.map(l => l.split(' ')[2]), ['T1', 'T2', 'T3', 'T4']);
  for (const l of blocked) assert.match(l, / blocked "/);
  for (const op of ['worktree', 'verify', 'merge', 'prs']) assert.deepEqual(linesOf(opsLines, op), [], op);
  assert.deepEqual(result.blocked, ['T1', 'T2', 'T3', 'T4']);
});

test('amendment 1: stopped names the invalid start, as one line', async () => {
  for (const start of ['-x', 'abc 123', 'a..b', 'bad\nstart', '']) {
    const { result } = await runEngine([task('T1', ['src/**'])], { start });
    const label = JSON.stringify(start);
    assert.equal(typeof result.stopped, 'string', label);
    assert.match(result.stopped, /start/, label);
    assert.ok(result.stopped.includes(JSON.stringify(start).replace(/\s+/g, ' ')), `${label}: ${result.stopped}`);
    assert.doesNotMatch(result.stopped, /[\n\r]/, label);
    assert.ok(result.stopped.length <= 300, label);
  }
});

test('amendment 1: stopped names the invalid start even with no task to drive', async () => {
  for (const ledger of [[], [task('T1', ['src/**'], [], { status: 'merged' }), task('T2', ['lib/**'], [], { status: 'blocked' })]]) {
    const { result, opsLines, agentPrompts } = await runEngine(ledger, { start: '-bad' });
    assert.deepEqual(result.results, []);
    assert.equal(agentPrompts.length, 0);
    assert.deepEqual(linesOf(opsLines, 'status'), []);
    assert.match(result.stopped, /start/);
    assert.ok(result.stopped.includes('"-bad"'), result.stopped);
    const finish = linesOf(opsLines, 'finish');
    assert.equal(finish.length, 1);
    assert.match(finish[0], /^finish "\/tmp\/ledger\.json" stopped "[^"]*-bad[^"]*" test1$/);
  }
});

test('amendment 1: the start is checked once, before any task runs, and not per task', async () => {
  // A valid start lets every task run, independent of their bases.
  const { result, agentPrompts } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'])], {
    start: 'origin/main',
    answers: { worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'task/t/T0' }) },
  });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.status), ['merged', 'merged']);
  assert.equal(agentPrompts.length, 4);
});

test('amendment 1: an invalid start reaches command lines only inside a quoted reason', async () => {
  const { agentPrompts, opsLines } = await runEngine([task('T1', ['src/**'])], { start: 'evil;id' });
  assert.equal(agentPrompts.length, 0);
  for (const l of opsLines.filter(l => l.includes('evil'))) {
    assert.match(l, /^(status "\/tmp\/ledger\.json" T1 blocked|finish "\/tmp\/ledger\.json" stopped) "[^"]*evil;id[^"]*"( test1)?$/, l);
  }
});

// ---- amendment 2 -------------------------------------------------------------------------------

test('amendment 2: a finished run passes its run id as the last argument of finish', async () => {
  const { result, opsLines } = await runEngine([task('T1', ['src/**'])], { runId: 'run-2026-abc' });
  assert.equal(result.stopped, null);
  const finish = linesOf(opsLines, 'finish');
  assert.equal(finish.length, 1, opsLines.join('\n'));
  assert.match(finish[0], /^finish "\/tmp\/ledger\.json" finished /);
  assert.equal(finish[0].split(' ').at(-1), 'run-2026-abc');
});

test('amendment 2: a stopped run passes reason, then run id, to finish', async () => {
  const { result, opsLines } = await runEngine([task('T1', ['src/**'])], {
    runId: 'run-2026-abc',
    answers: { merge: () => ({ ok: false, error: 'conflict' }) },
  });
  assert.notEqual(result.stopped, null);
  const finish = linesOf(opsLines, 'finish');
  assert.equal(finish.length, 1, opsLines.join('\n'));
  assert.match(finish[0], /^finish "\/tmp\/ledger\.json" stopped "T1 blocked: merge failed: conflict" run-2026-abc$/);
});

test('amendment 2: the finish helper call keeps the pinned ops form', async () => {
  for (const merge of [() => ({ ok: true, sha: 'def456' }), () => ({ ok: false, error: 'conflict' })]) {
    const { prompts } = await runEngine([task('T1', ['src/**'])], { answers: { merge } });
    const finishPrompts = prompts.filter(p => /node "\/tmp\/tasks-git\.js" finish /.test(p));
    assert.equal(finishPrompts.length, 1);
    const p = finishPrompts[0];
    assert.match(p, /\nnode "\/tmp\/tasks-git\.js" finish "\/tmp\/ledger\.json" (finished|stopped) .* test1\n/);
    assert.equal(p.indexOf('node "'), p.lastIndexOf('node "'), p);
    // With quotes removed and split on spaces, the parts are subcommand, ledger path, status, ..., run id.
    const parts = p.match(/node "[^"]*" (.*)\n/)[1].replace(/"/g, '').split(' ');
    assert.deepEqual(parts.slice(0, 2), ['finish', '/tmp/ledger.json']);
    assert.equal(parts.at(-1), 'test1');
  }
});

test('amendment 2: a failed prepare does not call finish', async () => {
  const { result, opsLines } = await runEngine([], { answers: { prepare: () => ({ ok: false, error: 'locked', locked: true }) } });
  assert.deepEqual(result.results, []);
  assert.deepEqual(linesOf(opsLines, 'finish'), []);
});
