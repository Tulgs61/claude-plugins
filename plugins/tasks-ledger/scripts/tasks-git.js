#!/usr/bin/env node
// tasks-git: every repository, worktree and ledger mutation of a tasks run.
// Usage: node tasks-git.js <command> <ledger> [args...]
// Prints exactly one JSON line and exits 0, failures included.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_KEYS = [
  'acceptance', 'base', 'branch', 'budget', 'constraints', 'dependsOn', 'evidence',
  'files', 'id', 'needsAcceptance', 'pr', 'proof', 'status', 'title', 'worktree',
];
const LISTING_LISTS = ['constraints', 'dependsOn', 'files'];
const LISTING_SCALARS = ['acceptance', 'base', 'branch', 'budget', 'id', 'pr', 'proof', 'status', 'title', 'worktree'];
const ID_RE = /^T[0-9]+$/;
const INBOX_ID_RE = /^T[0-9]{1,9}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{4,64}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const AGENT_ROLES = ['implementer', 'reviewer'];
const SETTABLE = ['blocked', 'done', 'in_progress', 'todo', 'verified'];
const RUN_STATUSES = ['finished', 'running', 'stopped'];
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const GUARD_ABANDON_MS = 10 * 60 * 1000;
const GUARD_WAIT_MAX_MS = 30 * 1000;
const TAKEOVER_SETTLE_MS = 1500;
const DEFAULT_CHECK_TIMEOUT_MIN = 30;
const EVIDENCE_MAX = 4000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const OPEN_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const OPEN_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const TAIL_MAX = 2000;
const PERMANENT_BRANCHES = ['main', 'master', 'develop', 'trunk'];

// BEGIN glob-overlap
// Conservative overlap test for `files` globs. Each pattern is reduced to its literal prefix (the
// segments before the first one holding a glob character); two patterns are disjoint only when
// those prefixes disagree at a position where both have a segment. A false "overlap" is
// acceptable, a false "disjoint" is not. A pattern holding `..` anywhere overlaps everything.
function globLiteralPrefix(pattern) {
  const text = String(pattern == null ? '' : pattern)
    .toLowerCase()
    .replace(/\\/g, '/');
  if (text.includes('..')) return null;
  const segments = text.split('/').filter(s => s !== '' && s !== '.');
  const prefix = [];
  for (const s of segments) {
    if (/[*?[\]{}()]/.test(s) || s.startsWith('!')) break;
    prefix.push(s);
  }
  return prefix;
}

