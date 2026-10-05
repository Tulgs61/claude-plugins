// Rev 8, amendments 1-3: an empty finish reason stores null; finish with a run id fails and changes
// nothing while another live run holds the lock; racing takeovers over a fresh lock leave exactly
// one owner, repeated many times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const HOUR = 60 * 60 * 1000;
const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;

function runAsync(sb, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: sb.repo, env: sb.env });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0);
        const lines = out.split('\n').filter(Boolean);
        assert.equal(lines.length, 1, out);
        resolve(JSON.parse(lines[0]));
      } catch (e) {
        reject(e);
      }
    });
  });
}

test('finish with an empty reason stores stopReason null', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('finish', 'stopped', '');
  assert.equal(sb.ledger().stopReason, null);
  sb.ok('prepare', 'run-one');
  sb.ok('finish', 'stopped', '', 'run-one');
  assert.equal(sb.ledger().stopReason, null);
  assert.equal(existsSync(sb.lockFile), false);
});

test('finish without a reason stores stopReason null', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('finish', 'finished');
  assert.equal(sb.ledger().stopReason, null);
});

test('finish of a superseded run fails and changes nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  sb.ok('prepare', 'run-two', 'takeover');
  const ledgerBefore = readFileSync(sb.ledgerFile, 'utf8');
  const lockBefore = readFileSync(sb.lockFile, 'utf8');
  const r = sb.run('finish', 'stopped', 'superseded', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /another run \(run-two/);
  assert.equal(r.locked, true);
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), ledgerBefore);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), lockBefore);
  assert.equal(existsSync(guardOf(sb)), false);
});

test('finish with a run id over a stale foreign lock finishes and leaves that lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const stale = JSON.stringify({ runId: 'run-two', at: Date.now() - 7 * HOUR }) + '\n';
  writeFileSync(sb.lockFile, stale);
  const r = sb.ok('finish', 'stopped', 'x', 'run-one');
  assert.equal(r.runStatus, 'stopped');
  assert.equal(sb.ledger().stopReason, 'x');
  assert.equal(readFileSync(sb.lockFile, 'utf8'), stale);
});

test('finish with a run id and no lock finishes', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('finish', 'finished', 'done', 'run-one');
  assert.equal(sb.ledger().runStatus, 'finished');
  assert.equal(existsSync(sb.lockFile), false);
});

const IDS = ['race-0', 'race-1', 'race-2', 'race-3', 'race-4', 'race-5'];
const ROUNDS = 20;

test(`racing takeovers over a fresh lock leave exactly one owner, ${ROUNDS} times`, async t => {
  for (let round = 0; round < ROUNDS; round++) {
    const sb = sandbox(t, { tasks: [task('T1')] });
    writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
    const answers = await Promise.all(IDS.map(id => runAsync(sb, 'prepare', sb.ledgerFile, id, 'takeover')));
    const winners = answers.filter(a => a.ok);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(answers)}`);
    for (const a of answers.filter(x => !x.ok)) assert.match(a.error, /another run \(/, `round ${round}`);
    const winner = IDS[answers.findIndex(a => a.ok)];
    assert.equal(lockOf(sb).runId, winner, `round ${round}: exactly the winner holds the lock`);
    assert.equal(existsSync(guardOf(sb)), false, `round ${round}: no guard is left behind`);
    const leftovers = readdirSync(path.dirname(sb.lockFile)).filter(f => /\.lock\./.test(f));
    assert.deepEqual(leftovers, [], `round ${round}`);
  }
});
