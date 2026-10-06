// Rev 10, amendments 7-9: the 15th task key `needsAcceptance`, the ledger's `agents` overrides (kept
// on every rewrite and reported by prepare), `invalid task id` before the lock, title-only inbox lines
// stored with an empty acceptance and `needsAcceptance: true`, and agent keys in inbox lines dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sandbox, task } from './helpers/git-sandbox.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/tasks.schema.json', import.meta.url), 'utf8'));
const AGENTS = { implementer: 'my-plugin:fast-implementer', reviewer: 'strict_reviewer-2' };
const writeInbox = (sb, lines) => writeFileSync(sb.inboxFile, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

test('amendment 7: prepare reports the ledger\'s agents, and every rewrite keeps them unchanged', t => {
  const sb = sandbox(t, { tasks: [task('T1'), task('T2')], ledgerExtra: { agents: AGENTS } });
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(r.agents, AGENTS);
  writeInbox(sb, [{ title: 'later', acceptance: 'acc' }]);
  sb.ok('sync', 'run-one');
  sb.ok('worktree', 'T1');
  sb.ok('status', 'T2', 'blocked', 'why');
  sb.ok('finish', 'stopped', 'paused', 'run-one');
  assert.deepEqual(sb.ledger().agents, AGENTS);
  assert.deepEqual(sb.ok('prepare', 'run-two').agents, AGENTS);
});

test('amendment 7: prepare answers agents null when the ledger has none', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const r = sb.ok('prepare', 'run-one');
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'agents'), JSON.stringify(r));
  assert.equal(r.agents, null);
});

test('amendment 7: prepare fails with invalid task id before taking the lock', t => {
  for (const id of ['X1', 'T1;rm', 't2']) {
    const sb = sandbox(t, { tasks: [task('T1'), task(id)] });
    const before = readFileSync(sb.ledgerFile);
    const r = sb.run('prepare', 'run-one');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(`invalid task id ${id}`), r.error);
    assert.equal(existsSync(sb.lockFile), false, 'no lock was taken');
    assert.deepEqual(readFileSync(sb.ledgerFile), before);
  }
});

test('amendment 7: the schema has the 15 task keys and the agents object', () => {
  const t = SCHEMA.properties.tasks.items;
  assert.equal(Object.keys(t.properties).length, 15);
  assert.equal(t.properties.needsAcceptance.type, 'boolean');
  const agents = SCHEMA.properties.agents;
  assert.equal(agents.type, 'object');
  assert.equal(agents.additionalProperties, false);
  assert.deepEqual(Object.keys(agents.properties).sort(), ['implementer', 'reviewer']);
  for (const k of ['implementer', 'reviewer']) {
    assert.equal(agents.properties[k].type, 'string');
    assert.equal(agents.properties[k].pattern, '^[A-Za-z0-9:_-]{1,64}$');
  }
});

test('amendment 8: title-only lines are stored with an empty acceptance and needsAcceptance true', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  writeInbox(sb, [
    { title: 'no acceptance' },
    { title: 'empty acceptance', acceptance: '' },
    { title: 'claims it is fine', acceptance: '', needsAcceptance: false },
    { title: 'with acceptance', acceptance: 'the page shows a count', needsAcceptance: true },
  ]);
  assert.deepEqual(sb.ok('sync').added, ['T2', 'T3', 'T4', 'T5']);
  const L = sb.ledger();
  assert.deepEqual(L.tasks[1], {
    title: 'no acceptance',
    id: 'T2',
    files: [],
    dependsOn: [],
    status: 'todo',
    branch: null,
    base: null,
    worktree: null,
    pr: null,
    evidence: null,
    acceptance: '',
    needsAcceptance: true,
  });
  for (const x of L.tasks.slice(1, 4)) {
    assert.equal(x.acceptance, '', x.title);
    assert.equal(x.needsAcceptance, true, x.title);
  }
  assert.equal(L.tasks[4].acceptance, 'the page shows a count');
  assert.equal(Object.prototype.hasOwnProperty.call(L.tasks[4], 'needsAcceptance'), false, 'a line with acceptance never gets the flag');
});

test('amendment 9: agent keys in an inbox line are dropped; the run-level agents come from the ledger only', t => {
  const sb = sandbox(t, { tasks: [task('T1')], ledgerExtra: { agents: AGENTS } });
  writeInbox(sb, [{ title: 'sneaky', acceptance: 'acc', agent: 'evil', agents: { implementer: 'evil', reviewer: 'evil' } }]);
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(r.added, ['T2']);
  assert.deepEqual(r.agents, AGENTS);
  const stored = sb.taskOf('T2');
  assert.equal(stored.agent, undefined);
  assert.equal(stored.agents, undefined);
  assert.deepEqual(sb.ledger().agents, AGENTS);
});
