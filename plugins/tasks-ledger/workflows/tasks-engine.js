export const meta = {
  name: 'tasks-engine',
  description:
    'Runs a tasks-ledger run to completion: one implementer per task in its own worktree, ' +
    'verify.cmd and an independent reviewer per task, local merges into the integration branch, ' +
    'and draft PRs only when the ledger asks for them.',
};

// tasks-engine workflow. The body runs with the injected `args`, `agent`, `phase` and `log`; it has
// no file access, so every ledger and git side effect goes through scripts/tasks-git.js, which an
// "ops" agent runs and whose single JSON answer line it hands back.

const AGENT_NAME = /^[A-Za-z0-9:_-]+$/;
const RUN_ID = /^[A-Za-z0-9-]{4,64}$/;
const TASK_ID = /^T[0-9]+$/;
const OPS_ATTEMPTS = 3;
// Values the helper hands back before they go into prompts and command lines.
const GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
// Everything bash still expands inside double quotes, plus control characters (C0, DEL, C1) and the
// Unicode line and paragraph separators.
const UNSAFE_PATH = /["$`\\!]|[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Whitespace other than a plain space; `args` paths refuse the space as well.
const OTHER_SPACE = /(?! )\s/;
const STOPPED_MAX = 300;
// How long a successful `sync` keeps the run lock fresh. The runtime throws on reading the clock or
// asking for random numbers, so freshness is tracked with a timer of this length.
const REFRESH_MS = 10 * 60 * 1000;

// ---- arguments (all checks happen before the first agent call) ---------------------------------

if (args == null || typeof args !== 'object') throw new Error('args must be an object');

function requirePath(key) {
  const value = args[key];
  // The path is double-quoted on the command line; refuse everything bash still expands there.
  if (typeof value !== 'string' || !value.startsWith('/') || UNSAFE_PATH.test(value) || /\s/.test(value)) {
    throw new Error(`args.${key} must match an absolute path without whitespace or control characters`);
  }
  return value;
}

function checkAgentName(source, key, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !AGENT_NAME.test(value)) {
    throw new Error(`${source}.${key} must match ${AGENT_NAME.source}`);
  }
  return value;
}

const ledgerPath = requirePath('ledger');
const scriptPath = requirePath('script');
if (typeof args.runId !== 'string' || !RUN_ID.test(args.runId)) {
  throw new Error(`args.runId is required and must match ${RUN_ID.source}`);
}
const runId = args.runId;
// `undefined` when not given; the ledger's `agents` object then decides (after prepare).
const implementerArg = checkAgentName('args', 'implementerAgent', args.implementerAgent, undefined);
const reviewerArg = checkAgentName('args', 'reviewerAgent', args.reviewerAgent, undefined);
// A string names the run whose lock may be taken over; any other truthy value takes over any lock.
if (typeof args.takeover === 'string' && !RUN_ID.test(args.takeover)) {
  throw new Error(`args.takeover must match ${RUN_ID.source}`);
}
const takeoverArgs = typeof args.takeover === 'string' ? ['takeover', args.takeover] : args.takeover ? ['takeover'] : [];

// ---- helper calls ------------------------------------------------------------------------------

// Free text (a reason or evidence) goes on the command line double-quoted, reduced to characters
// that have no meaning there.
function quoteText(text, max = 600) {
  const safe = String(text == null ? '' : text)
    .replace(/[^A-Za-z0-9 _.,:;()/@#+=%-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return `"${safe || '-'}"`;
}

const isGitRef = value => typeof value === 'string' && GIT_REF.test(value);
const isSafePath = value =>
  typeof value === 'string' && value.startsWith('/') && !UNSAFE_PATH.test(value) && !OTHER_SPACE.test(value);

// The first `max` UTF-16 units of `value`, moved back before a surrogate pair the cut would split.
function cut(value, max) {
  let end = Math.min(max, value.length);
  if (end > 0 && end < value.length && /[\ud800-\udbff]/.test(value[end - 1]) && /[\udc00-\udfff]/.test(value[end])) end--;
  return value.slice(0, end);
}

// `result.stopped` is always one line of at most STOPPED_MAX characters.
function oneLine(reason) {
  return cut(String(reason).replace(/\s+/g, ' ').trim(), STOPPED_MAX).trim();
}

const OPS_SCHEMA = {
  type: 'object',
  properties: {
    stdout: { type: 'string', description: 'The complete, unmodified standard output of the command.' },
  },
  required: ['stdout'],
  additionalProperties: false,
};

function opsPrompt(command) {
  return [
    'You run exactly one shell command for an automated workflow and report its output.',
    '',
    'Run the command below once, in the foreground, with the Bash tool, exactly as written. Do not',
    'edit it, do not run any other command before or after it, do not retry it, and do not try to',
    'fix anything it reports. It always exits 0 and prints one JSON line, also on failure.',
    '',
    `node "${scriptPath}" ${command}`,
    '',
    'Answer with `stdout` set to the complete standard output of that one run, character for',
    'character, without summarising, reformatting or adding anything.',
  ].join('\n');
}

function lastJsonObject(stdout) {
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // not JSON; keep looking further up
    }
  }
  return null;
}

