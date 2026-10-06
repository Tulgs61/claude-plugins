// Coverage for `verify-consent.js approve` on a real terminal: the script runs as a command, without the
// module seam, on a pseudo-terminal that it holds as its controlling terminal (Python's pty.fork(), through
// helpers/pty-drive.py), so opening /dev/tty, the synchronous writes and the byte-wise read all run.
// Skipped without a python3 that can create a pseudo-terminal, except when CI is set: then it fails.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const TESTS = dirname(fileURLToPath(import.meta.url));
const CONSENT = join(TESTS, '..', 'scripts', 'verify-consent.js');
const DRIVER = join(TESTS, 'helpers', 'pty-drive.py');
const POSIX = process.platform !== 'win32';
const QUESTION = 'Run this command after Claude edits files here? [yes/N]';

const PTY_OK = POSIX && spawnSync('python3', ['-I', DRIVER, '--probe'], { encoding: 'utf8', timeout: 30000 }).status === 0;
const skip = !POSIX ? 'POSIX only' : !PTY_OK && !process.env.CI ? 'no python3 with a working pty module' : false;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-pty-rev11-')));
after(() => rmSync(root, { recursive: true, force: true }));

const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;

function makeRepo(name, body) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'verify.cmd'), body);
  chmodSync(join(repo, '.claude', 'verify.cmd'), 0o644);
  return repo;
}

// Runs `node verify-consent.js approve <dir>` on a pseudo-terminal; `action` is `answer:<text>` or `hangup`.
function drive(env, dir, action) {
  assert.ok(PTY_OK, 'python3 with a working pty module is required when CI is set');
  const r = spawnSync('python3', ['-I', DRIVER, action, QUESTION, process.execPath, CONSENT, 'approve', dir], {
    env, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('approve on a terminal: yes records one entry after showing the file, every line, the line count and the hash', { skip }, () => {
  const env = withConsentStore(baseEnv, root);
  const body = 'echo pty \x1b[2K shown\nexit 0\n';
  const repo = makeRepo('pty-yes', body);
  const r = drive(env, repo, 'answer:yes');
  assert.equal(r.timedOut, false);
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: commandHash(body) }]);

  const shown = r.output.slice(0, r.output.indexOf(QUESTION));
  assert.ok(r.output.includes(QUESTION), r.output);
  for (const part of [join(repo, '.claude', 'verify.cmd'), '| echo pty \\x1b[2K shown', '| exit 0', `2 lines, sha256 ${commandHash(body).slice(0, 12)}`]) {
    assert.ok(shown.includes(part), `${JSON.stringify(part)} before the question in ${JSON.stringify(r.output)}`);
  }
  // The escape sequence never reaches the terminal raw.
  assert.equal(r.output.includes('\x1b[2K'), false, JSON.stringify(r.output));
});

test('approve on a terminal: no exits 1 and records nothing', { skip }, () => {
  const env = withConsentStore(baseEnv, root);
  const repo = makeRepo('pty-no', 'exit 0\n');
  const r = drive(env, repo, 'answer:no');
  assert.equal(r.timedOut, false);
  assert.equal(r.exit, 1, r.output);
  assert.equal(existsSync(storePath(env)), false);
});

test('approve on a terminal: a hangup after the question ends the process within 10 seconds and records nothing', { skip }, () => {
  const env = withConsentStore(baseEnv, root);
  const repo = makeRepo('pty-hangup', 'exit 0\n');
  const r = drive(env, repo, 'hangup');
  assert.equal(r.asked, true, r.output);
  assert.equal(r.timedOut, false);
  assert.ok(r.signal !== null || r.exit !== 0, JSON.stringify(r));
  assert.equal(existsSync(storePath(env)), false);
});

test('approve on a terminal: without a check file the question never appears, so a hangup is never sent and nothing is recorded', { skip }, () => {
  const env = withConsentStore(baseEnv, root);
  const dir = join(root, 'pty-no-check');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const r = drive(env, dir, 'hangup');
  assert.equal(r.asked, false, r.output);
  assert.equal(r.timedOut, true, JSON.stringify(r));
  assert.equal(r.output.includes(QUESTION), false, r.output);
  assert.equal(existsSync(storePath(env)), false);
});
