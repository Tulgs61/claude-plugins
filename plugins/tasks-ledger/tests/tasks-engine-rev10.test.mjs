// Rev 10 of the tasks-engine spec: lock refreshes at agent boundaries, agent types from the ledger,
// tasks that need acceptance, invalid task ids, path arguments, a one-line cut that keeps surrogate
// pairs whole, named takeovers, and the engine's handling of failure paths and of `finish` answers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };
const MINUTE = 60 * 1000;

// Runs the engine against a fake helper, with mocked timers. `answers` overrides the canned answer per
// subcommand (a function of the parts after the ledger path and of the call count of that
// subcommand). `implementer` and `reviewer` replace the task agents; `agentMinutes` is how far every
// task agent call advances the mocked timers, once it is done. `events` records ops lines and task
// agent calls in order (`impl T1`, `impl T1 done`, `review T1`, `review T1 done`).
async function runEngine(ledgerTasks, opts = {}) {
  const {
    answers = {},
    start = 'abc123',
    agents,
    extraArgs = {},
    implementer = () => 'done',
    reviewer = () => GOOD_REVIEW,
    agentMinutes = 0,
  } = opts;
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const events = [];
  const opsLines = [];
  const logs = [];
  const agentTypes = [];
  const counts = {};
  let calls = 0;
  const canned = {
    prepare: () => ({ ok: true, start, integration: '/tmp/int', prs: false, tasks: ledgerTasks, ...(agents !== undefined ? { agents } : {}) }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };
  const agent = async (prompt, options) => {
    calls++;
    if (options.agentType !== undefined) {
      const isImpl = /^TASK: /.test(prompt);
      const id = isImpl ? prompt.match(/^TASK: (\S+)/)[1] : prompt.match(/^Review task (\S+)/)[1];
      const role = isImpl ? 'impl' : 'review';
      agentTypes.push(`${role} ${options.agentType}`);
      events.push(`${role} ${id}`);
      try {
        return await (isImpl ? implementer : reviewer)(id, prompt);
      } finally {
        events.push(`${role} ${id} done`);
        mock.timers.tick(agentMinutes * MINUTE);
      }
    }
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    events.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    counts[op] = (counts[op] || 0) + 1;
    return { stdout: JSON.stringify(canned[op] ? canned[op](...rest, counts[op]) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1', ...extraArgs };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const result = await run(args, agent, () => {}, text => logs.push(String(text)));
    return { result, events, opsLines, logs, agentTypes, calls };
  } catch (error) {
    error.agentCalls = calls;
    throw error;
  } finally {
    mock.timers.reset();
  }
}

const linesOf = (lines, op) => lines.filter(l => l.startsWith(`${op} `));
const isSync = e => e.startsWith('sync ');
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ---- amendment 1: lock refresh at agent boundaries ---------------------------------------------

test('amendment 1: a refresh runs between two long agent calls, and right before and after each', async () => {
  const { result, events } = await runEngine([task('T1', ['src/**'])], { agentMinutes: 11 });
  assert.equal(result.stopped, null);
  const impl = events.indexOf('impl T1');
  const implDone = events.indexOf('impl T1 done');
  const review = events.indexOf('review T1');
  const reviewDone = events.indexOf('review T1 done');
  assert.ok(isSync(events[impl - 1]), `sync right before the implementer:\n${events.join('\n')}`);
  assert.ok(isSync(events[implDone + 1]), `sync right after the implementer:\n${events.join('\n')}`);
  assert.ok(events.slice(implDone + 1, review).some(isSync), 'a refresh between the two agent calls');
  assert.ok(isSync(events[reviewDone + 1]), `sync right after the reviewer:\n${events.join('\n')}`);
  for (const e of events.filter(isSync)) assert.equal(e, 'sync "/tmp/ledger.json" test1');
});

test('amendment 1: a refresh is skipped while the last successful sync is under 10 minutes old', async () => {
  const { result, events } = await runEngine([task('T1', ['src/**'])], { agentMinutes: 4 });
  assert.equal(result.stopped, null);
  const impl = events.indexOf('impl T1');
  const implDone = events.indexOf('impl T1 done');
  const review = events.indexOf('review T1');
  const reviewDone = events.indexOf('review T1 done');
  // No sync before this run's first agent yet: the first boundary refreshes.
  assert.ok(isSync(events[impl - 1]), events.join('\n'));
  // 4 minutes later: skipped; 8 minutes later: still skipped.
  assert.ok(!events.slice(implDone, review).some(isSync), events.join('\n'));
  assert.equal(events[reviewDone + 1].startsWith('sync '), false, events.join('\n'));
});

test('amendment 1: tasks a refresh reports join the schedule, and a failed refresh does not stop the run', async () => {
  const added = task('T2', ['lib/**']);
  const { result, events, logs } = await runEngine([task('T1', ['src/**'])], {
    agentMinutes: 11,
    answers: { sync: (_runId, n) => (n === 1 ? { ok: true, tasks: [added] } : { ok: false, error: 'lock gone' }) },
  });
  // The first sync is the refresh right before T1's implementer.
  assert.ok(events.indexOf('sync "/tmp/ledger.json" test1') < events.indexOf('impl T1'), events.join('\n'));
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => `${r.id} ${r.status}`), ['T1 merged', 'T2 merged']);
  assert.ok(logs.some(l => /sync failed: lock gone/.test(l)), logs.join('\n'));
  // Every later sync failed, so every agent boundary after the first tried a refresh.
  assert.ok(events.filter(isSync).length >= 8, events.join('\n'));
});

// ---- amendment 2: agent types from the ledger --------------------------------------------------

test('amendment 2: the ledger agents are used when args give none', async () => {
  const { result, agentTypes } = await runEngine([task('T1', ['src/**'])], {
    agents: { implementer: 'ledger-impl', reviewer: 'other:ledger_rev' },
  });
  assert.equal(result.stopped, null);
  assert.deepEqual(agentTypes, ['impl ledger-impl', 'review other:ledger_rev']);
});

test('amendment 2: args override the ledger agents, key by key, and defaults fill the rest', async () => {
  const one = await runEngine([task('T1', ['src/**'])], {
    agents: { implementer: 'ledger-impl', reviewer: 'ledger-rev' },
    extraArgs: { reviewerAgent: 'arg-rev' },
  });
  assert.deepEqual(one.agentTypes, ['impl ledger-impl', 'review arg-rev']);
  const two = await runEngine([task('T1', ['src/**'])], {
    agents: { reviewer: 'ledger-rev' },
    extraArgs: { reviewerAgent: 'arg-rev', implementerAgent: 'arg-impl' },
  });
  assert.deepEqual(two.agentTypes, ['impl arg-impl', 'review arg-rev']);
  const three = await runEngine([task('T1', ['src/**'])], { agents: { reviewer: 'ledger-rev' } });
  assert.deepEqual(three.agentTypes, ['impl tasks-ledger:task-implementer', 'review ledger-rev']);
  const four = await runEngine([task('T1', ['src/**'])], { agents: null });
  assert.deepEqual(four.agentTypes, ['impl tasks-ledger:task-implementer', 'review tasks-ledger:reviewer']);
});

test('amendment 2: an invalid ledger agent starts no agent and is named in stopped', async () => {
  for (const [key, value] of [['implementer', 'bad name'], ['reviewer', 'x"; rm -rf /'], ['reviewer', 42], ['implementer', '']]) {
    const label = `${key}=${JSON.stringify(value)}`;
    const { result, agentTypes, opsLines } = await runEngine([task('T1', ['src/**'])], { agents: { [key]: value } });
    assert.deepEqual(agentTypes, [], label);
    assert.deepEqual(linesOf(opsLines, 'worktree'), [], label);
    assert.match(result.stopped, new RegExp(`agents\\.${key} must match`), label);
    assert.deepEqual(result.waiting, ['T1'], label);
    assert.equal(linesOf(opsLines, 'finish').length, 1, label);
  }
  // A valid args value means the invalid ledger value is never taken.
  const { result } = await runEngine([task('T1', ['src/**'])], {
    agents: { implementer: 'bad name' },
    extraArgs: { implementerAgent: 'good-impl' },
  });
  assert.equal(result.stopped, null);
});

// ---- amendment 3: tasks that need acceptance ---------------------------------------------------

test('amendment 3: a needsAcceptance task is blocked through the helper and no agent runs for it', async () => {
  const { result, opsLines, events } = await runEngine([
    task('T1', ['src/**'], [], { acceptance: '', needsAcceptance: true }),
    task('T2', ['lib/**'], [], { needsAcceptance: false }),
  ]);
  const t1 = result.results.find(r => r.id === 'T1');
  assert.equal(t1.status, 'blocked');
  assert.equal(t1.note, 'needs acceptance');
  assert.deepEqual(linesOf(opsLines, 'status').filter(l => l.includes(' T1 ')), ['status "/tmp/ledger.json" T1 blocked "needs acceptance"']);
  assert.ok(!events.some(e => / T1( |$)/.test(e) && !e.startsWith('status ')), events.join('\n'));
  assert.ok(result.blocked.includes('T1'));
  assert.match(result.stopped, /T1/);
});

// ---- amendment 4: task ids ---------------------------------------------------------------------

test('amendment 4: invalid task ids are never started, appear in blocked and stopped, and get no status call', async () => {
  const { result, opsLines, events } = await runEngine([
    task('X1', ['src/**'], ['T9']), // its prerequisite does not exist, so it would never become ready
    task(7, ['lib/**']),
    task('T1', ['doc/**']),
  ]);
  // Amendment 10: the valid task keeps running; only the invalid ids never start.
  assert.deepEqual(events.filter(e => /^(impl|review) \S+$/.test(e)), ['impl T1', 'review T1']);
  assert.deepEqual(result.results.filter(r => r.id === 'T1').map(r => r.status), ['merged']);
  assert.ok(result.blocked.includes('X1'), JSON.stringify(result.blocked));
  assert.ok(result.blocked.includes('7'), JSON.stringify(result.blocked));
  assert.ok(!result.waiting.includes('X1'));
  assert.match(result.stopped, /X1/);
  assert.match(result.stopped, /7/);
  // Only the quoted run reason of `finish` may name them.
  for (const l of opsLines.filter(l => !l.startsWith('finish '))) assert.doesNotMatch(l, /X1|^status "\/tmp\/ledger\.json" 7 /, l);
});

test('amendment 4: an invalid id is named in stopped even when another failure came first', async () => {
  const { result, opsLines } = await runEngine([task('T1', ['src/**'])], {
    answers: {
      merge: () => ({ ok: false, error: 'conflict' }),
      // Only the sync after T1 ended (the first one is the refresh before its implementer).
      sync: (_runId, n) => ({ ok: true, tasks: n >= 2 ? [task('bad-1', ['x/**'])] : [] }),
    },
  });
  assert.match(result.stopped, /bad-1/);
  assert.match(result.stopped, /T1 blocked: merge failed: conflict/);
  assert.ok(result.blocked.includes('bad-1'));
  assert.ok(!opsLines.some(l => l.includes('bad-1') && !l.startsWith('finish ')), opsLines.join('\n'));
});

// ---- amendment 5: path arguments ---------------------------------------------------------------

test('amendment 5: path arguments with whitespace or control characters throw before any agent runs', async () => {
  const bad = [
    { ledger: '/tmp/my ledger.json' },
    { ledger: '/tmp/ledger\t.json' },
    { ledger: '/tmp/ledger\u00a0.json' },
    { ledger: 'tmp/ledger.json' },
    { script: '/tmp/tasks\u2028git.js' },
    { script: '/tmp/tasks\u2029git.js' },
    { script: '/tmp/tasks\u0085git.js' },
    { script: '/tmp/tasks\u009bgit.js' },
    { script: '/tmp/tasks\u007fgit.js' },
  ];
  for (const extra of bad) {
    const key = Object.keys(extra)[0];
    await assert.rejects(
      runEngine([task('T1', ['src/**'])], { extraArgs: extra }),
      e => new RegExp(`args\\.${key} must match`).test(e.message) && e.agentCalls === 0,
      JSON.stringify(extra)
    );
  }
});

test('amendment 5: a worktree with a line separator or C1 control is refused, one with spaces passes', async () => {
  for (const wt of ['/tmp/wt\u2028T1', '/tmp/wt\u2029T1', '/tmp/wt\u0085T1', '/tmp/wt\tT1']) {
    const { result, agentTypes } = await runEngine([task('T1', ['src/**'])], {
      answers: { worktree: () => ({ ok: true, worktree: wt, branch: 'task/t/T1', base: 'main' }) },
    });
    assert.deepEqual(agentTypes, [], JSON.stringify(wt));
    assert.equal(result.results[0].status, 'blocked', JSON.stringify(wt));
    assert.match(result.results[0].note, /worktree/);
  }
  const { result } = await runEngine([task('T1', ['src/**'])], {
    answers: { worktree: () => ({ ok: true, worktree: '/tmp/my wt T1', branch: 'task/t/T1', base: 'main' }) },
  });
  assert.equal(result.stopped, null);
});

// ---- amendment 6: one-line cut -----------------------------------------------------------------

test('amendment 6: the 300-character cut never splits an emoji', async () => {
  const prefix = 'T1 blocked: merge failed: ';
  // The emoji's two halves sit at positions 299 and 300, so a plain cut at 300 splits it.
  const error = 'x'.repeat(299 - prefix.length) + '\u{1F600}' + 'y'.repeat(20);
  const { result } = await runEngine([task('T1', ['src/**'])], { answers: { merge: () => ({ ok: false, error }) } });
  assert.doesNotMatch(result.stopped, LONE_SURROGATE);
  assert.equal(result.stopped, prefix + 'x'.repeat(299 - prefix.length));
  // When the whole pair fits, it stays.
  const fits = 'x'.repeat(298 - prefix.length) + '\u{1F600}' + 'y'.repeat(20);
  const two = await runEngine([task('T1', ['src/**'])], { answers: { merge: () => ({ ok: false, error: fits }) } });
  assert.equal(two.result.stopped, prefix + 'x'.repeat(298 - prefix.length) + '\u{1F600}');
});

test('amendment 6: a cut start ref in stopped keeps surrogate pairs whole', async () => {
  // The quoted start is cut to 80 characters; the emoji's halves sit at 79 and 80.
  const start = 'a'.repeat(78) + '\u{1F600}' + 'b'.repeat(10);
  const { result } = await runEngine([task('T1', ['src/**'])], { start });
  assert.doesNotMatch(result.stopped, LONE_SURROGATE);
  assert.ok(result.stopped.endsWith('"' + 'a'.repeat(78)), result.stopped);
});

// ---- amendment 8: named takeover ---------------------------------------------------------------

test('amendment 8: a run-id takeover is passed to prepare, other truthy values stay bare', async () => {
  const named = await runEngine([], { extraArgs: { takeover: 'old-run-2026' } });
  assert.deepEqual(linesOf(named.opsLines, 'prepare'), ['prepare "/tmp/ledger.json" test1 takeover old-run-2026']);
  for (const takeover of [true, 1, { yes: true }]) {
    const bare = await runEngine([], { extraArgs: { takeover } });
    assert.deepEqual(linesOf(bare.opsLines, 'prepare'), ['prepare "/tmp/ledger.json" test1 takeover'], JSON.stringify(takeover));
  }
  for (const takeover of [undefined, false, null, 0]) {
    const none = await runEngine([], { extraArgs: { takeover } });
    assert.deepEqual(linesOf(none.opsLines, 'prepare'), ['prepare "/tmp/ledger.json" test1'], String(takeover));
  }
});

test('amendment 8: a takeover string that is no run id throws before any agent runs', async () => {
  for (const takeover of ['abc', 'old run', 'run;id', 'x'.repeat(65), 'run\n1', '']) {
    await assert.rejects(
      runEngine([task('T1', ['src/**'])], { extraArgs: { takeover } }),
      e => /args\.takeover must match/.test(e.message) && e.agentCalls === 0,
      JSON.stringify(takeover)
    );
  }
});

test('amendment 8: the prepare helper call keeps the pinned ops form with a named takeover', async () => {
  const { result, opsLines } = await runEngine([task('T1', ['src/**'])], { extraArgs: { takeover: 'old-run-2026' } });
  assert.equal(result.stopped, null);
  const parts = opsLines[0].replace(/"/g, '').split(' ');
  assert.deepEqual(parts, ['prepare', '/tmp/ledger.json', 'test1', 'takeover', 'old-run-2026']);
});

// ---- amendment 9: failure paths and `finish` ---------------------------------------------------

// Each failure path blocks the task with a note, both in `results` and in the ledger, and refreshes
// the lock right after every long agent call it made.
const failures = {
  'worktree refused': { answers: { worktree: () => ({ ok: false, error: 'branch exists' }) }, note: /worktree failed: branch exists/, agents: [] },
  'verify refused twice': {
    answers: { verify: () => ({ ok: false, error: 'tests failed', tail: 'boom' }) },
    note: /verification failed twice: tests failed/,
    agents: ['impl T1', 'impl T1'],
  },
  'merge refused': { answers: { merge: () => ({ ok: false, error: 'conflict' }) }, note: /merge failed: conflict/, agents: ['impl T1', 'review T1'] },
  'status verified refused': {
    answers: { status: (_id, state) => (state === 'verified' ? { ok: false, error: 'ledger busy' } : { ok: true }) },
    note: /could not record verified: ledger busy/,
    agents: ['impl T1', 'review T1'],
  },
  'implementer never finishes': { implementer: () => null, note: /the implementer did not finish/, agents: ['impl T1'] },
  'implementer throws': {
    implementer: () => {
      throw new Error('agent crashed');
    },
    note: /unexpected error: agent crashed/,
    agents: ['impl T1'],
  },
};

for (const [name, spec] of Object.entries(failures)) {
  test(`amendment 9: ${name} blocks the task with a note`, async () => {
    const { result, opsLines, events } = await runEngine([task('T1', ['src/**'])], { agentMinutes: 11, ...spec });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'blocked');
    assert.match(result.results[0].note, spec.note);
    assert.deepEqual(result.blocked, ['T1']);
    assert.match(result.stopped, spec.note);
    const blockedLines = linesOf(opsLines, 'status').filter(l => / T1 blocked "/.test(l));
    assert.equal(blockedLines.length, 1, opsLines.join('\n'));
    assert.deepEqual(events.filter(e => /^(impl|review) T1$/.test(e)), spec.agents);
    for (const role of new Set(spec.agents)) {
      const done = events.lastIndexOf(`${role} done`);
      assert.ok(isSync(events[done + 1]), `refresh after ${role}:\n${events.join('\n')}`);
    }
  });
}

test('amendment 9: a refused status blocked call still blocks the task, with a note saying so', async () => {
  const { result } = await runEngine([task('T1', ['src/**'])], {
    agentMinutes: 11,
    answers: { status: () => ({ ok: false, error: 'ledger busy' }) },
  });
  assert.equal(result.results[0].status, 'blocked');
  assert.match(result.results[0].note, /could not record verified: ledger busy \(ledger not updated: ledger busy\)/);
});

test('amendment 9: a task that becomes ready later is not started under an invalid start', async () => {
  const { result, agentTypes, opsLines } = await runEngine(
    [task('T1', ['src/**']), task('T2', ['src/**'], ['T1']), task('T3', ['lib/**'], [], { needsAcceptance: true })],
    { start: 'bad..start' }
  );
  assert.deepEqual(agentTypes, []);
  assert.deepEqual(linesOf(opsLines, 'worktree'), []);
  assert.deepEqual(linesOf(opsLines, 'sync'), []);
  assert.deepEqual(result.results.map(r => `${r.id} ${r.status}`), ['T1 blocked', 'T2 blocked', 'T3 blocked']);
  assert.match(result.stopped, /start/);
});

test('amendment 9: a stopped text from many unfinished tasks is cut to 300 characters', async () => {
  const ledger = Array.from({ length: 60 }, (_, i) => task(`T${i + 1}`, [`d${i}/**`], ['T999']));
  const { result, opsLines } = await runEngine(ledger, { agentMinutes: 11 });
  assert.match(result.stopped, /^unfinished tasks: T1 todo, T2 todo/);
  assert.equal(result.stopped.length, 300);
  assert.doesNotMatch(result.stopped, /[\n\r]/);
  assert.equal(result.waiting.length, 60);
  // No agent ran, so no refresh happened either: only the end-of-schedule sync.
  assert.equal(linesOf(opsLines, 'sync').length, 1);
  const finish = linesOf(opsLines, 'finish');
  assert.equal(finish.length, 1);
  assert.match(finish[0], /^finish "\/tmp\/ledger\.json" stopped "unfinished tasks: T1 todo, [^"]*" test1$/);
});

test('amendment 9: a finish answered with ok false is reported in stopped, once, not retried', async () => {
  const { result, opsLines, logs } = await runEngine([task('T1', ['src/**'])], {
    answers: { finish: () => ({ ok: false, error: 'disk full' }) },
  });
  assert.deepEqual(result.results.map(r => r.status), ['merged']);
  assert.equal(linesOf(opsLines, 'finish').length, 1);
  assert.match(linesOf(opsLines, 'finish')[0], /^finish "\/tmp\/ledger\.json" finished "" test1$/);
  assert.equal(result.stopped, 'finish failed: disk full');
  assert.equal(result.locked, false);
  assert.ok(logs.some(l => /finish failed: disk full/.test(l)));
});

test('amendment 9: a superseded finish reports the foreign lock and keeps the run reason', async () => {
  const superseded = () => ({ ok: false, locked: true, error: 'another run (other-run-1, 2 min old) holds the lock' });
  const clean = await runEngine([task('T1', ['src/**'])], { answers: { finish: superseded } });
  assert.equal(clean.result.locked, true);
  assert.match(clean.result.stopped, /another run \(other-run-1/);
  assert.equal(linesOf(clean.opsLines, 'finish').length, 1);

  const failed = await runEngine([task('T1', ['src/**'])], {
    answers: { finish: superseded, merge: () => ({ ok: false, error: 'conflict' }) },
  });
  assert.equal(failed.result.locked, true);
  assert.match(failed.result.stopped, /^T1 blocked: merge failed: conflict; .*another run \(other-run-1/);
  assert.doesNotMatch(failed.result.stopped, /[\n\r]/);
  assert.ok(failed.result.stopped.length <= 300);
});

test('amendment 9: a successful finish leaves stopped null and locked false', async () => {
  const { result } = await runEngine([task('T1', ['src/**'])]);
  assert.equal(result.stopped, null);
  assert.equal(result.locked, false);
});
