#!/usr/bin/env node
// tasks-git: every repository, worktree and ledger mutation of a tasks run.
// Usage: node tasks-git.js <command> <ledger> [args...]
// Prints exactly one JSON line and exits 0, failures included.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TASK_KEYS = [
  'acceptance', 'base', 'branch', 'budget', 'constraints', 'dependsOn', 'evidence',
  'files', 'id', 'pr', 'proof', 'status', 'title', 'worktree',
];
const LISTING_LISTS = ['constraints', 'dependsOn', 'files'];
const LISTING_SCALARS = ['acceptance', 'base', 'branch', 'budget', 'id', 'pr', 'proof', 'status', 'title', 'worktree'];
const ID_RE = /^T[0-9]+$/;
const INBOX_ID_RE = /^T[0-9]{1,9}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{4,64}$/;
const SETTABLE = ['blocked', 'done', 'in_progress', 'todo', 'verified'];
const RUN_STATUSES = ['finished', 'running', 'stopped'];
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MIN = 30;
const EVIDENCE_MAX = 4000;
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
  const r = run('bash', ['-c', command], cwd, { timeout: minutes * 60 * 1000 });
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

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function persistLedger(ctx) {
  writeAtomic(ctx.ledgerFile, JSON.stringify(ctx.L, null, 2) + '\n');
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
      fail(`unsafe task id ${JSON.stringify(t && t.id)}: must match ${ID_RE}`);
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

function readLockText(ctx) {
  try {
    return fs.readFileSync(ctx.lockFile, 'utf8');
  } catch {
    return null;
  }
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

// Takes the lock atomically. A missing lock is created with link(2), which fails when another
// call created it first; an existing lock is first renamed aside (only one caller can do that) and
// checked to be the lock that was judged replaceable. Losers re-read the lock and are refused when
// it now belongs to a live foreign run. Returns { previous, written }: the lock text before the
// call (null when there was none) and the text this call wrote.
function acquireLock(ctx, runId, takeover) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const written = JSON.stringify({ runId, at: Date.now() }) + '\n';
  const tmp = `${ctx.lockFile}.new-${token}`;
  fs.writeFileSync(tmp, written);
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const previous = readLockText(ctx);
      const held = previous === null ? null : parseLock(previous);
      if (isLiveForeign(held, runId) && !takeover) lockedFailure(held);

      if (previous === null) {
        try {
          fs.linkSync(tmp, ctx.lockFile);
          return { previous: null, written };
        } catch (e) {
          if (errCode(e) === 'EEXIST') continue;
          throw e;
        }
      }

      const aside = `${ctx.lockFile}.old-${token}`;
      try {
        fs.renameSync(ctx.lockFile, aside);
      } catch (e) {
        if (errCode(e) === 'ENOENT') continue;
        throw e;
      }
      if (fs.readFileSync(aside, 'utf8') !== previous) {
        // The lock changed between reading and renaming it: put it back and judge it again.
        try {
          fs.linkSync(aside, ctx.lockFile);
        } catch {}
        fs.rmSync(aside, { force: true });
        continue;
      }
      try {
        fs.linkSync(tmp, ctx.lockFile);
      } catch (e) {
        fs.rmSync(aside, { force: true });
        if (errCode(e) === 'EEXIST') continue;
        throw e;
      }
      fs.rmSync(aside, { force: true });
      return { previous, written };
    }
    const held = readLock(ctx);
    fail(`another run (${(held && held.runId) || 'unknown'}) keeps changing this ledger's lock; try again`, { locked: true });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Puts back the lock that was there before acquireLock, unless another call has replaced ours since.
function restoreLock(ctx, { previous, written }) {
  if (readLockText(ctx) !== written) return;
  if (previous === null) fs.rmSync(ctx.lockFile, { force: true });
  else writeAtomic(ctx.lockFile, previous);
}

function removeLock(ctx) {
  fs.rmSync(ctx.lockFile, { force: true });
}

// ---- inbox -------------------------------------------------------------------------------------

// Reads the inbox and appends its valid entries to ctx.L.tasks. Returns the added ids and a
// `consume` function that renames the inbox once the caller has saved the ledger.
function ingestInbox(ctx) {
  if (!fs.existsSync(ctx.inboxFile)) return { added: [], consume: () => {} };
  const text = fs.readFileSync(ctx.inboxFile, 'utf8');
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

  const consume = () => {
    const kept = `${ctx.inboxFile}.ingested-${Date.now()}`;
    fs.renameSync(ctx.inboxFile, kept);
    // Lines appended after the read above go back into a fresh inbox.
    const now = fs.readFileSync(kept, 'utf8');
    if (now.length > text.length && now.startsWith(text)) fs.appendFileSync(ctx.inboxFile, now.slice(text.length));
  };
  return { added, consume };
}

// ---- commands ----------------------------------------------------------------------------------

function opFinish(ctx, [runStatus, reason]) {
  if (!RUN_STATUSES.includes(runStatus)) fail(`bad runStatus ${runStatus}: expected one of ${RUN_STATUSES.join(', ')}`);
  ctx.L.runStatus = runStatus;
  ctx.L.stopReason = reason === undefined ? null : reason;
  persistLedger(ctx);
  removeLock(ctx);
  return { runStatus, tasks: listing(ctx.L) };
}

function opStatus(ctx, [id, status, evidence]) {
  const t = findTask(ctx, id);
  if (!SETTABLE.includes(status)) fail(`status ${status} not settable: expected one of ${SETTABLE.join(', ')}`);
  t.status = status;
  if (evidence !== undefined) t.evidence = String(evidence).slice(0, EVIDENCE_MAX);
  persistLedger(ctx);
  return { id, status };
}

function opSync(ctx) {
  const { added, consume } = ingestInbox(ctx);
  if (added.length) persistLedger(ctx);
  consume();
  const lock = readLock(ctx);
  if (lock) writeAtomic(ctx.lockFile, JSON.stringify({ ...lock, at: Date.now() }) + '\n');
  return { added, tasks: listing(ctx.L) };
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
      if (!globListsOverlap(a.files, b.files)) continue;
      if (reaches(L, a.id, b.id) || reaches(L, b.id, a.id)) continue;
      warnings.push(`${a.id} and ${b.id} have overlapping files globs but no dependsOn path links them; their merges may conflict`);
    }
  }
  return warnings;
}

