// Tests for the rev 10 group B amendments (8-12): verify-gate runs a check only after that exact command
// was approved for its repository, and scripts/verify-consent.js manages the consent store. The hook and
// the script are spawned as child processes; the yes/no answers are given only through the `ask` option
// of approve(), which is reachable solely by loading the script as a module. Nothing here ever opens a
// terminal: the command-line approve runs detached, so it has no controlling terminal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync,
  statSync, lstatSync, realpathSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';
const PROMPT = 'Run this command after Claude edits files here? [yes/N] ';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
// Each test gets its own fresh store.
const freshEnv = () => withConsentStore(baseEnv, root);

const stateFile = (session, project) =>
  join(hookTmp, `claude-verify-${session}-${createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16)}.json`);

// Writes a verify.cmd without approving it.
function writeVerify(dir, body, mode = 0o644) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

// A fake repository: a .git directory marks the root, but git does not accept it as a repository.
function makeRepo(name, verify) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.git'));
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

function run(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd, file) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: file ? { file_path: file } : {} }, cwd, env);
const stop = (env, session_id, cwd, event = 'Stop') =>
  run({ session_id, cwd, hook_event_name: event, stop_hook_active: false }, cwd, env);

const consentCli = (env, ...args) =>
  spawnSync(process.execPath, [CONSENT, ...args], { env, encoding: 'utf8', timeout: 60000, input: 'yes\n' });

// Asserts that `r` is an allowed stop with exactly one compact systemMessage line on stdout.
function requestOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.equal(r.stdout, `${JSON.stringify(out)}\n`);
  return out.systemMessage;
}

// Loads the script as a module (the only way to reach the answer seam) and collects its output.
const loadConsent = () => createRequire(import.meta.url)(CONSENT);
function approveWith(env, dir, answer) {
  const consentModule = loadConsent();
  const asked = [];
  let out = '';
  let err = '';
  const code = consentModule.approve(dir, {
    env,
    ask: prompt => {
      asked.push(prompt);
      return answer;
    },
    out: { write: s => { out += s; } },
    err: { write: s => { err += s; } },
  });
  return { code, asked, out, err };
}

// --- Amendments 8, 10, 12: an unapproved check ---

test('amendment 10: an unapproved check is not run, asks once, keeps the session dirty and records nothing', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('b10-unapproved', 'touch ran.marker; echo b10-ran >&2; exit 1\n');
  const session = 'rev10-b10-unapproved';
  assert.equal(edit(env, session, join(repo, 'src'), join(repo, 'src', 'a.js')).status, 0);

  const message = requestOf(stop(env, session, join(repo, 'src')));
  assert.equal(existsSync(join(repo, 'ran.marker')), false, 'check ran');
  assert.ok(message.includes(join(repo, '.claude', 'verify.cmd')), message);
  // Rev 10 amendments 19 and 21: shell-quoted, after the assignment that chose the store.
  assert.ok(message.includes(`CLAUDE_PLUGIN_DATA='${env.CLAUDE_PLUGIN_DATA}' node '${CONSENT}' approve '${repo}'`), message);
  assert.match(message, /terminal/);

  // Later unapproved stops in this session and project stay silent, also as SubagentStop and after an edit.
  for (const r of [stop(env, session, repo), stop(env, session, repo, 'SubagentStop'), (edit(env, session, repo), stop(env, session, repo))]) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
  assert.equal(existsSync(join(repo, 'ran.marker')), false, 'check ran');
  // The session stayed dirty, and the gate did not record consent (amendment 8).
  assert.equal(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')).dirty, true);
  assert.equal(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')).failures, 0);
  assert.equal(existsSync(storePath(env)), false);

  // Another session asks again.
  assert.equal(edit(env, 'rev10-b10-other', repo).status, 0);
  requestOf(stop(env, 'rev10-b10-other', repo));

  // Once approved, the next stop runs the check.
  approveCheck(env, repo);
  const block = stop(env, session, repo);
  assert.equal(block.status, 2);
  assert.match(block.stderr, /b10-ran/);
  assert.match(block.stderr, /failure 1 of 3/);
  assert.equal(existsSync(join(repo, 'ran.marker')), true);
});

test('amendment 10: a changed verify.cmd is unapproved again', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('b10-changed', 'echo b10-first-ran >&2; exit 1\n');
  approveCheck(env, repo);
  const session = 'rev10-b10-changed';
  assert.equal(edit(env, session, repo).status, 0);
  assert.match(stop(env, session, repo).stderr, /b10-first-ran/);

  // Even a whitespace change inside the command changes the hash.
  writeVerify(repo, 'echo  b10-first-ran >&2; exit 1\n');
  const message = requestOf(stop(env, session, repo));
  assert.match(message, /approve/);
  // Leading and trailing whitespace is not passed to bash, so it does not change the command.
  writeVerify(repo, '\n  echo b10-first-ran >&2; exit 1  \n\n');
  const same = stop(env, session, repo);
  assert.equal(same.status, 2);
  assert.match(same.stderr, /failure 2 of 3/);
});

