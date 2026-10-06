// Rev 10, amendments 21, 23 and 24: every ledger write re-reads the ledger under the guard, so no
// command undoes another's change; a lock file that cannot be read refuses a named takeover; a failed
// inbox move reports accurately whether the ledger is unchanged, and restores whenever the ledger
// still holds what this call wrote and the inbox is still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(10);
  }
}

function runAsync(sb, preload, env, ...args) {
  const pre = preload ? ['--require', preload] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...pre, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env } });
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

function runSync(sb, preload, ...args) {
  const r = spawnSync(process.execPath, ['--require', preload, SCRIPT, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

// Pauses the helper right after its first read of A3_PAUSE_ON until A3_RELEASE exists, whether it
// is read by path or through a file it opened.
const PAUSE_PRELOAD = `
const fs = require('node:fs');
const realRead = fs.readFileSync;
const realOpen = fs.openSync;
const realClose = fs.closeSync;
const E = process.env;
const opened = new Map();
let paused = false;
fs.openSync = function (file) {
  const fd = realOpen.apply(this, arguments);
  opened.set(fd, String(file));
  return fd;
};
fs.closeSync = function (fd) {
  opened.delete(fd);
  return realClose.apply(this, arguments);
};
fs.readFileSync = function (file) {
  const r = realRead.apply(this, arguments);
  const name = typeof file === 'number' ? opened.get(file) : String(file);
  if (!paused && name === E.A3_PAUSE_ON) {
    paused = true;
    fs.writeFileSync(E.A3_MARKER, '');
    const end = Date.now() + 60000;
    while (!fs.existsSync(E.A3_RELEASE) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return r;
};
`;

const TITLES = ['first', 'second'];

// Starts a sync that pauses after reading the inbox, runs `other` while it is paused, then lets the
// sync finish. Returns both answers.
async function raceWithSync(sb, ...other) {
  writeFileSync(sb.inboxFile, TITLES.map(title => JSON.stringify({ title, acceptance: 'acc' })).join('\n') + '\n');
  const preload = path.join(sb.tmp, 'pause-preload.cjs');
  writeFileSync(preload, PAUSE_PRELOAD);
  const marker = path.join(sb.tmp, 'read');
  const release = path.join(sb.tmp, 'release');
  const env = { A3_PAUSE_ON: sb.inboxFile, A3_MARKER: marker, A3_RELEASE: release };
  const sync = runAsync(sb, preload, env, 'sync', sb.ledgerFile, 'run-one');
  await until(() => existsSync(marker), 'the sync to read the inbox');
  const second = runAsync(sb, null, {}, other[0], sb.ledgerFile, ...other.slice(1));
  await delay(1000);
  writeFileSync(release, '');
  const [a, b] = await Promise.all([sync, second]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  return [a, b];
}

test('amendment 21: finish racing a sync keeps the ingested tasks', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  await raceWithSync(sb, 'finish', 'stopped', 'paused by hand', 'run-one');
  const L = sb.ledger();
  assert.deepEqual(L.tasks.map(x => x.title), ['task T1', ...TITLES]);
  assert.equal(L.runStatus, 'stopped');
  assert.equal(L.stopReason, 'paused by hand');
  assert.equal(existsSync(sb.lockFile), false);
});

test('amendment 21: status racing a sync keeps both changes', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  await raceWithSync(sb, 'status', 'T1', 'blocked', 'needs a decision');
  const L = sb.ledger();
  assert.deepEqual(L.tasks.map(x => x.title), ['task T1', ...TITLES]);
  assert.equal(L.tasks[0].status, 'blocked');
  assert.equal(L.tasks[0].evidence, 'needs a decision');
});

test('amendment 21: a task a command changes is re-read, so a status set in between survives worktree', async t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')] });
  sb.ok('prepare', 'run-one');
  // worktree reads the ledger at start; status T2 lands before worktree writes.
  const preload = path.join(sb.tmp, 'pause-preload.cjs');
  writeFileSync(preload, PAUSE_PRELOAD);
  const marker = path.join(sb.tmp, 'read');
  const release = path.join(sb.tmp, 'release');
  // The worktree command reads the main checkout's worktree list through git; pause on the first
  // read of the ledger instead, which happens before any git step.
  const env = { A3_PAUSE_ON: sb.ledgerFile, A3_MARKER: marker, A3_RELEASE: release };
  const pending = runAsync(sb, preload, env, 'worktree', sb.ledgerFile, 'T1');
  await until(() => existsSync(marker), 'worktree to read the ledger');
  sb.ok('status', 'T2', 'blocked', 'set in between');
  writeFileSync(release, '');
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sb.taskOf('T1').status, 'in_progress');
  assert.equal(sb.taskOf('T2').status, 'blocked');
  assert.equal(sb.taskOf('T2').evidence, 'set in between');
});

const asRoot = process.getuid?.() === 0;

test('amendment 23: a lock file that cannot be read refuses a named takeover', { skip: asRoot }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 1000 }) + '\n');
  const lockBefore = readFileSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  chmodSync(sb.lockFile, 0o000);
  const r = sb.run('prepare', 'run-new', 'takeover', 'run-old');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.equal(statSync(sb.lockFile).mode & 0o777, 0);
  chmodSync(sb.lockFile, 0o600);
  assert.deepEqual(readFileSync(sb.lockFile), lockBefore);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
});

test('amendment 23: a lock that is a directory refuses a named takeover', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  mkdirSync(sb.lockFile);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const r = sb.run('prepare', 'run-new', 'takeover', 'run-old');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^another run \(/);
  assert.equal(r.locked, true);
  assert.ok(statSync(sb.lockFile).isDirectory());
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  rmSync(sb.lockFile, { recursive: true });
});

// Makes every move of the inbox aside fail with the error code `code`.
const movePreload = code => `
const fs = require('node:fs');
const realRename = fs.renameSync;
fs.renameSync = function (src) {
  if (String(src).endsWith('.inbox.jsonl')) {
    const e = new Error('${code}: rename refused');
    e.code = '${code}';
    throw e;
  }
  return realRename.apply(this, arguments);
};
`;

function failingMove(sb, code, lines) {
  const preload = path.join(sb.tmp, `move-${code}.cjs`);
  writeFileSync(preload, movePreload(code));
  writeFileSync(sb.inboxFile, lines.join('\n') + '\n');
  return preload;
}

test('amendment 24: a failed move when this call never wrote the ledger says the ledger is unchanged', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = failingMove(sb, 'EACCES', ['{not json', JSON.stringify({ acceptance: 'no title' })]);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const inboxBefore = readFileSync(sb.inboxFile);
  const r = runSync(sb, preload, 'sync', sb.ledgerFile);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /the ledger is unchanged/);
  assert.doesNotMatch(r.error, /not restored/);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
});

test('amendment 24: a failed move with the ledger untouched and the inbox present restores, whatever the error code', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const preload = failingMove(sb, 'ENOENT', TITLES.map(title => JSON.stringify({ title, acceptance: 'acc' })));
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const inboxBefore = readFileSync(sb.inboxFile);
  const r = runSync(sb, preload, 'sync', sb.ledgerFile);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /the ledger is unchanged/);
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
  assert.deepEqual(readdirSync(path.dirname(sb.ledgerFile)).filter(f => f.includes('.ingested-')), []);

  assert.deepEqual(sb.ok('sync').added, ['T2', 'T3']);
  assert.deepEqual(sb.ok('sync').added, []);
});
