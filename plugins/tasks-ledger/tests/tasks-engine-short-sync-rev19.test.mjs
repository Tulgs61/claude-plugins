// Short heartbeat answers: the engine names the tasks it already knows on every `sync`, and the helper
// leaves those out of its answer, so a lock refresh no longer relays the whole ledger. Tasks added
// through the inbox are still listed in full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

test('helper: sync leaves the known tasks out of its answer and still lists the others', t => {
  const sb = sandbox(t, { tasks: [sandboxTask('T1', ['a/**']), sandboxTask('T2', ['b/**'])] });
  sb.ok('prepare', 'run-short');
  assert.deepEqual(sb.ok('sync', 'run-short').tasks.map(x => x.id), ['T1', 'T2'], 'without known: every task');
  assert.deepEqual(sb.ok('sync', 'run-short', 'known', 'T1').tasks.map(x => x.id), ['T2']);
  assert.deepEqual(sb.ok('sync', 'run-short', 'known', 'T1,T2').tasks, []);
});

test('helper: a task added through the inbox is listed although the caller names its other tasks', t => {
  const sb = sandbox(t, { tasks: [sandboxTask('T1', ['a/**'])] });
  sb.ok('prepare', 'run-short');
  writeFileSync(sb.inboxFile, JSON.stringify({ title: 'late', acceptance: 'acc' }) + '\n');
  const r = sb.ok('sync', 'run-short', 'known', 'T1');
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.tasks.map(x => x.id), r.added);
  // That answer may be lost in the relay: the engine still names only T1, and the task is listed again.
  const again = sb.ok('sync', 'run-short', 'known', 'T1');
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.tasks.map(x => x.id), r.added);
});

test('helper: malformed known arguments are refused, the lock is not refreshed by them', t => {
  const sb = sandbox(t, { tasks: [sandboxTask('T1', ['a/**'])] });
  sb.ok('prepare', 'run-short');
  const lockFile = sb.ledgerFile.replace(/\.json$/, '.lock');
  const before = readFileSync(lockFile, 'utf8');
  for (const rest of [['known'], ['known', 'T1;rm'], ['known', 'T1,,T2'], ['other', 'T1'], ['known', 'T1', 'T2']]) {
    const r = sb.run('sync', 'run-short', ...rest);
    assert.equal(r.ok, false, `sync ${rest.join(' ')} must fail`);
    assert.match(r.error, /bad sync arguments/);
  }
  assert.equal(readFileSync(lockFile, 'utf8'), before, 'the lock was not refreshed');
});

test('engine: every sync after prepare names the known task ids', async () => {
  const { opsLines } = await runEngine([task('T1'), task('T2', { dependsOn: ['T1'] })]);
  const syncs = opsLines.filter(l => /^sync /.test(l));
  assert.ok(syncs.length > 0, 'the run syncs');
  for (const line of syncs) assert.match(line, / known T1,T2$/, line);
});

test('engine: a task a sync adds is known to the next sync', async () => {
  let n = 0;
  const sync = () => (n++ === 0 ? { ok: true, added: ['T3'], tasks: [task('T3')] } : { ok: true, added: [], tasks: [] });
  const { opsLines } = await runEngine([task('T1')], { answers: { sync } });
  const syncs = opsLines.filter(l => /^sync /.test(l));
  assert.match(syncs[0], / known T1$/);
  assert.match(syncs[1], / known T1,T3$/);
});
