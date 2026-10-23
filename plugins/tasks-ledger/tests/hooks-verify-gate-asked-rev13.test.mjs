// Tests for the rev 13 amendment to verify-gate: the approval request is shown once per session and
// check directory, not once per session and project. The session state remembers the real paths of the
// check directories it already asked about (consentAskedDirs); the boolean consentAsked of earlier
// versions is read safely and ignored.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-gate-asked-rev13-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
const freshEnv = () => withConsentStore(baseEnv, root);

const stateFile = (session, project) =>
  join(hookTmp, `claude-verify-${session}-${createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16)}.json`);
const readStateFile = (session, project) => JSON.parse(readFileSync(stateFile(session, project), 'utf8'));

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

// A real git repository with an unapproved check at the top level and one in `sub`.
function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo);
  git(root, 'init', '-q', repo);
  const body = `echo ${name}-ran >&2; exit 1\n`;
  writeVerify(repo, body);
  const sub = join(repo, 'sub');
  writeVerify(sub, body);
  return { repo, sub, ran: new RegExp(`${name}-ran`) };
}

function run(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env);
const stop = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env);

// An allowed stop that did not run the check and showed the approval request for the check in `dir`.
function assertRequestFor(r, dir, ran) {
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, ran);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  const message = JSON.parse(r.stdout).systemMessage;
  assert.match(message, /not approved/);
  assert.ok(message.endsWith(` approve '${dir}'`), message);
}

// An allowed stop that did not run the check and printed nothing.
function assertSilent(r, ran) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, ran);
}

test('rev 13: the top level is asked about once, then an unapproved subdirectory once, then silence', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, sub, ran } = makeRepo('asked-order');
  const session = 'rev13-asked-order';

  assert.equal(edit(env, session, repo).status, 0);
  assertRequestFor(stop(env, session, repo), repo, ran);
  assertSilent(stop(env, session, repo), ran);

  // A later stop in the unapproved subdirectory of the same project gets that directory's request once.
  assertRequestFor(stop(env, session, sub), sub, ran);
  assertSilent(stop(env, session, sub), ran);
  // An edit keeps what was asked; neither directory is asked about again.
  assert.equal(edit(env, session, sub).status, 0);
  assertSilent(stop(env, session, sub), ran);
  assertSilent(stop(env, session, repo), ran);
  assert.deepEqual(readStateFile(session, repo), { dirty: true, failures: 0, consentAskedDirs: [repo, sub] });
});

test('rev 13: asking about a subdirectory first does not silence the top level', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, sub, ran } = makeRepo('asked-sub-first');
  const session = 'rev13-asked-sub-first';

  assert.equal(edit(env, session, sub).status, 0);
  assertRequestFor(stop(env, session, sub), sub, ran);
  assertRequestFor(stop(env, session, repo), repo, ran);
  assertSilent(stop(env, session, repo), ran);
  assertSilent(stop(env, session, sub), ran);
});

test('rev 13: an approved top level does not count as asked for an unapproved subdirectory', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, sub, ran } = makeRepo('asked-approved');
  approveCheck(env, repo);
  const session = 'rev13-asked-approved';

  assert.equal(edit(env, session, repo).status, 0);
  const top = stop(env, session, repo);
  assert.equal(top.status, 2, top.stdout);
  assert.match(top.stderr, ran);
  assertRequestFor(stop(env, session, sub), sub, ran);
  assertSilent(stop(env, session, sub), ran);
});

test('rev 13: a symlinked spelling of a check directory already asked about stays silent', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, sub, ran } = makeRepo('asked-link');
  const link = join(root, 'asked-link-alias');
  symlinkSync(sub, link);
  const session = 'rev13-asked-link';

  assert.equal(edit(env, session, sub).status, 0);
  assertRequestFor(stop(env, session, sub), sub, ran);
  assertSilent(stop(env, session, link), ran);
  assert.deepEqual(readStateFile(session, repo).consentAskedDirs, [sub]);
});

test('rev 13: a state file with the older consentAsked: true is read safely and asks once per directory', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, sub, ran } = makeRepo('asked-legacy');
  const session = 'rev13-asked-legacy';
  writeFileSync(stateFile(session, repo),
    JSON.stringify({ dirty: true, failures: 2, looseWarned: true, consentAsked: true }), { mode: 0o600 });

  // Still dirty with its count and warning flag (not unreadable), and the old flag does not silence it.
  assertRequestFor(stop(env, session, repo), repo, ran);
  assert.deepEqual(readStateFile(session, repo), { dirty: true, failures: 2, looseWarned: true, consentAskedDirs: [repo] });
  assertSilent(stop(env, session, repo), ran);
  assertRequestFor(stop(env, session, sub), sub, ran);
  assertSilent(stop(env, session, sub), ran);
});

test('rev 13: a malformed consentAskedDirs counts as none and keeps the rest of the state', { skip: !POSIX }, () => {
  const env = freshEnv();
  const { repo, ran } = makeRepo('asked-malformed');
  const session = 'rev13-asked-malformed';
  for (const value of ['x', 1, { [repo]: true }, [7, null, '']]) {
    writeFileSync(stateFile(session, repo), JSON.stringify({ dirty: true, failures: 1, consentAskedDirs: value }), { mode: 0o600 });
    assertRequestFor(stop(env, session, repo), repo, ran);
    assert.deepEqual(readStateFile(session, repo), { dirty: true, failures: 1, consentAskedDirs: [repo] });
  }
});
