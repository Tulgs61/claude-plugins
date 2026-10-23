// Rev 13: relay-check polish. The engine scans a relayed `stdout` upward for the last JSON line whose
// check holds, so a JSON line the relay appended after a correctly sealed answer costs no attempt.
// The `T<n> started` log line carries the task's title again, taken from the dispatch record once it
// is fetched (the scheduling summary has no title).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { task } from './helpers/git-sandbox.mjs';
import { runEngine, sealed } from './helpers/relay.mjs';

const statusOf = (result, id) => result.results.filter(r => r.id === id).map(r => r.status);
const noteOf = (result, id) => result.results.find(r => r.id === id).note;
const failedChecks = logs => logs.filter(l => /helper answer failed its check/.test(l));

test('a JSON line the relay appends after a sealed answer costs no attempt', async () => {
  const appended = ['{"note":"copied verbatim"}', '{"ok":true}', '{"ok":false,"error":"relay says no"}', '{"len":3,"sum":"00000000"}'];
  for (const extra of appended) {
    const { result, counts, logs } = await runEngine([task('T1', ['src/**'])], {
      relay: (_op, _n, line) => `${line}\n${extra}\n`,
    });
    assert.equal(result.stopped, null, `${extra}\n${logs.join('\n')}`);
    assert.deepEqual(statusOf(result, 'T1'), ['merged'], extra);
    for (const op of ['prepare', 'task', 'worktree', 'verify', 'merge']) assert.equal(counts[op], 1, `${op} after ${extra}`);
    assert.deepEqual(failedChecks(logs), [], extra);
  }
});

test('the last line whose check holds is the answer, also when an altered line follows it', async () => {
  const { result, counts, logs, prompts } = await runEngine([task('T1', ['src/**'])], {
    relay: (op, _n, line) => (op === 'worktree' ? `${line}\n${line.replace('/tmp/wt-T1', '/tmp/elsewhere')}` : line),
  });
  assert.equal(counts.worktree, 1);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.deepEqual(failedChecks(logs), []);
  for (const p of prompts) assert.doesNotMatch(p, /elsewhere/);
  assert.ok(prompts.some(p => p.includes('Worktree: /tmp/wt-T1')));

  // Two sealed lines: the lower one is the answer.
  const twice = await runEngine([task('T1', ['src/**'])], {
    relay: (op, _n, line) => (op === 'merge' ? `${sealed({ ok: true, sha: 'aaa111' })}\n${line}` : line),
  });
  assert.equal(noteOf(twice.result, 'T1'), 'merged @ def456');
});

test('an altered answer with an appended JSON line is still one failed attempt', async () => {
  const { result, counts, logs } = await runEngine([task('T1', ['src/**'])], {
    relay: (op, n, line) => (op === 'merge' && n === 1 ? `${line.replace('def456', 'bad000')}\n{"ok":true}` : line),
  });
  assert.equal(counts.merge, 2);
  assert.equal(noteOf(result, 'T1'), 'merged @ def456');
  assert.deepEqual(failedChecks(logs), ['helper answer failed its check (merge, attempt 1 of 3)']);

  const always = await runEngine([task('T1', ['src/**'])], {
    relay: (op, _n, line) => (op === 'merge' ? `${line.replace('def456', 'bad000')}\n{"ok":true}` : line),
  });
  assert.equal(always.counts.merge, 3);
  assert.match(noteOf(always.result, 'T1'), /^merge failed: helper answer was altered in transit: 3 of 3 relayed answers to merge failed their check/);
});

test('the started line names the task title from the fetched record', async () => {
  const { result, logs, opsLines } = await runEngine([
    task('T1', ['src/**'], [], { title: 'Rename the API' }),
    task('T2', ['lib/**'], [], { title: '  Trim the docs  ' }),
  ]);
  assert.equal(result.stopped, null);
  assert.ok(logs.includes('T1 started: Rename the API'), logs.join('\n'));
  assert.ok(logs.includes('T2 started: Trim the docs'), logs.join('\n'));
  // The summary that scheduled the tasks has no title; the record fetch came first.
  assert.ok(opsLines.includes('task "/tmp/ledger.json" T1'));
  assert.ok(opsLines.includes('task "/tmp/ledger.json" T2'));
});

test('no started line is logged for a task whose record cannot be read', async () => {
  const { result, logs, prompts } = await runEngine([task('T1', ['src/**'])], {
    answers: { task: () => ({ ok: false, error: 'no task T1' }) },
  });
  assert.deepEqual(statusOf(result, 'T1'), ['blocked']);
  assert.deepEqual(prompts, []);
  assert.ok(!logs.some(l => /^T1 started\b/.test(l)), logs.join('\n'));
});

test('a task verified in an earlier run logs its started line without a record fetch', async () => {
  const { result, logs, opsLines, prompts } = await runEngine([task('T1', ['src/**'], [], { status: 'verified' })]);
  assert.deepEqual(statusOf(result, 'T1'), ['merged']);
  assert.deepEqual(prompts, []);
  assert.ok(!opsLines.some(l => l.startsWith('task ')), opsLines.join('\n'));
  assert.ok(logs.includes('T1 started: verified in an earlier run, merging'), logs.join('\n'));
});
