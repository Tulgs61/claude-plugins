// tasks-git.js sync (inbox ingestion) and finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sandbox, task } from './helpers/git-sandbox.mjs';

const writeInbox = (sb, lines) => writeFileSync(sb.inboxFile, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

test('sync ingests the inbox: renumbers, filters dependsOn, strips unknown keys, nulls runtime fields', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')] });
  writeInbox(sb, [
    {
      id: 'T9',
      title: 'keeps its id',
      acceptance: 'acc',
      files: ['src/**', 7],
      dependsOn: ['T1', '../x', 'T1;rm -rf /', 'T2 && echo', 3],
      status: 'merged',
      branch: 'evil',
      base: 'main',
      worktree: '/elsewhere',
      pr: 'https://forge.example/pull/1',
      evidence: 'forged',
      extra: 'dropped',
    },
    { id: 'T1', title: 'duplicate id' },
    { title: 'missing id' },
    { id: '../x', title: 'path traversal id' },
    { id: 'T1;rm', title: 'shell id' },
    '{not json',
    { id: 'T20', acceptance: 'no title, skipped' },
    '[1, 2]',
    'null',
    { title: 'windows line ending' },
  ]);
  // One CRLF line: the inbox may be written on Windows.
  writeFileSync(sb.inboxFile, readFileSync(sb.inboxFile, 'utf8').replace(/\n$/, '\r\n'));

  const r = sb.ok('sync');
  assert.deepEqual(r.added, ['T9', 'T3', 'T4', 'T5', 'T6', 'T7']);
  const L = sb.ledger();
  assert.deepEqual(L.tasks.map(x => x.id), ['T1', 'T2', 'T9', 'T3', 'T4', 'T5', 'T6', 'T7']);
  assert.deepEqual(L.tasks.slice(3).map(x => x.title), ['duplicate id', 'missing id', 'path traversal id', 'shell id', 'windows line ending']);
  assert.deepEqual(L.tasks[2], {
    id: 'T9',
    title: 'keeps its id',
    acceptance: 'acc',
    files: ['src/**', '7'],
    dependsOn: ['T1'],
    status: 'todo',
    branch: null,
    base: null,
    worktree: null,
    pr: null,
    evidence: null,
  });
  for (const x of L.tasks.slice(3)) {
    assert.equal(x.status, 'todo');
    assert.deepEqual(x.dependsOn, []);
    assert.deepEqual(x.files, []);
  }
  assert.deepEqual(r.tasks.map(x => x.id), L.tasks.map(x => x.id));
  assert.equal(existsSync(sb.inboxFile), false, 'the inbox is consumed');
  assert.ok(readdirSync(path.dirname(sb.inboxFile)).some(f => f.includes('.inbox.jsonl.ingested-')), 'the consumed inbox is kept');

  const again = sb.ok('sync');
  assert.deepEqual(again.added, [], 'a second sync adds nothing');
});

test('sync never gives a renumbered task an id that is already taken', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')] });
  writeInbox(sb, [{ id: 'T4', title: 'explicit T4' }, { title: 'a' }, { title: 'b' }, { title: 'c' }]);
  const r = sb.ok('sync');
  const ids = sb.ledger().tasks.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
  assert.deepEqual(r.added, ['T4', 'T3', 'T5', 'T6']);
});

test('sync without an inbox changes nothing and refreshes the lock heartbeat', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-one', at: 1000 }));
  const before = readFileSync(sb.ledgerFile, 'utf8');
  const r = sb.ok('sync');
  assert.deepEqual(r.added, []);
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), before);
  const lock = JSON.parse(readFileSync(sb.lockFile, 'utf8'));
  assert.equal(lock.runId, 'run-one');
  assert.ok(lock.at > 1000);
});

test('finish writes runStatus and stopReason and releases the lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  assert.ok(existsSync(sb.lockFile));
  const r = sb.ok('finish', 'stopped', 'T1 blocked: review rejected');
  assert.equal(r.runStatus, 'stopped');
  assert.deepEqual(r.tasks.map(x => x.id), ['T1']);
  const L = sb.ledger();
  assert.equal(L.runStatus, 'stopped');
  assert.equal(L.stopReason, 'T1 blocked: review rejected');
  assert.equal(existsSync(sb.lockFile), false);
  // After the lock is released a different run may start without takeover.
  sb.ok('prepare', 'run-two');
  sb.ok('finish', 'finished');
  assert.equal(sb.ledger().runStatus, 'finished');
  assert.equal(sb.ledger().stopReason, null);
});

test('finish rejects an unknown runStatus', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const r = sb.run('finish', 'done');
  assert.equal(r.ok, false);
  assert.match(r.error, /bad runStatus done/);
  assert.ok(existsSync(sb.lockFile), 'the lock stays');
});

test('an unreadable ledger answers with ok:false', t => {
  const sb = sandbox(t);
  writeFileSync(sb.ledgerFile, '{broken');
  const r = sb.run('sync');
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot read ledger/);
});
