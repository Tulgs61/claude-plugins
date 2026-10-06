// The tasks-engine keeps its run lock fresh with one timer instead of the clock: the Workflow runtime
// makes the clock and `Math.random` throw, provides `setTimeout` and `clearTimeout`, and a heartbeat
// `sync` runs while a long implementer or reviewer call is in progress. No timer outlives the run.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };
const MINUTE = 60 * 1000;
const REFRESH_MS = 10 * MINUTE;
const UNAVAILABLE = 'unavailable in workflow scripts (breaks resume)';

// Lets every pending promise reaction run; `setImmediate` is not mocked.
const drain = () => new Promise(resolve => setImmediate(resolve));

// Makes the clock and `Math.random` throw as the Workflow runtime does, and returns the restore step.
function runtimeClockRules() {
  const RealDate = Date;
  const realRandom = Math.random;
  function RuntimeDate(...parts) {
    if (!new.target || parts.length === 0) throw new Error(`Date ${UNAVAILABLE}`);
    return new RealDate(...parts);
  }
  RuntimeDate.prototype = RealDate.prototype;
  RuntimeDate.UTC = RealDate.UTC;
  RuntimeDate.parse = RealDate.parse;
  RuntimeDate.now = () => {
    throw new Error(`Date.now() ${UNAVAILABLE}`);
  };
  globalThis.Date = RuntimeDate;
  Math.random = () => {
    throw new Error(`Math.random() ${UNAVAILABLE}`);
  };
  return () => {
    globalThis.Date = RealDate;
    Math.random = realRandom;
  };
}

// Starts the engine against a fake helper, under the runtime clock rules and with mocked timers.
// `answers` overrides the canned answer per subcommand (a function of the parts after the ledger path,
// the call count of that subcommand, and the harness state, which also holds `advance`; it may return
// a promise). `implementer` and `reviewer` replace the
// task agents. `events` records ops lines and task agent calls in order, `syncs` the mocked minute of
// every `sync` call and whether a task agent was in progress then. `pending` holds the ids of the
// armed timers. Call `done()` once the result is in to restore the globals.
function startEngine(ledgerTasks, opts = {}) {
  const { answers = {}, implementer = () => 'done', reviewer = () => GOOD_REVIEW } = opts;
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const state = { minute: 0, agentsInProgress: 0 };
  const events = [];
  const opsLines = [];
  const logs = [];
  const syncs = [];
  const counts = {};
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: ledgerTasks }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };

  mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Set();
  const mockedSetTimeout = globalThis.setTimeout;
  const mockedClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = mockedSetTimeout(
      (...a) => {
        pending.delete(id);
        fn(...a);
      },
      ms,
      ...rest
    );
    pending.add(id);
    return id;
  };
  globalThis.clearTimeout = id => {
    pending.delete(id);
    mockedClearTimeout(id);
  };
  const restoreClock = runtimeClockRules();

  // Moves the mocked timers forward one minute at a time, draining the microtask queue after each.
  const advance = async minutes => {
    for (let i = 0; i < minutes; i++) {
      state.minute++;
      mock.timers.tick(MINUTE);
      await drain();
    }
  };
  state.advance = advance;

  const agent = async (prompt, options) => {
    if (options.agentType !== undefined) {
      const isImpl = /^TASK: /.test(prompt);
      const id = isImpl ? prompt.match(/^TASK: (\S+)/)[1] : prompt.match(/^Review task (\S+)/)[1];
      const role = isImpl ? 'impl' : 'review';
      events.push(`${role} ${id}`);
      state.agentsInProgress++;
      try {
        return await (isImpl ? implementer : reviewer)(id, advance);
      } finally {
        state.agentsInProgress--;
        events.push(`${role} ${id} done`);
      }
    }
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    events.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    counts[op] = (counts[op] || 0) + 1;
    const answer = canned[op] ? await canned[op](...rest, counts[op], state) : { ok: true };
    if (op === 'sync') syncs.push({ minute: state.minute, during: state.agentsInProgress > 0, ok: answer.ok === true });
    return { stdout: JSON.stringify(answer) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  let restored = false;
  const done = () => {
    if (restored) return;
    restored = true;
    restoreClock();
    globalThis.setTimeout = mockedSetTimeout;
    globalThis.clearTimeout = mockedClearTimeout;
    mock.timers.reset();
  };
  const promise = run(args, agent, () => {}, text => logs.push(String(text)));
  return { promise, events, opsLines, logs, syncs, pending, advance, done, state };
}

// A task agent that returns only after the test has moved the mocked timers `minutes` forward.
const longAgent = (minutes, value) => async (_id, advance) => {
  await advance(minutes);
  return value;
};

const isSync = e => e.startsWith('sync ');
const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);

