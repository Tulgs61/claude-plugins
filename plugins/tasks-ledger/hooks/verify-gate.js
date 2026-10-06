#!/usr/bin/env node
// PostToolUse + Stop + SubagentStop hook. After Claude has edited files, the turn cannot end while the
// project's .claude/verify.cmd fails, up to MAX_FAILURES runs; after that the gate only warns.
// - PostToolUse (Edit|Write|MultiEdit|NotebookEdit): marks the edited file's project dirty for the
//   session and resets its failure count.
// - Stop / SubagentStop: if the project of `cwd` is dirty, runs the nearest trusted .claude/verify.cmd
//   between cwd and its repository root.
// State is kept per session and project; a project is the nearest ancestor of the real path that
// contains .git (so a linked worktree is its own project), or the real path of the event's cwd.
// A check only runs after that exact command was approved for its repository and check directory with
// scripts/verify-consent.js; the gate itself never records consent.
// Exit 2 blocks (stderr goes to Claude), exit 0 allows. Fails open on any error.
// The check always follows the hook input's `cwd`; CLAUDE_PROJECT_DIR is ignored on purpose.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FAILURES = 3;
const TIMEOUT_MS = 3 * 60 * 1000;
// After the time limit (or the output limit) the check's process group gets SIGTERM, and SIGKILL when
// any member is still alive this much later. TIMEOUT_MS + GRACE_MS stays below the hook timeout.
const GRACE_MS = 5 * 1000;
const POLL_MS = 100;
const TAIL_CHARS = 4000;
// Bytes kept per stream; enough for TAIL_CHARS characters of any encoding.
const TAIL_BYTES = TAIL_CHARS * 4;
// The most output the hook accepts per stream; a check that produces more is ended and fails.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const VERIFY_REL = path.join('.claude', 'verify.cmd');
const POSIX = process.platform !== 'win32';

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CONSENT_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'verify-consent.js');

// The process group of the running check, ended when the hook fails open.
let runningGroup = null;

// Fail-open: any error not handled elsewhere, also one thrown in a timer or child-process callback and
// an unhandled 'error' event on a child's pipes or on stdout/stderr (for example EPIPE), ends the hook
// with exit 0 and no further output.
function failOpen() {
  if (runningGroup !== null) {
    try {
      if (POSIX) process.kill(-runningGroup, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  process.exit(0);
}
process.on('uncaughtException', failOpen);
process.on('unhandledRejection', failOpen);
process.stdout.on('error', failOpen);
process.stderr.on('error', failOpen);

// A number is used as its decimal string; a missing, null or empty id, or any other type, gives null.
function sessionKey(sessionId) {
  if (typeof sessionId === 'number') return String(sessionId);
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
  return null;
}

// The session id is sanitised and the project is hashed, so the state file always lies directly in
// the temp directory.
function stateFileFor(session, project) {
  const id = session.replace(/[^A-Za-z0-9_-]/g, '_');
  const p = crypto.createHash('sha256').update(project).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `claude-verify-${id}-${p}.json`);
}

const NOFOLLOW = (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

// A state file is only used when it is a regular file owned by the current user (POSIX).
function ownStateFile(stat) {
  if (!stat.isFile()) return false;
  return !POSIX || stat.uid === currentUid();
}

function clampFailures(n) {
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), MAX_FAILURES) : 0;
}

const CLEAN = { dirty: false, failures: 0, looseWarned: false, consentAsked: false };
const UNREADABLE = { dirty: true, failures: 0, looseWarned: false, consentAsked: false };

// The file is gone (or a path component is not a directory), possibly removed since it was inspected.
function missing(e) {
  return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
}

// Only a missing state file, or one rejected because it is not a regular file (symbolic links and
// other non-regular files are never followed or opened) or belongs to another user, counts as clean.
// Any other failure to read our own state file, or content that cannot be parsed, counts as dirty
// with 0 failures, never as clean.
function readState(file) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch (e) {
    return missing(e) ? CLEAN : UNREADABLE;
  }
  if (!ownStateFile(before)) return CLEAN;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    // Replaced by a symbolic link since it was inspected: not followed.
    return missing(e) || e.code === 'ELOOP' ? CLEAN : UNREADABLE;
  }
  try {
    if (!ownStateFile(fs.fstatSync(fd))) return CLEAN;
    const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return UNREADABLE;
    return {
      dirty: state.dirty === true,
      failures: clampFailures(state.failures),
      looseWarned: state.looseWarned === true,
      consentAsked: state.consentAsked === true,
    };
  } catch {
    return UNREADABLE;
  } finally {
    fs.closeSync(fd);
  }
}

