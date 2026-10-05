// Tests for the rev 10 group A amendments of verify-gate.js: per-project state, SubagentStop, process
// groups, atomic state writes, session id types, the loose-permissions warning and empty stdout,
// plus the group A test list of amendment 13. The hook is spawned with JSON on stdin.
// The timeout of amendment 3 is tested in hooks-verify-gate-timeout-rev10.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync, symlinkSync, linkSync,
  existsSync, lstatSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck } from './helpers/verify-consent.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const GATE = join(HOOKS, 'verify-gate.js');
const POSIX = process.platform !== 'win32';
const NON_ROOT = POSIX && process.getuid() !== 0;

const root = mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-rev10-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Isolated temp dir for the hook's own state files.
const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
// Rev 10 amendment 12: a fresh consent store, so the checks these tests run can be approved.
const env = withConsentStore({ ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp }, root);

// The state file of a session and project: claude-verify-<session>-<first 16 hex of sha256(project)>.json,
// where the project is its real path (amendment 16).
const stateName = (session, project) =>
  `claude-verify-${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}-` +
  `${createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16)}.json`;
const stateFile = (session, project) => join(hookTmp, stateName(session, project));
const filesOf = session => readdirSync(hookTmp).filter(f => f.includes(session));

function writeVerify(dir, body, mode = 0o644) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  approveCheck(env, dir, body);
  return file;
}

// A fake repository: a .git directory, or a .git file as in a linked worktree, marks the root.
function makeRepo(name, { verify, gitFile = false } = {}) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  if (gitFile) writeFileSync(join(repo, '.git'), 'gitdir: /nowhere\n');
  else mkdirSync(join(repo, '.git'), { recursive: true });
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

function run(stdin, cwd, opts = {}) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  return spawnSync(process.execPath, [GATE], {
    input, cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...opts,
  });
}

const edit = (session_id, cwd, file) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: file ? { file_path: file } : {} }, cwd);
const stop = (session_id, cwd, event = 'Stop', extra = {}) =>
  run({ session_id, cwd, hook_event_name: event, stop_hook_active: false, ...extra }, cwd);

// --- Amendment 1: per-project state ---