let opsChain = Promise.resolve();
let opsQueued = 0; // serialised helper calls running or waiting for their turn
function serialised(fn) {
  opsQueued++;
  const run = opsChain.then(fn, fn);
  opsChain = run.then(
    () => {
      opsQueued--;
    },
    () => {
      opsQueued--;
    }
  );
  return run;
}

async function runOps(command) {
  for (let attempt = 1; attempt <= OPS_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await agent(opsPrompt(command), { schema: OPS_SCHEMA });
    } catch (error) {
      result = null;
      log(`helper call failed (${command.split(' ')[0]}): ${error && error.message}`);
    }
    if (result != null) {
      const stdout = typeof result === 'string' ? result : result.stdout;
      const answer = lastJsonObject(stdout);
      if (answer) return answer; // an `ok: false` answer is final
    }
  }
  return { ok: false, error: `no answer from the helper after ${OPS_ATTEMPTS} attempts` };
}

const opsLine = (subcommand, rest) => [subcommand, `"${ledgerPath}"`, ...rest].join(' ');

function ops(subcommand, ...rest) {
  const command = opsLine(subcommand, rest);
  return subcommand === 'verify' ? runOps(command) : serialised(() => runOps(command));
}

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

// ---- agent prompts -----------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['needs_input', 'rejected', 'verified'] },
    acceptance_met: { type: 'boolean' },
    scope_ok: { type: 'boolean' },
    constraints_ok: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['message'],
      },
    },
    evidence: { type: 'string' },
  },
  required: ['verdict', 'acceptance_met', 'scope_ok', 'constraints_ok', 'findings', 'evidence'],
};

const list = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);
const bullets = (items, none) => (items.length ? items.map(x => `- ${x}`).join('\n') : `- ${none}`);
const text = value => (value == null ? '' : String(value).trim());

function implementerPrompt(t, place, failure) {
  const files = list(t.files).map(String);
  const deps = list(t.dependsOn).map(String);
  const parts = [
    `TASK: ${t.id} ${text(t.title)}`,
    '',
    `Worktree: ${place.worktree}`,
    `Branch: ${place.branch} (already checked out there; it starts from ${place.base})`,
    deps.length
      ? `Prerequisites already merged into that start point: ${deps.join(', ')}.`
      : 'This task has no prerequisites.',
    'Work only inside that worktree: cd into it first and never touch the main checkout, another',
    'worktree or the task ledger.',
    '',
    'OUTCOME:',
    text(t.acceptance) || text(t.title),
    '',
    'PROOF:',
    `Run \`${text(t.proof)}\` in the worktree and include its output in your final report. Then run`,
    'the command in `.claude/verify.cmd` there; it must pass before you finish.',
    '',
    'CONSTRAINTS:',
    `- Change only files matching: ${files.length ? files.join(', ') : '(no files declared; change nothing)'}`,
    bullets(list(t.constraints).map(String), 'no further constraints'),
    '- Do not weaken, skip or delete existing tests or checks to make them pass.',
    '',
    'DELIVERABLE:',
    `One or more commits on ${place.branch} in the worktree, with a clean working tree at the end`,
    '(no uncommitted or untracked files). Never push, never merge, never open a PR, never switch',
    'branches. Report the files changed, the proof output, the commit hash and what is unverified.',
    '',
    'BUDGET:',
    `${text(t.budget)}. When the budget runs out, stop and report what blocks you.`,
    '',
    'ESCALATION:',
    'Stop and report instead of guessing when the change needs files outside the scope above, a',
    'schema or migration change, auth or payment code, or when the task is ambiguous.',
  ];
  if (failure) {
    parts.push(
      '',
      'PREVIOUS ATTEMPT:',
      'Your earlier work in this worktree failed the workflow\'s verification. Fix it in the same',
      'worktree and commit again. Verification output:',
      '```',
      String(failure).slice(-4000),
      '```'
    );
  }
  return parts.join('\n');
}