function opPrepare(ctx, [runId, takeover]) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) fail(`bad runId ${JSON.stringify(runId)}: must match ${RUN_ID_RE}`);

  const lock = acquireLock(ctx, runId, takeover === 'takeover');

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

    const { added, consume } = ingestInbox(ctx);
    for (const t of L.tasks) if (t.status === 'in_progress' || t.status === 'done') t.status = 'todo';

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

    warnings.push(...overlapWarnings(L));

    L.runStatus = 'running';
    L.stopReason = null;
    L.integrationBranch = intBranch;
    persistLedger(ctx);
    consume();

    return { added, integration, prs: L.prs === true, root, start, tasks: listing(L), warnings };
  } catch (e) {
    restoreLock(ctx, lock);
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

  t.status = 'in_progress';
  t.branch = branch;
  t.base = base;
  t.worktree = worktree;
  persistLedger(ctx);
  return { id, branch, base, worktree };
}

function taskWorktree(ctx, t) {
  if (typeof t.worktree === 'string' && t.worktree && fs.existsSync(t.worktree)) {
    const known = worktrees(ctx.root).find(w => w.path === t.worktree && w.branch === taskBranch(ctx, t.id));
    if (known) return t.worktree;
  }
  return worktreeOfBranch(ctx.root, taskBranch(ctx, t.id));
}

function readVerifyCmd(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.claude', 'verify.cmd'), 'utf8').trim();
  } catch {
    return '';
  }
}

// Refuses a task whose branch changes .claude/verify.cmd since it left its base: a task must not
// rewrite the check that judges it.
function refuseVerifyCmdChange(ctx, t) {
  const branch = taskBranch(ctx, t.id);
  const baseRef = baseRefOf(ctx, t);
  const d = git(ctx.root, 'diff', '--quiet', `${baseRef}...refs/heads/${branch}`, '--', '.claude/verify.cmd');
  if (d.status === 0) return;
  if (d.status === 1) {
    fail(`${t.id}: ${branch} modifies .claude/verify.cmd compared with ${baseRef}; change verify.cmd outside a run, then retry the task`);
  }
  fail(`${t.id}: cannot compare .claude/verify.cmd of ${branch} with ${baseRef}: ${(d.stderr || d.stdout).trim()}`);
}

