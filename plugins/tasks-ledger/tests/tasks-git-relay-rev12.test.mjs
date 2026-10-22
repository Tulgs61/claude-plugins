// Rev 12: helper answers survive the relay only unchanged. Every answer line of tasks-git.js carries
// a check over its payload (`len`, `sum`), the task summary holds only the scheduling fields, and
// `task <id>` returns one task's full dispatch record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ENGINE, SCRIPT, sandbox, task } from './helpers/git-sandbox.mjs';
import { checkOf, fnv1a32 } from './helpers/relay.mjs';

const norm = s => s.replace(/\r\n/g, '\n');
const relayBlock = source => {
  const m = source.match(/\/\/ BEGIN relay-check\r?\n[\s\S]*?\/\/ END relay-check(?:\r?\n|$)/);
  return m ? m[0] : null;
};

// The check functions as the scripts define them, evaluated in an empty context.
function scriptCheck(file) {
  const ctx = vm.createContext({});
  vm.runInContext(relayBlock(readFileSync(file, 'utf8')) + '\nthis.relayCheck = relayCheck; this.relaySum = relaySum;', ctx);
  return ctx;
}

const SUMMARY_KEYS = ['base', 'branch', 'dependsOn', 'files', 'id', 'needsAcceptance', 'pr', 'status', 'worktree'];
const RECORD_KEYS = ['acceptance', 'base', 'branch', 'budget', 'constraints', 'dependsOn', 'files', 'id', 'needsAcceptance', 'pr', 'proof', 'status', 'title', 'worktree'];

// The raw answer line of one helper call.
function rawLine(sb, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8', timeout: 120000 });
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  return lines[0];
}

test('the relay-check block in tasks-git.js is identical to the one in workflows/tasks-engine.js', () => {
  const engine = relayBlock(readFileSync(ENGINE, 'utf8'));
  const helper = relayBlock(readFileSync(SCRIPT, 'utf8'));
  assert.ok(engine, 'engine has the relay-check block');
  assert.ok(helper, 'tasks-git.js has the relay-check block');
  assert.equal(norm(helper), norm(engine));
  const code = helper.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\brequire\s*\(|\bimport\b|\bcrypto\b|\bBuffer\b|\bTextEncoder\b/, 'pure JS, no runtime facilities');
});

test('the scripts hash as standard FNV-1a 32-bit over UTF-16LE bytes, also for surrogates and long texts', () => {
  const { relaySum, relayCheck } = scriptCheck(SCRIPT);
  assert.equal(relaySum(''), '811c9dc5');
  const samples = ['a', 'foobar', '{"ok":true}', 'é😀\ud800x\udc00', '\u0000\u001f ', 'x'.repeat(100000), '€'.repeat(3000)];
  for (const s of samples) assert.equal(relaySum(s), fnv1a32(Buffer.from(s, 'utf16le')), JSON.stringify(s.slice(0, 20)));
  const payload = { ok: true, tasks: [{ id: 'T1', title: 'ä "quoted" \\ \n😀', n: -0, big: 1.5e300, none: null }] };
  assert.deepEqual({ ...relayCheck(payload) }, checkOf(payload));
});