function reviewerPrompt(t, place, diffBase, verifyTail) {
  const files = list(t.files).map(String);
  return [
    `Review task ${t.id} of a tasks-ledger run: ${text(t.title)}`,
    '',
    `The change is in the git worktree ${place.worktree} on branch ${place.branch}.`,
    `Inspect it there, read-only: \`git -C "${place.worktree}" log --oneline "${diffBase}..HEAD"\` and`,
    `\`git -C "${place.worktree}" diff "${diffBase}...HEAD"\`. Do not edit, commit, push or merge anything.`,
    '',
    'The workflow already re-ran `.claude/verify.cmd` in that worktree and it passed. Output tail:',
    '```',
    text(verifyTail).slice(-2000) || '(no output)',
    '```',
    '',
    `Acceptance: ${text(t.acceptance) || '(none given)'}`,
    `Proof the implementer had to run: ${text(t.proof) || '(none given)'}`,
    `Files scope: ${files.length ? files.join(', ') : '(none declared)'}`,
    'Constraints:',
    bullets(list(t.constraints).map(String), 'none beyond the files scope'),
    '',
    'Answer with:',
    '- acceptance_met: the diff fully meets the acceptance;',
    '- scope_ok: every changed file matches the files scope;',
    '- constraints_ok: every constraint holds;',
    '- findings: each problem with a message, and file, line and severity (high, medium, low) where known;',
    '- evidence: what you checked and what you saw, briefly;',
    '- verdict: `verified` only when acceptance_met, scope_ok and constraints_ok are all true and no',
    '  finding is high; `needs_input` when the task cannot be judged without a human; otherwise',
    '  `rejected`.',
  ].join('\n');
}

// ---- run ---------------------------------------------------------------------------------------

phase('prepare');
const prepared = await ops('prepare', runId, ...takeoverArgs);
if (!prepared.ok) {
  return {
    locked: Boolean(prepared.locked),
    results: [],
    stopped: oneLine(`prepare failed: ${prepared.error || 'unknown error'}`),
  };
}

const tasks = new Map(); // id -> ledger task, in ledger order
const results = [];
let stopped = null;
let prsResult = null;
// Tasks that can never start, in the order they were learned. They are blocked once, when learned,
// and named at the end, but they are no failure of the run: the other tasks keep running.
const badIds = []; // task ids not of the form T<n>
const needAcceptance = []; // ids of tasks with `needsAcceptance: true`
// id -> note of every task set aside. Filled synchronously when an answer reports the task, before
// any further `await`, so `ready` never lets a scheduling step start one.
const aside = new Map();

// Why a task can never start, or null. The helper refuses ledgers with invalid ids; this is the
// second line of defence. A title-only task without proof or budget needs acceptance as well.
function asideNote(t) {
  if (!TASK_ID.test(t.id)) return 'invalid task id: not of the form T<n>';
  if (t.status !== 'todo' && t.status !== 'verified') return null;
  if (t.needsAcceptance === true) return 'needs acceptance';
  if (!text(t.acceptance) && (!text(t.proof) || !text(t.budget))) return 'needs acceptance';
  return null;
}

// Adds the tasks not known yet and returns them; a known task is never removed or overwritten.
function learn(listed) {
  const added = [];
  for (const t of list(listed)) {
    if (!t || typeof t !== 'object') continue;
    const id = typeof t.id === 'string' ? t.id : String(t.id);
    if (tasks.has(id)) continue;
    const known = { ...t, id };
    tasks.set(id, known);
    const note = asideNote(known);
    if (note !== null) {
      aside.set(id, note);
      (TASK_ID.test(id) ? needAcceptance : badIds).push(id);
    }
    added.push(known);
  }
  return added;
}
const initialTasks = learn(prepared.tasks);

// Blocks a task set aside when it was learned, ready or not, and returns whether it did. `block`
// makes no `status` call for an id that may not reach a command line.
async function setAside(t) {
  if (!aside.has(t.id)) return false;
  await block(t, aside.get(t.id), false);
  return true;
}

