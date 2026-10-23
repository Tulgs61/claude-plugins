// Rev 13: a carry-over write that fails partway while another writer appends leaves the other
// writer's line joined to an incomplete one. The next sync still reads the joined line from its
// ending, drops the incomplete part, and the warning says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';

const win32 = process.platform === 'win32';

function runWith(sb, args, { preload = [], env = {}, ms = 30000 } = {}) {
  const pre = preload.flatMap(p => ['--require', p]);
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

// When the inbox is moved aside, a late writer appends LATE_LINE first, and after the move a writer
// creates a new inbox holding OWN_LINE.
const LATE_WRITER_PRELOAD = `
const fs = require('node:fs');
const E = process.env;
const realRename = fs.renameSync;
fs.renameSync = function (src, dest) {
  if (String(src) === E.INBOX && String(dest).includes('.inbox.jsonl.ingested-')) {
    fs.writeFileSync(E.INBOX, E.LATE_LINE, { flag: 'a' });
    const r = realRename.apply(this, arguments);
    fs.writeFileSync(E.INBOX, E.OWN_LINE);
    return r;
  }
  return realRename.apply(this, arguments);
};
`;

// On the carry-over descriptor, the first fs.writeSync writes only part of the buffer; before the next
// one throws ENOSPC, another writer appends EXTRA_LINE through its own descriptor.
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

const FIRST_LINE = JSON.stringify({ title: 'first', acceptance: 'a' }) + '\n';
const LATE_LINE = JSON.stringify({ title: 'late', acceptance: 'a' }) + '\n';
const OWN_LINE = JSON.stringify({ title: 'own', acceptance: 'a' }) + '\n';
const EXTRA_LINE = JSON.stringify({ title: 'extra', acceptance: 'a', files: ['x/**'] }) + '\n';

const titles = sb => sb.ledger().tasks.map(x => x.title);

test('a line another writer appended after a partial carry-over is ingested by the next sync', { skip: win32 }, t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.inboxFile, FIRST_LINE);
  const late = writePreload(sb, 'late-writer-preload.cjs', LATE_WRITER_PRELOAD);
  const partial = writePreload(sb, 'partial-append-preload.cjs', PARTIAL_THEN_APPEND_PRELOAD);
  const r = runWith(sb, ['sync', sb.ledgerFile], {
    preload: [late, partial],
    env: { INBOX: sb.inboxFile, LATE_LINE, OWN_LINE, EXTRA_LINE },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(titles(sb), ['task T1', 'first']);

  // The inbox holds its own line, part of the late line, and the extra line joined to that part.
  const inbox = readFileSync(sb.inboxFile, 'utf8');
  assert.ok(inbox.startsWith(OWN_LINE), inbox);
  assert.ok(inbox.endsWith(EXTRA_LINE), inbox);
  const joined = inbox.slice(OWN_LINE.length).split('\n')[0];
  assert.notEqual(joined, EXTRA_LINE.trimEnd(), 'the extra line is joined to part of the late line');
  assert.throws(() => JSON.parse(joined), 'the joined line is not JSON as a whole');

  // The warning matches what the next sync does.
  const warnings = (r.warnings || []).filter(w => w.startsWith('lines appended to the inbox after it was read were not carried over'));
  assert.equal(warnings.length, 1, JSON.stringify(r));
  assert.ok(warnings[0].endsWith(`; the inbox may hold part of these lines, and a line another writer appended is joined to the last, incomplete one; the next sync drops the incomplete line and still reads the appended one; check ${sb.inboxFile}`), warnings[0]);

  const again = sb.ok('sync');
  assert.equal(again.warnings, undefined, JSON.stringify(again));
  assert.deepEqual(titles(sb), ['task T1', 'first', 'own', 'extra']);
  const extra = sb.ledger().tasks.find(x => x.title === 'extra');
  assert.deepEqual(extra.files, ['x/**']);
  assert.equal(extra.status, 'todo');
});

test('a joined line is read from its ending: a nested object and a complete line before it', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const nested = JSON.stringify({ title: 'nested', acceptance: 'a', extra: { deep: { x: '{"title":"no"}' } } });
  writeFileSync(
    sb.inboxFile,
    [
      // An incomplete line whose cut part holds a brace, joined to a line with nested objects.
      '{"title":"cut {", "acceptance":"a' + nested,
      // A complete line without its newline, joined to another: only the ending is read.
      JSON.stringify({ title: 'whole', acceptance: 'a' }) + JSON.stringify({ title: 'after', acceptance: 'a' }),
      // Text before an object is no longer a reason to skip the object.
      'garbage ' + JSON.stringify({ title: 'tail', acceptance: 'a' }),
      // Still skipped: nothing parses, or the ending has no title.
      '{not json',
      '{"title":"x"' + JSON.stringify({ acceptance: 'no title' }),
      '',
    ].join('\n'),
  );
  const r = sb.ok('sync');
  assert.deepEqual(r.added, ['T2', 'T3', 'T4']);
  assert.deepEqual(titles(sb), ['task T1', 'nested', 'after', 'tail']);
});

test('(coverage) a hostile line full of braces is given up on quickly and adds nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeFileSync(sb.inboxFile, '{"a":'.repeat(200000) + '\n' + JSON.stringify({ title: 'ok', acceptance: 'a' }) + '\n');
  const started = Date.now();
  const r = sb.ok('sync');
  assert.ok(Date.now() - started < 20000, 'sync answered in time');
  assert.deepEqual(r.added, ['T2']);
  assert.deepEqual(titles(sb), ['task T1', 'ok']);
});