// Atomic: writes a new file in the same directory, created exclusively with a random suffix and
// without following links, and renames it over the state file. An interrupted write never leaves an
// empty or partial state file behind.
function writeState(file, state) {
  const data = { dirty: state.dirty, failures: clampFailures(state.failures) };
  if (state.looseWarned) data.looseWarned = true;
  if (state.consentAsked) data.consentAsked = true;
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  let done = false;
  try {
    try {
      fs.writeSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    done = true;
  } finally {
    if (!done) removeState(tmp);
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

function eventCwd(input) {
  return typeof input.cwd === 'string' && input.cwd ? path.resolve(input.cwd) : process.cwd();
}

// The real path of `p`. When `p` does not exist yet, the real path of its nearest existing ancestor
// with the rest appended.
function realPathOf(p) {
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(p), ...rest);
    } catch {
      // Not there (yet); resolve the parent.
    }
    const parent = path.dirname(p);
    if (parent === p) return path.join(p, ...rest);
    rest.unshift(path.basename(p));
    p = parent;
  }
}

// The project of an event, from real paths only, so that every symlinked spelling reaches the same
// state: the nearest ancestor of `start` with a .git entry, or the event's cwd.
function projectOf(start, cwd) {
  return findGitRoot(realPathOf(start)) ?? realPathOf(cwd);
}

// An edit belongs to the project of the edited file; without a path, to the project of cwd.
function editProject(input, cwd) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const file = [ti.file_path, ti.notebook_path].find(p => typeof p === 'string' && p !== '');
  return projectOf(file === undefined ? cwd : path.dirname(path.resolve(cwd, file)), cwd);
}

// A trusted check file is a regular file; on POSIX it is also owned by the current user and not
// writable by group or others.
function isTrusted(stat) {
  if (!stat.isFile()) return false;
  if (!POSIX) return true;
  return stat.uid === currentUid() && (stat.mode & 0o022) === 0;
}

// A regular file of our own that is only rejected for being group- or world-writable.
function isLoose(stat) {
  return POSIX && stat.isFile() && stat.uid === currentUid() && (stat.mode & 0o022) !== 0;
}

// Reads `file` only if it is trusted. Non-regular files are never opened, and the opened descriptor
// is re-checked against the inspected file, so the file that is checked is the file that is read.
// Returns { content }, { loose: true } for an own file with loose permissions, or null.
function readTrusted(file) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!isTrusted(before)) return isLoose(before) ? { loose: true } : null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !isTrusted(opened)) return null;
    return { content: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

// The nearest trusted .claude/verify.cmd between `cwd` and its repository root inclusive, or only
// <cwd>/.claude/verify.cmd outside a repository. Untrusted files count as absent; when none is
// trusted, the nearest loose-permission file is reported as { loose }.
function findCheck(cwd) {
  const root = findGitRoot(cwd);
  let loose = null;
  let dir = cwd;
  for (;;) {
    const file = path.join(dir, VERIFY_REL);
    const found = readTrusted(file);
    if (found && found.content !== undefined) return { dir, command: found.content.trim() };
    if (found && found.loose && loose === null) loose = file;
    if (root === null || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return loose === null ? null : { loose };
}

function tail(text) {
  return text.length > TAIL_CHARS ? `...${text.slice(-TAIL_CHARS)}` : text;
}

// Collects the last TAIL_BYTES bytes of a stream and counts the total.
function collector() {
  let kept = Buffer.alloc(0);
  return {
    total: 0,
    add(chunk) {
      this.total += chunk.length;
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > TAIL_BYTES) kept = kept.subarray(kept.length - TAIL_BYTES);
    },
    text() {
      return kept.toString('utf8');
    },
  };
}

// Runs the check with bash in its own process group (detached on POSIX). bash is started by its absolute
// path (`bash`); the working directory is the check's directory, as the contract requires. On the time limit or the
// output limit the whole group gets SIGTERM, then SIGKILL after GRACE_MS if any member is still
// alive. On Windows only the direct child is ended.
// Resolves to { started: false } when no process was created, otherwise to
// { started: true, status, signal, reason, output } with reason 'timeout', 'overflow' or null.
function startVerifyCommand(bash, command, cwd) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bash, ['-c', command], { cwd, detached: POSIX, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ started: false });
      return;
    }
    if (child.pid > 0) runningGroup = child.pid;
    const out = collector();
    const err = collector();
    let reason = null;
    let closed = null;
    let killed = false;
    const timers = [];
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      runningGroup = null;
      for (const t of timers) clearTimeout(t);
      resolve(result);
    };
    const signalGroup = sig => {
      try {
        if (POSIX) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    const groupAlive = () => {
      if (!POSIX) return closed === null;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    };
    const result = () => ({
      started: true,
      status: closed.status,
      signal: closed.signal,
      reason,
      output: tail(`${out.text()}${err.text()}`.trim()),
    });
    // After the group was told to end, the run is over once the check has closed and no member is
    // left, or once SIGKILL has been sent.
    const settleIfDone = () => {
      if (closed !== null && (killed || !groupAlive())) finish(result());
    };
    const end = why => {
      if (reason !== null) return;
      reason = why;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => {
        if (groupAlive()) signalGroup('SIGKILL');
        killed = true;
        settleIfDone();
        if (settled) return;
        // A process that left the group may still hold the pipes open; stop waiting for them.
        timers.push(setTimeout(() => {
          if (closed !== null) return;
          child.stdout.destroy();
          child.stderr.destroy();
          closed = { status: child.exitCode, signal: child.signalCode };
          finish(result());
        }, GRACE_MS));
      }, GRACE_MS));
      timers.push(setInterval(settleIfDone, POLL_MS));
    };

    child.on('error', () => {
      if (!(child.pid > 0)) finish({ started: false });
    });
    child.stdout.on('data', chunk => {
      out.add(chunk);
      if (out.total > MAX_OUTPUT_BYTES) end('overflow');
    });
    child.stderr.on('data', chunk => {
      err.add(chunk);
      if (err.total > MAX_OUTPUT_BYTES) end('overflow');
    });
    child.on('close', (status, signal) => {
      if (!(child.pid > 0)) {
        finish({ started: false });
        return;
      }
      closed = { status, signal };
      if (reason === null) finish(result());
      else settleIfDone();
    });
    timers.push(setTimeout(() => end('timeout'), TIMEOUT_MS));
  });
}

