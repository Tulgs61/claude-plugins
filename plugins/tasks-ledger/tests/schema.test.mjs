// schemas/tasks.schema.json against real ledgers: the ones the helper sandbox writes, the same ledgers
// after helper commands have run (inbox ingestion included), and hand-made invalid ones. The validator
// below implements only the JSON Schema keywords the ledger schema uses and refuses any other keyword,
// so a schema change that needs more is noticed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { sandbox, task } from './helpers/git-sandbox.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/tasks.schema.json', import.meta.url), 'utf8'));

// ---- minimal validator ---------------------------------------------------------------------------

const ANNOTATIONS = new Set(['$schema', 'title', 'description']);
const KEYWORDS = new Set(['type', 'enum', 'pattern', 'properties', 'required', 'additionalProperties', 'items']);

// Walks the schema once and fails on a keyword this validator does not implement.
function checkSupported(schema, where = '#') {
  assert.equal(typeof schema, 'object', `${where} is not a schema object`);
  for (const key of Object.keys(schema)) {
    assert.ok(ANNOTATIONS.has(key) || KEYWORDS.has(key), `unsupported keyword ${key} at ${where}`);
  }
  for (const [name, sub] of Object.entries(schema.properties || {})) checkSupported(sub, `${where}/properties/${name}`);
  if (schema.items) checkSupported(schema.items, `${where}/items`);
  if (typeof schema.additionalProperties === 'object') checkSupported(schema.additionalProperties, `${where}/additionalProperties`);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function hasType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

// Returns a list of "<path>: <problem>" strings; empty means valid.
function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => hasType(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some(v => v === value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}: missing ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) errors.push(...validate(props[key], child, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown key ${key}`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, child, `${at}.${key}`));
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  return errors;
}

const assertValid = (ledger, label) => assert.deepEqual(validate(SCHEMA, ledger), [], `${label} should be valid`);
const assertInvalid = (ledger, fragment, label) => {
  const errors = validate(SCHEMA, ledger);
  assert.ok(errors.some(e => e.includes(fragment)), `${label}: expected an error containing "${fragment}", got ${JSON.stringify(errors)}`);
};

// ---- the schema itself ---------------------------------------------------------------------------

test('the schema is draft 2020-12 and uses only the implemented keywords', () => {
  assert.equal(SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
  checkSupported(SCHEMA);
});

test('the schema pins the ledger shape from the spec', () => {
  assert.equal(SCHEMA.type, 'object');
  assert.deepEqual(SCHEMA.required, ['tasks']);
  assert.notEqual(SCHEMA.additionalProperties, false, 'extra top-level keys are allowed');
  const top = SCHEMA.properties;
  assert.deepEqual(Object.keys(top).sort(), [
    'baseBranch', 'checkTimeoutMin', 'goal', 'integrationBranch', 'prs', 'runStatus', 'setup', 'stopReason', 'suite', 'tasks', 'topic',
  ]);
  assert.deepEqual([...top.runStatus.enum].sort(), ['finished', 'planned', 'running', 'stopped']);
  assert.equal(top.topic.pattern, '^[a-z0-9][a-z0-9-]*$');

  const t = top.tasks.items;
  assert.equal(t.additionalProperties, false);
  assert.deepEqual([...t.required].sort(), ['acceptance', 'dependsOn', 'files', 'id', 'status', 'title']);
  assert.deepEqual(Object.keys(t.properties).sort(), [
    'acceptance', 'base', 'branch', 'budget', 'constraints', 'dependsOn', 'evidence', 'files', 'id', 'pr', 'proof', 'status', 'title', 'worktree',
  ]);
  assert.equal(t.properties.id.pattern, '^T[0-9]+$');
  assert.equal(t.properties.dependsOn.items.pattern, '^T[0-9]+$');
  assert.deepEqual([...t.properties.status.enum].sort(), ['blocked', 'done', 'in_progress', 'merged', 'todo', 'verified']);
});

// ---- accepted ledgers ----------------------------------------------------------------------------

test('a ledger written by the helper sandbox is valid before any command runs', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/**']), task('T2', ['lib/**'], ['T1'])], ledgerExtra: { suite: 'true', checkTimeoutMin: 5 } });
  assertValid(sb.ledger(), 'fresh sandbox ledger');
  const bare = sandbox(t, { setup: null });
  assertValid(bare.ledger(), 'sandbox ledger without tasks or setup');
});

test('the ledger stays valid through prepare, worktree, status, merge, prs and finish', t => {
  const sb = sandbox(t, { prs: true, tasks: [task('T1', ['a/**']), task('T2', ['b/**'], ['T1']), task('T3', ['c/**'])] });
  sb.ok('prepare', 'run-one');
  assertValid(sb.ledger(), 'after prepare');

  sb.complete('T1');
  assertValid(sb.ledger(), 'after T1 merged');
  const w = sb.ok('worktree', 'T2');
  assertValid(sb.ledger(), 'after worktree T2');
  sb.commit(w.worktree, 'b/x.txt', 'x\n');
  sb.ok('verify', 'T2');
  sb.ok('status', 'T2', 'verified', 'reviewed');
  sb.ok('merge', 'T2');
  sb.ok('status', 'T3', 'blocked', 'review rejected');
  assertValid(sb.ledger(), 'after merge and block');

  sb.ok('prs');
  const L = sb.ledger();
  assert.equal(typeof L.tasks[0].pr, 'string', 'prs stored a request URL');
  assertValid(L, 'after prs');

  sb.ok('finish', 'stopped', 'T3 blocked');
  assertValid(sb.ledger(), 'after finish stopped');
  sb.ok('prepare', 'run-two');
  sb.ok('finish', 'finished');
  assertValid(sb.ledger(), 'after finish finished');
});

test('tasks ingested from inbox lines with title and acceptance are valid', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/**'])] });
  sb.ok('prepare', 'run-one');
  const lines = [
    { title: 'plain', acceptance: 'the page shows a count' },
    { id: 'T7', title: 'explicit id', acceptance: 'acc', files: ['docs/**', 7], dependsOn: ['T1', '../x', 3] },
    { title: 'with extras', acceptance: 'acc', status: 'merged', branch: 'evil', proof: 'npm test', budget: '20 turns', constraints: ['no API change'], unknown: true },
  ];
  writeFileSync(sb.inboxFile, lines.map(l => JSON.stringify(l)).join('\r\n') + '\r\n');
  const r = sb.ok('sync');
  assert.equal(r.added.length, 3);
  assertValid(sb.ledger(), 'after sync');

  writeFileSync(sb.inboxFile, JSON.stringify({ title: 'joined at prepare', acceptance: 'acc' }) + '\n');
  sb.ok('finish', 'stopped', 'paused');
  const again = sb.ok('prepare', 'run-two');
  assert.equal(again.added.length, 1);
  assertValid(sb.ledger(), 'after prepare ingested the inbox');
});

test('a planned ledger with every optional key is valid', () => {
  assertValid({
    topic: 'csv-export',
    goal: 'export reports as CSV',
    baseBranch: 'develop',
    prs: false,
    setup: 'npm ci',
    suite: 'npm test',
    checkTimeoutMin: 12.5,
    runStatus: 'planned',
    integrationBranch: null,
    stopReason: null,
    owner: 'extra top-level keys are allowed',
    tasks: [
      { ...task('T1', ['src/csv/**']), base: null, branch: null, worktree: null, pr: null, evidence: null },
      { ...task('T12', ['docs/csv.md'], ['T1']), status: 'in_progress' },
    ],
  }, 'planned ledger');
});

// ---- rejected ledgers ----------------------------------------------------------------------------

const good = () => ({ topic: 'demo', tasks: [task('T1', ['src/**'])] });

test('an unknown task key is rejected', () => {
  const L = good();
  L.tasks[0].owner = 'someone';
  assertInvalid(L, 'unknown key owner', 'unknown task key');
});

test('a malformed task id is rejected', () => {
  for (const id of ['t1', 'T', 'T1;rm', '../x', 'X1', 'T1 ']) {
    const L = good();
    L.tasks[0].id = id;
    assertInvalid(L, 'does not match', `id ${JSON.stringify(id)}`);
  }
  const L = good();
  L.tasks[0].dependsOn = ['T1', 'T2;rm'];
  assertInvalid(L, 'does not match', 'malformed prerequisite');
});

test('an unknown task status is rejected', () => {
  for (const status of ['finished', 'failed', 'Todo', '']) {
    const L = good();
    L.tasks[0].status = status;
    assertInvalid(L, 'not in enum', `status ${JSON.stringify(status)}`);
  }
});

test('other violations are rejected too', () => {
  assertInvalid({ topic: 'demo' }, 'missing tasks', 'no tasks');
  assertInvalid({ ...good(), topic: 'Demo_1' }, 'does not match', 'bad topic');
  assertInvalid({ ...good(), runStatus: 'done' }, 'not in enum', 'bad runStatus');
  assertInvalid({ ...good(), prs: 'yes' }, 'expected boolean', 'prs not boolean');
  const missing = good();
  delete missing.tasks[0].acceptance;
  assertInvalid(missing, 'missing acceptance', 'task without acceptance');
  const files = good();
  files.tasks[0].files = ['src/**', 7];
  assertInvalid(files, 'expected string', 'non-string file glob');
});
