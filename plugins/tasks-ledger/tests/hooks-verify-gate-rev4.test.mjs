// Tests for the rev 4 amendments of verify-gate.js: a check that cannot start, state file handling,
// a missing session id and the one-line systemMessage. The hook is spawned with JSON on stdin.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync, symlinkSync, chownSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'verify-gate.js');
const POSIX = process.platform !== 'win32';

const root = mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-rev4-'));
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
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env: runEnv, encoding: 'utf8', timeout: 30000 });
}

const edit = (session_id, cwd) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd);
const stop = (session_id, cwd, runEnv) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, runEnv);

test('amendment 1: a check that cannot be started lets the stop through and leaves the state as it was', { skip: !POSIX }, () => {
  const repo = makeRepo('no-start', 'echo no-start-broken >&2; exit 1\n');
  const session = 'rev4-no-start';
  assert.equal(edit(session, repo).status, 0);
  assert.equal(stop(session, repo).status, 2);
  const before = readFileSync(stateFile(session), 'utf8');
  assert.deepEqual(JSON.parse(before), { dirty: true, failures: 1 });

  // bash cannot be found on an empty PATH, so spawning the check fails.
  const emptyBin = join(root, 'empty-bin');
  mkdirSync(emptyBin);
  const r = stop(session, repo, { ...env, PATH: emptyBin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, /verification FAILED/);
  assert.equal(readFileSync(stateFile(session), 'utf8'), before);

  // With bash available again the next stop still counts as the second failure.
  const again = stop(session, repo);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /failure 2 of 3/);
});

test('amendment 2: the state file is not written through a symbolic link', { skip: !POSIX }, () => {
  const repo = makeRepo('symlink-write', 'exit 1\n');
  const session = 'rev4-symlink-write';
  const target = join(root, 'symlink-target.txt');
  writeFileSync(target, 'untouched');
  symlinkSync(target, stateFile(session));
  const r = edit(session, repo);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

test('amendment 2: the state file is not read through a symbolic link', { skip: !POSIX }, () => {
  const repo = makeRepo('symlink-read', 'echo symlink-read-used >&2; exit 1\n');
  const session = 'rev4-symlink-read';
  const target = join(root, 'dirty-state.json');
  writeFileSync(target, JSON.stringify({ dirty: true, failures: 0 }));
  symlinkSync(target, stateFile(session));
  // The linked state would be dirty; not following the link makes the session clean.
  const r = stop(session, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /symlink-read-used/);
});

test('amendment 2: the failure count is clamped to 0..3', { skip: !POSIX }, () => {
  const repo = makeRepo('clamp', 'echo clamp-broken >&2; exit 1\n');

  // A negative count is raised to 0, so this run is the first failure.
  writeFileSync(stateFile('rev4-clamp-low'), JSON.stringify({ dirty: true, failures: -5 }));
  const low = stop('rev4-clamp-low', repo);
  assert.equal(low.status, 2);
  assert.match(low.stderr, /failure 1 of 3/);
  assert.deepEqual(JSON.parse(readFileSync(stateFile('rev4-clamp-low'), 'utf8')), { dirty: true, failures: 1 });

  // A huge count is lowered to 3, so the gate gives up instead of misbehaving.
  writeFileSync(stateFile('rev4-clamp-high'), JSON.stringify({ dirty: true, failures: 1e9 }));
  const high = stop('rev4-clamp-high', repo);
  assert.equal(high.status, 0, high.stderr);
  assert.match(JSON.parse(high.stdout).systemMessage, /3 failed runs/);
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes('rev4-clamp-high')), []);
});

test('amendment 2: a state file owned by another user is not read', {
  skip: !POSIX || process.getuid() !== 0 ? 'needs root to chown' : false,
}, () => {
  const repo = makeRepo('foreign', 'echo foreign-used >&2; exit 1\n');
  const session = 'rev4-foreign';
  writeFileSync(stateFile(session), JSON.stringify({ dirty: true, failures: 0 }));
  chownSync(stateFile(session), 1, 1);
  const r = stop(session, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /foreign-used/);
});

test('amendment 3: without a session id the gate does nothing', { skip: !POSIX }, () => {
  const repo = makeRepo('no-session', 'echo no-session-used >&2; exit 1\n');
  for (const session_id of [undefined, null, '']) {
    const before = readdirSync(hookTmp).sort();
    const e = run({ session_id, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, repo);
    assert.equal(e.status, 0);
    assert.deepEqual(readdirSync(hookTmp).sort(), before, String(session_id));
    const s = run({ session_id, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }, repo);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stderr, '');
    assert.equal(s.stdout, '');
  }
});

test('amendment 4: the systemMessage has no line break even when the directory name has one', { skip: !POSIX }, () => {
  const repo = makeRepo('line\nbreak\r\u2028dir', 'echo one-line-broken >&2;\n  exit 4\n');
  const session = 'rev4-one-line';
  assert.equal(edit(session, repo).status, 0);
  for (let i = 1; i <= 2; i++) assert.equal(stop(session, repo).status, 2, `run ${i}`);
  const giveUp = stop(session, repo);
  assert.equal(giveUp.status, 0, giveUp.stderr);
  assert.equal(giveUp.stdout.split('\n').filter(Boolean).length, 1);
  const { systemMessage } = JSON.parse(giveUp.stdout);
  assert.doesNotMatch(systemMessage, /[\r\n\v\f\u0085\u2028\u2029]/);
  assert.match(systemMessage, /3 failed runs/);
  assert.match(systemMessage, /echo one-line-broken >&2; exit 4/);
});