function globsOverlap(a, b) {
  const pa = globLiteralPrefix(a);
  const pb = globLiteralPrefix(b);
  if (pa === null || pb === null) return true;
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function globListsOverlap(as, bs) {
  if (!Array.isArray(as) || !Array.isArray(bs)) return false;
  return as.some(a => bs.some(b => globsOverlap(a, b)));
}
// END glob-overlap

// ---- answers -----------------------------------------------------------------------------------

class Failure extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

const fail = (message, extra) => {
  throw new Failure(message, extra);
};

function tail(text) {
  const s = String(text || '').trimEnd();
  return s.length > TAIL_MAX ? s.slice(-TAIL_MAX) : s;
}

// ---- processes ---------------------------------------------------------------------------------

function run(program, args, cwd, opts = {}) {
  const r = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

// Runs git and returns trimmed stdout, failing with git's stderr otherwise.
function gitOk(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || String(r.error || '')).trim()}`);
  return r.stdout.trim();
}

function refExists(cwd, ref) {
  return git(cwd, 'rev-parse', '--verify', '--quiet', ref).status === 0;
}

function hasBranch(cwd, branch) {
  return refExists(cwd, `refs/heads/${branch}`);
}

function exitCode(r) {
  if (r.status !== null && r.status !== undefined) return r.status;
  if (r.error && r.error.code === 'ETIMEDOUT') return 'timeout';
  return r.signal ? `signal ${r.signal}` : 'unknown';
}

// Runs a shell check in bash inside `cwd`.
function shellCheck(L, command, cwd) {
  const minutes = Number(L.checkTimeoutMin) > 0 ? Number(L.checkTimeoutMin) : DEFAULT_CHECK_TIMEOUT_MIN;
  const r = run('bash', ['-c', command], cwd, { timeout: Math.max(1, Math.round(minutes * 60 * 1000)) });
  const output = r.stdout + r.stderr + (r.error && r.error.code === 'ETIMEDOUT' ? `\n(timed out after ${minutes} min)` : '');
  return { ok: r.status === 0, code: exitCode(r), tail: tail(output) };
}

// Parses `git worktree list --porcelain` into [{ path, branch }].
function worktrees(root) {
  const out = gitOk(root, 'worktree', 'list', '--porcelain');
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      list.push(cur);
    } else if (cur && line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return list;
}

function worktreeOfBranch(root, branch) {
  const w = worktrees(root).find(x => x.branch === branch && fs.existsSync(x.path));
  return w ? w.path : null;
}

// ---- ledger ------------------------------------------------------------------------------------

// A failed write removes its temporary file before it fails, so none is left behind.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The original error is what the caller needs to see.
    }
    throw e;
  }
}

// Writes ctx.L and returns the text written.
function persistLedger(ctx) {
  const text = JSON.stringify(ctx.L, null, 2) + '\n';
  writeAtomic(ctx.ledgerFile, text);
  return text;
}

// Checks what lstat or fstat reports for a ledger, lock or inbox file: a regular file of at most
// MAX_FILE_BYTES that, with `own`, belongs to this user.
function checkFileStat(st, file, what, own) {
  if (st.isSymbolicLink()) fail(`${what} ${file} is a symbolic link; refusing it`);
  if (!st.isFile()) fail(`${what} ${file} is not a regular file; refusing it`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (own && uid !== null && st.uid !== uid) fail(`${what} ${file} is owned by uid ${st.uid}, not by this user (uid ${uid}); refusing it`);
  if (st.size > MAX_FILE_BYTES) fail(`${what} ${file} is larger than ${MAX_FILE_BYTES} bytes; refusing it`);
}

// Reads a ledger, lock or inbox file through one open file: it is opened without following a
// symlink and without blocking on a FIFO, its type, owner (with `own`) and size are checked on the
// open file, and the content is read from it, so a swap between check and read changes nothing.
// Returns { content, st } with the checked stat, or null when the file does not exist. When the open
// fails with a permission error, the path is examined without following links: another user's file
// or one that is no regular file is refused as unsafe, and an own regular file gives the open error.
// Other open and read errors are thrown as they are.
function openCheckedFile(file, what, { own = true, encoding } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    if (errCode(e) === 'ELOOP' || errCode(e) === 'EMLINK') fail(`${what} ${file} is a symbolic link; refusing it`);
    if (errCode(e) === 'EACCES' || errCode(e) === 'EPERM') {
      const st = lstatOrNull(file);
      if (st) checkFileStat(st, file, what, true);
    }
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    checkFileStat(st, file, what, own);
    return { content: fs.readFileSync(fd, encoding), st };
  } finally {
    fs.closeSync(fd);
  }
}

function readCheckedFile(file, what, opts) {
  const r = openCheckedFile(file, what, opts);
  return r === null ? null : r.content;
}

// Reads and validates the ledger. `ledgerBytes` are the raw bytes, so a restore writes back exactly
// what was read.
function readLedgerFile(ledgerFile) {
  let L;
  let ledgerBytes;
  try {
    ledgerBytes = readCheckedFile(ledgerFile, 'ledger');
    if (ledgerBytes === null) fail(`cannot read ledger ${ledgerFile}: no such file`);
    L = JSON.parse(ledgerBytes.toString('utf8'));
  } catch (e) {
    if (e instanceof Failure) throw e;
    fail(`cannot read ledger ${ledgerFile}: ${e.message}`);
  }
  validateLedger(L);
  return { L, ledgerBytes };
}

// Re-reads the ledger, applies `change` to that fresh copy and writes it. The caller holds the lock
// guard, so no write undoes a change another command made in between. Returns what `change` returns.
function updateLedgerGuarded(ctx, change) {
  Object.assign(ctx, readLedgerFile(ctx.ledgerFile));
  const result = change(ctx.L);
  persistLedger(ctx);
  return result;
}

const updateLedger = (ctx, change) => withLockGuard(ctx, () => updateLedgerGuarded(ctx, change));

// The ledger's run-level agent overrides, or null when it has none.
function agentsOf(L) {
  if (L.agents === undefined || L.agents === null) return null;
  const a = L.agents;
  const valid = a && typeof a === 'object' && !Array.isArray(a)
    && Object.keys(a).every(k => AGENT_ROLES.includes(k) && typeof a[k] === 'string' && AGENT_NAME_RE.test(a[k]));
  if (!valid) fail(`invalid agents in the ledger: expected an object with optional ${AGENT_ROLES.join(' and ')} matching ${AGENT_NAME_RE}`);
  return a;
}

function validateLedger(L) {
  if (!L || typeof L !== 'object' || Array.isArray(L)) fail('cannot read ledger: not a JSON object');
  if (L.tasks === undefined) L.tasks = [];
  if (!Array.isArray(L.tasks)) fail('cannot read ledger: tasks is not an array');
  if (typeof L.topic !== 'string' || !TOPIC_RE.test(L.topic)) fail(`unsafe ledger topic ${JSON.stringify(L.topic)}: must match ${TOPIC_RE}`);
  if (L.baseBranch === undefined || L.baseBranch === null) L.baseBranch = 'main';
  if (typeof L.baseBranch !== 'string' || L.baseBranch === '' || L.baseBranch.startsWith('-') || /[\s:]/.test(L.baseBranch)) {
    fail(`unsafe ledger baseBranch ${JSON.stringify(L.baseBranch)}`);
  }
  for (const t of L.tasks) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID_RE.test(t.id)) {
      fail(`invalid task id ${t && typeof t === 'object' ? String(t.id) : String(t)}: unsafe for paths and git, must match ${ID_RE}`);
    }
    if (t.dependsOn !== undefined && t.dependsOn !== null) {
      if (!Array.isArray(t.dependsOn)) fail(`unsafe dependsOn of ${t.id}: not an array`);
      for (const d of t.dependsOn) {
        if (typeof d !== 'string' || !ID_RE.test(d)) fail(`unsafe prerequisite ${JSON.stringify(d)} of ${t.id}: must match ${ID_RE}`);
      }
    }
  }
}

function listing(L) {
  return L.tasks.map(t => {
    const o = {};
    for (const k of LISTING_LISTS) o[k] = Array.isArray(t[k]) ? t[k] : [];
    for (const k of LISTING_SCALARS) o[k] = t[k] === undefined ? null : t[k];
    o.needsAcceptance = t.needsAcceptance === true;
    return o;
  });
}

function findTask(ctx, id) {
  const t = ctx.L.tasks.find(x => x.id === id);
  if (!t) fail(`no task ${id}`);
  return t;
}

const depsOf = t => (Array.isArray(t.dependsOn) ? t.dependsOn : []);

// ---- names -------------------------------------------------------------------------------------

const integrationBranchName = ctx => `task/${ctx.L.topic}/integration`;
const integrationPath = ctx => path.join(ctx.root, '.claude', 'worktrees', `${ctx.L.topic}-integration`);
const taskBranch = (ctx, id) => `task/${ctx.L.topic}/${id}`;
const taskPath = (ctx, id) => path.join(ctx.root, '.claude', 'worktrees', `${ctx.L.topic}-${id}`);
const combinedBase = (ctx, id) => `task/${ctx.L.topic}/${id}-base`;

// The base a task branches from: baseBranch, its one prerequisite's branch, or its -base branch.
function baseOf(ctx, t) {
  const deps = depsOf(t);
  if (deps.length === 0) return ctx.L.baseBranch;
  if (deps.length === 1) return taskBranch(ctx, deps[0]);
  return combinedBase(ctx, t.id);
}

function resolveStartRef(ctx) {
  const remote = `origin/${ctx.L.baseBranch}`;
  return refExists(ctx.root, `refs/remotes/${remote}`) ? remote : ctx.L.baseBranch;
}

// The ref commits are counted from: the start ref for baseBranch, otherwise the base branch.
function baseRefOf(ctx, t) {
  const base = baseOf(ctx, t);
  return base === ctx.L.baseBranch ? resolveStartRef(ctx) : base;
}

// ---- lock --------------------------------------------------------------------------------------

// The lock file as { bytes, text, unreadable, unsafe }: `bytes` and `text` are null when there is no
// lock or it cannot be read; `unreadable` says why a lock file that exists cannot be read; `unsafe`
// marks a lock that is no regular file of this user and is never read or replaced.
function lockState(ctx) {
  try {
    const bytes = readCheckedFile(ctx.lockFile, 'lock');
    return { bytes, text: bytes === null ? null : bytes.toString('utf8'), unreadable: null, unsafe: false };
  } catch (e) {
    return { bytes: null, text: null, unreadable: e.message, unsafe: e instanceof Failure };
  }
}

function readLockText(ctx) {
  const state = lockState(ctx);
  if (state.unsafe) fail(state.unreadable);
  return state.text;
}

function parseLock(text) {
  try {
    const lock = JSON.parse(text);
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

const readLock = ctx => {
  const text = readLockText(ctx);
  return text === null ? null : parseLock(text);
};

const isLiveForeign = (lock, runId) => lock && lock.runId !== runId && Date.now() - Number(lock.at) < LOCK_TTL_MS;

const lockedFailure = held => {
  const age = Math.round((Date.now() - Number(held.at)) / 60000);
  fail(`another run (${held.runId}, heartbeat ${age} min ago) holds this ledger; pass takeover to replace it`, { locked: true });
};

const errCode = e => e && e.code;

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let asideCount = 0;

// What identifies a guard judged abandoned: its text, or for a guard that cannot be read (text
// null) its file identity and time.
const sameGuard = (expected, text, st) =>
  expected.text !== null
    ? text === expected.text
    : text === null && st !== null && st.dev === expected.dev && st.ino === expected.ino && st.mtimeMs === expected.mtimeMs;

const readOrNull = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const lstatOrNull = file => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};

// Opens a guard file (the guard path, a guard moved aside, or a private guard file) without following
// a link and without blocking, and reads it only when the open file is a regular file. Returns null
// when nothing is there, otherwise { st, text, regular }: `text` is null when the file is no regular
// file (it is never read) or cannot be read; `st` is that of the open file, or of the path when it
// cannot be opened. For a regular file, `keep(st, text)` (when given) runs while the file is still open.
function openGuardFile(file, keep) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    const st = lstatOrNull(file);
    return st && { st, text: null, regular: st.isFile() };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { st, text: null, regular: false };
    const text = readOrNull(fd);
    if (keep) keep(st, text);
    return { st, text, regular: true };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Moves the guard aside under a name unique to this caller and removes it only when it is the
// `expected` guard. Any other guard is linked back when the guard path is still free and otherwise
// left where it is; it is never deleted. Something that is no regular file is never the expected
// guard: it is put back (a directory by renaming, while the guard path is free). Returns whether the
// expected guard was removed.
function removeGuardIf(guard, token, expected) {
  const aside = `${guard}.aside-${token}-${++asideCount}`;
  try {
    fs.renameSync(guard, aside);
  } catch {
    return false;
  }
  const moved = openGuardFile(aside);
  if (moved && moved.regular && sameGuard(expected, moved.text, moved.text === null ? moved.st : null)) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try {
    fs.linkSync(aside, guard);
  } catch {
    try {
      if (moved && moved.st.isDirectory() && lstatOrNull(guard) === null) fs.renameSync(aside, guard);
    } catch {
      // Left aside; it is never deleted.
    }
    return false;
  }
  // The guard is back under its own name; this drops only the second name.
  fs.rmSync(aside, { force: true });
  return false;
}

// The owner a guard names ({ token, pid, host, at }), or null for content in another form.
function guardOwner(text) {
  try {
    const g = JSON.parse(text);
    return g && typeof g === 'object' && typeof g.token === 'string' ? g : null;
  } catch {
    return null;
  }
}

// True only when asking for the process reports that no such process exists.
const processGone = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return errCode(e) === 'ESRCH';
  }
};

// A guard (or a private guard file) is abandoned when it is older than GUARD_ABANDON_MS, or when the
// process on this machine that it names no longer exists. Its age is that of the file, or the
// creation time it names when that is older and it names this machine. A guard that cannot be
// read, or names no owner, counts only by the age of its file; so does one naming another host.
function guardAbandoned(text, mtimeMs) {
  const now = Date.now();
  if (now - mtimeMs > GUARD_ABANDON_MS) return true;
  const owner = text ? guardOwner(text) : null;
  if (!owner || owner.host !== os.hostname()) return false;
  if (Number.isFinite(owner.at) && now - owner.at > GUARD_ABANDON_MS) return true;
  return processGone(owner.pid);
}

// Removes a guard left behind by a crashed caller. Its content and age are read from one open
// file, so what is recorded is the guard judged abandoned; a guard that replaced it in the meantime
// carries another token and survives. Something at the guard path that is no regular file (a FIFO,
// a directory, a socket, a link) is a guard held by an unknown owner: it is never read, moved or
// removed, so waiting for it ends with the guard-wait timeout.
function breakAbandonedGuard(guard, token) {
  const g = openGuardFile(guard);
  if (!g || !g.regular || !guardAbandoned(g.text, g.st.mtimeMs)) return;
  removeGuardIf(guard, token, { text: g.text, dev: g.st.dev, ino: g.st.ino, mtimeMs: g.st.mtimeMs });
}

// Removes private guard files (`<guard>-new-<token>`, the files linked to create a guard) left by
// callers that are gone or older than GUARD_ABANDON_MS. A live caller's file is kept.
function removeAbandonedPrivateFiles(guard) {
  const dir = path.dirname(guard);
  const prefix = `${path.basename(guard)}-new-`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    const g = openGuardFile(file);
    if (g && g.regular && guardAbandoned(g.text, g.st.mtimeMs)) fs.rmSync(file, { force: true });
  }
}

// Removes the guard only while it is the one this caller created: the token is confirmed on the
// open file, and the path must still name that same file. A guard carrying another token, or
// anything that is no regular file, is never removed.
function releaseGuard(guard, content) {
  openGuardFile(guard, (held, text) => {
    if (text !== content) return;
    const now = lstatOrNull(guard);
    if (now && now.dev === held.dev && now.ino === held.ino) fs.rmSync(guard, { force: true });
  });
}

// The system error code and message, with the code named once: `<code>: <message>`, the message as
// it is when it already starts with its code, or `error: <message>` when there is no code.
function systemError(e) {
  const code = errCode(e);
  const message = e && e.message !== undefined ? e.message : String(e);
  if (!code) return `error: ${message}`;
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
}

// A failure to take the guard at all (it cannot be created, or waiting for it ran out); it is marked
// so that callers can tell it apart from a failure inside the guarded step.
function guardUnavailable(message, extra) {
  const e = new Failure(message, extra);
  e.guardUnavailable = true;
  throw e;
}

// Hard links are named only when the link step itself failed; otherwise the system error is.
const cannotCreateGuard = (guard, e, linking) =>
  guardUnavailable(`cannot create guard ${guard}: ${systemError(e)}${linking ? '; the file system must support hard links' : ''}`);

// Runs fn while holding the lock guard `<lock>.guard`, so that at most one caller at a time reads,
// judges and writes the run lock and the ledger. The guard's content (token, owner pid, host,
// creation time) is written to a private file first, which is then linked to the guard path; the
// link fails while a guard exists, and a guard never exists without its token.
function withLockGuard(ctx, fn) {
  const guard = `${ctx.lockFile}.guard`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const content = JSON.stringify({ token, pid: process.pid, host: os.hostname(), at: Date.now() }) + '\n';
  const fresh = `${guard}-new-${token}`;
  const deadline = Date.now() + GUARD_WAIT_MAX_MS;
  try {
    fs.writeFileSync(fresh, content, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    cannotCreateGuard(guard, e, false);
  }
  try {
    let waited = false;
    for (;;) {
      try {
        fs.linkSync(fresh, guard);
        break;
      } catch (e) {
        if (errCode(e) !== 'EEXIST') cannotCreateGuard(guard, e, true);
      }
      if (!waited) {
        waited = true;
        removeAbandonedPrivateFiles(guard);
      }
      breakAbandonedGuard(guard, token);
      if (Date.now() > deadline) {
        guardUnavailable(`another run (unknown, holding the lock guard ${guard}) is using the run lock of this ledger; try again`, { locked: true });
      }
      sleepMs(5 + Math.floor(Math.random() * 20));
    }
  } finally {
    fs.rmSync(fresh, { force: true });
  }
  try {
    return fn();
  } finally {
    releaseGuard(guard, content);
  }
}

const processAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
};

// Takes the lock under the guard. A live foreign lock is refused unless `takeover` is given.
// `takeover` replaces the lock of a run, not one a concurrent prepare has just taken: it refuses a
// lock whose prepare is still running and, without `heldRunId`, a lock written since this call
// started. A lock file that exists but cannot be read or parsed counts as held by an unknown live
// run: only a bare `takeover` replaces it, and a lock that is no regular file of this user is never
// replaced. With `heldRunId`, a lock of another run that does not name `heldRunId` is refused.
// Returns { previous, backup, written, tookOver }: the lock bytes before the call (null when there
// were none or they could not be read), the name the unreadable lock was moved aside to, the text
// this call wrote, and whether it replaced a live foreign lock; the written lock is marked
// `preparing` until settleLock.
function acquireLock(ctx, runId, takeover, heldRunId) {
  return withLockGuard(ctx, () => {
    const state = lockState(ctx);
    const previous = state.bytes;
    const held = state.text === null ? null : parseLock(state.text);
    const unknown = state.unreadable !== null || (state.text !== null && held === null);
    if (unknown && (state.unsafe || !takeover || heldRunId !== undefined)) {
      const why = state.unreadable !== null ? state.unreadable : `lock ${ctx.lockFile} cannot be parsed`;
      const replace = heldRunId === undefined ? 'only a bare takeover replaces a lock that cannot be read' : `a takeover of ${heldRunId} does not replace it`;
      fail(`another run (unknown, ${why}) may hold this ledger; ${state.unsafe ? 'it is never replaced' : replace}`, { locked: true });
    }
    if (heldRunId !== undefined && held && held.runId !== runId && held.runId !== heldRunId) lockedFailure(held);
    const tookOver = Boolean(isLiveForeign(held, runId));
    if (tookOver) {
      const at = Number(held.at);
      const sinceStart = heldRunId === undefined && at >= ctx.startedAt && at <= Date.now();
      const preparing = held.preparing === true && processAlive(held.pid);
      if (!takeover || sinceStart || preparing) lockedFailure(held);
    }
    // A lock whose bytes cannot be read is moved aside whole, so a failed prepare can put it back.
    let backup = null;
    if (unknown && previous === null) {
      backup = `${ctx.lockFile}.replaced-${process.pid}-${Date.now()}`;
      fs.renameSync(ctx.lockFile, backup);
    }
    const at = Date.now();
    const written = JSON.stringify({ runId, at, pid: process.pid, preparing: true }) + '\n';
    try {
      writeAtomic(ctx.lockFile, written);
    } catch (e) {
      // Still under the guard: the moved lock goes back, but never over something at the lock path.
      if (backup === null) throw e;
      if (lstatOrNull(ctx.lockFile) !== null) {
        fail(`cannot write the lock ${ctx.lockFile}: ${systemError(e)}; something is at the lock path, so the previous lock is kept at ${backup}`);
      }
      try {
        fs.renameSync(backup, ctx.lockFile);
      } catch (renameError) {
        if (e && typeof e === 'object') e.message = `${e.message}${cannotPutBack(renameError, backup)}`;
      }
      throw e;
    }
    return { previous, backup, written, runId, at, tookOver };
  });
}

// What follows the original error when the moved-aside lock could not be renamed back: the rename
// error and where the previous lock is kept.
const cannotPutBack = (renameError, backup) =>
  `; cannot put back the previous lock: ${systemError(renameError)}; the previous lock is kept at ${backup}`;

// Drops the `preparing` mark once prepare has succeeded, unless another call has replaced the lock.
// The moved-aside lock is removed even when the guard cannot be taken: it is private to this call.
function settleLock(ctx, { backup, written, runId, at }) {
  try {
    withLockGuard(ctx, () => {
      if (readLockText(ctx) === written) writeAtomic(ctx.lockFile, JSON.stringify({ runId, at }) + '\n');
    });
  } finally {
    if (backup !== null) fs.rmSync(backup, { force: true });
  }
}

// Puts back the exact lock that was there before acquireLock, unless the lock path no longer holds
// this call's text (another call replaced it, or it is now a link, a FIFO, another user's file or too
// large to read); the lock path is left as it is then, and the moved-aside lock is removed.
function restoreLock(ctx, { previous, backup, written }) {
  withLockGuard(ctx, () => {
    if (lockState(ctx).text !== written) {
      if (backup !== null) fs.rmSync(backup, { force: true });
      return;
    }
    if (backup !== null) fs.renameSync(backup, ctx.lockFile);
    else if (previous === null) fs.rmSync(ctx.lockFile, { force: true });
    else writeAtomic(ctx.lockFile, previous);
  });
}

// Applies `change` to the freshly read ledger and removes the lock, all under the guard. Before
// anything is written, the lock path must be absent or a regular file of this user. With a runId, a
// live lock of another run, or a lock that cannot be read, fails the call before anything is
// written, and only a lock naming that run is removed. A lock that is read but cannot be parsed
// names no run, so it is left in place (as kept tests pin).
function finishUnderLock(ctx, runId, change) {
  withLockGuard(ctx, () => {
    const st = lstatOrNull(ctx.lockFile);
    if (st) checkFileStat(st, ctx.lockFile, 'lock', true);
    let lock = null;
    if (runId !== undefined) {
      const state = lockState(ctx);
      if (state.unsafe) fail(state.unreadable);
      if (state.unreadable !== null) {
        fail(`another run (unknown, ${state.unreadable}) may hold this ledger; finish of ${runId} changed nothing (locked: true)`, { locked: true });
      }
      lock = state.text === null ? null : parseLock(state.text);
    }
    if (runId !== undefined && isLiveForeign(lock, runId)) {
      const age = Math.round((Date.now() - Number(lock.at)) / 60000);
      fail(`another run (${lock.runId}, heartbeat ${age} min ago) holds this ledger; finish of ${runId} changed nothing (locked: true)`, { locked: true });
    }
    updateLedgerGuarded(ctx, change);
    if (runId === undefined || (lock && lock.runId === runId)) fs.rmSync(ctx.lockFile, { force: true });
  });
}

// Sets the lock's `at` to now, keeping its runId, but only while the lock names `runId`. Without a
// runId nothing is refreshed. The caller holds the guard.
function refreshLockGuarded(ctx, runId) {
  if (runId === undefined) return;
  const lock = readLock(ctx);
  if (!lock || lock.runId !== runId) return;
  writeAtomic(ctx.lockFile, JSON.stringify({ ...lock, at: Date.now() }) + '\n');
}

// ---- inbox -------------------------------------------------------------------------------------

// Reads the inbox and appends its valid entries to ctx.L.tasks. Returns the added ids and a
// `consume(written)` function that renames the inbox once the caller has saved the ledger as the
// text `written`. Callers hold the lock guard from reading the ledger to consuming the inbox.
function ingestInbox(ctx) {
  // Anyone who can write the inbox may have written it, so its owner is not checked; a FIFO or a
  // symlink is still refused.
  const read = openCheckedFile(ctx.inboxFile, 'inbox', { own: false, encoding: 'utf8' });
  if (read === null) return { added: [], consume: () => [] };
  const text = read.content;
  const taken = new Set(ctx.L.tasks.map(t => t.id));
  // BigInt keeps every generated id of the form T<n> and every increment effective, however long
  // the ledger's ids are, so the loop below always terminates.
  let next = 0n;
  for (const id of taken) {
    const n = BigInt(id.slice(1));
    if (n > next) next = n;
  }
  const added = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (typeof o.title !== 'string' || o.title === '') continue;

    const stored = {};
    for (const k of TASK_KEYS) if (Object.prototype.hasOwnProperty.call(o, k)) stored[k] = o[k];
    // A line without an acceptance is kept, marked so that the engine does not start it; the
    // inbox itself never sets the mark.
    delete stored.needsAcceptance;
    if (typeof o.acceptance !== 'string' || o.acceptance.trim() === '') {
      stored.acceptance = '';
      stored.needsAcceptance = true;
    }
    let id = typeof o.id === 'string' && INBOX_ID_RE.test(o.id) && !taken.has(o.id) ? o.id : null;
    if (!id) {
      do next++;
      while (taken.has(`T${next}`));
      id = `T${next}`;
    }
    taken.add(id);
    stored.id = id;
    stored.files = Array.isArray(o.files) ? o.files.map(String) : o.files == null ? [] : [String(o.files)];
    stored.dependsOn = Array.isArray(o.dependsOn) ? o.dependsOn.filter(d => typeof d === 'string' && ID_RE.test(d)) : [];
    stored.status = 'todo';
    for (const k of ['branch', 'base', 'worktree', 'pr', 'evidence']) stored[k] = null;
    ctx.L.tasks.push(stored);
    added.push(id);
  }

  // When the inbox cannot be moved aside, the ledger gets back its bytes from before this call and
  // the inbox stays, so a later call ingests each line exactly once. That restore happens only
  // while the ledger still holds what this call wrote; an inbox that is gone, whatever the error,
  // has nothing left to process twice. Returns warnings for the answer.
  const consume = written => {
    const kept = `${ctx.inboxFile}.ingested-${Date.now()}`;
    try {
      fs.renameSync(ctx.inboxFile, kept);
    } catch (e) {
      if (!fs.existsSync(ctx.inboxFile)) return [];
      let outcome = 'the ledger is unchanged';
      if (written !== undefined) {
        let current = null;
        try {
          current = readCheckedFile(ctx.ledgerFile, 'ledger', { encoding: 'utf8' });
        } catch {
          // Not the ledger this call wrote.
        }
        if (current === written) writeAtomic(ctx.ledgerFile, ctx.ledgerBytes);
        else outcome = 'the ledger was not restored';
      }
      fail(`cannot move the inbox ${ctx.inboxFile} aside: ${e.message}; ${outcome}`);
    }
    // Lines appended after the read above go back into a fresh inbox. The moved file is read only
    // when it is the regular file read above, through the same checked read.
    let now = null;
    try {
      const moved = openCheckedFile(kept, 'moved inbox', { own: false, encoding: 'utf8' });
      if (moved && moved.st.dev === read.st.dev && moved.st.ino === read.st.ino) now = moved.content;
    } catch {
      // Skipped below.
    }
    if (now === null) {
      return [`the moved inbox ${kept} is not the file that was read; lines appended to it after the read were not carried over`];
    }
    if (now.length > text.length && now.startsWith(text)) fs.appendFileSync(ctx.inboxFile, now.slice(text.length));
    return [];
  };
  return { added, consume };
}

// ---- commands ----------------------------------------------------------------------------------

function opFinish(ctx, [runStatus, reason, runId]) {
  if (!RUN_STATUSES.includes(runStatus)) fail(`bad runStatus ${runStatus}: expected one of ${RUN_STATUSES.join(', ')}`);
  finishUnderLock(ctx, runId, L => {
    L.runStatus = runStatus;
    L.stopReason = reason === undefined || reason === '' ? null : reason;
  });
  return { runStatus, tasks: listing(ctx.L) };
}

function opStatus(ctx, [id, status, evidence]) {
  findTask(ctx, id);
  if (!SETTABLE.includes(status)) fail(`status ${status} not settable: expected one of ${SETTABLE.join(', ')}`);
  updateLedger(ctx, () => {
    const t = findTask(ctx, id);
    t.status = status;
    if (evidence !== undefined) t.evidence = String(evidence).slice(0, EVIDENCE_MAX);
  });
  return { id, status };
}

// Ingests the inbox and refreshes the lock under the guard, so overlapping calls process the inbox one after
// the other from the ledger as the previous one left it.
function opSync(ctx, [runId]) {
  return withLockGuard(ctx, () => {
    refreshLockGuarded(ctx, runId);
    Object.assign(ctx, readLedgerFile(ctx.ledgerFile));
    const { added, consume } = ingestInbox(ctx);
    const warnings = consume(added.length ? persistLedger(ctx) : undefined);
    return { added, tasks: listing(ctx.L), ...(warnings.length ? { warnings } : {}) };
  });
}

// Does `from` reach `to` through dependsOn, transitively?
function reaches(L, from, to) {
  const byId = new Map(L.tasks.map(t => [t.id, t]));
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const cur = byId.get(stack.pop());
    if (!cur) continue;
    for (const d of depsOf(cur)) {
      if (d === to) return true;
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return false;
}

function overlapWarnings(L) {
  const warnings = [];
  const tasks = L.tasks;
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a.status === 'merged' || b.status === 'merged') continue;
      if (!globListsOverlap(a.files, b.files)) continue;
      if (reaches(L, a.id, b.id) || reaches(L, b.id, a.id)) continue;
      warnings.push(`${a.id} and ${b.id} have overlapping files globs but no dependsOn path links them; their merges may conflict`);
    }
  }
  return warnings;
}

// prepare <runId> [takeover [heldRunId]]
function opPrepare(ctx, [runId, takeover, heldRunId]) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) fail(`bad runId ${JSON.stringify(runId)}: must match ${RUN_ID_RE}`);
  if (takeover !== 'takeover') heldRunId = undefined;
  if (heldRunId !== undefined && !RUN_ID_RE.test(heldRunId)) fail(`bad held runId ${JSON.stringify(heldRunId)}: must match ${RUN_ID_RE}`);
  agentsOf(ctx.L);

  const lock = acquireLock(ctx, runId, takeover === 'takeover', heldRunId);

  try {
    const { root, L } = ctx;
    const warnings = [];

    if (git(root, 'ls-files', '--error-unmatch', '--', '.claude/verify.cmd').status !== 0) {
      fail('.claude/verify.cmd is not tracked in the main checkout; commit it before starting a run');
    }

    if (git(root, 'remote', 'get-url', 'origin').status === 0) {
      const f = git(root, 'fetch', '-q', 'origin');
      if (f.status !== 0) warnings.push(`git fetch origin failed: ${(f.stderr || f.stdout).trim()}`);
    }

    const start = resolveStartRef(ctx);
    const intBranch = integrationBranchName(ctx);
    let integration = worktreeOfBranch(root, intBranch);
    if (!integration) {
      gitOk(root, 'worktree', 'prune');
      integration = integrationPath(ctx);
      if (hasBranch(root, intBranch)) gitOk(root, 'worktree', 'add', '-q', integration, intBranch);
      else gitOk(root, 'worktree', 'add', '-q', '-b', intBranch, integration, start);
    }

    if (L.setup) {
      const c = shellCheck(L, L.setup, integration);
      if (!c.ok) fail(`setup \`${L.setup}\` failed in ${integration} with exit ${c.code}`, { tail: c.tail });
    } else {
      warnings.push('the ledger has no `setup` command; worktrees start without installed dependencies');
    }

    const probe = '.claude/worktrees/.tasks-git-probe';
    if (git(root, 'check-ignore', '-q', '--', probe).status !== 0) {
      warnings.push('.claude/worktrees/ is not gitignored; add it to .gitignore so task worktrees stay out of the main checkout');
    }

    // Ingestion, the run state and the ledger write happen under the guard, from the ledger as it
    // is now; overlap warnings include the tasks just added. Every check of that fresh copy runs
    // before the write, so after it only the answer is built.
    let agents;
    const added = withLockGuard(ctx, () => {
      Object.assign(ctx, readLedgerFile(ctx.ledgerFile));
      agents = agentsOf(ctx.L);
      const { added: ids, consume } = ingestInbox(ctx);
      for (const t of ctx.L.tasks) if (t.status === 'in_progress' || t.status === 'done') t.status = 'todo';
      warnings.push(...overlapWarnings(ctx.L));
      ctx.L.runStatus = 'running';
      ctx.L.stopReason = null;
      ctx.L.integrationBranch = intBranch;
      warnings.push(...consume(persistLedger(ctx)));
      return ids;
    });
    // A racing takeover that started late still finds this lock `preparing` and is refused.
    if (lock.tookOver) sleepMs(Math.max(0, lock.at + TAKEOVER_SETTLE_MS - Date.now()));
    try {
      settleLock(ctx, lock);
    } catch {
      // The mark is harmless once this process has exited.
    }

    return { added, agents, integration, prs: ctx.L.prs === true, root, start, tasks: listing(ctx.L), warnings };
  } catch (e) {
    try {
      restoreLock(ctx, lock);
    } catch (restoreError) {
      // Without the guard the lock still holds this call's text, so the moved-aside lock is the only
      // copy of the previous one and stays. When renaming it back failed, it stays as well, and the
      // rename error follows the original one.
      if (lock.backup === null) throw restoreError;
      if (e && typeof e === 'object') {
        e.message += restoreError.guardUnavailable
          ? `; the previous lock is kept at ${lock.backup}`
          : cannotPutBack(restoreError, lock.backup);
      }
    }
    throw e;
  }
}

