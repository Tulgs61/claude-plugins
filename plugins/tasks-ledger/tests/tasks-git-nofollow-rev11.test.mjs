// The temporary file of an atomic write is created, never followed, and lines carried over after an
// inbox move are never written through a link or into anything but a plain regular inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const win32 = process.platform === 'win32';
const noMkfifo = win32 || spawnSync('sh', ['-c', 'command -v mkfifo']).status !== 0;

// Runs the helper with a preload and extra environment under a time limit, so a call that blocks
// fails the test instead of hanging it.
function runWith(sb, args, { preload, env = {}, ms = 30000 } = {}) {
  const pre = [].concat(preload || []).flatMap(p => ['--require', p]);
  const r = spawnSync(process.execPath, [...pre, SCRIPT, ...args], { cwd: sb.repo, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: ms });
  assert.equal(r.status, 0, `tasks-git ${args.join(' ')} did not answer within ${ms} ms: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return JSON.parse(lines[0]);
}

const writePreload = (sb, name, source) => {
  const file = path.join(sb.tmp, name);
  writeFileSync(file, source);
  return file;
};

const lstatOrNull = file => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};

// A file outside the runs directory that a planted link points to.
function victim(sb) {
  const file = path.join(sb.tmp, 'victim.txt');
  writeFileSync(file, 'victim\n');
  return { file, bytes: readFileSync(file) };
}

const runsFiles = sb => readdirSync(path.dirname(sb.ledgerFile));

// For the first write to a path starting with TMP_PREFIX, a symbolic link to VICTIM is planted at
// that exact path before the real write runs.
const PLANT_TMP_PRELOAD = `
const fs = require('node:fs');
const real = fs.writeFileSync;
let planted = false;
fs.writeFileSync = function (file) {
  if (!planted && typeof file === 'string' && file.startsWith(process.env.TMP_PREFIX)) {
    planted = true;
    fs.symlinkSync(process.env.VICTIM, file);
  }
  return real.apply(this, arguments);
};
`;

test('amendment 5: a ledger write whose temporary file is planted as a link fails and writes nothing through it', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const v = victim(sb);
  const ledgerBefore = readFileSync(sb.ledgerFile);
  const preload = writePreload(sb, 'plant-tmp-preload.cjs', PLANT_TMP_PRELOAD);
  const r = runWith(sb, ['status', sb.ledgerFile, 'T1', 'blocked', 'x'], { preload, env: { TMP_PREFIX: `${sb.ledgerFile}.tmp-`, VICTIM: v.file } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /EEXIST/);
  assert.deepEqual(readFileSync(v.file), v.bytes);
  assert.ok(lstatSync(sb.ledgerFile).isFile(), 'the ledger is still a regular file');
  assert.deepEqual(readFileSync(sb.ledgerFile), ledgerBefore);
  const links = runsFiles(sb).filter(f => f.includes('.json.tmp-'));
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.ok(lstatSync(path.join(path.dirname(sb.ledgerFile), links[0])).isSymbolicLink(), 'the planted link is still a link');
});

test('amendment 5: a lock write whose temporary file is planted as a link fails prepare and leaves no lock', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const v = victim(sb);
  const preload = writePreload(sb, 'plant-tmp-preload.cjs', PLANT_TMP_PRELOAD);
  const r = runWith(sb, ['prepare', sb.ledgerFile, 'run-new'], { preload, env: { TMP_PREFIX: `${sb.lockFile}.tmp-`, VICTIM: v.file } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(readFileSync(v.file), v.bytes);
  assert.equal(lstatOrNull(sb.lockFile), null, 'no lock of this call remains');
});

// When the inbox is moved aside, a late writer first appends LATE_LINE to it; after the move,
// CARRY_MODE puts something at the inbox path: a link to VICTIM, a FIFO, a new regular inbox holding
// OWN_LINE, a hard link to VICTIM, or nothing.
const LATE_WRITER_PRELOAD = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const E = process.env;
const realRename = fs.renameSync;
fs.renameSync = function (src, dest) {
  if (String(src) === E.INBOX && String(dest).includes('.inbox.jsonl.ingested-')) {
    fs.writeFileSync(E.INBOX, E.LATE_LINE, { flag: 'a' });
    const r = realRename.apply(this, arguments);
    if (E.CARRY_MODE === 'link') fs.symlinkSync(E.VICTIM, E.INBOX);
    else if (E.CARRY_MODE === 'fifo') spawnSync('mkfifo', [E.INBOX]);
    else if (E.CARRY_MODE === 'regular') fs.writeFileSync(E.INBOX, E.OWN_LINE);
    else if (E.CARRY_MODE === 'hardlink') fs.linkSync(E.VICTIM, E.INBOX);
    return r;
  }
  return realRename.apply(this, arguments);
};
`;

const FIRST_LINE = JSON.stringify({ title: 'first', acceptance: 'a' }) + '\n';
const LATE_LINE = JSON.stringify({ title: 'late', acceptance: 'a' }) + '\n';
const OWN_LINE = JSON.stringify({ title: 'own', acceptance: 'a' }) + '\n';

function syncWithLateWriter(sb, mode, extraEnv = {}, extraPreloads = []) {
  writeFileSync(sb.inboxFile, FIRST_LINE);
  const preload = writePreload(sb, 'late-writer-preload.cjs', LATE_WRITER_PRELOAD);
  return runWith(sb, ['sync', sb.ledgerFile], {
    preload: [preload, ...extraPreloads],
    env: { INBOX: sb.inboxFile, LATE_LINE, OWN_LINE, CARRY_MODE: mode, ...extraEnv },
  });
}

const keptCopy = sb => {
  const kept = runsFiles(sb).filter(f => f.includes('.inbox.jsonl.ingested-'));
  assert.equal(kept.length, 1, JSON.stringify(kept));
  return path.join(path.dirname(sb.ledgerFile), kept[0]);
};

const notCarried = r => (r.warnings || []).filter(w => /lines appended to the inbox after it was read were not carried over/.test(w));

test('amendment 6: late lines are not carried over through a link planted at the inbox path', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const v = victim(sb);
  const r = syncWithLateWriter(sb, 'link', { VICTIM: v.file });
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = keptCopy(sb);
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  assert.ok(warnings[0].includes(kept), `the warning names ${kept}: ${warnings[0]}`);
  assert.deepEqual(readFileSync(v.file), v.bytes);
  assert.ok(readFileSync(kept, 'utf8').includes(LATE_LINE), 'the kept file still holds the late line');
  assert.deepEqual(sb.ledger().tasks.map(x => x.title), ['task T1', 'first']);
  assert.ok(lstatSync(sb.inboxFile).isSymbolicLink(), 'the link is left as it is');
});

test('amendment 6: late lines are not carried over into a FIFO at the inbox path, and the call returns', { skip: noMkfifo }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const r = syncWithLateWriter(sb, 'fifo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(notCarried(r).length, 1, JSON.stringify(r));
  assert.ok(lstatSync(sb.inboxFile).isFIFO(), 'the FIFO is still there');
  assert.ok(readFileSync(keptCopy(sb), 'utf8').includes(LATE_LINE));
  assert.deepEqual(sb.ledger().tasks.map(x => x.title), ['task T1', 'first']);
});

test('amendment 6 (coverage): late lines are appended to a new regular inbox a writer created meanwhile', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const r = syncWithLateWriter(sb, 'regular');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings, undefined, JSON.stringify(r));
  assert.equal(readFileSync(sb.inboxFile, 'utf8'), OWN_LINE + LATE_LINE);
});

