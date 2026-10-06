// Tests for approvals per check directory: a store entry is (repository identity, check directory,
// sha256), where the check directory is the directory containing .claude/ relative to its checkout's top
// level, stored as `dir` only below the top level. Answers are given only through the `terminal` option of
// approve(), reached by loading the script as a module, in a detached child (no controlling terminal).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-dir-rev11-')));
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

// A real git repository, so that every directory in it shares one identity.
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

// An allowed stop that did not run the check and showed the approval request.
function assertRequest(r, ran) {
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, ran);
  assert.match(JSON.parse(r.stdout).systemMessage, /not approved/);
}

function writeStoreEntries(env, entries) {
  mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true, mode: 0o700 });
  writeFileSync(storePath(env), JSON.stringify({ entries }));
}

const consentCli = (env, ...args) => spawnSync(process.execPath, [CONSENT, ...args], { env, encoding: 'utf8', timeout: 60000 });

// approve() through the module seam in a detached child, answering `answer`.
function approveInChild(env, dir, answer) {
  const script = `
    const terminal = () => ({ write() {}, ask: () => ${JSON.stringify(answer)}, close() {} });
    const code = require(${JSON.stringify(CONSENT)}).approve(${JSON.stringify(dir)}, { terminal, out: { write() {} } });
    process.stdout.write(JSON.stringify({ code }) + '\\n');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env, cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => {
      assert.equal(status, 0, stderr);
      resolve({ ...JSON.parse(stdout.trim().split('\n').pop()), stderr });
    });
  });
}

test('an approval of the top-level check does not cover an identical check in a subdirectory; approving that one does', {
  skip: !POSIX,
}, () => {
  const env = freshEnv();
  const repo = makeGitRepo('dir-sub');
  const body = 'echo dir-sub-ran-in-$(basename "$PWD") >&2; exit 1\n';
  writeVerify(repo, body);
  const sub = join(repo, 'sub');
  writeVerify(sub, body);
  approveCheck(env, repo);
  const session = 'rev11-dir-sub';

  assert.equal(edit(env, session, sub).status, 0);
  assertRequest(stop(env, session, sub), /dir-sub-ran/);
  // The top-level check is approved.
  assert.equal(edit(env, session, repo).status, 0);
  assert.match(stop(env, session, repo).stderr, /dir-sub-ran-in-dir-sub/);

  approveCheck(env, sub);
  assert.deepEqual(storeEntries(env).map(e => e.dir), [undefined, 'sub']);
  assert.equal(edit(env, session, sub).status, 0);
  const r = stop(env, session, sub);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /dir-sub-ran-in-sub/);
});

test('a store entry without dir (the older format) approves the top-level check and no other', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeGitRepo('dir-old');
  const body = 'echo dir-old-ran-in-$(basename "$PWD") >&2; exit 1\n';
  writeVerify(repo, body);
  const pkg = join(repo, 'pkg');
  writeVerify(pkg, body);
  writeStoreEntries(env, [{ repo: repoIdentity(repo), sha256: commandHash(body) }]);
  const session = 'rev11-dir-old';

  assert.equal(edit(env, session, repo).status, 0);
  const top = stop(env, session, repo);
  assert.equal(top.status, 2, top.stdout);
  assert.match(top.stderr, /dir-old-ran-in-dir-old/);

  assert.equal(edit(env, session, pkg).status, 0);
  assertRequest(stop(env, session, pkg), /dir-old-ran/);
});

test('approve records the check directory, and an approval of <main>/pkg runs the same check in <linked worktree>/pkg', {
  skip: !POSIX,
}, async () => {
  const env = freshEnv();
  const main = makeGitRepo('dir-main');
  const body = 'echo dir-wt-ran-in-$(basename "$(dirname "$PWD")") >&2; exit 1\n';
  writeVerify(join(main, 'pkg'), body);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'check');
  const wt = join(root, 'dir-wt');
  git(main, 'worktree', 'add', '-q', '-b', 'dir-wt-task', wt);
  chmodSync(join(wt, 'pkg', '.claude', 'verify.cmd'), 0o644);

  const a = await approveInChild(env, join(main, 'pkg'), 'yes');
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(main), sha256: commandHash(body), dir: 'pkg' }]);

  const session = 'rev11-dir-wt';
  assert.equal(edit(env, session, join(wt, 'pkg')).status, 0);
  const r = stop(env, session, join(wt, 'pkg'));
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /dir-wt-ran-in-dir-wt/);
});

test('list prints the check directory as a third column only for entries below the top level', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeGitRepo('dir-list');
  writeVerify(repo, 'echo top\n');
  writeVerify(join(repo, 'a', 'b'), 'echo nested\n');
  approveCheck(env, repo);
  approveCheck(env, join(repo, 'a', 'b'));

  const r = consentCli(env, 'list');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
  const id = repoIdentity(repo);
  assert.deepEqual(lines, [
    [id, commandHash('echo top\n').slice(0, 12)],
    [id, commandHash('echo nested\n').slice(0, 12), 'a/b'],
  ]);
});

test('entries whose dir is absolute, empty, holds a .. segment or a control character are ignored', { skip: !POSIX }, () => {
  const repo = makeGitRepo('dir-invalid');
  const body = 'echo dir-invalid-ran >&2; exit 1\n';
  writeVerify(repo, body);
  const entry = { repo: repoIdentity(repo), sha256: commandHash(body) };
  for (const [i, dir] of ['/abs', '../x', 'a/../b', '', 'a\x1bb'].entries()) {
    const env = freshEnv();
    writeStoreEntries(env, [{ ...entry, dir }]);
    const session = `rev11-dir-invalid-${i}`;
    assert.equal(edit(env, session, repo).status, 0);
    assertRequest(stop(env, session, repo), /dir-invalid-ran/);
    assert.equal(consentCli(env, 'list').stdout, '', JSON.stringify(dir));
  }
  // Control: the same entry without dir approves the check.
  const env = freshEnv();
  writeStoreEntries(env, [entry]);
  assert.equal(edit(env, 'rev11-dir-invalid-control', repo).status, 0);
  assert.match(stop(env, 'rev11-dir-invalid-control', repo).stderr, /dir-invalid-ran/);
  assert.equal(existsSync(storePath(env)), true);
});

test('approve in a check directory whose relative path holds a control character records nothing and exits 2', {
  skip: !POSIX,
}, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('dir-control');
  const sub = join(repo, 'line\nfeed');
  writeVerify(sub, 'echo dir-control\n');
  const a = await approveInChild(env, sub, 'yes');
  assert.equal(a.code, 2, a.stderr);
  assert.match(a.stderr, /cannot be approved/);
  assert.match(a.stderr, /control character/);
  assert.equal(existsSync(storePath(env)), false);

  // Control: the same check in a directory without one is recorded.
  const plain = join(repo, 'plain');
  writeVerify(plain, 'echo dir-control\n');
  const b = await approveInChild(env, plain, 'yes');
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(storeEntries(env).map(e => e.dir), ['plain']);
});

test('entries whose dir holds a format character (U+202E) or a line separator (U+2028) are ignored', { skip: !POSIX }, () => {
  const repo = makeGitRepo('dir-format');
  const body = 'echo dir-format-ran >&2; exit 1\n';
  for (const [i, dir] of ['a‮b', 'a b'].entries()) {
    // The check sits in exactly that directory, so only the rule on `dir` keeps the entry from approving it.
    const checkDir = join(repo, dir);
    writeVerify(checkDir, body);
    const env = freshEnv();
    writeStoreEntries(env, [{ repo: repoIdentity(repo), sha256: commandHash(body), dir }]);
    const session = `rev11-dir-format-${i}`;
    assert.equal(edit(env, session, checkDir).status, 0);
    assertRequest(stop(env, session, checkDir), /dir-format-ran/);
    assert.equal(consentCli(env, 'list').stdout, '', JSON.stringify(dir));
  }
});

test('approve in a check directory whose relative path holds U+202E records nothing and exits 2', {
  skip: !POSIX,
}, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('dir-bidi');
  const sub = join(repo, 'a‮b');
  writeVerify(sub, 'echo dir-bidi\n');
  const a = await approveInChild(env, sub, 'yes');
  assert.equal(a.code, 2, a.stderr);
  assert.match(a.stderr, /cannot be approved/);
  assert.match(a.stderr, /control character/);
  assert.equal(existsSync(storePath(env)), false);
});
