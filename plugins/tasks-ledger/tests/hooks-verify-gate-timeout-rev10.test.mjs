// Test for rev 10 amendment 3 of verify-gate.js: on the 3-minute time limit the whole process group of
// the check is ended, SIGTERM first and SIGKILL 5 seconds later. POSIX only; it takes about 3 minutes,
// so it has its own file and runs alongside the others.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck } from './helpers/verify-consent.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'verify-gate.js');
const POSIX = process.platform !== 'win32';

const root = mkdtempSync(join(tmpdir(), 'tasks-ledger-hooks-timeout-rev10-'));
after(() => rmSync(root, { recursive: true, force: true }));
const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
// Rev 10 amendment 12: a fresh consent store, so the checks these tests run can be approved.
const env = withConsentStore({ ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp }, root);

function run(stdin, cwd) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 230000 });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Waits until no process with the given pid is left (a killed orphan is reaped asynchronously).
function gone(pid) {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    execFileSync('sleep', ['0.1']);
  }
  return true;
}

test('amendment 3: the timeout ends grandchildren too, with SIGKILL for one that ignores SIGTERM', { skip: !POSIX }, () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  const verify = join(repo, '.claude', 'verify.cmd');
  // Neither grandchild nor the foreground sleep holds the output pipes, so only a group kill ends them.
  writeFileSync(verify, [
    'sleep 600 >/dev/null 2>&1 &',
    'echo $! > plain.pid',
    'bash -c \'trap "" TERM; exec sleep 600\' >/dev/null 2>&1 &',
    'echo $! > stubborn.pid',
    'echo timeout-check-started >&2',
    'sleep 600 >/dev/null 2>&1',
    '',
  ].join('\n'));
  chmodSync(verify, 0o644);
  approveCheck(env, repo);

  const session = 'rev10-timeout';
  assert.equal(run({ session_id: session, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, repo).status, 0);
  const started = Date.now();
  const r = run({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }, repo);
  const elapsed = Date.now() - started;
  const pids = ['plain', 'stubborn'].map(n => Number(readFileSync(join(repo, `${n}.pid`), 'utf8')));
  const left = pids.filter(pid => !gone(pid));
  for (const pid of left) process.kill(pid, 'SIGKILL');

  assert.equal(r.error, undefined);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /verification FAILED \(exit timeout after 180s\)/);
  assert.match(r.stderr, /timeout-check-started/);
  assert.deepEqual(left, [], 'grandchildren still alive');
  // SIGKILL comes after the 5 s grace period, and the whole run stays below the hook timeout.
  assert.ok(elapsed >= 185000 && elapsed < 200000, `elapsed ${elapsed} ms`);
});
