// Rev 4, amendment 1: inbox ids with more than nine digits are invalid, generated ids always have
// the form T<n>, and ingestion terminates however large the ledger's ids are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, task } from './helpers/git-sandbox.mjs';

const inbox = (sb, entries) =>
  sb.write(path.dirname(sb.inboxFile), path.basename(sb.inboxFile), entries.map(e => JSON.stringify(e)).join('\n') + '\n');

test('an inbox id with more than nine digits gets a generated id; nine digits are kept', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  inbox(sb, [
    { id: 'T1234567890', title: 'ten digits' },
    { id: 'T999999999', title: 'nine digits' },
    { title: 'no id' },
  ]);
  const r = sb.ok('sync');
  assert.deepEqual(r.added, ['T2', 'T999999999', 'T3']);
  for (const id of r.added) assert.match(id, /^T[0-9]+$/);
  assert.deepEqual(sb.ledger().tasks.map(x => x.id), ['T1', 'T2', 'T999999999', 'T3']);
});

test('ingestion terminates and generates T<n> ids after a huge ledger id', t => {
  const huge = 'T99999999999999999999999';
  const sb = sandbox(t, { tasks: [task('T1'), task(huge)] });
  inbox(sb, [{ title: 'first' }, { id: huge, title: 'taken' }, { title: 'third' }]);
  const r = sb.ok('sync');
  assert.equal(r.added.length, 3);
  for (const id of r.added) assert.match(id, /^T[0-9]+$/);
  assert.deepEqual(r.added, ['T100000000000000000000000', 'T100000000000000000000001', 'T100000000000000000000002']);
  assert.equal(new Set(sb.ledger().tasks.map(x => x.id)).size, 5, 'ids stay unique');
});