// Creates task/<topic>/<id>-base with every prerequisite merged in, using a temporary detached
// worktree so the branch only appears once all merges succeeded.
function createCombinedBase(ctx, t) {
  const { root } = ctx;
  const deps = depsOf(t);
  const tmp = taskPath(ctx, `${t.id}-base`);
  gitOk(root, 'worktree', 'prune');
  gitOk(root, 'worktree', 'add', '-q', '--detach', tmp, taskBranch(ctx, deps[0]));
  try {
    for (const dep of deps.slice(1)) {
      const m = git(tmp, 'merge', '--no-ff', '--no-edit', '-q', '-m', `combine ${dep} into ${t.id}-base`, taskBranch(ctx, dep));
      if (m.status !== 0) {
        git(tmp, 'merge', '--abort');
        fail(`prerequisites of ${t.id} conflict with each other (merging ${dep}): ${(m.stdout + m.stderr).trim()}`);
      }
    }
    gitOk(tmp, 'branch', combinedBase(ctx, t.id), 'HEAD');
  } finally {
    git(root, 'worktree', 'remove', '--force', tmp);
    git(root, 'worktree', 'prune');
  }
}

function opWorktree(ctx, [id]) {
  const { root, L } = ctx;
  const t = findTask(ctx, id);
  for (const dep of depsOf(t)) {
    const d = L.tasks.find(x => x.id === dep);
    if (!d) fail(`prerequisite ${dep} of ${id} is not in the ledger`);
    if (d.status !== 'merged') fail(`prerequisite ${dep} is ${d.status}, not merged`);
  }

  const branch = taskBranch(ctx, id);
  const base = baseOf(ctx, t);
  let worktree = worktreeOfBranch(root, branch);
  if (!worktree) {
    gitOk(root, 'worktree', 'prune');
    worktree = taskPath(ctx, id);
    if (hasBranch(root, branch)) {
      gitOk(root, 'worktree', 'add', '-q', worktree, branch);
    } else {
      const deps = depsOf(t);
      if (deps.length >= 2 && !hasBranch(root, base)) createCombinedBase(ctx, t);
      const from = deps.length === 0 ? resolveStartRef(ctx) : base;
      gitOk(root, 'worktree', 'add', '-q', '-b', branch, worktree, from);
    }
  }

  updateLedger(ctx, () => Object.assign(findTask(ctx, id), { status: 'in_progress', branch, base, worktree }));
  return { id, branch, base, worktree };
}

