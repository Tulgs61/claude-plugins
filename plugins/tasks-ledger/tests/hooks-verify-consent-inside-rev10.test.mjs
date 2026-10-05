// Tests for rev 10 amendment 31: "inside" means inside (`<repo>/..bin` is inside the repository), the main
// working tree of a linked worktree is never a source of programs, and approve without a terminal writes
// nothing to stdout. Answers are given only through the `terminal` option of approve(), reached by loading
// the script as a module, and every approve here runs detached (a new session, so no controlling terminal).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-inside-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;
const freshEnv = () => withConsentStore(baseEnv, root);

function writeVerify(dir, body) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, 0o644);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// A real git repository.
function makeGitRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo);
  git(root, 'init', '-q', repo);
  return repo;
}

function run(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env);
const stop = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env);

// Executable `git` and `bash` files that leave a marker in `markers` when run.
function plantPrograms(dir, markers) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['git', 'bash']) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${join(markers, `${name}-ran`)}'\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
}
const ranPrograms = markers => ['git', 'bash'].filter(name => existsSync(join(markers, `${name}-ran`)));

// Runs a node child detached (a new session, so it has no controlling terminal).
function detached(args, { env, cwd = root, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

// approve() through the module seam in a detached child; the fake terminal answers `answer`, and with
// `answer` null there is none. The child prints a JSON report as its last stdout line.
function approveInChild(env, dir, answer, cwd) {
  const script = `
    const answer = ${JSON.stringify(answer)};
    const terminal = () => answer === null ? null : { write() {}, ask: () => answer, close() {} };
    let out = '';
    const code = require(${JSON.stringify(CONSENT)}).approve(${JSON.stringify(dir)}, {
      terminal, out: { write: s => { out += s; } },
    });
    process.stdout.write(JSON.stringify({ code, out }) + '\\n');`;
  return detached(['-e', script], { env, cwd }).then(r => {
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr };
  });
}

// --- `<repo>/..bin` is inside the repository ---

test('amendment 31: git and bash planted in <repo>/..bin on PATH never run from the gate', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeGitRepo('f31-dotdot-gate');
  writeVerify(repo, 'echo f31-dotdot-check-ran >&2; exit 1\n');
  const markers = mkdtempSync(join(root, 'f31-dotdot-gate-markers-'));
  plantPrograms(join(repo, '..bin'), markers);
  approveCheck(env, repo);
  const hostile = { ...env, PATH: `${join(repo, '..bin')}:${process.env.PATH}` };

  const session = 'rev10-f31-dotdot-gate';
  assert.equal(edit(hostile, session, repo).status, 0);
  const r = stop(hostile, session, repo);
  assert.deepEqual(ranPrograms(markers), []);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /f31-dotdot-check-ran/);
});

test('amendment 31: a git planted in <repo>/..bin on PATH never runs from approve or revoke', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('f31-dotdot-consent');
  writeVerify(repo, 'exit 0\n');
  const markers = mkdtempSync(join(root, 'f31-dotdot-consent-markers-'));
  plantPrograms(join(repo, '..bin'), markers);
  const hostile = { ...env, PATH: `${join(repo, '..bin')}:${process.env.PATH}` };

  const a = await approveInChild(hostile, repo, 'yes', repo);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(ranPrograms(markers), []);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: commandHash('exit 0\n') }]);

  const r = await detached([CONSENT, 'revoke', repo], { env: hostile, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ranPrograms(markers), []);
  assert.deepEqual(storeEntries(env), []);
});

// --- The main working tree of a linked worktree ---

// A main checkout with one commit and a linked worktree of it outside the main checkout.
function makeWorktree(name) {
  const main = makeGitRepo(`${name}-main`);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(root, `${name}-wt`);
  git(main, 'worktree', 'add', '-q', '--detach', wt);
  return { main, wt };
}

test('amendment 31: git and bash planted in the main checkout of a linked worktree never run from the gate', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { main, wt } = makeWorktree('f31-wt-gate');
  writeVerify(wt, 'echo f31-wt-check-ran >&2; exit 1\n');
  const markers = mkdtempSync(join(root, 'f31-wt-gate-markers-'));
  plantPrograms(main, markers);
  approveCheck(env, wt);
  // The main checkout as given, and through a symlinked spelling.
  const link = join(root, 'f31-wt-gate-main-link');
  symlinkSync(main, link);
  const hostile = { ...env, PATH: `${main}:${link}:${process.env.PATH}` };

  const session = 'rev10-f31-wt-gate';
  assert.equal(edit(hostile, session, wt).status, 0);
  const r = stop(hostile, session, wt);
  assert.deepEqual(ranPrograms(markers), []);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /f31-wt-check-ran/);
});

test('amendment 31: a git planted in the main checkout of a linked worktree never runs from approve', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const { main, wt } = makeWorktree('f31-wt-consent');
  writeVerify(wt, 'exit 0\n');
  const markers = mkdtempSync(join(root, 'f31-wt-consent-markers-'));
  plantPrograms(main, markers);
  const hostile = { ...env, PATH: `${main}:${process.env.PATH}` };

  const a = await approveInChild(hostile, wt, 'yes', wt);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(ranPrograms(markers), []);
  // The identity is the one the real git reports: the main checkout's common git directory.
  assert.deepEqual(storeEntries(env), [{ repo: join(main, '.git'), sha256: commandHash('exit 0\n') }]);
});

// --- approve without a terminal ---

test('amendment 31: approve without a terminal leaves stdout empty and says only needs a terminal', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('f31-no-tty');
  writeVerify(repo, 'echo f31-no-tty-shown\nexit 0\n');

  const cli = await detached([CONSENT, 'approve', repo], { env, input: 'yes\n' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /needs a terminal/);
  assert.doesNotMatch(cli.stderr, /f31-no-tty-shown|verify\.cmd/);
  assert.equal(existsSync(storePath(env)), false);

  const seam = await approveInChild(env, repo, null);
  assert.equal(seam.code, 2);
  assert.equal(seam.out, '');
  assert.match(seam.stderr, /needs a terminal/);
  assert.equal(existsSync(storePath(env)), false);
});