test('checksum round trip: every answer line verifies after JSON.parse and JSON.stringify, and any change breaks it', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/**'], [], { title: 'ünïcödé 😀 "q" \\ \t', constraints: ['c', { 2: 'b', 1: 'a', z: [1.25, -0, null] }] })] });
  const lines = [
    rawLine(sb, 'prepare', sb.ledgerFile, 'relay-run'),
    rawLine(sb, 'sync', sb.ledgerFile, 'relay-run'),
    rawLine(sb, 'task', sb.ledgerFile, 'T1'),
    rawLine(sb, 'task', sb.ledgerFile, 'T9'),
    rawLine(sb, 'status', sb.ledgerFile, 'T1', 'todo', 'note'),
    rawLine(sb, 'no-such-command', sb.ledgerFile),
  ];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys.slice(-2), ['len', 'sum'], 'the check fields come last');
    const { len, sum, ...payload } = parsed;
    const canonical = JSON.stringify(payload);
    assert.equal(line, `${canonical.slice(0, -1)},"len":${len},"sum":"${sum}"}`, 'the line is the canonical payload plus the check');
    assert.deepEqual({ len, sum }, checkOf(payload));
    // Re-serialised once more, with or without whitespace, the payload is still the same text.
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(payload, null, 2))), canonical);
    // Dropping a field or changing a value breaks the check.
    const first = keys[keys.length - 3];
    const { [first]: dropped, ...shortened } = payload;
    assert.notDeepEqual(checkOf(shortened), { len, sum });
    assert.notDeepEqual(checkOf({ ...payload, ok: !payload.ok }), { len, sum });
  }
});

test('prepare, sync and finish list only the scheduling summary of each task', t => {
  const sb = sandbox(t, {
    tasks: [
      task('T1', ['src/**'], [], { constraints: ['keep the API'], evidence: 'x'.repeat(3000) }),
      task('T2', ['lib/**'], ['T1'], { acceptance: '', proof: '' }),
      task('T3', ['doc/**'], [], { acceptance: '', budget: '' }),
      task('T4', ['web/**'], [], { needsAcceptance: true }),
      task('T5', ['x/**'], [], { acceptance: '', status: 'merged', resumeVerified: true }),
    ],
  });
  const answers = [sb.ok('prepare', 'relay-run'), sb.ok('sync', 'relay-run'), sb.ok('finish', 'finished', '', 'relay-run')];
  for (const a of answers) {
    assert.deepEqual(a.tasks.map(x => x.id), ['T1', 'T2', 'T3', 'T4', 'T5']);
    for (const x of a.tasks) {
      const expected = x.id === 'T5' ? [...SUMMARY_KEYS, 'resumeVerified'].sort() : SUMMARY_KEYS;
      assert.deepEqual(Object.keys(x).sort(), expected, JSON.stringify(x));
    }
    // A title-only task (no acceptance, and no proof or no budget) is marked like a flagged one.
    // T5 has no acceptance but both a proof and a budget, so it is dispatchable.
    assert.deepEqual(a.tasks.map(x => x.needsAcceptance), [false, true, true, true, false]);
    assert.deepEqual(a.tasks[1].dependsOn, ['T1']);
    assert.deepEqual(a.tasks[1].files, ['lib/**']);
    assert.equal(a.tasks[4].resumeVerified, true);
  }
});

test('task returns one task\'s full dispatch record and errors for an unknown or malformed id', t => {
  const sb = sandbox(t, {
    tasks: [
      task('T1', ['src/**'], [], { constraints: ['keep the API', 'no new deps'], evidence: 'long evidence' }),
      task('T2', ['lib/**'], ['T1'], { needsAcceptance: true, acceptance: '' }),
    ],
  });
  const r = sb.ok('task', 'T1');
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'task']);
  assert.deepEqual(Object.keys(r.task).sort(), RECORD_KEYS);
  assert.deepEqual(r.task, {
    constraints: ['keep the API', 'no new deps'], dependsOn: [], files: ['src/**'], acceptance: 'acceptance of T1', base: null,
    branch: null, budget: '5 turns', id: 'T1', pr: null, proof: 'true', status: 'todo', title: 'task T1', worktree: null,
    needsAcceptance: false,
  });
  const t2 = sb.ok('task', 'T2').task;
  assert.equal(t2.needsAcceptance, true);
  assert.deepEqual(t2.dependsOn, ['T1']);

  // The record follows the ledger as it is now.
  const w = sb.ok('worktree', 'T1');
  const after = sb.ok('task', 'T1').task;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.worktree, w.worktree);
  assert.equal(after.branch, w.branch);

  const unknown = sb.run('task', 'T9');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /no task T9/);
  for (const bad of ['t1', 'T1;x', '-T1']) {
    const refused = sb.run('task', bad);
    assert.equal(refused.ok, false, bad);
    assert.match(refused.error, /bad task id/, bad);
  }
  const missing = sb.run('task');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /bad task id/);
});

test('merge run again for a task it already merged answers as the merge did and changes nothing', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['T1.txt'])] });
  sb.ok('prepare', 'relay-run');
  const first = sb.complete('T1');
  const evidence = sb.taskOf('T1').evidence;
  const again = sb.ok('merge', 'T1');
  assert.equal(again.sha, first.sha);
  assert.equal(again.already, true);
  assert.equal(sb.taskOf('T1').status, 'merged');
  assert.equal(sb.taskOf('T1').evidence, evidence, 'the evidence is not appended twice');
});