test('amendment 6 (coverage): late lines go into a fresh inbox when the inbox path is free', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const r = syncWithLateWriter(sb, 'none');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings, undefined, JSON.stringify(r));
  assert.ok(existsSync(sb.inboxFile));
  assert.ok(lstatSync(sb.inboxFile).isFile());
  assert.equal(readFileSync(sb.inboxFile, 'utf8'), LATE_LINE);
});

test('amendment 6: late lines are not carried over into a new inbox that is a hard link to another file', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const v = victim(sb);
  const r = syncWithLateWriter(sb, 'hardlink', { VICTIM: v.file });
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = keptCopy(sb);
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  assert.ok(warnings[0].includes(kept), `the warning names ${kept}: ${warnings[0]}`);
  assert.deepEqual(readFileSync(v.file), v.bytes);
  assert.ok(readFileSync(kept, 'utf8').includes(LATE_LINE), 'the kept file still holds the late line');
});

// On the first descriptor opened for writing at INBOX with numeric flags (the carry-over), the first
// fs.writeSync writes only part of the buffer and the next one throws ENOSPC.
const PARTIAL_WRITE_PRELOAD = `
const fs = require('node:fs');
const realOpen = fs.openSync;
const realWrite = fs.writeSync;
let target = null;
let writes = 0;
fs.openSync = function (file, flags) {
  const fd = realOpen.apply(this, arguments);
  if (target === null && String(file) === process.env.INBOX && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) target = fd;
  return fd;
};
fs.writeSync = function (fd, buffer, offset, length) {
  if (fd === target && target !== null) {
    writes++;
    if (writes === 1) return realWrite.call(this, fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
    const e = new Error('ENOSPC: no space left on device, write');
    e.code = 'ENOSPC';
    throw e;
  }
  return realWrite.apply(this, arguments);
};
`;