function taskWorktree(ctx, t) {
  if (typeof t.worktree === 'string' && t.worktree && fs.existsSync(t.worktree)) {
    const known = worktrees(ctx.root).find(w => w.path === t.worktree && w.branch === taskBranch(ctx, t.id));
    if (known) return t.worktree;
  }
  return worktreeOfBranch(ctx.root, taskBranch(ctx, t.id));
}

// The verify command committed on the task's base ref, never the copy in a worktree. A missing or
// empty one fails the call; no check is ever skipped.
function baseVerifyCmd(ctx, t) {
  const baseRef = baseRefOf(ctx, t);
  const r = git(ctx.root, 'show', `${baseRef}:.claude/verify.cmd`);
  if (r.status !== 0) fail(`${t.id}: .claude/verify.cmd is not tracked on the base ${baseRef}; commit it there before verifying`);
  const command = r.stdout.trim();
  if (!command) fail(`${t.id}: .claude/verify.cmd is empty on ${baseRef}; commit a check there before verifying`);
  return command;
}

// Refuses a task whose branch changes .claude/verify.cmd since it left its base, in any spelling of
// upper and lower case: a task must not rewrite the check that judges it.
function refuseVerifyCmdChange(ctx, t) {
  const branch = taskBranch(ctx, t.id);
  const baseRef = baseRefOf(ctx, t);
  const d = git(ctx.root, 'diff', '--name-only', '--no-renames', '-z', `${baseRef}...refs/heads/${branch}`);
  if (d.status !== 0) fail(`${t.id}: cannot compare .claude/verify.cmd of ${branch} with ${baseRef}: ${(d.stderr || d.stdout).trim()}`);
  const changed = d.stdout.split('\0').find(p => p.toLowerCase() === '.claude/verify.cmd');
  if (changed) {
    fail(`${t.id}: ${branch} modifies ${changed} compared with ${baseRef}; change verify.cmd outside a run, then retry the task`);
  }
}