test('runtime clock rules: a run with a task added by sync completes without the clock', async () => {
  const engine = startEngine([task('T1', ['src/**']), task('T2', ['lib/**'], ['T1'])], {
    answers: { sync: (_runId, n) => ({ ok: true, tasks: n === 1 ? [task('T3', ['doc/**'])] : [] }) },
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    assert.deepEqual(statusOf(result, 'T1'), ['merged']);
    assert.deepEqual(statusOf(result, 'T2'), ['merged']);
    assert.deepEqual(statusOf(result, 'T3'), ['merged']);
    assert.ok(!engine.logs.some(l => l.includes('unavailable')), engine.logs.join('\n'));
  } finally {
    engine.done();
  }
});

test('source check: the body reads neither the clock nor Math.random', () => {
  for (const pattern of [/Date\.now/, /Math\.random/, /new Date\(/, /(?<![\w$])Date\(/]) {
    const found = body.match(pattern);
    assert.ok(found === null, `${pattern} found: ${found && body.slice(found.index - 40, found.index + 40)}`);
  }
});

test('heartbeat: a single 35-minute implementer call gets a sync at least every 10 minutes', async () => {
  const engine = startEngine([task('T1', ['src/**'])], { implementer: longAgent(35, 'done') });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    const during = engine.syncs.filter(s => s.during);
    assert.ok(during.length >= 3, JSON.stringify(engine.syncs));
    for (const s of during) {
      const before = engine.syncs.slice(0, engine.syncs.indexOf(s)).filter(p => p.ok);
      const previous = before[before.length - 1];
      assert.ok(previous, JSON.stringify(engine.syncs));
      assert.ok((s.minute - previous.minute) * MINUTE >= REFRESH_MS, JSON.stringify(engine.syncs));
    }
    for (const e of engine.events.filter(isSync)) assert.equal(e, 'sync "/tmp/ledger.json" test1');
  } finally {
    engine.done();
  }
});

test('heartbeat: a failed heartbeat sync is logged and retried 10 minutes later without stopping the run', async () => {
  let failed = null;
  const engine = startEngine([task('T1', ['src/**'])], {
    implementer: longAgent(35, 'done'),
    answers: {
      sync: (_runId, _n, state) => {
        if (state.agentsInProgress > 0 && failed === null) {
          failed = state.minute;
          return { ok: false, error: 'lock busy' };
        }
        return { ok: true, tasks: [] };
      },
    },
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    assert.notEqual(failed, null, JSON.stringify(engine.syncs));
    assert.ok(engine.logs.some(l => l.includes('lock refresh failed')), engine.logs.join('\n'));
    assert.ok(
      engine.syncs.some(s => s.during && s.minute === failed + 10),
      `a further heartbeat 10 minutes after minute ${failed}: ${JSON.stringify(engine.syncs)}`
    );
  } finally {
    engine.done();
  }
});

// Coverage: the same rule was pinned before with a fake clock.
test('boundaries skip while fresh: no sync between a 4-minute implementer and a 4-minute reviewer', async () => {
  const engine = startEngine([task('T1', ['src/**'])], {
    implementer: longAgent(4, 'done'),
    reviewer: longAgent(4, GOOD_REVIEW),
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    const { events } = engine;
    assert.ok(isSync(events[events.indexOf('impl T1') - 1]), events.join('\n'));
    assert.ok(!events.slice(events.indexOf('impl T1 done'), events.indexOf('review T1')).some(isSync), events.join('\n'));
  } finally {
    engine.done();
  }
});

// After the body returned: no timer is armed, an hour of mocked time makes no helper call, and
// `finish` was the last helper call.
async function assertNothingAfterTheEnd(engine) {
  assert.deepEqual([...engine.pending], [], 'no armed timer');
  const calls = engine.opsLines.length;
  assert.match(engine.opsLines[calls - 1], /^finish /, engine.opsLines.join('\n'));
  for (let i = 0; i < 60; i++) {
    mock.timers.tick(MINUTE);
    await drain();
  }
  assert.equal(engine.opsLines.length, calls, engine.opsLines.join('\n'));
}

test('no timer after the end: neither after a normal run nor after one whose main loop ends in its catch', async () => {
  const normal = startEngine([task('T1', ['src/**'])], { implementer: longAgent(25, 'done') });
  try {
    const result = await normal.promise;
    assert.equal(result.stopped, null, normal.logs.join('\n'));
    await assertNothingAfterTheEnd(normal);
  } finally {
    normal.done();
  }

  // The sync after T1 reports T2 with a title that cannot be turned into text (an object whose
  // `toString` is no function). Starting T2 then throws inside the main loop, which ends in its catch
  // while the refresh timer that this successful sync armed is pending.
  const caught = startEngine([task('T1', ['src/**'])], {
    implementer: longAgent(5, 'done'),
    answers: {
      sync: (_runId, n) => ({ ok: true, tasks: n === 2 ? [task('T2', ['lib/**'], [], { title: { toString: 1 } })] : [] }),
    },
  });
  try {
    const result = await caught.promise;
    assert.match(result.stopped, /^unexpected error: /, caught.logs.join('\n'));
    assert.deepEqual(statusOf(result, 'T1'), ['merged']);
    assert.ok(!caught.events.includes('impl T2'), caught.events.join('\n'));
    await assertNothingAfterTheEnd(caught);
  } finally {
    caught.done();
  }
});

test('heartbeat reports unstartable tasks: they get no agent and are named in stopped', async () => {
  let reported = false;
  const engine = startEngine([task('T1', ['src/**'])], {
    implementer: longAgent(25, 'done'),
    answers: {
      sync: (_runId, _n, state) => {
        if (state.agentsInProgress > 0 && !reported) {
          reported = true;
          return {
            ok: true,
            tasks: [task('T5', ['a/**'], [], { needsAcceptance: true }), task('T6', ['b/**'], [], { needsAcceptance: true })],
          };
        }
        return { ok: true, tasks: [] };
      },
    },
  });
  try {
    const result = await engine.promise;
    assert.ok(reported, JSON.stringify(engine.syncs));
    for (const id of ['T5', 'T6']) {
      assert.ok(!engine.events.includes(`impl ${id}`), engine.events.join('\n'));
      assert.deepEqual(statusOf(result, id), ['blocked']);
    }
    assert.deepEqual(statusOf(result, 'T1'), ['merged']);
    assert.equal(result.stopped, 'T5 needs acceptance; T6 needs acceptance');
  } finally {
    engine.done();
  }
});

test('a failed sync right before a 35-minute implementer still arms the timer: heartbeats follow during the call', async () => {
  const engine = startEngine([task('T1', ['src/**'])], {
    implementer: longAgent(35, 'done'),
    answers: { sync: (_runId, n) => (n === 1 ? { ok: false, error: 'lock busy' } : { ok: true, tasks: [] }) },
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    const { events } = engine;
    assert.ok(isSync(events[events.indexOf('impl T1') - 1]), events.join('\n'));
    assert.equal(engine.syncs[0].ok, false, JSON.stringify(engine.syncs));
    assert.ok(engine.syncs.filter(s => s.during).length >= 3, JSON.stringify(engine.syncs));
  } finally {
    engine.done();
  }
});

test('the timer fires while no task agent runs: the boundary before the reviewer refreshes the lock', async () => {
  const engine = startEngine([task('T1', ['src/**'])], {
    answers: {
      verify: async (_id, _n, state) => {
        await state.advance(11);
        return { ok: true, tail: 'ok' };
      },
    },
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    const { events } = engine;
    assert.ok(isSync(events[events.indexOf('review T1') - 1]), events.join('\n'));
    assert.ok(!engine.syncs.some(s => s.during), JSON.stringify(engine.syncs));
  } finally {
    engine.done();
  }
});

test('two tasks reaching a boundary together while due send exactly one sync for it', async () => {
  // Both implementers return at the same moment, and every sync before that fails, so the lock is due
  // when both reach the boundary after their implementer. A sync answer takes a turn of the event loop,
  // as a real helper call takes time, so the second task arrives while the first one's sync is running.
  let release;
  const together = new Promise(resolve => {
    release = resolve;
  });
  let started = 0;
  const engine = startEngine([task('T1', ['src/**']), task('T2', ['lib/**'])], {
    implementer: () => {
      if (++started === 2) release();
      return together.then(() => 'done');
    },
    answers: {
      sync: async () => {
        const fail = started < 2;
        await drain();
        return fail ? { ok: false, error: 'lock busy' } : { ok: true, tasks: [] };
      },
    },
  });
  try {
    const result = await engine.promise;
    assert.equal(result.stopped, null, engine.logs.join('\n'));
    const { events } = engine;
    const firstDone = Math.min(events.indexOf('impl T1 done'), events.indexOf('impl T2 done'));
    const lastReview = Math.max(events.indexOf('review T1'), events.indexOf('review T2'));
    assert.ok(firstDone > 0 && lastReview > firstDone, events.join('\n'));
    assert.equal(events.slice(firstDone, lastReview).filter(isSync).length, 1, events.join('\n'));
  } finally {
    engine.done();
  }
});
