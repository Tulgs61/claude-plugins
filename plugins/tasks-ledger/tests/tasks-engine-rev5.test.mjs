// Rev 5, amendments 1-3 of the tasks-engine spec: a `start` from prepare is always checked, `..`
// is rejected in ref names, and `stopped` (also from unfinished tasks) and the reason passed to
// `finish` are single lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `answers` overrides the canned answer per subcommand
// (a function of the task id). `opsLines` records each helper command line exactly as prompted.
async function runEngine(ledgerTasks, { answers = {}, start = 'abc123' } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const commands = [];
  const opsLines = [];
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
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    const cmd = line.replace(/"/g, '');
    commands.push(cmd);
    const [op, , id] = cmd.split(' ');
    return { stdout: JSON.stringify(canned[op] ? canned[op](id) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  const result = await run(args, agent, () => {}, () => {});
  return { result, commands, opsLines, agentPrompts };
}

const blockedWith = commands => commands.filter(c => / blocked /.test(c));

// ---- amendment 1 -------------------------------------------------------------------------------

test('amendment 1: an invalid start blocks a task whose base begins with task/', async () => {
  for (const start of ['-x', 'abc 123', 'abc;id', 'a..b', '']) {
    const { result, agentPrompts, commands } = await runEngine([task('T1', ['src/**'], ['T0'])], {
      start,
      answers: {
        prepare: () => ({
          ok: true,
          start,
          integration: '/tmp/int',
          prs: false,
          tasks: [task('T0', ['lib/**'], [], { status: 'merged' }), task('T1', ['src/**'], ['T0'])],
        }),
        worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'task/t/T0' }),
      },
    });
    const label = JSON.stringify(start);
    assert.deepEqual(result.results.map(r => r.status), ['blocked'], label);
    assert.doesNotMatch(result.results[0].note, /[\n\r]/, label);
    assert.match(result.results[0].note, /start/, label);
    assert.equal(agentPrompts.length, 0, label);
    assert.equal(blockedWith(commands).length, 1, label);
    assert.notEqual(result.stopped, null, label);
  }
});

test('amendment 1: an invalid start also blocks a resumed verified task', async () => {
  const { result, commands } = await runEngine([task('T1', ['src/**'], [], { status: 'verified' })], {
    start: 'bad start',
  });
  assert.deepEqual(result.results.map(r => r.status), ['blocked']);
  assert.ok(!commands.some(c => c.startsWith('merge ')), commands.join('\n'));
});

test('amendment 1: every task started with an invalid start is blocked', async () => {
  const { result, agentPrompts } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'])], {
    start: '-bad',
  });
  assert.deepEqual(result.results.map(r => r.status).sort(), ['blocked', 'blocked']);
  assert.equal(agentPrompts.length, 0);
});

test('amendment 1: a missing start is not an error', async () => {
  const { result } = await runEngine([task('T1', ['src/**'])], { start: undefined });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.status), ['merged']);
});

// ---- amendment 2 -------------------------------------------------------------------------------

test('amendment 2: `..` in a branch or base ref blocks the task', async () => {
  const good = { ok: true, worktree: '/tmp/wt-T1', branch: 'task/t/T1', base: 'main' };
  for (const override of [{ branch: 'task/t/..T1' }, { branch: 'task..x' }, { base: 'main..' }, { base: '..main' }]) {
    const { result, agentPrompts } = await runEngine([task('T1', ['src/**'])], {
      answers: { worktree: () => ({ ...good, ...override }) },
    });
    const label = JSON.stringify(override);
    assert.deepEqual(result.results.map(r => r.status), ['blocked'], label);
    assert.equal(agentPrompts.length, 0, label);
  }
});

test('amendment 2: single dots in ref names still pass', async () => {
  const { result } = await runEngine([task('T1', ['src/**'])], {
    start: 'v1.2.3',
    answers: { worktree: () => ({ ok: true, worktree: '/tmp/wt-T1', branch: 'task/t/T1.a', base: 'release/1.0' }) },
  });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.status), ['merged']);
});

// ---- amendment 3 -------------------------------------------------------------------------------

test('amendment 3: stopped from unfinished tasks is a single line naming them', async () => {
  // T2 waits for a prerequisite that never appears, so nothing fails but T2 stays todo.
  const { result } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'], ['T9'])]);
  assert.deepEqual(result.results.map(r => r.status), ['merged']);
  assert.deepEqual(result.waiting, ['T2']);
  assert.equal(typeof result.stopped, 'string');
  assert.doesNotMatch(result.stopped, /[\n\r]|\s\s/);
  assert.ok(result.stopped.length <= 300);
  assert.match(result.stopped, /T2/);
});

test('amendment 3: the reason passed to finish has no line break', async () => {
  const error = `merge\nconflict\r\n  in src/a.js\n${'x\n'.repeat(200)}`;
  const { result, opsLines } = await runEngine([task('T1', ['src/**'])], {
    answers: { merge: () => ({ ok: false, error }) },
  });
  assert.notEqual(result.stopped, null);
  const finish = opsLines.filter(l => l.startsWith('finish '));
  assert.equal(finish.length, 1, opsLines.join('\n'));
  assert.match(finish[0], /^finish "\/tmp\/ledger\.json" stopped "/);
  assert.doesNotMatch(finish[0], /[\n\r]/);
  assert.match(finish[0], /T1 blocked: merge failed: merge conflict in src\/a\.js/);
});