test('amendment 8: a carry-over write that fails partway leaves the new inbox as it was', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const partial = writePreload(sb, 'partial-write-preload.cjs', PARTIAL_WRITE_PRELOAD);
  const r = syncWithLateWriter(sb, 'regular', {}, [partial]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  const kept = keptCopy(sb);
  assert.ok(warnings[0].includes(kept), `the warning names ${kept}: ${warnings[0]}`);
  assert.ok(!warnings[0].includes('may hold part'), warnings[0]);
  assert.equal(readFileSync(sb.inboxFile, 'utf8'), OWN_LINE);
  assert.ok(readFileSync(kept, 'utf8').includes(LATE_LINE), 'the kept file still holds the late line');
});

// From the second write to a path starting with LOCK_TMP on, fs.writeFileSync throws EIO.
const EIO_PRELOAD = `
const fs = require('node:fs');
const real = fs.writeFileSync;
let calls = 0;
fs.writeFileSync = function (file) {
  if (typeof file === 'string' && file.startsWith(process.env.LOCK_TMP) && ++calls >= 2) {
    const e = new Error('EIO: i/o error, write');
    e.code = 'EIO';
    throw e;
  }
  return real.apply(this, arguments);
};
`;

test('amendment 8: a failed rewrite of the previous lock keeps the original error and says the lock is still this call\'s', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'exit 4' });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 7 * 3600 * 1000 }) + '\n');
  const preload = writePreload(sb, 'eio-preload.cjs', EIO_PRELOAD);
  const r = runWith(sb, ['prepare', sb.ledgerFile, 'run-new', 'takeover'], { preload, env: { LOCK_TMP: `${sb.lockFile}.tmp-` } });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 4/);
  assert.match(r.error, /EIO/);
  assert.ok(r.error.includes("the lock still holds this call's text"), r.error);
});

// From the second attempt on, linking a guard fails, so the guard cannot be created for restoring.
const LATE_NOLINK_PRELOAD = `
const fs = require('node:fs');
const real = fs.linkSync;
let guards = 0;
fs.linkSync = function (from, to) {
  if (String(to).endsWith('.guard') && ++guards > 1) {
    const e = new Error('EPERM: operation not permitted, link');
    e.code = 'EPERM';
    throw e;
  }
  return real.apply(this, arguments);
};
`;

test('amendment 10: a restore without the guard keeps the original error and says the lock is still this call\'s', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')], setup: 'exit 4' });
  writeFileSync(sb.lockFile, JSON.stringify({ runId: 'run-old', at: Date.now() - 7 * 3600 * 1000 }) + '\n');
  const preload = writePreload(sb, 'late-nolink-preload.cjs', LATE_NOLINK_PRELOAD);
  const r = runWith(sb, ['prepare', sb.ledgerFile, 'run-new', 'takeover'], { preload });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /setup .* failed .* exit 4/);
  assert.match(r.error, /cannot create guard/);
  assert.ok(r.error.includes("the lock still holds this call's text"), r.error);
  assert.equal(r.tail !== undefined, true, 'the original error keeps its extra fields');
});

