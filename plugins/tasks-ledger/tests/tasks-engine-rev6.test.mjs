// Rev 6, amendment 1 of the tasks-engine spec: every `sync` call carries the run's own run id as
// its one argument after the ledger path, in the pinned ops prompt form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `answers` overrides the canned answer per subcommand
// (a function of the parts after the ledger path). `opsLines` records each helper command line
// exactly as prompted, `prompts` each ops prompt in full.
async function runEngine(ledgerTasks, { answers = {}, runId = 'test1' } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const opsLines = [];
  const prompts = [];
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: ledgerTasks }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };
  const agent = async (prompt, opts) => {
    if (opts.agentType !== undefined) return /^TASK: /.test(prompt) ? 'done' : GOOD_REVIEW;
    prompts.push(prompt);
    const line = prompt.match(/node "[^"]*" (.*)\n/)[1];
    opsLines.push(line);
    const [op, , ...rest] = line.replace(/"/g, '').split(' ');
    return { stdout: JSON.stringify(canned[op] ? canned[op](...rest) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId };
  const result = await run(args, agent, () => {}, () => {});
  return { result, opsLines, prompts };
}

const syncLines = opsLines => opsLines.filter(l => l.startsWith('sync '));

test('amendment 1: every sync call carries the run id as its one argument', async () => {
  const { result, opsLines } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**']), task('T3', ['src/a/**'])], {
    runId: 'run-2026-abc',
  });
  assert.equal(result.stopped, null);
  const syncs = syncLines(opsLines);
  assert.ok(syncs.length >= 2, opsLines.join('\n'));
  for (const line of syncs) assert.equal(line, 'sync "/tmp/ledger.json" run-2026-abc');
});

test('amendment 1: the sync on an empty ledger also carries the run id', async () => {
  const { opsLines } = await runEngine([]);
  const syncs = syncLines(opsLines);
  assert.ok(syncs.length >= 1, opsLines.join('\n'));
  for (const line of syncs) assert.equal(line, 'sync "/tmp/ledger.json" test1');
});

test('amendment 1: the sync ops prompt keeps its pinned form', async () => {
  const { prompts } = await runEngine([task('T1', ['src/**'])]);
  const syncPrompts = prompts.filter(p => /node "\/tmp\/tasks-git\.js" sync /.test(p));
  assert.ok(syncPrompts.length >= 1);
  for (const p of syncPrompts) {
    assert.ok(p.includes('node "/tmp/tasks-git.js" sync "/tmp/ledger.json" test1\n'), p);
    assert.equal(p.indexOf('node "'), p.lastIndexOf('node "'), p);
  }
});

test('amendment 1: tasks added through a sync with the run id still join the schedule', async () => {
  let added = false;
  const seen = [];
  const { result } = await runEngine([task('T1', ['src/**'])], {
    answers: {
      sync: id => {
        seen.push(id);
        if (added) return { ok: true, tasks: [] };
        added = true;
        return { ok: true, tasks: [task('T2', ['lib/**'])] };
      },
    },
  });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.id).sort(), ['T1', 'T2']);
  assert.ok(seen.length >= 1 && seen.every(id => id === 'test1'), seen.join(','));
});