// Agent types: `args` first, then the ledger's `agents` object, then the defaults. A ledger value
// passes the same rule as an argument; an invalid one starts no agent and stops the run.
const ledgerAgents = prepared.agents && typeof prepared.agents === 'object' ? prepared.agents : {};
let implementerType = 'tasks-ledger:task-implementer';
let reviewerType = 'tasks-ledger:reviewer';
let agentsError = null;
try {
  implementerType = implementerArg !== undefined
    ? implementerArg
    : checkAgentName('agents', 'implementer', ledgerAgents.implementer, implementerType);
  reviewerType = reviewerArg !== undefined
    ? reviewerArg
    : checkAgentName('agents', 'reviewer', ledgerAgents.reviewer, reviewerType);
} catch (error) {
  agentsError = error.message;
}

// `failure` false: the task is set aside and does not count as the run's first failure.
function finishTask(t, status, note, failure = true) {
  t.status = status;
  results.push({ id: t.id, status, note });
  log(`${t.id} ${status}: ${note}`);
  if (failure && status !== 'merged' && stopped === null) stopped = `${t.id} ${status}: ${note}`;
}

async function block(t, note, failure = true) {
  if (TASK_ID.test(t.id)) {
    const answer = await ops('status', t.id, 'blocked', quoteText(note));
    if (!answer.ok) note = `${note} (ledger not updated: ${answer.error || 'no answer'})`;
  }
  finishTask(t, 'blocked', note, failure);
}

async function merge(t) {
  const merged = await ops('merge', t.id);
  if (!merged.ok) return block(t, `merge failed: ${merged.error || 'unknown error'}`);
  finishTask(t, 'merged', `merged @ ${merged.sha || '?'}`);
}

async function verify(t) {
  const answer = await ops('verify', t.id);
  if (answer.ok) return { ok: true, tail: answer.tail };
  const output = [answer.error, answer.tail, list(answer.dirty).join('\n')].filter(Boolean).join('\n');
  return { ok: false, error: answer.error || 'verify failed', output };
}

async function driveTask(t) {
  if (t.status === 'verified') return merge(t); // resumed: reviewed in an earlier run
  if (!text(t.proof) || !text(t.budget)) return block(t, 'not dispatchable: the task has no proof or no budget');

  const place = await ops('worktree', t.id);
  if (!place.ok) return block(t, `worktree failed: ${place.error || 'unknown error'}`);
  if (!isSafePath(place.worktree)) return block(t, 'worktree failed: the helper returned an unsafe worktree path');
  if (!isGitRef(place.branch)) return block(t, 'worktree failed: the helper returned an invalid branch name');
  if (!isGitRef(place.base)) return block(t, 'worktree failed: the helper returned an invalid base ref');
  const diffBase = place.base.startsWith('task/') ? place.base : prepared.start || place.base;

  if ((await runAgent(implementerPrompt(t, place), { agentType: implementerType })) == null) {
    return block(t, 'the implementer did not finish');
  }
  let checked = await verify(t);
  if (!checked.ok) {
    log(`${t.id}: verification failed (${checked.error}); one more implementer attempt`);
    if ((await runAgent(implementerPrompt(t, place, checked.output), { agentType: implementerType })) == null) {
      return block(t, `the implementer did not finish its retry after: ${checked.error}`);
    }
    checked = await verify(t);
    if (!checked.ok) return block(t, `verification failed twice: ${checked.error}`);
  }

  const review = await runAgent(reviewerPrompt(t, place, diffBase, checked.tail), {
    agentType: reviewerType,
    schema: REVIEW_SCHEMA,
  });
  if (review == null || typeof review !== 'object') return block(t, 'the reviewer did not finish');
  if (review.verdict !== 'verified') {
    const findings = list(review.findings)
      .map(f => (f && f.message ? String(f.message) : ''))
      .filter(Boolean)
      .join('; ');
    return block(t, `review ${review.verdict || 'without verdict'}: ${findings || text(review.evidence) || 'no details'}`);
  }
  const consistent =
    review.acceptance_met === true &&
    review.scope_ok === true &&
    review.constraints_ok === true &&
    !list(review.findings).some(f => f && f.severity === 'high');
  if (!consistent) return block(t, 'review inconsistent');

  const marked = await ops('status', t.id, 'verified', quoteText(`review verified: ${text(review.evidence)}`, 2000));
  if (!marked.ok) return block(t, `could not record verified: ${marked.error || 'unknown error'}`);
  t.status = 'verified';
  return merge(t);
}

