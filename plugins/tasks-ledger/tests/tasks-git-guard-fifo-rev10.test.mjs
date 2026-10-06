// Rev 10, group C (amendment 37): the guard and its private files are never opened blocking. Something
// at the guard path that is no regular file counts as a guard held by an unknown owner: it is never
// read, moved or removed, and waiting for it ends with the guard-wait timeout error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

// The helper waits 30 s for the guard; a call that blocks is killed after this limit.
const LIMIT_MS = 50000;

// Runs the helper without blocking the test, so several calls wait for the guard at the same time.
function runAsync(sb, args) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, args[0], sb.ledgerFile, ...args.slice(1)], { cwd: sb.repo, env: sb.env });
    let out = '';
    child.stdout.on('data', d => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ args, code, out, ms: Date.now() - started });
    });
  });
}

function assertGuardTimeout(r) {
  const label = r.args.join(' ');
  assert.equal(r.code, 0, `${label} did not answer within ${LIMIT_MS} ms`);
  const lines = r.out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${label}: ${r.out}`);
  const a = JSON.parse(lines[0]);
  assert.equal(a.ok, false, `${label}: ${lines[0]}`);
  assert.match(a.error, /another run \(/, label);
  assert.match(a.error, /lock guard/, label);
  assert.equal(a.locked, true, label);
}

test('amendment 37: a FIFO or an old directory at the guard path is never read, moved or removed', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const fifo = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(fifo.lockFile, JSON.stringify({ runId: 'run-one', at: Date.now() - 1000 }) + '\n');
  const fifoGuard = `${fifo.lockFile}.guard`;
  assert.equal(spawnSync('mkfifo', [fifoGuard]).status, 0, 'mkfifo');
  // An old private guard file that is a FIFO is not read either.
  const fifoPrivate = `${fifoGuard}-new-1-1-x`;
  assert.equal(spawnSync('mkfifo', [fifoPrivate]).status, 0, 'mkfifo');

  // A directory older than the abandon time would count as abandoned if it were judged as a guard.
  const dir = sandbox(t, { tasks: [task('T1')] });
  const dirGuard = `${dir.lockFile}.guard`;
  mkdirSync(dirGuard);
  writeFileSync(`${dirGuard}/inside`, 'x');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(dirGuard, old, old);

  const ledgers = [fifo, dir].map(sb => readFileSync(sb.ledgerFile));
  const lockBefore = readFileSync(fifo.lockFile);
  const results = await Promise.all([
    runAsync(fifo, ['sync', 'run-one']),
    runAsync(fifo, ['status', 'T1', 'done']),
    runAsync(fifo, ['prepare', 'run-two']),
    runAsync(dir, ['sync', 'run-one']),
  ]);
  for (const r of results) assertGuardTimeout(r);

  assert.ok(lstatSync(fifoGuard).isFIFO(), 'the FIFO is still the guard');
  assert.ok(lstatSync(fifoPrivate).isFIFO(), 'the FIFO private file is left alone');
  assert.ok(lstatSync(dirGuard).isDirectory(), 'the directory is still the guard');
  assert.equal(readFileSync(`${dirGuard}/inside`, 'utf8'), 'x');
  assert.deepEqual(readFileSync(fifo.ledgerFile), ledgers[0]);
  assert.deepEqual(readFileSync(dir.ledgerFile), ledgers[1]);
  assert.deepEqual(readFileSync(fifo.lockFile), lockBefore);
  rmSync(fifoGuard);
  rmSync(fifoPrivate);
  rmSync(dirGuard, { recursive: true });

  // With the guard path free again, the helper works as before.
  assert.equal(fifo.run('sync', 'run-one').ok, true);
});
