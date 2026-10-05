// Rev 4, amendment 5: a PR target must be baseBranch or a well-formed task/<topic>/ branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const b = id => `task/${TOPIC}/${id}`;

test('prs refuses a request target that is neither baseBranch nor a task/<topic>/ branch', t => {
  for (const base of ['develop', 'task/other/T1', 'main:refs/heads/x', '-main', 'task/demo/bad..name', 'task/demo/a b', '']) {
    const sb = sandbox(t, { prs: true, tasks: [task('T1', [], [], { status: 'merged', branch: b('T1'), base })] });
    sb.ok('prepare', 'run-one');
    sb.complete('T1');
    const L = sb.ledger();
    L.tasks[0].base = base;
    sb.writeLedger(L);
    const r = sb.run('prs');
    assert.equal(r.ok, false, base);
    assert.match(r.error, /refusing to push/, base);
    assert.deepEqual(sb.originHeads(), ['main'], base);
    assert.equal(sb.ghCalls().length, 0, base);
  }
});

test('prs accepts baseBranch and a task/<topic>/ branch as targets', t => {
  const sb = sandbox(t, { prs: true, tasks: [task('T1'), task('T2', [], ['T1'])] });
  sb.ok('prepare', 'run-one');
  sb.complete('T1');
  sb.complete('T2');
  const r = sb.ok('prs');
  assert.deepEqual(r.results.map(x => x.target), ['main', b('T1')]);
});