const running = new Map(); // id -> promise

function ready(t) {
  if (aside.has(t.id)) return false; // set aside: never ready, also while its `status` call runs
  if (t.status !== 'todo' && t.status !== 'verified') return false;
  if (!list(t.dependsOn).every(d => tasks.has(d) && tasks.get(d).status === 'merged')) return false;
  for (const id of running.keys()) if (globListsOverlap(tasks.get(id).files, t.files)) return false;
  return true;
}

function start(t) {
  log(`${t.id} started: ${text(t.title)}`);
  const promise = driveTask(t)
    .catch(error => block(t, `unexpected error: ${(error && error.message) || error}`))
    .catch(error => finishTask(t, 'blocked', `unexpected error: ${(error && error.message) || error}`))
    .finally(() => running.delete(t.id));
  running.set(t.id, promise);
}

// Lock freshness: `refreshDue` is true until a `sync` succeeds, and again once the refresh timer,
// armed for REFRESH_MS by every successful `sync`, fires. At most one refresh timer is armed, and
// one is always armed while a refresh is due after a failed `sync` or once a task agent started.
let refreshDue = true;
let refreshTimer = null;
let syncing = null; // the `sync` in progress, if any; it settles without rejecting
let heartbeat = null; // the heartbeat refresh in progress, if any; it never rejects
let taskAgents = 0; // implementer and reviewer calls in progress
let runEnded = false; // set once the main loop is over: no timer is armed and no heartbeat starts

function armRefreshTimer() {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = runEnded ? null : setTimeout(onRefreshTimer, REFRESH_MS);
}

// Arms the timer when a refresh is due and none is armed, so a due refresh is always attempted.
function keepRefreshTimer() {
  if (refreshDue && refreshTimer === null) armRefreshTimer();
}

