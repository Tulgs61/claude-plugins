// Rev 5, amendments 1-3: the run lock is read, judged and written under a short exclusive guard, so
// racing prepare calls leave exactly one owner, also from a stale lock or under takeover; an
// abandoned guard does not block forever; sync refreshes only its own run's lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const HOUR = 60 * 60 * 1000;
const IDS = ['race-0', 'race-1', 'race-2', 'race-3', 'race-4', 'race-5'];

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

const lockOf = sb => JSON.parse(readFileSync(sb.lockFile, 'utf8'));
const guardOf = sb => `${sb.lockFile}.guard`;

async function race(sb, extra = []) {
  const answers = await Promise.all(IDS.map(id => runAsync(sb, 'prepare', sb.ledgerFile, id, ...extra)));
  const winners = answers.filter(a => a.ok);
  assert.equal(winners.length, 1, JSON.stringify(answers));
  for (const a of answers.filter(x => !x.ok)) assert.match(a.error, /another run \(/);
  const winner = IDS[answers.findIndex(a => a.ok)];
  assert.equal(lockOf(sb).runId, winner, 'exactly the winner holds the lock');
  assert.equal(existsSync(guardOf(sb)), false, 'no guard is left behind');
  const leftovers = readdirSync(path.dirname(sb.lockFile)).filter(f => /\.lock\./.test(f));
  assert.deepEqual(leftovers, []);
  return winner;
}

test('racing prepare calls starting from a stale lock: exactly one holds the lock', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 7 * HOUR }) + '\n');
  await race(sb);
});

test('racing prepare calls with takeover over a fresh lock: exactly one holds the lock', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  await race(sb, ['takeover']);
});

test('racing prepare calls without a lock: exactly one holds the lock', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  await race(sb);
});

test('takeover does not replace a lock whose prepare is still running', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  // The test process itself is alive, so its pid stands for a prepare in progress.
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000, pid: process.pid, preparing: true }) + '\n');
  const r = sb.run('prepare', 'run-new', 'takeover');
  assert.equal(r.ok, false);
  assert.match(r.error, /^another run \(run-old/);
  assert.equal(lockOf(sb).runId, 'run-old');
});

test('a successful prepare leaves a plain lock that a later takeover replaces', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const lock = lockOf(sb);
  assert.equal(lock.runId, 'run-one');
  assert.notEqual(lock.preparing, true);
  sb.ok('prepare', 'run-two', 'takeover');
  assert.equal(lockOf(sb).runId, 'run-two');
});

test('a fresh guard makes prepare wait; it proceeds once the guard is released', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(guardOf(sb), 'someone-else');
  const pending = runAsync(sb, 'prepare', sb.ledgerFile, 'run-one');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(existsSync(sb.lockFile), false, 'no lock is written while the guard is held');
  rmSync(guardOf(sb));
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lockOf(sb).runId, 'run-one');
});

test('an abandoned guard is broken after a short fixed time', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(guardOf(sb), JSON.stringify({ token: 'crashed-caller', pid: gone, host: hostname(), at: Date.now() }) + '\n');
  const old = new Date(Date.now() - 60 * 1000);
  utimesSync(guardOf(sb), old, old);
  const started = Date.now();
  sb.ok('prepare', 'run-one');
  assert.ok(Date.now() - started < 10000, 'prepare did not wait for the guard');
  assert.equal(lockOf(sb).runId, 'run-one');
  assert.equal(existsSync(guardOf(sb)), false);
});

test('sync with a run id refreshes only that run\'s lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-two', at: 1000 }) + '\n');
  const before = readFileSync(sb.lockFile, 'utf8');
  sb.ok('sync', 'run-one');
  assert.equal(readFileSync(sb.lockFile, 'utf8'), before, 'a newer owner is left alone');

  sb.ok('sync', 'run-two');
  const lock = lockOf(sb);
  assert.equal(lock.runId, 'run-two');
  assert.ok(lock.at > 1000);
});

test('sync never writes another run id over the lock and writes none when there is no lock', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('sync', 'run-one');
  assert.equal(existsSync(sb.lockFile), false);
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-two', at: 1000 }) + '\n');
  sb.ok('sync');
  assert.equal(lockOf(sb).runId, 'run-two');
  assert.equal(existsSync(guardOf(sb)), false);
});
