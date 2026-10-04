// Vocabulary check: the helper subcommands and engine arguments that the dispatch, tasks and
// tasks-plan skills name must exist in scripts/tasks-git.js and workflows/tasks-engine.js, and the
// skills name no others.
//
// What counts as "naming":
// - a helper subcommand is the first word after a quoted script path in a `node "<path>" <word>`
//   command line;
// - an engine argument is a key of a JSON object in a ```json block, or an inline `"key":` pair;
// - every camelCase code span must be an engine argument or a ledger property from the schema, so
//   an engine argument that does not exist cannot hide in prose either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ENGINE, SCRIPT } from './helpers/git-sandbox.mjs';

const HELPER_COMMANDS = ['finish', 'merge', 'prepare', 'prs', 'status', 'sync', 'verify', 'worktree'];
const ENGINE_ARGS = ['implementerAgent', 'ledger', 'reviewerAgent', 'runId', 'script', 'takeover'];
const SKILLS = ['dispatch', 'tasks', 'tasks-plan'];

const skillText = name => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('../schemas/tasks.schema.json', import.meta.url), 'utf8'));
const LEDGER_KEYS = new Set([...Object.keys(schema.properties), ...Object.keys(schema.properties.tasks.items.properties)]);

function helperCommandsNamed(text) {
  const names = new Set();
  for (const m of text.matchAll(/\bnode\s+"[^"\n]*"\s+([^\s"]+)/g)) {
    if (!m[1].startsWith('<')) names.add(m[1]);
  }
  return names;
}

function engineArgsNamed(text) {
  const names = new Set();
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const value = JSON.parse(m[1]);
    assert.equal(typeof value, 'object', 'a json block holds an object');
    for (const key of Object.keys(value)) names.add(key);
  }
  for (const m of text.matchAll(/"([A-Za-z_]\w*)"\s*:/g)) names.add(m[1]);
  return names;
}

const camelCaseSpans = text => [...text.matchAll(/`([a-z]+[A-Z][A-Za-z0-9]*)`/g)].map(m => m[1]);

// The helper's command table, read from its source and confirmed by running it: a known command
// with an unusable ledger fails on the ledger, an unknown one on the command.
function helperCommands() {
  const table = readFileSync(SCRIPT, 'utf8').match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'COMMANDS table found in tasks-git.js');
  return [...table[1].matchAll(/^\s*([a-z]+):/gm)].map(m => m[1]);
}

function helperError(cmd) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, '/nonexistent/ledger.json'], { encoding: 'utf8' });
  return JSON.parse(r.stdout.trim()).error;
}

// The engine's arguments, observed: run the body with a recording proxy as `args` and an agent that
// makes `prepare` fail at once, so the engine ends without doing anything.
async function engineArgs() {
  const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const read = new Set();
  const args = new Proxy(
    { ledger: '/tmp/x/.claude/runs/l.json', script: '/tmp/tasks-git.js', runId: 'vocab-check' },
    { get(target, key) { if (typeof key === 'string') read.add(key); return target[key]; } }
  );
  const agent = async () => ({ stdout: JSON.stringify({ ok: false, error: 'vocabulary check' }) + '\n' });
  const result = await new AsyncFunction('args', 'agent', 'phase', 'log', body)(args, agent, () => {}, () => {});
  assert.match(String(result.stopped), /vocabulary check/);
  return [...read].sort();
}

test('the spec lists match the helper and the engine', async () => {
  assert.deepEqual([...helperCommands()].sort(), HELPER_COMMANDS);
  for (const cmd of HELPER_COMMANDS) assert.doesNotMatch(helperError(cmd), /unknown command/, cmd);
  assert.match(helperError('no-such-command'), /unknown command no-such-command/);
  assert.deepEqual(await engineArgs(), ENGINE_ARGS);
});

for (const name of SKILLS) {
  test(`${name}: names only existing helper subcommands and engine arguments`, () => {
    const text = skillText(name);
    for (const cmd of helperCommandsNamed(text)) assert.ok(HELPER_COMMANDS.includes(cmd), `${name} names helper command ${cmd}`);
    for (const arg of engineArgsNamed(text)) assert.ok(ENGINE_ARGS.includes(arg), `${name} names engine argument ${arg}`);
    for (const word of camelCaseSpans(text)) {
      assert.ok(ENGINE_ARGS.includes(word) || LEDGER_KEYS.has(word), `${name} names ${word}, neither an engine argument nor a ledger key`);
    }
  });
}

test('the tasks skill starts the engine with its required arguments and retries through the helper', () => {
  const text = skillText('tasks');
  const args = engineArgsNamed(text);
  for (const key of ['ledger', 'runId', 'script', 'takeover']) assert.ok(args.has(key), `tasks passes ${key}`);
  const spans = new Set(camelCaseSpans(text));
  for (const key of ['implementerAgent', 'reviewerAgent']) assert.ok(spans.has(key), `tasks mentions ${key}`);
  assert.ok(helperCommandsNamed(text).has('status'), 'retry goes through the helper status command');
});

test('the extraction catches names that do not exist', () => {
  assert.deepEqual([...helperCommandsNamed('run `node "<helper>" reset "<ledger>"`')], ['reset']);
  assert.deepEqual([...engineArgsNamed('```json\n{"ledger": "x", "dryRun": true}\n```')], ['ledger', 'dryRun']);
  assert.deepEqual(camelCaseSpans('pass `maxTasks` and `runId`'), ['maxTasks', 'runId']);
});