function opVerify(ctx, [id]) {
  const t = findTask(ctx, id);
  const worktree = taskWorktree(ctx, t);
  if (!worktree) fail(`worktree for ${id} missing`);

  const branch = taskBranch(ctx, id);
  const baseRef = baseRefOf(ctx, t);
  const commits = Number(gitOk(worktree, 'rev-list', '--count', `${baseRef}..HEAD`));
  if (!(commits > 0)) fail(`${id}: no commits on ${branch} beyond ${baseRef}`);

  const st = git(worktree, 'status', '--porcelain', '--untracked-files=all');
  if (st.status !== 0) fail(`git status failed in ${worktree}: ${st.stderr.trim()}`);
  const dirty = st.stdout.split('\n').filter(Boolean);
  if (dirty.length) fail(`${id}: uncommitted changes in ${worktree}`, { dirty });
  refuseVerifyCmdChange(ctx, t);

  const command = readVerifyCmd(worktree);
  if (!command) fail(`${id}: .claude/verify.cmd is missing or empty in ${worktree}`);
  const c = shellCheck(ctx.L, command, worktree);
  if (!c.ok) fail(`${id}: verify.cmd exited ${c.code}`, { tail: c.tail });

  return { id, commits, verify: 'passed', tail: c.tail };
}

const appendEvidence = (old, text) => (old ? `${old} | ${text}` : text).slice(0, EVIDENCE_MAX);

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

  if (git(integration, 'merge-base', '--is-ancestor', branch, 'HEAD').status === 0) {
    const sha = gitOk(integration, 'rev-parse', '--short', 'HEAD');
    t.status = 'merged';
    t.evidence = appendEvidence(t.evidence, `already in ${intBranch} @ ${sha}`);
    persistLedger(ctx);
    return { id, sha, already: true };
  }

  if (gitOk(integration, 'status', '--porcelain', '--untracked-files=no')) {
    fail(`integration worktree ${integration} has uncommitted changes to tracked files`);
  }
  const head = gitOk(integration, 'rev-parse', 'HEAD');
  const restore = () => {
    git(integration, 'merge', '--abort');
    git(integration, 'reset', '-q', '--hard', head);
  };

  const m = git(integration, 'merge', '--no-ff', '--no-commit', '-q', branch);
  if (m.status !== 0) {
    const conflicts = git(integration, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
    restore();
    fail(`${id} conflicts with already-merged tasks`, { conflicts, tail: tail(m.stdout + m.stderr) });
  }

  const checks = [];
  const checkCommand = readVerifyCmd(integration);
  for (const [name, command] of [['setup', L.setup], ['verify', checkCommand], ['suite', L.suite]]) {
    if (!command) continue;
    const c = shellCheck(L, command, integration);
    if (!c.ok) {
      restore();
      fail(`${id}: combined check failed after merging (${command}, exit ${c.code}); merge aborted`, { tail: c.tail });
    }
    checks.push(`${name} passed`);
  }

  const title = typeof t.title === 'string' ? t.title : '';
  const commit = git(integration, 'commit', '-q', '-m', `merge ${id}: ${title}`);
  if (commit.status !== 0) {
    restore();
    fail(`${id}: merge commit failed: ${(commit.stdout + commit.stderr).trim()}`);
  }
  // Checks may touch tracked files; the merge commit is what counts.
  if (gitOk(integration, 'status', '--porcelain', '--untracked-files=no')) git(integration, 'reset', '-q', '--hard', 'HEAD');

  const sha = gitOk(integration, 'rev-parse', '--short', 'HEAD');
  t.status = 'merged';
  t.evidence = appendEvidence(t.evidence, `merged into ${intBranch} @ ${sha}; checks: ${checks.join(', ') || 'none'}`);
  persistLedger(ctx);
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
    t.pr = urls[urls.length - 1];
    persistLedger(ctx);
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
  const [cmd, ledgerArg, ...rest] = argv;
  if (!cmd || !ledgerArg) fail(`usage: tasks-git.js <${Object.keys(COMMANDS).join('|')}> <ledger> [args...]`);
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) fail(`unknown command ${cmd}`);

  const ledgerFile = path.resolve(ledgerArg);
  const runsDir = path.dirname(ledgerFile);
  const claudeDir = path.dirname(runsDir);
  if (path.basename(runsDir) !== 'runs' || path.basename(claudeDir) !== '.claude') {
    fail(`ledger ${ledgerFile} is not in <repo>/.claude/runs/`);
  }
  const root = path.dirname(claudeDir);

  let L;
  try {
    L = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch (e) {
    fail(`cannot read ledger ${ledgerFile}: ${e.message}`);
  }
  validateLedger(L);

  const stem = ledgerFile.replace(/\.json$/, '');
  const ctx = { root, ledgerFile, L, lockFile: `${stem}.lock`, inboxFile: `${stem}.inbox.jsonl` };
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