function stopRefreshTimer() {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

// Waits until no `sync` is in progress.
async function syncIdle() {
  while (syncing !== null) await syncing;
}

// Returns whether the `sync` succeeded. `label` names a failure in the log. A `sync` is in progress
// from the moment its helper call is made (at once when the serialised helper path is idle, else when
// its turn comes) until its answer has been taken in; the helper path never runs two at once.
async function syncTasks(label = 'sync') {
  let release;
  const settled = new Promise(resolve => {
    release = resolve;
  });
  if (opsQueued === 0) syncing = settled;
  let answer = null;
  let added = [];
  try {
    // The run id lets the helper refresh the lock only while it still names this run.
    answer = await serialised(() => {
      syncing = settled;
      return runOps(opsLine('sync', [runId]));
    });
    if (answer.ok) {
      refreshDue = false;
      armRefreshTimer();
      // `learn` sets unstartable tasks aside before the first `await` below.
      added = learn(answer.tasks);
    }
  } finally {
    if (syncing === settled) syncing = null;
    release();
    // A failed `sync` leaves the refresh due; the timer makes sure it is attempted again.
    if (!answer || !answer.ok) keepRefreshTimer();
  }
  if (!answer.ok) {
    log(`${label} failed: ${answer.error || 'unknown error'}`);
    return false;
  }
  for (const t of added) await setAside(t);
  return true;
}

// The refresh timer fired: the lock is due for a refresh. While an implementer or reviewer is in
// progress, the heartbeat refreshes it straight away; otherwise the next agent boundary does.
function onRefreshTimer() {
  refreshTimer = null;
  refreshDue = true;
  if (runEnded || taskAgents === 0 || heartbeat !== null) return;
  heartbeat = beat().finally(() => {
    heartbeat = null;
  });
}

// A `sync` already in progress is awaited first and makes the heartbeat unnecessary when it
// succeeded. A failed heartbeat is logged and retried after REFRESH_MS while agents keep running; it
// never ends the run.
async function beat() {
  try {
    // No `await` between the last check and the start of the `sync`, so no other refresh slips in.
    while (syncing !== null) await syncing;
    if (!refreshDue || runEnded || taskAgents === 0) return;
    await syncTasks('lock refresh');
  } catch (error) {
    log(`lock refresh failed: ${(error && error.message) || error}`);
  }
  keepRefreshTimer();
}

// Keeps the run lock fresh at an agent boundary, only while a refresh is due. A `sync` already in
// progress is awaited first, so a boundary never doubles it. A failed refresh is only logged.
async function refreshLock() {
  while (syncing !== null) await syncing;
  if (!refreshDue) return;
  try {
    await syncTasks();
  } catch (error) {
    log(`lock refresh failed: ${(error && error.message) || error}`);
  }
}

// An implementer or reviewer agent, with a lock refresh right before it starts and right after it
// returns (also when it throws).
async function runAgent(prompt, options) {
  await refreshLock();
  taskAgents++;
  keepRefreshTimer();
  try {
    return await agent(prompt, options);
  } finally {
    taskAgents--;
    await refreshLock();
  }
}

// A `start` from prepare is checked once, before any task agent runs. An invalid one stops the run
// and blocks every task it would otherwise drive. Tasks that can never start are set aside first,
// in the same pass in ledger order.
const badStart = prepared.start != null && !isGitRef(prepared.start);
const startReason = badStart ? `prepare returned an invalid start ref ${cut(JSON.stringify(String(prepared.start)), 80)}` : null;
if (badStart) stopped = startReason;
for (const t of initialTasks) {
  if (await setAside(t)) continue;
  if (badStart && (t.status === 'todo' || t.status === 'verified')) await block(t, startReason);
}

if (agentsError !== null) stopped = stopped === null ? agentsError : `${agentsError}; ${stopped}`;

phase('run tasks');
try {
  while (!badStart && agentsError === null) {
    if (stopped === null) {
      // `running` grows inside this loop, so two tasks that become ready together never overlap.
      for (const t of tasks.values()) if (!running.has(t.id) && ready(t)) start(t);
    }
    if (running.size > 0) {
      await Promise.race(running.values());
      await syncTasks(); // also refreshes the run lock
      continue;
    }
    if (stopped !== null) break;
    await syncTasks();
    if (![...tasks.values()].some(ready)) break;
  }
} catch (error) {
  if (stopped === null) stopped = `unexpected error: ${(error && error.message) || error}`;
  await Promise.allSettled(running.values());
}
// No timer outlives the run, and no `sync` runs once `prs` or `finish` may start.
runEnded = true;
stopRefreshTimer();
if (heartbeat !== null) await heartbeat;
await syncIdle();
stopRefreshTimer();

const idsWith = status => [...tasks.values()].filter(t => t.status === status).map(t => t.id);
const waiting = idsWith('todo');
const blocked = idsWith('blocked');
// Tasks set aside are named here, each exactly once and before any other reason; no other reason
// names them, since they are neither a failure nor unfinished work.
if (stopped === null) {
  const unfinished = [...tasks.values()]
    .filter(t => t.status !== 'merged' && !aside.has(t.id))
    .map(t => `${t.id} ${t.status}`);
  if (unfinished.length) stopped = `unfinished tasks: ${unfinished.join(', ')}`;
}
const shownId = id => (/^[A-Za-z0-9._-]+$/.test(id) ? id : JSON.stringify(id));
const asideReasons = needAcceptance.map(id => `${id} needs acceptance`);
if (badIds.length) asideReasons.push(`invalid task ids: ${badIds.map(shownId).join(', ')}`);
if (asideReasons.length) stopped = [...asideReasons, ...(stopped === null ? [] : [stopped])].join('; ');

phase('finish');
if (stopped === null && prepared.prs === true) {
  const prs = await ops('prs');
  prsResult = list(prs.results);
  if (!prs.ok) stopped = `prs failed: ${prs.error || 'unknown error'}`;
}
if (stopped !== null) stopped = oneLine(stopped);

// The run id comes last, so the helper removes the lock only while it still names this run. A
// finished run passes an empty reason, which the helper stores as `null` (`stopReason`).
const finished = stopped === null
  ? await ops('finish', 'finished', '""', runId)
  : await ops('finish', 'stopped', quoteText(stopped), runId);
// A refused `finish` leaves the ledger's run status as it was, so the run did not complete: the
// reason says so, after any earlier one, and a lock now held by another run is reported as `locked`.
let locked = false;
if (!finished.ok) {
  locked = finished.locked === true;
  const why = `finish failed: ${finished.error || 'unknown error'}`;
  log(why);
  stopped = oneLine(stopped === null ? why : `${stopped}; ${why}`);
}

return {
  blocked,
  integration: prepared.integration,
  ledger: ledgerPath,
  locked,
  prs: prsResult,
  results,
  stopped,
  waiting,
};
