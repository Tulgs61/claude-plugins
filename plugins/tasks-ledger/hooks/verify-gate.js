#!/usr/bin/env node
// PostToolUse + Stop hook. After Claude has edited files, the turn cannot end while the project's
// .claude/verify.cmd fails, up to MAX_FAILURES runs; after that the gate only warns.
// - PostToolUse (Edit|Write|MultiEdit|NotebookEdit): marks the session dirty, resets the failure count.
// - Stop: if dirty, runs the nearest trusted .claude/verify.cmd between cwd and its repository root.
// Exit 2 blocks (stderr goes to Claude), exit 0 allows. Fails open on any error.
// The check always follows the hook input's `cwd`; CLAUDE_PROJECT_DIR is ignored on purpose.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_FAILURES = 3;
const TIMEOUT_MS = 3 * 60 * 1000;
const TAIL_CHARS = 4000;
const VERIFY_REL = path.join('.claude', 'verify.cmd');

// The session id is sanitised so the state file always lies directly in the temp directory.
function sessionStateFile(sessionId) {
  const id = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `claude-verify-${id}.json`);
}

const NOFOLLOW = (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

// A state file is only used when it is a regular file owned by the current user (POSIX).
function ownStateFile(stat) {
  if (!stat.isFile()) return false;
  return process.platform === 'win32' || stat.uid === currentUid();
}

function clampFailures(n) {
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), MAX_FAILURES) : 0;
}

// Symbolic links are never followed, and a state file that belongs to another user is ignored.
function readState(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    if (ownStateFile(fs.fstatSync(fd))) {
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (state && typeof state === 'object') {
        return { dirty: state.dirty === true, failures: clampFailures(state.failures) };
      }
    }
  } catch {
    // Missing or corrupt state counts as clean.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { dirty: false, failures: 0 };
}

// Writes without following a symbolic link; a file that is not the user's own is left alone.
function writeState(file, state) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    if (!ownStateFile(fs.fstatSync(fd))) return;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify({ dirty: state.dirty, failures: clampFailures(state.failures) }));
  } finally {
    fs.closeSync(fd);
  }
}

function removeState(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

// The nearest directory at or above `dir` that contains a .git entry (directory or file), or null.
function findGitRoot(dir) {
  for (;;) {
    try {
      fs.lstatSync(path.join(dir, '.git'));
      return dir;
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A trusted check file is a regular file; on POSIX it is also owned by the current user and not
// writable by group or others.
function isTrusted(stat) {
  if (!stat.isFile()) return false;
  if (process.platform === 'win32') return true;
  return stat.uid === currentUid() && (stat.mode & 0o022) === 0;
}

// Reads `file` only if it is trusted. Non-regular files are never opened, and the opened descriptor
// is re-checked against the inspected file, so the file that is checked is the file that is read.
function readTrusted(file) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!isTrusted(before)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !isTrusted(opened)) return null;
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// The nearest trusted .claude/verify.cmd between `cwd` and its repository root inclusive, or only
// <cwd>/.claude/verify.cmd outside a repository. Untrusted files count as absent.
function findCheck(cwd) {
  const root = findGitRoot(cwd);
  let dir = cwd;
  for (;;) {
    const content = readTrusted(path.join(dir, VERIFY_REL));
    if (content !== null) return { dir, command: content.trim() };
    if (root === null || dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function tail(text) {
  return text.length > TAIL_CHARS ? `...${text.slice(-TAIL_CHARS)}` : text;
}

function onStop(input, stateFile) {
  if (input.stop_hook_active === true) return 0;
  const state = readState(stateFile);
  if (!state.dirty) return 0;
  const cwd = typeof input.cwd === 'string' && input.cwd ? path.resolve(input.cwd) : process.cwd();
  const check = findCheck(cwd);
  if (!check) return 0;

  const result = spawnSync('bash', ['-c', check.command], {
    cwd: check.dir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timedOut = Boolean(result.error) && result.error.code === 'ETIMEDOUT';
  // The check could not be started at all: let the stop through and leave the state as it was.
  if (result.error && !timedOut) return 0;
  if (result.status === 0 && !result.error) {
    removeState(stateFile);
    return 0;
  }

  let code;
  if (timedOut) code = `timeout after ${TIMEOUT_MS / 1000}s`;
  else if (result.status !== null && result.status !== undefined) code = String(result.status);
  else if (result.signal) code = result.signal;
  else code = 'unknown';
  const output = tail(`${result.stdout || ''}${result.stderr || ''}`.trim());
  const failures = state.failures + 1;

  if (failures >= MAX_FAILURES) {
    removeState(stateFile);
    const oneLine = check.command.replace(/\s+/g, ' ');
    // The whole value stays on one line, even when the directory name holds a line break.
    const message = (
      `verify-gate: ${MAX_FAILURES} failed runs of \`${oneLine}\` in ${check.dir} (last exit ${code}); ` +
      'no longer blocking this stop. Fix the check before relying on the result.'
    ).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
    process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
    if (output) process.stderr.write(`${output}\n`);
    return 0;
  }

  writeState(stateFile, { dirty: true, failures });
  process.stderr.write(
    `verification FAILED (exit ${code}) running .claude/verify.cmd in ${check.dir} ` +
    `(failure ${failures} of ${MAX_FAILURES}). Fix the problem before ending the turn.\n` +
    (output ? `${output}\n` : ''),
  );
  return 2;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (!input || typeof input !== 'object') return 0;
  // Without a session id there is no state to key on, so the gate does nothing.
  if (typeof input.session_id !== 'string' || input.session_id === '') return 0;
  const stateFile = sessionStateFile(input.session_id);
  switch (input.hook_event_name) {
    case 'PostToolUse':
      writeState(stateFile, { dirty: true, failures: 0 });
      return 0;
    case 'Stop':
      return onStop(input, stateFile);
    default:
      return 0;
  }
}

let code = 0;
try {
  code = main();
} catch {
  code = 0;
}
process.exitCode = code;
