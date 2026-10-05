// Tests for rev 10 amendment 32: a repository cannot borrow another repository's identity. The git
// directory that `git rev-parse --git-common-dir` reports is only the identity when it really belongs to
// the checkout (a main checkout's own <top>/.git, or a linked worktree that git's back-reference in the
// common git directory names); otherwise the identity is the directory that contains .claude/, so no
// approval of another repository applies. The gate is spawned as a child process; approvals are written
// directly into a fresh store with the test helper.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-identity-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
const freshEnv = () => withConsentStore(baseEnv, root);

const BODY = 'touch "$PWD/ran.marker"; echo identity-check-ran >&2; exit 1\n';

function writeVerify(dir, body = BODY) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, 0o644);
}

function git(cwd, ...args) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' });
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A real repository with a committed, approved verify.cmd and a real linked worktree.
function approvedRepo(env, name) {
  const main = join(root, name);
  mkdirSync(main);
  git(main, 'init', '-q');
  writeVerify(main);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'check');
  const wt = join(root, `${name}-wt`);
  git(main, 'worktree', 'add', '-q', '-b', `${name}-task`, wt);
  chmodSync(join(wt, '.claude', 'verify.cmd'), 0o644);
  approveCheck(env, main);
  return { main, wt };
}

function run(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwd, 'a.js') } }, cwd, env);
const stop = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env);

// The stop did not run the check and showed the approval request for `dir`.
function assertRequested(r, dir) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(existsSync(join(dir, 'ran.marker')), false, 'check ran');
  const { systemMessage } = JSON.parse(r.stdout);
  assert.ok(systemMessage.includes(join(dir, '.claude', 'verify.cmd')), systemMessage);
  assert.ok(systemMessage.includes(`approve '${dir}'`), systemMessage);
}

function assertRan(r, dir) {
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /identity-check-ran/);
  assert.equal(existsSync(join(dir, 'ran.marker')), true, 'check did not run');
}

const identityOf = dir => createRequire(import.meta.url)(CONSENT).repoIdentity(dir);

test('amendment 32: a .git file pointing at an approved repository\'s git directory does not borrow its approval', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { main } = approvedRepo(env, 'a32-approved');
  const forged = join(root, 'a32-gitfile');
  mkdirSync(forged);
  writeFileSync(join(forged, '.git'), `gitdir: ${join(main, '.git')}\n`);
  writeVerify(forged);
  // git itself reports the approved repository's git directory here.
  assert.equal(realpathSync(resolve(forged, git(forged, 'rev-parse', '--git-common-dir'))), realpathSync(join(main, '.git')));
  assert.equal(identityOf(forged), forged);

  const session = 'rev10-a32-gitfile';
  assert.equal(edit(env, session, forged).status, 0);
  assertRequested(stop(env, session, forged), forged);

  // Control: the approved repository itself runs the same command.
  assert.equal(edit(env, session, main).status, 0);
  assertRan(stop(env, session, main), main);
});

test('amendment 32: a .git file pointing at a linked worktree\'s git directory of an approved repository does not borrow it', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { main, wt } = approvedRepo(env, 'a32-wtdir');
  const wtGitDir = readFileSync(join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)[1];
  const forged = join(root, 'a32-wtdir-forged');
  mkdirSync(forged);
  writeFileSync(join(forged, '.git'), `gitdir: ${wtGitDir}\n`);
  writeVerify(forged);
  assert.equal(identityOf(forged), forged);
  assert.equal(identityOf(wt), realpathSync(join(main, '.git')));

  const session = 'rev10-a32-wtdir';
  assert.equal(edit(env, session, forged).status, 0);
  assertRequested(stop(env, session, forged), forged);
});

test('amendment 32: a real linked worktree of an approved repository still runs the check', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { main, wt } = approvedRepo(env, 'a32-real');
  assert.equal(identityOf(wt), realpathSync(join(main, '.git')));
  assert.equal(identityOf(join(wt, '.claude', '..')), realpathSync(join(main, '.git')));
  const session = 'rev10-a32-real';
  assert.equal(edit(env, session, wt).status, 0);
  assertRan(stop(env, session, wt), wt);
});

test('amendment 32: a forged commondir is ignored', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { main } = approvedRepo(env, 'a32-commondir');

  // A real .git directory whose commondir names the approved repository's git directory.
  const own = join(root, 'a32-commondir-own');
  mkdirSync(own);
  git(own, 'init', '-q');
  writeFileSync(join(own, '.git', 'commondir'), `${join(main, '.git')}\n`);
  writeVerify(own);
  assert.equal(realpathSync(resolve(own, git(own, 'rev-parse', '--git-common-dir'))), realpathSync(join(main, '.git')));
  assert.equal(identityOf(own), own);

  // A .git file naming a worktree-style git directory of its own, whose commondir names the approved one.
  const linked = join(root, 'a32-commondir-linked');
  const fakeGitDir = join(root, 'a32-commondir-fake-gitdir');
  mkdirSync(linked);
  mkdirSync(fakeGitDir);
  writeFileSync(join(fakeGitDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(fakeGitDir, 'commondir'), `${join(main, '.git')}\n`);
  writeFileSync(join(fakeGitDir, 'gitdir'), `${join(linked, '.git')}\n`);
  writeFileSync(join(linked, '.git'), `gitdir: ${fakeGitDir}\n`);
  writeVerify(linked);
  assert.equal(realpathSync(resolve(linked, git(linked, 'rev-parse', '--git-common-dir'))), realpathSync(join(main, '.git')));
  assert.equal(identityOf(linked), linked);

  for (const dir of [own, linked]) {
    const session = `rev10-a32-commondir-${dir.endsWith('own') ? 'own' : 'linked'}`;
    assert.equal(edit(env, session, dir).status, 0);
    assertRequested(stop(env, session, dir), dir);
  }
});