function opVerify(ctx, [id]) {
  const t = findTask(ctx, id);
  const worktree = taskWorktree(ctx, t);
  if (!worktree) fail(`worktree for ${id} missing`);
  refuseVerifyCmdChange(ctx, t);
  const command = baseVerifyCmd(ctx, t);

  const branch = taskBranch(ctx, id);
  const baseRef = baseRefOf(ctx, t);
  const commits = Number(gitOk(worktree, 'rev-list', '--count', `${baseRef}..HEAD`));
  if (!(commits > 0)) fail(`${id}: no commits on ${branch} beyond ${baseRef}`);

  const st = git(worktree, 'status', '--porcelain', '--untracked-files=all');
  if (st.status !== 0) fail(`git status failed in ${worktree}: ${st.stderr.trim()}`);
  const dirty = st.stdout.split('\n').filter(Boolean);
  if (dirty.length) fail(`${id}: uncommitted changes in ${worktree}`, { dirty });

  const c = shellCheck(ctx.L, command, worktree);
  if (!c.ok) fail(`${id}: verify.cmd exited ${c.code}`, { tail: c.tail });

  return { id, commits, verify: 'passed', tail: c.tail };
}

const appendEvidence = (old, text) => (old ? `${old} | ${text}` : text).slice(0, EVIDENCE_MAX);

