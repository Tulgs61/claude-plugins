// Tests for the tasks-ledger hooks: dispatch-guard.js (PreToolUse on Agent) and verify-gate.js
// (PostToolUse + Stop). Each hook is spawned with JSON on stdin, the way Claude Code runs it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const GUARD = join(HOOKS, 'dispatch-guard.js');
const GATE = join(HOOKS, 'verify-gate.js');

const root = mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Isolated temp dir for the hook's own state files, so real session state is never read or written.
const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const env = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };

// Writes a verify.cmd with explicit owner-only write permission, independent of the host's umask
// (the hook skips group/world-writable files).
function writeVerify(dir, body, mode = 0o644) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

// True when `dir` or one of its ancestors contains .git, i.e. the temp root sits inside a repository.
function hasGitAncestor(dir) {
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
const rootInRepo = hasGitAncestor(root);

function run(script, stdin, cwd = root) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  return spawnSync(process.execPath, [script], { input, cwd, env, encoding: 'utf8', timeout: 30000 });
}

const agentCall = (subagent_type, prompt) => ({
  session_id: 'test-guard',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type, prompt },
});

const FULL = [
  'TASK: T1 add a flag',
  'OUTCOME: the CLI accepts --dry-run',
  'PROOF: npm test',
  'CONSTRAINTS: stay within src/cli/**',
  'DELIVERABLE: commit on the task branch',
  'BUDGET: stop after 20 turns and report',
  'ESCALATION: ask before schema changes',
].join('\n');
const without = word => FULL.split('\n').filter(l => !l.startsWith(word)).join('\n');

test('dispatch-guard blocks a task-implementer prompt without PROOF', () => {
  const r = run(GUARD, agentCall('task-implementer', without('PROOF')));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no PROOF/);
});

test('dispatch-guard blocks a task-implementer prompt without BUDGET', () => {
  const r = run(GUARD, agentCall('task-implementer', without('BUDGET')));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no BUDGET/);
});

test('dispatch-guard names both missing sections', () => {
  const r = run(GUARD, agentCall('task-implementer', 'just do it'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no PROOF and no BUDGET/);
});

test('dispatch-guard also guards plugin-namespaced and plain implementer agents', () => {
  assert.equal(run(GUARD, agentCall('tasks-ledger:task-implementer', without('PROOF'))).status, 2);
  assert.equal(run(GUARD, agentCall('implementer', without('BUDGET'))).status, 2);
});

test('dispatch-guard allows a task-implementer prompt with PROOF and BUDGET', () => {
  const r = run(GUARD, agentCall('task-implementer', FULL));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('dispatch-guard accepts markdown headings and bold labels', () => {
  const md = '## Proof\nnpm test\n\n1. **Budget:** stop after 10 turns';
  assert.equal(run(GUARD, agentCall('task-implementer', md)).status, 0);
});

test('dispatch-guard lets other agent types through without a contract', () => {
  for (const type of ['Explore', 'general-purpose', 'reviewer', 'tasks-ledger:reviewer']) {
    const r = run(GUARD, agentCall(type, 'look around'));
    assert.equal(r.status, 0, type);
  }
});

test('dispatch-guard fails open on garbage or empty stdin', () => {
  for (const input of ['not json {{{', '', '[1,2', 'null']) {
    const r = run(GUARD, input);
    assert.equal(r.status, 0, JSON.stringify(input));
  }
});

test('verify-gate exits 0 in a directory without .claude/verify.cmd', () => {
  // The .git entry makes `dir` its own repository root, so the lookup never reaches the host's
  // ancestors (a host repository with its own verify.cmd cannot change the result).
  const dir = join(root, 'no-verify');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const base = { session_id: 'test-gate-none', cwd: dir };
  const edit = run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, dir);
  assert.equal(edit.status, 0);
  const stop = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, dir);
  assert.equal(stop.status, 0);
  assert.equal(stop.stderr, '');
});

test('verify-gate exits 0 on Stop when nothing was edited', () => {
  const dir = join(root, 'clean');
  writeVerify(dir, 'exit 1\n');
  const r = run(GATE, { session_id: 'test-gate-clean', cwd: dir, hook_event_name: 'Stop' }, dir);
  assert.equal(r.status, 0);
});

test('verify-gate fails open on garbage stdin', () => {
  assert.equal(run(GATE, '{{{ nope').status, 0);
});

test('verify-gate blocks a dirty Stop when verify.cmd fails and passes when it succeeds', { skip: process.platform === 'win32' }, () => {
  const dir = join(root, 'with-verify');
  const base = { session_id: 'test-gate-verify', cwd: dir };

  writeVerify(dir, 'echo broken-check >&2; exit 3\n');
  assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write' }, dir).status, 0);
  const fail = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, dir);
  assert.equal(fail.status, 2);
  assert.match(fail.stderr, /verification FAILED \(exit 3\)/);
  assert.match(fail.stderr, /broken-check/);

  // A continuation forced by the hook itself is never blocked again.
  assert.equal(run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: true }, dir).status, 0);

  writeVerify(dir, 'exit 0\n');
  const pass = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, dir);
  assert.equal(pass.status, 0);
  // Passing clears the session state file.
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes('test-gate-verify')), []);
});

// A fake repository: a .git entry (directory or, as in a worktree, a file) marks the root.
function makeRepo(name, { gitFile = false, verify } = {}) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  if (gitFile) writeFileSync(join(repo, '.git'), 'gitdir: /nowhere\n');
  else mkdirSync(join(repo, '.git'));
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

