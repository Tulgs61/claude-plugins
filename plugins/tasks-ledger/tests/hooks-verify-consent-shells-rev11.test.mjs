// Tests for the shell the approval request's command is meant for: it names a POSIX shell, and a quoted
// path with a backslash that shells read differently inside single quotes (one before another backslash
// or a single quote, or at the end of the path) gets no command; the request names which path it is.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-shells-rev11-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;
const freshEnv = () => withConsentStore(baseEnv, root);

function makeRepo(name, body) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'verify.cmd'), body);
  chmodSync(join(repo, '.claude', 'verify.cmd'), 0o644);
  return repo;
}

function run(stdin, cwd, env, gate = GATE) {
  return spawnSync(process.execPath, [gate], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd, gate) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env, gate);
const stop = (env, session_id, cwd, gate) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env, gate);

function messageOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  return out.systemMessage;
}

function assertNoCommand(message) {
  assert.match(message, /contains a backslash/, message);
  assert.doesNotMatch(message, /approve '/, message);
  assert.doesNotMatch(message, /node '/, message);
}

test('a repository directory with a backslash gets no command, and the request names the repository directory', { skip: !POSIX }, () => {
  const env = freshEnv();
  for (const [i, name] of ['back\\\\slash', 'back\\\'slash', 'trailing back\\'].entries()) {
    const repo = makeRepo(name, 'touch backslash-ran.marker; exit 1\n');
    const session = `rev11-backslash-repo-${i}`;
    assert.equal(edit(env, session, repo).status, 0);
    const message = messageOf(stop(env, session, repo));
    assertNoCommand(message);
    assert.match(message, /repository directory/, message);
    assert.doesNotMatch(message, /plugin directory|consent store/, message);
    assert.ok(message.includes(repo), message);
    assert.equal(existsSync(join(repo, 'backslash-ran.marker')), false);
  }
});

test('a consent store or plugin directory with a backslash gets no command, and the request names that path', { skip: !POSIX }, () => {
  const repo = makeRepo('backslash-other', 'exit 1\n');
  const storeEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'store dir\\') };
  assert.equal(edit(storeEnv, 'rev11-backslash-store', repo).status, 0);
  const m1 = messageOf(stop(storeEnv, 'rev11-backslash-store', repo));
  assertNoCommand(m1);
  assert.match(m1, /consent store/);
  assert.doesNotMatch(m1, /plugin directory|repository directory/);

  const plugin = join(root, 'plugin\\\\dir');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  mkdirSync(join(plugin, 'scripts'));
  copyFileSync(GATE, join(plugin, 'hooks', 'verify-gate.js'));
  copyFileSync(CONSENT, join(plugin, 'scripts', 'verify-consent.js'));
  const gate = join(plugin, 'hooks', 'verify-gate.js');
  const env = freshEnv();
  assert.equal(edit(env, 'rev11-backslash-plugin', repo, gate).status, 0);
  const m2 = messageOf(stop(env, 'rev11-backslash-plugin', repo, gate));
  assertNoCommand(m2);
  assert.match(m2, /plugin directory/);
  assert.doesNotMatch(m2, /consent store|repository directory/);
});

test('a request without a backslash in its paths says the command is for a POSIX shell such as bash or zsh', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('posix-shell', 'exit 1\n');
  assert.equal(edit(env, 'rev11-posix-shell', repo).status, 0);
  const message = messageOf(stop(env, 'rev11-posix-shell', repo));
  assert.match(message, /POSIX shell such as bash or zsh/);
  assert.ok(message.includes(`node '${CONSENT}' approve '${repo}'`), message);
});

test('a backslash that is not before another backslash or a single quote, nor at the end, keeps the command', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('a\\b', 'exit 1\n');
  assert.equal(edit(env, 'rev11-inner-backslash', repo).status, 0);
  const message = messageOf(stop(env, 'rev11-inner-backslash', repo));
  assert.doesNotMatch(message, /contains a backslash/, message);
  assert.match(message, /POSIX shell such as bash or zsh/);
  assert.ok(message.includes(`node '${CONSENT}' approve '${repo}'`), message);
});