// Marks the task merged in the freshly read ledger, appending `text` to its evidence.
function markMerged(ctx, id, text) {
  updateLedger(ctx, () => {
    const t = findTask(ctx, id);
    t.status = 'merged';
    t.evidence = appendEvidence(t.evidence, text);
  });
}

// The paths that git names, as it prints them without quotes, when untracked files block a merge:
// files that would be overwritten or removed, and directories that would lose untracked files (git
// run with LC_ALL=C).
function untrackedBlockers(output) {
  const lines = output.split(/\r?\n/);
  const paths = [];
  const add = p => {
    if (p && !paths.includes(p)) paths.push(p);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const single = /untracked working tree file '(.+)' would be (?:overwritten|removed) by merge/i.exec(l)
      || /updating '(.+)' would lose untracked files in it/i.exec(l);
    if (single) {
      add(single[1]);
      continue;
    }
    if (!/untracked working tree files would be (?:overwritten|removed) by merge|directories would lose untracked files in them/i.test(l)) continue;
    for (i++; i < lines.length && /^\t/.test(lines[i]); i++) add(lines[i].slice(1));
    i--;
  }
  return paths;
}

function opMerge(ctx, [id]) {
  const { L } = ctx;
  const t = findTask(ctx, id);
  const intBranch = L.integrationBranch || integrationBranchName(ctx);
  const integration = worktreeOfBranch(ctx.root, intBranch);
  if (!integration) fail('integration worktree missing');
  if (t.status !== 'verified') fail(`${id} is ${t.status}, only verified tasks merge`);

  const branch = taskBranch(ctx, id);
  if (!hasBranch(ctx.root, branch)) fail(`${id}: branch ${branch} does not exist`);
  refuseVerifyCmdChange(ctx, t);

  // Already merged: nothing is merged, so no verify command is needed.
  if (git(integration, 'merge-base', '--is-ancestor', branch, 'HEAD').status === 0) {
    const sha = gitOk(integration, 'rev-parse', '--short', 'HEAD');
    markMerged(ctx, id, `already in ${intBranch} @ ${sha}`);
    return { id, sha, already: true };
  }

  if (gitOk(integration, 'status', '--porcelain', '--untracked-files=no')) {
    fail(`integration worktree ${integration} has uncommitted changes to tracked files`);
  }
  const checkCommand = baseVerifyCmd(ctx, t);
  const head = gitOk(integration, 'rev-parse', 'HEAD');
  const restore = () => {
    git(integration, 'merge', '--abort');
    git(integration, 'reset', '-q', '--hard', head);
  };

  // After any failed merge the integration worktree is reset to its HEAD.
  const checks = [];
  try {
    const m = run('git', ['merge', '--no-ff', '--no-commit', '-q', branch], integration, { env: { ...process.env, LC_ALL: 'C' } });
    if (m.status !== 0) {
      const output = m.stdout + m.stderr;
      const blockers = untrackedBlockers(output);
      if (blockers.length) fail(`${id}: untracked files in the integration worktree block the merge: ${blockers.slice(0, 5).join(', ')}`, { tail: tail(output) });
      const conflicts = git(integration, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
      fail(`${id} conflicts with already-merged tasks`, { conflicts, tail: tail(output) });
    }

    for (const [name, command] of [['setup', L.setup], ['verify', checkCommand], ['suite', L.suite]]) {
      if (!command) continue;
      const c = shellCheck(L, command, integration);
      if (!c.ok) fail(`${id}: combined check failed after merging (${command}, exit ${c.code}); merge aborted`, { tail: c.tail });
      checks.push(`${name} passed`);
    }

    const title = typeof t.title === 'string' ? t.title : '';
    const commit = git(integration, 'commit', '-q', '-m', `merge ${id}: ${title}`);
    if (commit.status !== 0) fail(`${id}: merge commit failed: ${(commit.stdout + commit.stderr).trim()}`);
  } catch (e) {
    restore();
    throw e;
  }
  // Checks may touch tracked files; the merge commit is what counts.
  if (gitOk(integration, 'status', '--porcelain', '--untracked-files=no')) git(integration, 'reset', '-q', '--hard', 'HEAD');

  const sha = gitOk(integration, 'rev-parse', '--short', 'HEAD');
  markMerged(ctx, id, `merged into ${intBranch} @ ${sha}; checks: ${checks.join(', ') || 'none'}`);
  return { id, sha };
}

// ---- prs ---------------------------------------------------------------------------------------

function checkPushable(ctx, branch) {
  const refuse = why => fail(`refusing to push ${JSON.stringify(branch)}: ${why}`);
  if (typeof branch !== 'string' || branch === '') refuse('not a branch name');
  if (/[\s:]/.test(branch) || branch.startsWith('-')) refuse('not a well-formed branch name');
  if (git(ctx.root, 'check-ref-format', '--branch', branch).status !== 0) refuse('not a well-formed branch name');
  if (PERMANENT_BRANCHES.includes(branch) || branch === ctx.L.baseBranch) refuse('permanent branch');
  if (branch === integrationBranchName(ctx) || branch === ctx.L.integrationBranch) refuse('the integration branch is never pushed');
  if (!branch.startsWith(`task/${ctx.L.topic}/`)) refuse(`not under task/${ctx.L.topic}/`);
}

// A request may target only baseBranch or a well-formed branch under task/<topic>/.
function checkTarget(ctx, target) {
  if (target === ctx.L.baseBranch) return;
  const refuse = why => fail(`refusing to push a request targeting ${JSON.stringify(target)}: ${why}`);
  if (typeof target !== 'string' || target === '') refuse('not a branch name');
  if (/[\s:]/.test(target) || target.startsWith('-')) refuse('not a well-formed branch name');
  if (git(ctx.root, 'check-ref-format', '--branch', target).status !== 0) refuse('not a well-formed branch name');
  if (!target.startsWith(`task/${ctx.L.topic}/`)) refuse(`neither ${ctx.L.baseBranch} nor under task/${ctx.L.topic}/`);
}

// Merged tasks with prerequisites before dependants, otherwise in ledger order.
function mergedInOrder(L) {
  const byId = new Map(L.tasks.map(t => [t.id, t]));
  const out = [];
  const seen = new Set();
  const visit = t => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of depsOf(t)) if (byId.has(d)) visit(byId.get(d));
    if (t.status === 'merged') out.push(t);
  };
  L.tasks.forEach(visit);
  return out;
}

