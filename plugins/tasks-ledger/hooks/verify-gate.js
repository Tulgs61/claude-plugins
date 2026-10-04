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

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state && typeof state === 'object') {
      return { dirty: state.dirty === true, failures: Number.isInteger(state.failures) ? state.failures : 0 };
    }
  } catch {
    // Missing or corrupt state counts as clean.
  }
  return { dirty: false, failures: 0 };
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state));
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
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return stat.uid === uid && (stat.mode & 0o022) === 0;
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
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags);
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
  if (result.status === 0 && !result.error) {
    removeState(stateFile);
    return 0;
  }

  let code;
  if (result.error && result.error.code === 'ETIMEDOUT') code = `timeout after ${TIMEOUT_MS / 1000}s`;
  else if (result.status !== null && result.status !== undefined) code = String(result.status);
  else if (result.signal) code = result.signal;
  else code = result.error ? result.error.code || 'error' : 'unknown';
  const output = tail(`${result.stdout || ''}${result.stderr || ''}`.trim());
  const failures = state.failures + 1;

  if (failures >= MAX_FAILURES) {
    removeState(stateFile);
    const oneLine = check.command.replace(/\s+/g, ' ');
    const message =
      `verify-gate: ${MAX_FAILURES} failed runs of \`${oneLine}\` in ${check.dir} (last exit ${code}); ` +
      'no longer blocking this stop. Fix the check before relying on the result.';
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