// Like the partial-write preload, but before the failing write another writer appends EXTRA_LINE to
// the inbox path through its own descriptor.
const PARTIAL_THEN_APPEND_PRELOAD = `
const fs = require('node:fs');
const realOpen = fs.openSync;
const realWrite = fs.writeSync;
let target = null;
let writes = 0;
fs.openSync = function (file, flags) {
  const fd = realOpen.apply(this, arguments);
  if (target === null && String(file) === process.env.INBOX && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) target = fd;
  return fd;
};
fs.writeSync = function (fd, buffer, offset, length) {
  if (fd === target && target !== null) {
    writes++;
    if (writes === 1) return realWrite.call(this, fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
    const other = realOpen.call(fs, process.env.INBOX, 'a');
    realWrite.call(fs, other, process.env.EXTRA_LINE);
    fs.closeSync(other);
    const e = new Error('ENOSPC: no space left on device, write');
    e.code = 'ENOSPC';
    throw e;
  }
  return realWrite.apply(this, arguments);
};
`;

const EXTRA_LINE = JSON.stringify({ title: 'extra', acceptance: 'a' }) + '\n';

test('amendment 10: a failed carry-over write never truncates lines another writer appended meanwhile', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const partial = writePreload(sb, 'partial-append-preload.cjs', PARTIAL_THEN_APPEND_PRELOAD);
  const r = syncWithLateWriter(sb, 'regular', { EXTRA_LINE }, [partial]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  assert.ok(warnings[0].includes('; the inbox may hold part of these lines'), warnings[0]);
  assert.ok(warnings[0].includes('lines appended after them may be unreadable'), warnings[0]);
  assert.ok(warnings[0].includes(sb.inboxFile), `the warning names ${sb.inboxFile}: ${warnings[0]}`);
  assert.ok(readFileSync(sb.inboxFile, 'utf8').includes(EXTRA_LINE), 'the inbox still holds the other writer\'s line');
});

test('amendment 10 (coverage): a carry-over write that fails partway into an inbox this call created leaves it empty', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const partial = writePreload(sb, 'partial-write-preload.cjs', PARTIAL_WRITE_PRELOAD);
  const r = syncWithLateWriter(sb, 'none', {}, [partial]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  const kept = keptCopy(sb);
  assert.ok(warnings[0].includes(kept), `the warning names ${kept}: ${warnings[0]}`);
  assert.ok(!warnings[0].includes('may hold part'), warnings[0]);
  assert.equal(readFileSync(sb.inboxFile, 'utf8'), '');
});

// fs.ftruncateSync always throws.
const NO_TRUNCATE_PRELOAD = `
const fs = require('node:fs');
fs.ftruncateSync = function () {
  const e = new Error('EIO: i/o error, ftruncate');
  e.code = 'EIO';
  throw e;
};
`;

test('amendment 10 (coverage): when truncating after a failed carry-over write fails, the warning says the inbox may hold part', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const partial = writePreload(sb, 'partial-write-preload.cjs', PARTIAL_WRITE_PRELOAD);
  const noTruncate = writePreload(sb, 'no-truncate-preload.cjs', NO_TRUNCATE_PRELOAD);
  const r = syncWithLateWriter(sb, 'regular', {}, [partial, noTruncate]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const warnings = notCarried(r);
  assert.equal(warnings.length, 1, JSON.stringify(r));
  assert.ok(warnings[0].endsWith('; the inbox may hold part of these lines'), warnings[0]);
});

// Closing the first descriptor opened for writing at INBOX with numeric flags closes it and then
// throws, once (the descriptor number may be reused afterwards).
const CLOSE_THROWS_PRELOAD = `
const fs = require('node:fs');
const realOpen = fs.openSync;
const realClose = fs.closeSync;
let target = null;
fs.openSync = function (file, flags) {
  const fd = realOpen.apply(this, arguments);
  if (target === null && String(file) === process.env.INBOX && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) target = fd;
  return fd;
};
let thrown = false;
fs.closeSync = function (fd) {
  realClose.apply(this, arguments);
  if (fd === target && target !== null && !thrown) {
    thrown = true;
    const e = new Error('EIO: i/o error, close');
    e.code = 'EIO';
    throw e;
  }
};
`;

test('amendment 10 (coverage): an error closing the inbox after a carry-over changes nothing about the answer', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const closeThrows = writePreload(sb, 'close-throws-preload.cjs', CLOSE_THROWS_PRELOAD);
  const r = syncWithLateWriter(sb, 'regular', {}, [closeThrows]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings, undefined, JSON.stringify(r));
  assert.equal(readFileSync(sb.inboxFile, 'utf8'), OWN_LINE + LATE_LINE);
});