// --- Amendment 9: repository identity and store location ---

function realGit(cwd, ...args) {
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

test('amendment 9 / 12: an approval in the main checkout makes the check run in a linked worktree', { skip: !POSIX }, () => {
  const env = freshEnv();
  const main = join(root, 'b9-main');
  mkdirSync(main);
  realGit(main, 'init', '-q');
  const body = 'echo b9-check-ran-in-$(basename "$PWD") >&2; exit 1\n';
  writeVerify(main, body);
  realGit(main, 'add', '-A');
  realGit(main, 'commit', '-q', '-m', 'check');
  const wt = join(root, 'b9-wt');
  realGit(main, 'worktree', 'add', '-q', '-b', 'b9-task', wt);
  chmodSync(join(wt, '.claude', 'verify.cmd'), 0o644);
  // Both share the identity of the main checkout's .git directory.
  assert.equal(repoIdentity(wt), realpathSync(join(main, '.git')));

  approveCheck(env, main);
  const session = 'rev10-b9-worktree';
  assert.equal(edit(env, session, main, join(wt, 'a.js')).status, 0);
  const r = stop(env, session, wt, 'SubagentStop');
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /b9-check-ran-in-b9-wt/);

  // The same command in another repository is not approved.
  const other = makeRepo('b9-other', body);
  assert.equal(edit(env, session, other).status, 0);
  const otherStop = stop(env, session, other);
  assert.doesNotMatch(otherStop.stderr, /b9-check-ran/);
  requestOf(otherStop);
});

test('amendment 9: the store is $CLAUDE_PLUGIN_DATA, else <config>/tasks-ledger, else ~/.claude/tasks-ledger', { skip: !POSIX }, () => {
  const repo = makeRepo('b9-location', 'echo b9-location-ran >&2; exit 1\n');
  const place = name => join(root, 'b9-places', name);
  const env = { ...baseEnv };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_CONFIG_DIR;
  const cases = [
    ['plugin data', { ...env, CLAUDE_PLUGIN_DATA: place('data') }, place('data')],
    ['config dir', { ...env, CLAUDE_PLUGIN_DATA: '', CLAUDE_CONFIG_DIR: place('config') }, join(place('config'), 'tasks-ledger')],
    ['home', { ...env, CLAUDE_CONFIG_DIR: '', HOME: place('home') }, join(place('home'), '.claude', 'tasks-ledger')],
  ];
  for (const [name, runEnv, storeDir] of cases) {
    const session = `rev10-b9-location-${name.replace(' ', '-')}`;
    assert.equal(edit(runEnv, session, repo).status, 0);
    // Not approved yet: an approval elsewhere does not count.
    requestOf(stop(runEnv, session, repo));
    approveCheck({ CLAUDE_PLUGIN_DATA: storeDir }, repo);
    const r = stop(runEnv, session, repo);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, /b9-location-ran/, name);
  }
});

