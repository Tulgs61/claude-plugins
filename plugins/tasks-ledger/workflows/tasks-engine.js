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
const UNSAFE_PATH = /["$`\\!]|[\u0000-\u001f\u007f]/;
const STOPPED_MAX = 300;

// ---- arguments (all checks happen before the first agent call) ---------------------------------

if (args == null || typeof args !== 'object') throw new Error('args must be an object');

function requirePath(key) {
  const value = args[key];
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`args.${key} is required and must be an absolute path`);
  }
  // The path is double-quoted on the command line; refuse everything bash still expands there.
  if (UNSAFE_PATH.test(value)) {
    throw new Error(`args.${key} contains characters that are not safe on a command line`);
  }
  return value;
}

function agentName(key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !AGENT_NAME.test(value)) {
    throw new Error(`args.${key} must match ${AGENT_NAME.source}`);
  }
  return value;
}

const ledgerPath = requirePath('ledger');
const scriptPath = requirePath('script');
if (typeof args.runId !== 'string' || !RUN_ID.test(args.runId)) {
  throw new Error(`args.runId is required and must match ${RUN_ID.source}`);
}
const runId = args.runId;
const implementerType = agentName('implementerAgent', 'tasks-ledger:task-implementer');
const reviewerType = agentName('reviewerAgent', 'tasks-ledger:reviewer');
const takeover = Boolean(args.takeover);

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
const isSafePath = value => typeof value === 'string' && value.startsWith('/') && !UNSAFE_PATH.test(value);

// `result.stopped` is always one line of at most STOPPED_MAX characters.
function oneLine(reason) {
  return String(reason).replace(/\s+/g, ' ').trim().slice(0, STOPPED_MAX).trim();
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
function serialised(fn) {
  const run = opsChain.then(fn, fn);
  opsChain = run.catch(() => {});
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

function ops(subcommand, ...rest) {
  const command = [subcommand, `"${ledgerPath}"`, ...rest].join(' ');
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
const prepared = await ops('prepare', runId, ...(takeover ? ['takeover'] : []));
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

function learn(listed) {
  for (const t of list(listed)) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || tasks.has(t.id)) continue;
    tasks.set(t.id, { ...t });
  }
}
learn(prepared.tasks);

function finishTask(t, status, note) {
  t.status = status;
  results.push({ id: t.id, status, note });
  log(`${t.id} ${status}: ${note}`);
  if (status !== 'merged' && stopped === null) stopped = `${t.id} ${status}: ${note}`;
}

async function block(t, note) {
  if (TASK_ID.test(t.id)) {
    const answer = await ops('status', t.id, 'blocked', quoteText(note));
    if (!answer.ok) note = `${note} (ledger not updated: ${answer.error || 'no answer'})`;
  }
  finishTask(t, 'blocked', note);
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
  if (!TASK_ID.test(t.id)) return finishTask(t, 'blocked', 'task id is not of the form T<n>');
  if (t.status === 'verified') return merge(t); // resumed: reviewed in an earlier run
  if (!text(t.proof) || !text(t.budget)) return block(t, 'not dispatchable: the task has no proof or no budget');

  const place = await ops('worktree', t.id);
  if (!place.ok) return block(t, `worktree failed: ${place.error || 'unknown error'}`);
  if (!isSafePath(place.worktree)) return block(t, 'worktree failed: the helper returned an unsafe worktree path');
  if (!isGitRef(place.branch)) return block(t, 'worktree failed: the helper returned an invalid branch name');
  if (!isGitRef(place.base)) return block(t, 'worktree failed: the helper returned an invalid base ref');
  const diffBase = place.base.startsWith('task/') ? place.base : prepared.start || place.base;
  if (!isGitRef(diffBase)) return block(t, 'prepare returned an invalid start ref');

  if ((await agent(implementerPrompt(t, place), { agentType: implementerType })) == null) {
    return block(t, 'the implementer did not finish');
  }
  let checked = await verify(t);
  if (!checked.ok) {
    log(`${t.id}: verification failed (${checked.error}); one more implementer attempt`);
    if ((await agent(implementerPrompt(t, place, checked.output), { agentType: implementerType })) == null) {
      return block(t, `the implementer did not finish its retry after: ${checked.error}`);
    }
    checked = await verify(t);
    if (!checked.ok) return block(t, `verification failed twice: ${checked.error}`);
  }

  const review = await agent(reviewerPrompt(t, place, diffBase, checked.tail), {
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

async function syncTasks() {
  const answer = await ops('sync');
  if (answer.ok) learn(answer.tasks);
  else log(`sync failed: ${answer.error || 'unknown error'}`);
}

phase('run tasks');
try {
  for (;;) {
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

const idsWith = status => [...tasks.values()].filter(t => t.status === status).map(t => t.id);
const waiting = idsWith('todo');
const blocked = idsWith('blocked');
if (stopped === null) {
  const unfinished = [...tasks.values()].filter(t => t.status !== 'merged').map(t => `${t.id} ${t.status}`);
  if (unfinished.length) stopped = `unfinished tasks: ${unfinished.join(', ')}`;
}

phase('finish');
if (stopped === null && prepared.prs === true) {
  const prs = await ops('prs');
  prsResult = list(prs.results);
  if (!prs.ok) stopped = `prs failed: ${prs.error || 'unknown error'}`;
}
if (stopped !== null) stopped = oneLine(stopped);

const finished = stopped === null
  ? await ops('finish', 'finished')
  : await ops('finish', 'stopped', quoteText(stopped));
if (!finished.ok) log(`finish failed: ${finished.error || 'unknown error'}`);

return {
  blocked,
  integration: prepared.integration,
  ledger: ledgerPath,
  prs: prsResult,
  results,
  stopped,
  waiting,
};
