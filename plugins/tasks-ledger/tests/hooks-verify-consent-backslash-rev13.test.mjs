// Tests for rev 13: a stored check directory is split into segments only at `/` on POSIX, where a backslash
// is an ordinary character of a directory name; on Windows `\` is a separator too. Answers are given only
// through the `terminal` option of approve(), reached by loading the script as a module, in a detached
// child (no controlling terminal).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';
const { dirProblem } = createRequire(import.meta.url)(CONSENT);

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-backslash-rev13-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;
const freshEnv = () => withConsentStore(baseEnv, root);

// A directory name holding backslashes around a `..`: one segment on POSIX.
const BACKSLASH_DIR = 'a\\..\\b';

function writeVerify(dir, body) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, 0o644);
}

function makeGitRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo);
  const r = spawnSync('git', ['init', '-q', repo], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
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

test('on POSIX, approve accepts a real directory named a\\..\\b and the gate runs its check', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('bs-approve');
  const body = 'echo bs-approve-ran >&2; exit 1\n';
  const sub = join(repo, BACKSLASH_DIR);
  writeVerify(sub, body);

  const session = 'rev13-bs-approve';
  assert.equal(edit(env, session, sub).status, 0);
  assertRequest(stop(env, session, sub), /bs-approve-ran/);

  const a = await approveInChild(env, sub, 'yes');
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: commandHash(body), dir: BACKSLASH_DIR }]);

  assert.equal(edit(env, session, sub).status, 0);
  const r = stop(env, session, sub);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /bs-approve-ran/);
});

test('on POSIX, a stored entry whose dir is a\\..\\b is honoured; a/../b and ../x are still ignored', { skip: !POSIX }, () => {
  const repo = makeGitRepo('bs-store');
  const body = 'echo bs-store-ran >&2; exit 1\n';
  const sub = join(repo, BACKSLASH_DIR);
  writeVerify(sub, body);
  const entry = { repo: repoIdentity(repo), sha256: commandHash(body) };

  const env = freshEnv();
  writeStoreEntries(env, [{ ...entry, dir: BACKSLASH_DIR }]);
  assert.equal(edit(env, 'rev13-bs-store', sub).status, 0);
  const r = stop(env, 'rev13-bs-store', sub);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /bs-store-ran/);

  for (const [i, dir] of ['a/../b', '../x'].entries()) {
    const refused = freshEnv();
    writeStoreEntries(refused, [{ ...entry, dir }]);
    const session = `rev13-bs-store-refused-${i}`;
    assert.equal(edit(refused, session, sub).status, 0);
    assertRequest(stop(refused, session, sub), /bs-store-ran/);
    const list = spawnSync(process.execPath, [CONSENT, 'list'], { env: refused, encoding: 'utf8', timeout: 60000 });
    assert.equal(list.stdout, '', JSON.stringify(dir));
  }
});

test('dirProblem splits on / only on POSIX and on both separators on win32', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(dirProblem(BACKSLASH_DIR, platform), null, platform);
    assert.equal(dirProblem('..\\x', platform), null, platform);
    assert.match(dirProblem('a/../b', platform), /\.\. segment/, platform);
    assert.match(dirProblem('../x', platform), /\.\. segment/, platform);
    assert.match(dirProblem('a/..', platform), /\.\. segment/, platform);
  }
  for (const dir of [BACKSLASH_DIR, '..\\x', 'a\\..', 'a/../b', '../x', 'a\\b/../c']) {
    assert.match(dirProblem(dir, 'win32'), /\.\. segment/, JSON.stringify(dir));
  }
  // Absolute paths and control characters are refused on every platform.
  for (const platform of ['linux', 'win32']) {
    assert.match(dirProblem('/abs', platform), /absolute/);
    assert.match(dirProblem('\\abs', platform), /absolute/);
    assert.match(dirProblem('C:\\abs', platform), /absolute/);
    assert.match(dirProblem('a\x1bb', platform), /control character/);
    assert.match(dirProblem('a\u202eb', platform), /control character/);
  }
  // The default is the running platform.
  assert.equal(dirProblem(BACKSLASH_DIR) === null, POSIX);
});