test('amendment 9: approve creates missing directories with mode 0700 and replaces the store by rename', { skip: !POSIX }, () => {
  const repo = makeRepo('b9-dirs', 'exit 0\n');
  const data = join(root, 'b9-dirs-data', 'a', 'b');
  const env = { CLAUDE_PLUGIN_DATA: data };
  assert.equal(approveWith(env, repo, 'yes').code, 0);
  for (const dir of [join(root, 'b9-dirs-data'), join(root, 'b9-dirs-data', 'a'), data]) {
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  }
  const store = storePath(env);
  assert.ok(lstatSync(store).isFile());
  const ino = lstatSync(store).ino;
  writeVerify(repo, 'exit 0 # second\n');
  assert.equal(approveWith(env, repo, 'yes').code, 0);
  assert.notEqual(lstatSync(store).ino, ino);
  assert.equal(storeEntries(env).length, 2);
});

// --- Amendment 11: verify-consent.js ---

// Runs the command-line script detached (a new session, so no controlling terminal), with "yes" on stdin.
function consentDetached(env, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONSENT, ...args], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end('yes\n');
  });
}

test('amendment 11 / 12: approve without a terminal exits 2 with needs a terminal and records nothing', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const repo = makeRepo('b11-no-tty', 'echo b11-no-tty-ran >&2; exit 1\n');
  const r = await consentDetached(env, 'approve', repo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /needs a terminal/);
  // Amendment 31: it opens the terminal first, so without one it writes nothing to stdout.
  assert.equal(r.stdout, '');
  // "yes" on stdin is never read as the answer.
  assert.equal(existsSync(storePath(env)), false);
  assert.equal(edit(env, 'rev10-b11-no-tty', repo).status, 0);
  requestOf(stop(env, 'rev10-b11-no-tty', repo));
});

test('amendment 11: no command-line argument supplies the answer', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('b11-args', 'exit 0\n');
  for (const args of [['approve', repo, 'yes'], ['approve', repo, '--yes'], ['approve'], ['yes'], [], ['list', 'x'], ['revoke']]) {
    const r = consentCli(env, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/, args.join(' '));
  }
  assert.equal(existsSync(storePath(env)), false);
});

test('amendment 11: only the exact answer yes records the pair', { skip: !POSIX }, () => {
  const env = freshEnv();
  const body = 'echo b11-answer-ran >&2; exit 1\n';
  const repo = makeRepo('b11-answer', body);
  for (const answer of ['no', 'YES', 'Yes', 'yes ', ' yes', 'y', '', 'yes please']) {
    const r = approveWith(env, repo, answer);
    assert.equal(r.code, 1, JSON.stringify(answer));
    assert.deepEqual(r.asked, [PROMPT]);
    assert.equal(existsSync(storePath(env)), false, JSON.stringify(answer));
  }
  // No terminal: exit 2, needs a terminal, nothing recorded.
  const none = approveWith(env, repo, null);
  assert.equal(none.code, 2);
  assert.match(none.err, /needs a terminal/);
  assert.equal(existsSync(storePath(env)), false);

  const yes = approveWith(env, repo, 'yes');
  assert.equal(yes.code, 0, yes.err);
  assert.ok(yes.out.includes(join(repo, '.claude', 'verify.cmd')));
  assert.ok(yes.out.includes(body.trim()));
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: commandHash(body) }]);
  assert.equal(edit(env, 'rev10-b11-answer', repo).status, 0);
  assert.match(stop(env, 'rev10-b11-answer', repo).stderr, /b11-answer-ran/);
});

test('amendment 11: approve applies the gate\'s trust rules and never asks about an untrusted file', { skip: !POSIX }, () => {
  const env = freshEnv();
  const loose = makeRepo('b11-loose');
  writeVerify(loose, 'exit 0\n', 0o664);
  const linked = makeRepo('b11-linked');
  mkdirSync(join(linked, '.claude'));
  symlinkSync(join(loose, '.claude', 'verify.cmd'), join(linked, '.claude', 'verify.cmd'));
  chmodSync(join(loose, '.claude', 'verify.cmd'), 0o644);
  const missing = makeRepo('b11-missing');
  const looseAgain = makeRepo('b11-loose-again');
  writeVerify(looseAgain, 'exit 0\n', 0o646);
  for (const dir of [linked, missing, looseAgain]) {
    const r = approveWith(env, dir, 'yes');
    assert.equal(r.code, 2, dir);
    assert.deepEqual(r.asked, [], dir);
  }
  assert.equal(existsSync(storePath(env)), false);
});

