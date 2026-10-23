// Rev 13: the task listing of prepare, sync and finish carries no `resumeVerified` (nothing writes or
// reads it, and the schema does not allow it), and a title-only task is judged as the engine judges
// it: a proof, budget or acceptance counts when it is any value whose text is not blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ENGINE, sandbox, task } from './helpers/git-sandbox.mjs';

const SUMMARY_KEYS = ['base', 'branch', 'dependsOn', 'files', 'id', 'needsAcceptance', 'pr', 'status', 'worktree'];
const RECORD_KEYS = ['acceptance', 'base', 'branch', 'budget', 'constraints', 'dependsOn', 'files', 'id', 'needsAcceptance', 'pr', 'proof', 'status', 'title', 'worktree'];

const listings = sb => [sb.ok('prepare', 'listing-run'), sb.ok('sync', 'listing-run'), sb.ok('finish', 'finished', '', 'listing-run')];

test('a ledger task with resumeVerified does not surface it in the listing or the task record', t => {
  const sb = sandbox(t, {
    tasks: [
      task('T1', ['a/**'], [], { status: 'merged', resumeVerified: true }),
      task('T2', ['b/**'], [], { resumeVerified: false }),
      task('T3', ['c/**'], [], { resumeVerified: { nested: 'x'.repeat(500) } }),
      task('T4', ['d/**']),
    ],
  });
  for (const a of listings(sb)) {
    assert.deepEqual(a.tasks.map(x => x.id), ['T1', 'T2', 'T3', 'T4']);
    for (const x of a.tasks) {
      assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS, JSON.stringify(x));
      assert.equal(Object.prototype.hasOwnProperty.call(x, 'resumeVerified'), false, x.id);
    }
  }
  for (const id of ['T1', 'T2', 'T3']) assert.deepEqual(Object.keys(sb.ok('task', id).task).sort(), RECORD_KEYS, id);
});

// The engine's own rule for a title-only task, taken from workflows/tasks-engine.js.
function engineNeedsAcceptance() {
  const line = readFileSync(ENGINE, 'utf8').match(/^const text = .*;$/m);
  assert.ok(line, 'the engine defines `text`');
  const ctx = vm.createContext({});
  vm.runInContext(`${line[0]}\nthis.text = text;`, ctx);
  return r => r.needsAcceptance === true || (!ctx.text(r.acceptance) && (!ctx.text(r.proof) || !ctx.text(r.budget)));
}

test('needsAcceptance counts any non-blank value as present, numbers included, as the engine does', t => {
  // [extra fields, expected needsAcceptance]
  const cases = [
    [{ acceptance: '', proof: 42, budget: 5 }, false],
    [{ acceptance: '', proof: 0, budget: 0 }, false],
    [{ acceptance: '', proof: 'true', budget: 30 }, false],
    [{ acceptance: 7, proof: '', budget: '' }, false],
    [{ acceptance: '', proof: '', budget: 5 }, true],
    [{ acceptance: '', proof: 42, budget: '   ' }, true],
    [{ acceptance: null, proof: null, budget: '5 turns' }, true],
    [{ acceptance: '  ', proof: 'true', budget: undefined }, true],
    [{ acceptance: 'x', needsAcceptance: true }, true],
    [{}, false],
  ];
  const sb = sandbox(t, { tasks: cases.map(([extra], i) => task(`T${i + 1}`, [`p${i}/**`], [], extra)) });
  const engine = engineNeedsAcceptance();
  const ledger = JSON.parse(readFileSync(sb.ledgerFile, 'utf8'));
  for (const a of listings(sb)) {
    assert.deepEqual(a.tasks.map(x => x.needsAcceptance), cases.map(([, want]) => want));
    // Same verdict as the engine's check on the stored task.
    assert.deepEqual(a.tasks.map(x => x.needsAcceptance), ledger.tasks.map(engine));
  }
});
