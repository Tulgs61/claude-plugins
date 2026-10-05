// Tests for the rev 10 group C amendments (14-18) of verify-gate.js: fail-open on asynchronous errors,
// an unreadable own state file counting as dirty, the project identity from the real path and the
// quoted chmod hint. The hook is spawned with JSON on stdin.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck } from './helpers/verify-consent.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'verify-gate.js');
const POSIX = process.platform !== 'win32';
const NON_ROOT = POSIX && process.getuid() !== 0;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-fixes-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const env = withConsentStore({ ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp }, root);

const stateFile = (session, project) =>
  join(hookTmp, `claude-verify-${session}-${createHash('sha256').update(project).digest('hex').slice(0, 16)}.json`);

// An approved verify.cmd (see amendment 12), owner-only writable unless `mode` says otherwise.
function writeVerify(dir, body, mode = 0o644) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  approveCheck(env, dir, body);
  return file;
}

function makeRepo(name, verify) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.git'));
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

function run(stdin, cwd) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (session_id, cwd, file) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: file ? { file_path: file } : {} }, cwd);
const stop = (session_id, cwd) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd);

// --- Amendment 14: fail-open on asynchronous errors ---

// Runs the gate with the read end of its stdout closed, so writing to stdout fails with EPIPE.
function runClosedStdout(stdin, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stderr }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test('amendment 14 / 18: an EPIPE on stdout gives exit 0 and no further output', { skip: !POSIX }, async () => {
  // The loose-permissions warning, the approval request and the give-up message are written to stdout.
  const loose = makeRepo('c14-loose');
  writeVerify(loose, 'exit 1\n', 0o664);
  const unapproved = makeRepo('c14-unapproved');
  mkdirSync(join(unapproved, '.claude'));
  writeFileSync(join(unapproved, '.claude', 'verify.cmd'), 'exit 1\n');
  chmodSync(join(unapproved, '.claude', 'verify.cmd'), 0o644);
  const giveUp = makeRepo('c14-give-up', 'exit 1\n');
  writeFileSync(stateFile('rev10-c14-give-up', giveUp), JSON.stringify({ dirty: true, failures: 2 }));

  for (const [session, repo] of [['rev10-c14-loose', loose], ['rev10-c14-unapproved', unapproved], ['rev10-c14-give-up', giveUp]]) {
    if (session !== 'rev10-c14-give-up') assert.equal(edit(session, repo).status, 0);
    const r = await runClosedStdout({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }, repo);
    assert.equal(r.signal, null, session);
    assert.equal(r.status, 0, `${session}: ${r.stderr}`);
    assert.equal(r.stderr, '', session);
  }
});

// --- Amendment 15: an unreadable own state file is dirty ---

test('amendment 15 / 18: an own state file with mode 000 counts as dirty with 0 failures', {
  skip: !NON_ROOT ? 'POSIX non-root only' : false,
}, () => {
  const repo = makeRepo('c15-unreadable', 'echo c15-check-ran >&2; exit 1\n');
  const session = 'rev10-c15-unreadable';
  const file = stateFile(session, repo);
  writeFileSync(file, JSON.stringify({ dirty: false, failures: 2 }));
  chmodSync(file, 0o000);
  const r = stop(session, repo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /c15-check-ran/);
  assert.match(r.stderr, /failure 1 of 3/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { dirty: true, failures: 1 });

  // Still clean: a missing state file.
  const clean = stop('rev10-c15-missing', repo);
  assert.equal(clean.status, 0);
  assert.equal(clean.stderr, '');
});

// --- Amendment 16: project identity from the real path ---

test('amendment 16 / 18: an edit through a symlinked repo path and a stop through the real path reach the same state', { skip: !POSIX }, () => {
  const repo = makeRepo('c16-real', 'echo c16-check-ran >&2; exit 1\n');
  const link = join(root, 'c16-link');
  symlinkSync(repo, link);

  // The edited file's directory does not exist yet.
  const session = 'rev10-c16-link-then-real';
  assert.equal(edit(session, link, join(link, 'src', 'not', 'yet', 'a.js')).status, 0);
  assert.ok(existsSync(stateFile(session, repo)));
  const r = stop(session, repo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /c16-check-ran/);

  // The other way round, with an existing directory.
  const back = 'rev10-c16-real-then-link';
  assert.equal(edit(back, repo, join(repo, 'src', 'a.js')).status, 0);
  const viaLink = stop(back, join(link, 'src'));
  assert.equal(viaLink.status, 2, viaLink.stderr);
  assert.match(viaLink.stderr, /c16-check-ran/);
});

// --- Amendments 17 and 18: the loose-permissions warning ---

const shellQuoted = text => `'${text.split("'").join("'\\''")}'`;

test('amendment 17 / 18: the loose-permissions warning comes once per project and names the quoted absolute path', { skip: !POSIX }, () => {
  const one = makeRepo('c17-one');
  const two = makeRepo("c17-it's");
  const files = [writeVerify(one, 'exit 1\n', 0o664), writeVerify(two, 'exit 1\n', 0o646)];
  const session = 'rev10-c17';
  assert.equal(edit(session, one).status, 0);
  assert.equal(edit(session, two).status, 0);

  const hints = [];
  for (const [repo, file] of [[one, files[0]], [two, files[1]]]) {
    const first = stop(session, join(repo, 'src'));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.split('\n').filter(Boolean).length, 1);
    const { systemMessage } = JSON.parse(first.stdout);
    assert.ok(systemMessage.includes(`skipped ${file} `), systemMessage);
    assert.ok(systemMessage.includes(`chmod 644 ${shellQuoted(file)}`), systemMessage);
    hints.push(systemMessage.match(/`(chmod 644 [^`]*)`/)[1]);
  }
  assert.equal(shellQuoted(files[1]), `'${root}/c17-it'\\''s/.claude/verify.cmd'`);

  for (const repo of [one, two]) {
    const again = stop(session, repo);
    assert.equal(again.status, 0);
    assert.equal(again.stdout, '');
  }

  // The hint works as a shell command: afterwards the next stop runs the check.
  const sh = spawnSync('bash', ['-c', hints[1]], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  assert.equal(stop(session, two).status, 2);
});