test('amendment 11 / 12: revoke removes every entry for the repository; list shows the rest', { skip: !POSIX }, () => {
  const env = freshEnv();
  const a = makeRepo('b11-revoke-a', 'echo b11-a-ran >&2; exit 1\n');
  const b = makeRepo('b11-revoke-b', 'echo b11-b-ran >&2; exit 1\n');
  approveCheck(env, a, 'echo an older command\n');
  approveCheck(env, a);
  approveCheck(env, b);

  const listed = consentCli(env, 'list');
  assert.equal(listed.status, 0, listed.stderr);
  const lines = listed.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.match(lines[2], new RegExp(`^${repoIdentity(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${commandHash('echo b11-b-ran >&2; exit 1')
    .slice(0, 12)}$`));

  const r = consentCli(env, 'revoke', a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(b), sha256: commandHash('echo b11-b-ran >&2; exit 1\n') }]);
  assert.equal(consentCli(env, 'list').stdout.split('\n').filter(Boolean).length, 1);

  const session = 'rev10-b11-revoke';
  assert.equal(edit(env, session, a).status, 0);
  requestOf(stop(env, session, a));
  assert.equal(edit(env, session, b).status, 0);
  assert.match(stop(env, session, b).stderr, /b11-b-ran/);

  // Revoking a repository without entries is fine too.
  assert.equal(consentCli(env, 'revoke', a).status, 0);
});

// --- Amendment 9 / 12: an untrusted store is ignored ---

test('amendment 9 / 12: a symlinked store is ignored', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('b9-symlink-store', 'echo b9-symlink-store-ran >&2; exit 1\n');
  // A store with the approval elsewhere, linked into place.
  const elsewhere = { CLAUDE_PLUGIN_DATA: join(root, 'b9-elsewhere') };
  approveCheck(elsewhere, repo);
  symlinkSync(storePath(elsewhere), storePath(env));
  const session = 'rev10-b9-symlink-store';
  assert.equal(edit(env, session, repo).status, 0);
  const r = stop(env, session, repo);
  assert.doesNotMatch(r.stderr, /b9-symlink-store-ran/);
  requestOf(r);
  assert.equal(consentCli(env, 'list').stdout, '');

  // Control: the same content as a regular file in place is used.
  rmSync(storePath(env));
  copyFileSync(storePath(elsewhere), storePath(env));
  const block = stop(env, session, repo);
  assert.equal(block.status, 2);
  assert.match(block.stderr, /b9-symlink-store-ran/);
});

// Rev 10 amendment 22: runs as a normal user; the gate preloads a module that makes process.getuid()
// return another uid, so the store looks owned by someone else.
const OTHER_UID = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'other-uid.cjs');

test('amendment 9 / 12: a store owned by another user is ignored', {
  skip: !POSIX || typeof process.getuid !== 'function',
}, () => {
  const env = freshEnv();
  const repo = makeRepo('b9-foreign-store', 'echo b9-foreign-store-ran >&2; exit 1\n');
  approveCheck(env, repo);
  const session = 'rev10-b9-foreign-store';
  assert.equal(edit(env, session, repo).status, 0);
  const foreignRun = (args, input) =>
    spawnSync(process.execPath, ['--require', OTHER_UID, ...args], { input, cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  const r = foreignRun([GATE], JSON.stringify({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /b9-foreign-store-ran/);
  // The store itself is ignored, not only the files around it.
  assert.equal(foreignRun([CONSENT, 'list'], '').stdout, '');
  assert.equal(consentCli(env, 'list').stdout.split('\n').filter(Boolean).length, 1);
});