function forgeCli(envName, fallback) {
  const v = process.env[envName];
  const parts = v ? v.split('|').filter(Boolean) : [fallback];
  return { program: parts[0], lead: parts.slice(1) };
}

function opPrs(ctx) {
  const { root, L } = ctx;
  if (L.prs !== true) fail('prs is false in the ledger; nothing pushed');

  const todo = mergedInOrder(L);
  const plan = [];
  for (const t of todo) {
    if (t.pr) continue;
    const branch = t.branch == null ? taskBranch(ctx, t.id) : t.branch;
    const target = t.base == null ? baseOf(ctx, t) : t.base;
    const push = [branch];
    checkPushable(ctx, branch);
    checkTarget(ctx, target);
    if (target === combinedBase(ctx, t.id)) {
      checkPushable(ctx, target);
      push.push(target);
    }
    plan.push({ t, branch, target, push });
  }

  const originUrl = git(root, 'remote', 'get-url', 'origin').stdout.trim();
  const gitlab = originUrl.includes('gitlab');
  const cli = gitlab ? forgeCli('TASKS_GIT_GLAB', 'glab') : forgeCli('TASKS_GIT_GH', 'gh');
  const label = gitlab ? 'glab mr' : 'gh pr';
  const results = [];

  for (const t of todo) {
    if (t.pr) {
      results.push({ id: t.id, pr: t.pr, skipped: 'exists' });
      continue;
    }
    const { branch, target, push } = plan.find(p => p.t === t);
    for (const b of push) {
      const p = git(root, 'push', '-q', 'origin', `refs/heads/${b}:refs/heads/${b}`);
      if (p.status !== 0) fail(`git push of ${b} failed: ${(p.stdout + p.stderr).trim()}`, { results });
    }

    const title = typeof t.title === 'string' ? t.title : t.id;
    const lines = [`**${t.id}: ${title}**`];
    if (t.acceptance) lines.push('', `Acceptance: ${t.acceptance}`);
    const deps = depsOf(t);
    if (deps.length) {
      lines.push('');
      for (const dep of deps) {
        const d = L.tasks.find(x => x.id === dep);
        lines.push(`Stacked on ${dep} (${(d && d.pr) || 'no request yet'})`);
      }
    }
    const body = lines.join('\n');
    const args = gitlab
      ? ['mr', 'create', '--draft', '--source-branch', branch, '--target-branch', target, '--title', title, '--description', body, '--yes']
      : ['pr', 'create', '--draft', '--head', branch, '--base', target, '--title', title, '--body', body];
    const r = run(cli.program, [...cli.lead, ...args], root);
    const output = (r.stdout + r.stderr).trim();
    const urls = r.stdout.match(/https?:\/\/\S+/g);
    if (r.status !== 0 || !urls) {
      fail(`${label} create failed for ${t.id}: ${output || String(r.error || '')}`, { results });
    }
    const pr = urls[urls.length - 1];
    t.pr = pr;
    updateLedger(ctx, () => {
      findTask(ctx, t.id).pr = pr;
    });
    results.push({ id: t.id, pr: t.pr, target });
  }
  return { results };
}

