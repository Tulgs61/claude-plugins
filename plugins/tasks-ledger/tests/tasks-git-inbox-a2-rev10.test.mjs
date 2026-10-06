// Rev 10, amendment 15: sync and prepare read the inbox, write the ledger and move the inbox aside
// under the guard, so overlapping calls process the inbox one after the other; the ledger is restored after a
// failed move only while it holds what this call wrote and the inbox is still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

function runSync(sb, preload, env, ...args) {
  const r = spawnSync(process.execPath, ['--require', preload, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

const TITLES =['first', 'second', 'third'];

function fillInbox(sb) {
  writeFileSync(sb.inboxFile, TITLES.map(title => JSON.stringify({ title })).join('\n') + '\n');
}

const runsFiles = sb => readdirSync(path.dirname(sb.ledgerFile));
const ingestedCopies = sb => runsFiles(sb).filter(f => f.includes('.inbox.jsonl.ingested-'));

// Pauses the helper right after its first read of the inbox until A2_RELEASE exists, whether it is
// read by path or through a file it opened.
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
  if (!paused && name === E.A2_PAUSE_ON) {
    paused = true;
    fs.writeFileSync(E.A2_MARKER, '');
    const end = Date.now() + 60000;
    while (!fs.existsSync(E.A2_RELEASE) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return r;
};
`;

test('two overlapping syncs over one inbox take in every line exactly once', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  fillInbox(sb);
  const preload = path.join(sb.tmp, 'pause-preload.cjs');
  writeFileSync(preload, PAUSE_PRELOAD);
  const marker = path.join(sb.tmp, 'read');
  const release = path.join(sb.tmp, 'release');
  const ledgerBefore = readFileSync(sb.ledgerFile, 'utf8');

  const first = runAsync(sb, preload, { A2_PAUSE_ON: sb.inboxFile, A2_MARKER: marker, A2_RELEASE: release }, 'sync', sb.ledgerFile);
  await until(() => existsSync(marker), 'the first sync to read the inbox');
  let secondDone = false;
  const second = runAsync(sb, null, {}, 'sync', sb.ledgerFile).finally(() => (secondDone = true));
  await delay(1500);
  assert.equal(secondDone, false, 'the second sync waits while the first ingests');
  assert.equal(readFileSync(sb.ledgerFile, 'utf8'), ledgerBefore);
  writeFileSync(release, '');

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(a.added, ['T2', 'T3', 'T4']);
  assert.deepEqual(b.added, []);
  const titles = sb.ledger().tasks.map(x => x.title);
  for (const title of TITLES) assert.equal(titles.filter(x => x === title).length, 1, `${title} once in ${titles}`);
  assert.equal(existsSync(sb.inboxFile), false);
  assert.equal(ingestedCopies(sb).length, 1);
});

test('a prepare overlapping a sync over one inbox: every line ends up in the ledger exactly once', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  fillInbox(sb);
  const preload = path.join(sb.tmp, 'pause-preload.cjs');
  writeFileSync(preload, PAUSE_PRELOAD);
  const marker = path.join(sb.tmp, 'read');
  const release = path.join(sb.tmp, 'release');

  const sync = runAsync(sb, preload, { A2_PAUSE_ON: sb.inboxFile, A2_MARKER: marker, A2_RELEASE: release }, 'sync', sb.ledgerFile);
  await until(() => existsSync(marker), 'the sync to read the inbox');
  const prepare = runAsync(sb, null, {}, 'prepare', sb.ledgerFile, 'run-one');
  await delay(1500);
  writeFileSync(release, '');

  const [a, b] = await Promise.all([sync, prepare]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual([...a.added, ...b.added].sort(), ['T2', 'T3', 'T4']);
  const L = sb.ledger();
  const titles = L.tasks.map(x => x.title);
  for (const title of TITLES) assert.equal(titles.filter(x => x === title).length, 1, `${title} once in ${titles}`);
  assert.equal(L.runStatus, 'running');
  assert.equal(existsSync(sb.inboxFile), false);
});

// Removes the inbox just before the helper moves it, so the move fails because it is gone.
const GONE_PRELOAD = `
const fs = require('node:fs');
const realRename = fs.renameSync;
fs.renameSync = function (src) {
  if (String(src).endsWith('.inbox.jsonl')) fs.unlinkSync(src);
  return realRename.apply(this, arguments);
};
`;

test('a move that fails because the inbox is gone does not restore the ledger', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  fillInbox(sb);
  const preload = path.join(sb.tmp, 'gone-preload.cjs');
  writeFileSync(preload, GONE_PRELOAD);
  const r = runSync(sb, preload, {}, 'sync', sb.ledgerFile);
  assert.deepEqual(r.added, ['T2', 'T3', 'T4'], JSON.stringify(r));
  assert.deepEqual(sb.ledger().tasks.map(x => x.title), ['task T1', ...TITLES], 'the ingested lines stay in the ledger');
  assert.deepEqual(sb.ok('sync').added, []);
});

// Another writer replaces the ledger, then the move of the inbox fails.
const CHANGED_PRELOAD = `
const fs = require('node:fs');
const realRename = fs.renameSync;
fs.renameSync = function (src) {
  if (String(src).endsWith('.inbox.jsonl')) {
    const L = JSON.parse(fs.readFileSync(process.env.A2_LEDGER, 'utf8'));
    L.otherWriter = true;
    fs.writeFileSync(process.env.A2_LEDGER, JSON.stringify(L, null, 2) + '\\n');
    const e = new Error('EACCES: permission denied, rename');
    e.code = 'EACCES';
    throw e;
  }
  return realRename.apply(this, arguments);
};
`;

test('a failed inbox move does not restore a ledger that someone else has written since', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  fillInbox(sb);
  const inboxBefore = readFileSync(sb.inboxFile);
  const preload = path.join(sb.tmp, 'changed-preload.cjs');
  writeFileSync(preload, CHANGED_PRELOAD);
  const r = runSync(sb, preload, { A2_LEDGER: sb.ledgerFile }, 'sync', sb.ledgerFile);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(sb.ledger().otherWriter, true, 'the other writer\'s ledger is kept');
  assert.deepEqual(readFileSync(sb.inboxFile), inboxBefore);
});
