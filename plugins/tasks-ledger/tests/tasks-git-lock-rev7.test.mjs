// Rev 7, amendments 1 and 3: finish with a run id removes only that run's lock; a timed-out wait
// for the lock guard reports `another run (`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { sandbox, task } from './helpers/git-sandbox.mjs';

const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;

test('finish with its own run id removes the lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const r = sb.ok('finish', 'finished', 'all merged', 'run-one');
  assert.equal(r.runStatus, 'finished');
  assert.equal(existsSync(sb.lockFile), false);
  assert.equal(sb.ledger().stopReason, 'all merged');
});

test('finish with another run id leaves that run\'s lock in place', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('prepare', 'run-two', 'takeover');
  const before = readFileSync(sb.lockFile, 'utf8');
  assert.equal(sb.run('finish', 'stopped', 'superseded', 'run-one').ok, false);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), before);
  assert.equal(lockOf(sb).runId, 'run-two');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('finish with a run id leaves an unreadable lock in place', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, 'not json');
  sb.ok('finish', 'stopped', 'x', 'run-one');
  assert.equal(readFileSync(sb.lockFile, 'utf8'), 'not json');
});

test('finish without a run id removes any lock, as before', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-two', at: Date.now() }) + '\n');
  sb.ok('finish', 'stopped', 'manual');
  assert.equal(existsSync(sb.lockFile), false);
});

test('finish with a bad runStatus keeps the lock even with a matching run id', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const r = sb.run('finish', 'done', 'x', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /bad runStatus done/);
  assert.equal(lockOf(sb).runId, 'run-one');
});

test('a timed-out wait for the lock guard reports another run (', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  // A guard dated in the future never counts as abandoned, so the wait runs into its time limit.
  writeFileSync(guardOf(sb), 'someone-else');
  const future = new Date(Date.now() + 60 * 60 * 1000);
  utimesSync(guardOf(sb), future, future);
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /another run \(/);
  assert.equal(r.locked, true);
  assert.equal(existsSync(sb.lockFile), false);
  assert.equal(readFileSync(guardOf(sb), 'utf8'), 'someone-else', 'the foreign guard is left alone');
});