// ---- main --------------------------------------------------------------------------------------

const COMMANDS = {
  finish: opFinish,
  merge: opMerge,
  prepare: opPrepare,
  prs: opPrs,
  status: opStatus,
  sync: opSync,
  verify: opVerify,
  worktree: opWorktree,
};

function main(argv) {
  // When the process was created, not when this script began to run: concurrently spawned callers
  // may need very different times to boot.
  const startedAt = Math.floor(Date.now() - process.uptime() * 1000);
  const [cmd, ledgerArg, ...rest] = argv;
  if (!cmd || !ledgerArg) fail(`usage: tasks-git.js <${Object.keys(COMMANDS).join('|')}> <ledger> [args...]`);
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) fail(`unknown command ${cmd}`);

  if (ledgerArg.split(/[\\/]/).includes('..')) fail(`ledger path ${ledgerArg} contains a .. segment; refusing it`);
  const ledgerFile = path.resolve(ledgerArg);
  const runsDir = path.dirname(ledgerFile);
  const claudeDir = path.dirname(runsDir);
  if (path.basename(runsDir) !== 'runs' || path.basename(claudeDir) !== '.claude') {
    fail(`ledger ${ledgerFile} is not in <repo>/.claude/runs/`);
  }
  // Every file of the run lives in these two directories; neither may lead elsewhere.
  for (const dir of [claudeDir, runsDir]) {
    const st = lstatOrNull(dir);
    if (st && st.isSymbolicLink()) fail(`ledger directory ${dir} is a symbolic link; refusing it`);
  }
  const root = path.dirname(claudeDir);
  const { L, ledgerBytes } = readLedgerFile(ledgerFile);

  const stem = ledgerFile.replace(/\.json$/, '');
  const ctx = { root, ledgerFile, ledgerBytes, L, startedAt, lockFile: `${stem}.lock`, inboxFile: `${stem}.inbox.jsonl` };
  return COMMANDS[cmd](ctx, rest);
}

let answer;
try {
  answer = { ok: true, ...main(process.argv.slice(2)) };
} catch (e) {
  answer = e instanceof Failure
    ? { ok: false, error: e.message, ...e.extra }
    : { ok: false, error: `unexpected error: ${e && e.message ? e.message : String(e)}` };
}
process.stdout.write(JSON.stringify(answer) + '\n');
process.exitCode = 0;