test('verify-gate finds .claude/verify.cmd from a subdirectory and runs it at the repo root', { skip: process.platform === 'win32' }, () => {
  // The command only succeeds when its working directory is the directory that holds verify.cmd.
  const repo = makeRepo('sub-repo', { verify: '[ -f .claude/verify.cmd ] || { echo wrong-cwd >&2; exit 5; }; echo sub-check-broken >&2; exit 3\n' });
  const sub = join(repo, 'src', 'deep');
  const base = { session_id: 'test-gate-subdir', cwd: sub };

  assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, sub).status, 0);
  const fail = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, sub);
  assert.equal(fail.status, 2);
  assert.match(fail.stderr, /verification FAILED \(exit 3\)/);
  assert.match(fail.stderr, /sub-check-broken/);

  writeVerify(repo, '[ -f .claude/verify.cmd ] || exit 5\n');
  const pass = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, sub);
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes('test-gate-subdir')), []);
});

test('verify-gate does not look above the git root for .claude/verify.cmd', { skip: process.platform === 'win32' }, () => {
  // outer/.claude/verify.cmd always fails; the repos inside outer/ have none of their own.
  const outer = join(root, 'outer');
  writeVerify(outer, 'echo outer-used >&2; exit 1\n');

  for (const gitFile of [false, true]) {
    const repo = makeRepo(join('outer', gitFile ? 'worktree' : 'checkout'), { gitFile });
    const sub = join(repo, 'src', 'deep');
    const base = { session_id: `test-gate-gitroot-${gitFile}`, cwd: sub };
    assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write' }, sub).status, 0);
    const stop = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, sub);
    assert.equal(stop.status, 0, `gitFile=${gitFile}`);
    assert.doesNotMatch(stop.stderr, /outer-used/);
  }
});

test('verify-gate outside any git repo checks only <cwd>/.claude/verify.cmd', {
  skip: process.platform === 'win32' ? 'POSIX only' : rootInRepo ? 'temp root is inside a git repository' : false,
}, () => {
  // nogit/.claude/verify.cmd always fails; cwd is nogit/a/b with no .git anywhere above it.
  const outer = join(root, 'nogit');
  writeVerify(outer, 'echo nogit-outer-used >&2; exit 1\n');
  const cwd = join(outer, 'a', 'b');
  mkdirSync(cwd, { recursive: true });
  const base = { session_id: 'test-gate-nogit', cwd };
  assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd).status, 0);
  const stop = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, cwd);
  assert.equal(stop.status, 0, stop.stderr);
  assert.doesNotMatch(stop.stderr, /nogit-outer-used/);

  // The same file in cwd itself is still used (the original opt-in).
  const own = writeVerify(cwd, 'echo nogit-own-used >&2; exit 1\n');
  assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd).status, 0);
  const block = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, cwd);
  assert.equal(block.status, 2);
  assert.match(block.stderr, /nogit-own-used/);
  rmSync(own);
  // Clear the state file left by the blocked stop.
  writeVerify(cwd, 'exit 0\n');
  assert.equal(run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, cwd).status, 0);
});

test('verify-gate skips a group- or world-writable verify.cmd inside a repo', { skip: process.platform === 'win32' }, () => {
  for (const [mode, name] of [[0o664, 'group'], [0o646, 'world']]) {
    const repo = makeRepo(`writable-${name}`);
    const file = writeVerify(repo, `echo ${name}-writable-used >&2; exit 1\n`, mode);
    const sub = join(repo, 'src', 'deep');
    const base = { session_id: `test-gate-writable-${name}`, cwd: sub };
    assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, sub).status, 0);
    const stop = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, sub);
    assert.equal(stop.status, 0, `${name}: ${stop.stderr}`);
    assert.doesNotMatch(stop.stderr, /writable-used/);

    // Control: the same file with owner-only write permission is used.
    chmodSync(file, 0o644);
    const block = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, sub);
    assert.equal(block.status, 2, name);
    assert.match(block.stderr, new RegExp(`${name}-writable-used`));
  }
});

test('verify-gate gives up after 3 failed runs with one systemMessage JSON object on stdout', { skip: process.platform === 'win32' }, () => {
  // State lives in os.tmpdir(); `env` points TMPDIR/TEMP/TMP at the isolated hookTmp.
  const repo = makeRepo('give-up', { verify: 'echo give-up-check-broken >&2; exit 4\n' });
  const base = { session_id: 'test-gate-give-up', cwd: repo };
  assert.equal(run(GATE, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, repo).status, 0);

  // Runs 1 and 2 block, with nothing on stdout.
  for (let i = 1; i <= 2; i++) {
    const block = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, repo);
    assert.equal(block.status, 2, `run ${i}`);
    assert.equal(block.stdout, '', `run ${i}`);
  }

  // Run 3 gives up: exit 0, exactly one JSON object on stdout, the output tail on stderr.
  const giveUp = run(GATE, { ...base, hook_event_name: 'Stop', stop_hook_active: false }, repo);
  assert.equal(giveUp.status, 0, giveUp.stderr);
  const out = JSON.parse(giveUp.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.equal(typeof out.systemMessage, 'string');
  assert.doesNotMatch(out.systemMessage, /\n/);
  assert.match(out.systemMessage, /3 failed runs/);
  assert.match(out.systemMessage, /echo give-up-check-broken >&2; exit 4/);
  assert.match(giveUp.stderr, /give-up-check-broken/);
  // The tail goes to stderr only; stdout holds nothing but the JSON object.
  assert.equal(giveUp.stdout.trim(), JSON.stringify(out));
  // Giving up clears the session state file.
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes('test-gate-give-up')), []);
});