// Single quotes, with each embedded single quote written as '\''.
function shellQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// A backslash that some shells (fish) read as an escape inside single quotes once the path is quoted: one
// before another backslash or a single quote, or at the end, where it meets the closing quote.
const QUOTED_BACKSLASH = /\\(?=[\\']|$)/;

// The request to approve the check in `dir`. The approve command is copy-safe: it pins the store the gate
// reads by setting the store variables explicitly (the one that chose the store with its value, each
// higher-priority one empty; for the ~/.claude default, CLAUDE_CONFIG_DIR is the absolute <home>/.claude this
// process resolved), so it records into that store whatever the terminal exports and whatever its HOME is. A
// store whose location is not an absolute path is unavailable and gets no command.
// Every path in it is shell-quoted, so pasting it into a POSIX shell runs nothing but node on the consent
// script. A path with control characters, or (outside Windows) with a backslash that shells quote
// differently (QUOTED_BACKSLASH), is not offered as a command at all, and the request names which path it is.
function approvalRequest(dir) {
  const consent = require(CONSENT_SCRIPT);
  const text = `verify-gate: ${consent.shownPath(path.join(dir, VERIFY_REL))} was not run because this command ` +
    'is not approved for this repository. ';
  const store = consent.storeSelection();
  // A store whose location is not an absolute path is unavailable, and no command can pin it.
  if (store.file === null) {
    return `${text}${store.unavailable[0].toUpperCase()}${store.unavailable.slice(1)} and no approve command is offered; ` +
      'set it to an absolute path, then approve the check with scripts/verify-consent.js in a terminal.';
  }
  const paths = [
    ['the plugin directory', PLUGIN_ROOT, CONSENT_SCRIPT],
    ['the consent store', store.file, store.value],
    ['the repository directory', dir, dir],
  ];
  const naming = bad => {
    const named = bad.map(([what, shown]) => `${what} (${consent.shownPath(shown)})`);
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  };
  // Control characters as the consent script defines them, so both refuse the same paths.
  const control = paths.filter(([, , p]) => consent.CONTROL_CHARS.test(p));
  if (control.length > 0) {
    return `${text}The path of ${naming(control)} contains control characters, so no approve command is offered; ` +
      'move or rename it, then approve the check with scripts/verify-consent.js in a terminal.';
  }
  const backslash = POSIX ? paths.filter(([, , p]) => QUOTED_BACKSLASH.test(p)) : [];
  if (backslash.length > 0) {
    return `${text}The path of ${naming(backslash)} contains a backslash, which shells quote differently, so no ` +
      'approve command is offered; move or rename it, then approve the check with scripts/verify-consent.js in a terminal.';
  }
  const assign = store.name === 'CLAUDE_PLUGIN_DATA'
    ? `CLAUDE_PLUGIN_DATA=${shellQuote(store.value)} `
    : `CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR=${shellQuote(store.value)} `;
  const shell = POSIX ? ', in a POSIX shell such as bash or zsh' : '';
  return `${text}To approve it, run this yourself${shell} in a terminal (it must be run in a terminal): ` +
    `${assign}node ${shellQuote(CONSENT_SCRIPT)} approve ${shellQuote(dir)}`;
}

// One line of compact JSON whose only key is systemMessage; the value never holds a line break.
function systemMessage(text) {
  const message = text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

async function onStop(input, session) {
  if (input.stop_hook_active === true) return 0;
  const cwd = eventCwd(input);
  const stateFile = stateFileFor(session, projectOf(cwd, cwd));
  const state = readState(stateFile);
  if (!state.dirty) return 0;
  const check = findCheck(cwd);
  if (!check) return 0;

  // A group- or world-writable check file is not run. The first such stop per session and project
  // says so; the session stays dirty.
  if (check.loose) {
    if (!state.looseWarned) {
      systemMessage(
        `verify-gate: skipped ${check.loose} because it is group- or world-writable, so .claude/verify.cmd ` +
        `was not run. Run \`chmod 644 ${shellQuote(check.loose)}\` to use it.`,
      );
      writeState(stateFile, { ...state, looseWarned: true });
    }
    return 0;
  }

  // A check runs only after this exact command was approved for this repository and the directory that
  // holds it (relative to the checkout's top level). Otherwise the stop
  // passes and the session stays dirty; the first such stop per session and project asks for approval.
  const consent = require(CONSENT_SCRIPT);
  if (!consent.isApproved(check.dir, check.command)) {
    if (!state.consentAsked) {
      systemMessage(approvalRequest(check.dir));
      writeState(stateFile, { ...state, consentAsked: true });
    }
    return 0;
  }

  // bash is never taken from the repository: it is searched on PATH, skipping empty and relative entries
  // and the repository's own directories. Without one, the check could not start.
  const bash = consent.findProgram('bash', consent.untrustedDirs(check.dir));
  const result = bash === null ? { started: false } : await startVerifyCommand(bash, check.command, check.dir);
  // The check could not be started at all (no process was created): let the stop through and leave
  // the state as it was. Any other outcome belongs to a started check.
  if (!result.started) return 0;
  if (result.status === 0 && result.reason === null) {
    removeState(stateFile);
    return 0;
  }

  let code;
  if (result.reason === 'timeout') code = `timeout after ${TIMEOUT_MS / 1000}s`;
  else if (result.reason === 'overflow') code = 'output limit exceeded';
  else if (result.status !== null && result.status !== undefined) code = String(result.status);
  else if (result.signal) code = result.signal;
  else code = 'unknown';
  const output = result.output;
  const failures = state.failures + 1;

  if (failures >= MAX_FAILURES) {
    removeState(stateFile);
    const oneLine = check.command.replace(/\s+/g, ' ');
    // The whole value stays on one line, even when the directory name holds a line break.
    systemMessage(
      `verify-gate: ${MAX_FAILURES} failed runs of \`${oneLine}\` in ${check.dir} (last exit ${code}); ` +
      'no longer blocking this stop. Fix the check before relying on the result.',
    );
    if (output) process.stderr.write(`${output}\n`);
    return 0;
  }

  writeState(stateFile, { ...state, dirty: true, failures });
  process.stderr.write(
    `verification FAILED (exit ${code}) running .claude/verify.cmd in ${check.dir} ` +
    `(failure ${failures} of ${MAX_FAILURES}). Fix the problem before ending the turn.\n` +
    (output ? `${output}\n` : ''),
  );
  return 2;
}

function onEdit(input, session) {
  const cwd = eventCwd(input);
  const stateFile = stateFileFor(session, editProject(input, cwd));
  const { looseWarned, consentAsked } = readState(stateFile);
  writeState(stateFile, { dirty: true, failures: 0, looseWarned, consentAsked });
  return 0;
}

async function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (!input || typeof input !== 'object') return 0;
  // Without a usable session id there is no state to key on, so the gate does nothing.
  const session = sessionKey(input.session_id);
  if (session === null) return 0;
  switch (input.hook_event_name) {
    case 'PostToolUse':
      return onEdit(input, session);
    case 'Stop':
    case 'SubagentStop':
      return onStop(input, session);
    default:
      return 0;
  }
}

main().then(
  code => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 0;
  },
);
