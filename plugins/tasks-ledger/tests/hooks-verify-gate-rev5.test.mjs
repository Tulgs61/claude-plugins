// Tests for the rev 5 amendment of verify-gate.js: only a check for which no process was created
// counts as "could not start"; a check ended for too much output is a failed run. The hook is spawned
// with JSON on stdin.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'verify-gate.js');
const POSIX = process.platform !== 'win32';

const root = mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-rev5-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Isolated temp dir for the hook's own state files.
const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const env = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
const stateFile = session => join(hookTmp, `claude-verify-${session}.json`);

// A fake repository (a .git directory marks the root) with an owner-only-writable verify.cmd.
function makeRepo(name, verify) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const file = join(repo, '.claude', 'verify.cmd');
  writeFileSync(file, verify);
  chmodSync(file, 0o644);
  return repo;
}

function run(stdin, cwd, runEnv = env) {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(stdin), cwd, env: runEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
}

const edit = (session_id, cwd) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd);
const stop = (session_id, cwd, runEnv) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, runEnv);

// More than the hook's 64 MiB output limit, in printable text.
const FLOOD = 'yes flood-line | head -c 70000000\n';

test('amendment 1: a check ended for too much output is a failed run that blocks and counts', { skip: !POSIX }, () => {
  const repo = makeRepo('flood', FLOOD);
  const session = 'rev5-flood';
  assert.equal(edit(session, repo).status, 0);

  for (let i = 1; i <= 2; i++) {
    const r = stop(session, repo);
    assert.equal(r.status, 2, `run ${i}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /verification FAILED \(exit output limit exceeded\)/);
    assert.match(r.stderr, new RegExp(`failure ${i} of 3`));
    // Only a tail of the output reaches Claude.
    assert.ok(r.stderr.length < 10000, `stderr length ${r.stderr.length}`);
    assert.deepEqual(JSON.parse(readFileSync(stateFile(session), 'utf8')), { dirty: true, failures: i });
  }

  // The third consecutive overflow gives up like any other failure.
  const giveUp = stop(session, repo);
  assert.equal(giveUp.status, 0, giveUp.stderr.slice(0, 500));
  assert.equal(giveUp.stdout.split('\n').filter(Boolean).length, 1);
  const { systemMessage } = JSON.parse(giveUp.stdout);
  assert.match(systemMessage, /3 failed runs/);
  assert.match(systemMessage, /output limit exceeded/);
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes(session)), []);
});

test('amendment 1: an overflow counts together with ordinary failures', { skip: !POSIX }, () => {
  const repo = makeRepo('mixed', 'exit 1\n');
  const session = 'rev5-mixed';
  assert.equal(edit(session, repo).status, 0);
  const first = stop(session, repo);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /verification FAILED \(exit 1\)/);

  writeFileSync(join(repo, '.claude', 'verify.cmd'), FLOOD);
  const second = stop(session, repo);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /failure 2 of 3/);
  assert.match(second.stderr, /exit output limit exceeded/);
});

test('amendment 1: a check for which no process was created still lets the stop through', { skip: !POSIX }, () => {
  const repo = makeRepo('no-process', 'exit 1\n');
  const session = 'rev5-no-process';
  assert.equal(edit(session, repo).status, 0);
  const before = readFileSync(stateFile(session), 'utf8');

  // bash cannot be found on an empty PATH, so no process is created.
  const emptyBin = join(root, 'empty-bin');
  mkdirSync(emptyBin);
  const r = stop(session, repo, { ...env, PATH: emptyBin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(readFileSync(stateFile(session), 'utf8'), before);
});