test('amendment 1: the state file is named after the session and the project of the edited file', { skip: !POSIX }, () => {
  const repo = makeRepo('a1-name', { verify: 'exit 1\n' });
  const session = 'rev10-a1-name';
  // The edited file lies in src/; its project is the repository root, not the event's cwd.
  assert.equal(edit(session, join(repo, 'src'), join(repo, 'src', 'a.js')).status, 0);
  assert.deepEqual(filesOf(session), [stateName(session, repo)]);
  assert.deepEqual(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')), { dirty: true, failures: 0 });

  // notebook_path is used the same way, and a stop from a subdirectory finds the same project.
  const nb = 'rev10-a1-notebook';
  const r = run({
    session_id: nb, cwd: root, hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit',
    tool_input: { notebook_path: join(repo, 'src', 'n.ipynb') },
  }, root);
  assert.equal(r.status, 0);
  assert.deepEqual(filesOf(nb), [stateName(nb, repo)]);
  const block = stop(nb, join(repo, 'src'));
  assert.equal(block.status, 2, block.stderr);
  assert.match(block.stderr, /failure 1 of 3/);
});

test('amendment 1: an edit in project X does not make a stop in project Y run Y\'s check', { skip: !POSIX }, () => {
  const x = makeRepo('a1-x', { verify: 'echo x-check-ran >&2; exit 1\n' });
  const y = makeRepo('a1-y', { verify: 'echo y-check-ran >&2; exit 1\n' });
  const session = 'rev10-a1-xy';
  // The session's cwd is Y, but the edit is in X.
  assert.equal(edit(session, y, join(x, 'src', 'a.js')).status, 0);

  const inY = stop(session, y);
  assert.equal(inY.status, 0, inY.stderr);
  assert.equal(inY.stderr, '');
  assert.equal(inY.stdout, '');

  const inX = stop(session, x);
  assert.equal(inX.status, 2);
  assert.match(inX.stderr, /x-check-ran/);
});

test('amendment 1: a linked worktree is its own project', { skip: !POSIX }, () => {
  const main = makeRepo('a1-main', { verify: 'echo main-check-ran >&2; exit 1\n' });
  // A worktree inside the main checkout, its .git a file at its own root.
  const wt = makeRepo(join('a1-main', 'wt'), { gitFile: true, verify: 'echo wt-check-ran >&2; exit 1\n' });
  const session = 'rev10-a1-wt';
  assert.equal(edit(session, main, join(wt, 'src', 'a.js')).status, 0);
  assert.deepEqual(filesOf(session), [stateName(session, wt)]);

  const inMain = stop(session, main);
  assert.equal(inMain.status, 0, inMain.stderr);
  assert.doesNotMatch(inMain.stderr, /main-check-ran/);
  const inWt = stop(session, join(wt, 'src'));
  assert.equal(inWt.status, 2);
  assert.match(inWt.stderr, /wt-check-ran/);
});

// --- Amendment 2: SubagentStop ---

test('amendment 2: hooks.json registers verify-gate on SubagentStop like Stop', () => {
  const { hooks } = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  assert.ok(Array.isArray(hooks.SubagentStop), 'SubagentStop registered');
  assert.equal(hooks.SubagentStop.length, 1);
  const [entry] = hooks.SubagentStop;
  assert.equal(entry.matcher, undefined);
  assert.deepEqual(entry.hooks, hooks.Stop[0].hooks);
  assert.deepEqual(entry.hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/verify-gate.js']);
});

test('amendment 2: a SubagentStop in another project\'s worktree runs that worktree\'s check', { skip: !POSIX }, () => {
  const main = makeRepo('a2-main', { verify: 'echo a2-main-check-ran >&2; exit 1\n' });
  const wt = makeRepo(join('a2-main', '.claude', 'worktrees', 'task'), {
    gitFile: true, verify: 'echo a2-wt-check-ran >&2; exit 7\n',
  });
  const session = 'rev10-a2-subagent';
  // The subagent edits inside its worktree; the main session's cwd is the main checkout.
  assert.equal(edit(session, main, join(wt, 'src', 'a.js')).status, 0);

  for (let i = 1; i <= 2; i++) {
    const r = stop(session, wt, 'SubagentStop');
    assert.equal(r.status, 2, `run ${i}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /verification FAILED \(exit 7\)/);
    assert.match(r.stderr, /a2-wt-check-ran/);
    assert.match(r.stderr, new RegExp(`failure ${i} of 3`));
    assert.doesNotMatch(r.stderr, /a2-main-check-ran/);
  }
  // Its own stop_hook_active lets it through unchecked.
  assert.equal(stop(session, wt, 'SubagentStop', { stop_hook_active: true }).status, 0);
  // The main session's stop in the main checkout is unaffected.
  const mainStop = stop(session, main);
  assert.equal(mainStop.status, 0, mainStop.stderr);
  // The give-up rule applies per session and project.
  const giveUp = stop(session, wt, 'SubagentStop');
  assert.equal(giveUp.status, 0);
  assert.match(JSON.parse(giveUp.stdout).systemMessage, /3 failed runs/);
  assert.deepEqual(filesOf(session), []);
});

// --- Amendment 3: process group ---

test('amendment 3: the check time limit plus 5 s grace stays below the registered timeouts', () => {
  const { hooks } = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  for (const event of ['Stop', 'SubagentStop']) {
    assert.ok(hooks[event][0].hooks[0].timeout > 180 + 5, event);
  }
});

// Waits until no process with the given pid is left (a killed orphan is reaped asynchronously).
function gone(pid) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    execFileSync('sleep', ['0.1']);
  }
}

test('amendment 3 / 13: an over-limit check reports output limit exceeded and its process group is ended', { skip: !POSIX }, () => {
  // A background grandchild that does not hold the pipes would outlive a kill of the direct child.
  const repo = makeRepo('a3-flood', {
    verify: 'sleep 600 >/dev/null 2>&1 &\necho $! > grandchild.pid\nyes flood-line | head -c 70000000\nsleep 600 >/dev/null 2>&1\n',
  });
  const session = 'rev10-a3-flood';
  assert.equal(edit(session, repo).status, 0);
  const r = stop(session, repo);
  const pid = Number(readFileSync(join(repo, 'grandchild.pid'), 'utf8'));
  const grandchildGone = gone(pid);
  if (!grandchildGone) process.kill(pid, 'SIGKILL');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /verification FAILED \(exit output limit exceeded\)/);
  assert.ok(grandchildGone, 'grandchild still alive');
});

// --- Amendment 4: atomic state writes ---

test('amendment 4: the state is replaced by rename, never rewritten in place, and leaves no temp file', { skip: !POSIX }, () => {
  const repo = makeRepo('a4-atomic', { verify: 'exit 1\n' });
  const session = 'rev10-a4-atomic';
  const file = stateFile(session, repo);
  writeFileSync(file, JSON.stringify({ dirty: true, failures: 2 }));
  // A second name for the same inode: an in-place write would change it as well.
  const witness = join(root, 'a4-witness.json');
  linkSync(file, witness);
  const before = lstatSync(file).ino;

  assert.equal(edit(session, repo).status, 0);
  assert.notEqual(lstatSync(file).ino, before);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { dirty: true, failures: 0 });
  assert.deepEqual(JSON.parse(readFileSync(witness, 'utf8')), { dirty: true, failures: 2 });
  assert.deepEqual(filesOf(session), [stateName(session, repo)]);
});

test('amendment 4 / 13: an unparsable state file counts as dirty with 0 failures', { skip: !POSIX }, () => {
  const repo = makeRepo('a4-garbage', { verify: 'echo a4-check-ran >&2; exit 1\n' });
  for (const [name, content] of [['empty', ''], ['partial', '{"dirty":tr'], ['garbage', 'not json']]) {
    const session = `rev10-a4-${name}`;
    writeFileSync(stateFile(session, repo), content);
    const r = stop(session, repo);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, /a4-check-ran/, name);
    assert.match(r.stderr, /failure 1 of 3/, name);
  }
});

// --- Amendment 5: session id types ---

test('amendment 5: a numeric session id is used as its decimal string; other non-string types do nothing', { skip: !POSIX }, () => {
  const repo = makeRepo('a5-number', { verify: 'echo a5-check-ran >&2; exit 1\n' });
  assert.equal(edit(4711, repo).status, 0);
  assert.ok(existsSync(stateFile('4711', repo)));
  const r = stop(4711, repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a5-check-ran/);

  for (const session_id of [{ id: 'x' }, ['x'], true, false]) {
    const before = readdirSync(hookTmp).sort();
    assert.equal(edit(session_id, repo).status, 0);
    assert.deepEqual(readdirSync(hookTmp).sort(), before, JSON.stringify(session_id));
    const s = stop(session_id, repo);
    assert.equal(s.status, 0);
    assert.equal(s.stderr, '');
    assert.equal(s.stdout, '');
  }
});

// --- Amendment 6: loose permissions warning ---

test('amendment 6: a group- or world-writable check warns once per session and project and stays dirty', { skip: !POSIX }, () => {
  for (const [mode, name] of [[0o664, 'group'], [0o646, 'world']]) {
    const repo = makeRepo(`a6-${name}`);
    const file = writeVerify(repo, `echo a6-${name}-ran >&2; exit 1\n`, mode);
    const session = `rev10-a6-${name}`;
    assert.equal(edit(session, repo).status, 0);

    const first = stop(session, join(repo, 'src'));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, '');
    assert.equal(first.stdout.split('\n').filter(Boolean).length, 1);
    assert.equal(first.stdout, `${first.stdout.trim()}\n`);
    const out = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(out), ['systemMessage']);
    assert.equal(first.stdout.trim(), JSON.stringify(out));
    assert.match(out.systemMessage, /\.claude\/verify\.cmd/);
    assert.match(out.systemMessage, /skipped/);
    assert.match(out.systemMessage, /group- or world-writable/);
    assert.match(out.systemMessage, /chmod 644/);

    // Later stops in the same session and project stay silent, also after another edit.
    const second = stop(session, repo);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.equal(edit(session, repo).status, 0);
    assert.equal(stop(session, repo).stdout, '');

    // The session stayed dirty: once the file is trusted, the next stop runs it.
    chmodSync(file, 0o644);
    const block = stop(session, repo);
    assert.equal(block.status, 2);
    assert.match(block.stderr, new RegExp(`a6-${name}-ran`));
  }
});

// --- Amendment 7 / 13: stdout is empty on block, pass and skip paths ---

test('amendment 7: stdout is empty on edit, block, pass and skip paths', { skip: !POSIX }, () => {
  const repo = makeRepo('a7-stdout', { verify: 'echo a7-on-stdout; exit 1\n' });
  const none = makeRepo('a7-none');
  const symlinked = makeRepo('a7-symlinked');
  mkdirSync(join(symlinked, '.claude'));
  symlinkSync(join(repo, '.claude', 'verify.cmd'), join(symlinked, '.claude', 'verify.cmd'));
  const session = 'rev10-a7';
  const results = {
    clean: stop(session, repo),
    edit: edit(session, repo),
    noCheck: (edit(session, none), stop(session, none)),
    untrusted: (edit(session, symlinked), stop(session, symlinked, 'SubagentStop')),
    active: stop(session, repo, 'Stop', { stop_hook_active: true }),
    block: stop(session, repo),
    subagentBlock: stop(session, repo, 'SubagentStop'),
  };
  writeVerify(repo, 'echo a7-pass-on-stdout\n');
  results.pass = stop(session, repo);
  results.otherEvent = run({ session_id: session, cwd: repo, hook_event_name: 'UserPromptSubmit' }, repo);
  results.garbage = run('{{{', repo);
  assert.equal(results.block.status, 2);
  assert.match(results.block.stderr, /a7-on-stdout/);
  assert.equal(results.subagentBlock.status, 2);
  assert.match(results.subagentBlock.stderr, /a7-on-stdout/);
  assert.equal(results.pass.status, 0);
  for (const [name, r] of Object.entries(results)) assert.equal(r.stdout, '', name);
});

// --- Amendment 13: the remaining group A tests ---

test('amendment 13: a stored count of 99 gives up on the next failure and not before; a negative count is 0', { skip: !POSIX }, () => {
  const repo = makeRepo('a13-clamp', { verify: 'echo a13-clamp-ran >&2; exit 1\n' });

  // A passing check with 99 stored failures passes without a give-up message.
  writeFileSync(stateFile('rev10-clamp-pass', repo), JSON.stringify({ dirty: true, failures: 99 }));
  writeVerify(repo, 'exit 0\n');
  const pass = stop('rev10-clamp-pass', repo);
  assert.equal(pass.status, 0);
  assert.equal(pass.stdout, '');
  assert.deepEqual(filesOf('rev10-clamp-pass'), []);

  // The next failure gives up.
  writeVerify(repo, 'echo a13-clamp-ran >&2; exit 1\n');
  writeFileSync(stateFile('rev10-clamp-high', repo), JSON.stringify({ dirty: true, failures: 99 }));
  const high = stop('rev10-clamp-high', repo);
  assert.equal(high.status, 0, high.stderr);
  assert.match(JSON.parse(high.stdout).systemMessage, /3 failed runs/);
  assert.deepEqual(filesOf('rev10-clamp-high'), []);

  // A negative count behaves as 0.
  writeFileSync(stateFile('rev10-clamp-low', repo), JSON.stringify({ dirty: true, failures: -7 }));
  const low = stop('rev10-clamp-low', repo);
  assert.equal(low.status, 2);
  assert.match(low.stderr, /failure 1 of 3/);
  assert.deepEqual(JSON.parse(readFileSync(stateFile('rev10-clamp-low', repo), 'utf8')), { dirty: true, failures: 1 });
});

test('amendment 13: a directory or FIFO at the state path is not followed, opened or trusted', {
  skip: !NON_ROOT ? 'POSIX non-root only' : false,
}, () => {
  const repo = makeRepo('a13-special', { verify: 'echo a13-special-ran >&2; exit 1\n' });

  // A directory holding what would be a dirty state.
  const dirSession = 'rev10-special-dir';
  const dir = stateFile(dirSession, repo);
  mkdirSync(dir);
  writeFileSync(join(dir, 'inner.json'), JSON.stringify({ dirty: true, failures: 0 }));
  const dirStop = stop(dirSession, repo);
  assert.equal(dirStop.status, 0, dirStop.stderr);
  assert.doesNotMatch(dirStop.stderr, /a13-special-ran/);
  assert.equal(edit(dirSession, repo).status, 0);
  assert.ok(lstatSync(dir).isDirectory());
  assert.equal(readFileSync(join(dir, 'inner.json'), 'utf8'), JSON.stringify({ dirty: true, failures: 0 }));

  // A FIFO: opening it for a blocking read would hang the hook.
  const fifoSession = 'rev10-special-fifo';
  const fifo = stateFile(fifoSession, repo);
  execFileSync('mkfifo', [fifo]);
  const fifoStop = stop(fifoSession, repo, 'Stop');
  assert.equal(fifoStop.error, undefined);
  assert.equal(fifoStop.status, 0, fifoStop.stderr);
  assert.doesNotMatch(fifoStop.stderr, /a13-special-ran/);
  assert.ok(lstatSync(fifo).isFIFO());

  // Control: both paths are the ones the gate uses. Once they are gone, an edit writes a regular
  // state file there and the next stop runs the check.
  for (const [session, file] of [[dirSession, dir], [fifoSession, fifo]]) {
    rmSync(file, { recursive: true });
    assert.equal(edit(session, repo).status, 0);
    assert.ok(lstatSync(file).isFile(), session);
    assert.match(stop(session, repo).stderr, /a13-special-ran/, session);
  }
});

test('amendment 13: an edit between two failures resets the count', { skip: !POSIX }, () => {
  const repo = makeRepo('a13-reset', { verify: 'echo a13-reset-ran >&2; exit 1\n' });
  const session = 'rev10-reset';
  assert.equal(edit(session, repo).status, 0);
  assert.match(stop(session, repo).stderr, /failure 1 of 3/);
  assert.match(stop(session, repo).stderr, /failure 2 of 3/);
  // The edit's cwd lies outside the repository; the edited file decides the project it resets.
  assert.equal(edit(session, root, join(repo, 'src', 'a.js')).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')), { dirty: true, failures: 0 });
  const after = stop(session, repo);
  assert.equal(after.status, 2);
  assert.match(after.stderr, /failure 1 of 3/);
  assert.equal(stop(session, repo).status, 2);
  assert.equal(stop(session, repo).status, 0);
});

test('amendment 13: a symlinked verify.cmd is not run', { skip: !POSIX }, () => {
  const repo = makeRepo('a13-symlink');
  const target = join(root, 'a13-target.cmd');
  writeFileSync(target, 'echo a13-symlink-ran >&2; exit 1\n');
  chmodSync(target, 0o644);
  mkdirSync(join(repo, '.claude'));
  symlinkSync(target, join(repo, '.claude', 'verify.cmd'));
  const session = 'rev10-symlink';
  assert.equal(edit(session, repo).status, 0);
  const r = stop(session, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '');
  // The session stays dirty and is keyed by this project.
  assert.deepEqual(filesOf(session), [stateName(session, repo)]);
});

test('amendment 13: a session id with / or .. gives a state file directly in the temp directory', { skip: !POSIX }, () => {
  const repo = makeRepo('a13-traversal', { verify: 'exit 1\n' });
  const session = '../../rev10-escape/x';
  const outside = join(root, 'rev10-escape');
  assert.equal(edit(session, repo).status, 0);
  assert.ok(existsSync(stateFile(session, repo)), 'sanitised name in hookTmp');
  assert.equal(stateName(session, repo).startsWith('claude-verify-______rev10-escape_x-'), true);
  assert.deepEqual(readdirSync(hookTmp).filter(f => f.includes('rev10-escape')), [stateName(session, repo)]);
  assert.equal(existsSync(outside), false);
  assert.equal(stop(session, repo).status, 2);
});
