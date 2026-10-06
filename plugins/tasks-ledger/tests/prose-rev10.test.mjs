// Rev 10 amendments of the tasks-prose spec: the dispatch namespace and its live-run check, cleanup
// next to a live run, the named takeover, agent types in the ledger, tasks that need acceptance, the
// `..` overlap examples and the verify consent in the conventions. As amendment 7 asks, the prose is
// checked for key terms and commands, not for whole sentences; where a rule can be exercised, it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, markerBlock, sandbox, task } from './helpers/git-sandbox.mjs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TASKS = read('../skills/tasks/SKILL.md');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const DISPATCH = read('../skills/dispatch/SKILL.md');
const CONVENTIONS = read('../rules/conventions.md');

// The body of a `## <heading>` section, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

const flat = text => text.replace(/\s+/g, ' ');
const codeSpans = text => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

// The helper's own overlap function, taken from its glob-overlap block.
const { globsOverlap } = new Function(`${markerBlock(readFileSync(SCRIPT, 'utf8'))}\nreturn { globsOverlap };`)();

// 1. Dispatch namespace.
test('rev10-1: dispatch commits on dispatch/<slug> in <root>/.claude/worktrees/dispatch-<slug>', () => {
  const where = flat(section(DISPATCH, '3. Settle where the commits go'));
  assert.ok(where.includes('`dispatch/<slug>`'), 'names the dispatch/<slug> branch');
  assert.ok(where.includes('`<root>/.claude/worktrees/dispatch-<slug>`'), 'names the dispatch worktree');
  assert.ok(codeSpans(where).includes('git -C <root> worktree add -b dispatch/<slug> <root>/.claude/worktrees/dispatch-<slug> <base>'));
  assert.match(where, /never on a `task\/…` branch/);
  for (const span of codeSpans(DISPATCH)) assert.doesNotMatch(span, /\btask\/<slug>/, `no task/<slug> in ${span}`);
  assert.doesNotMatch(DISPATCH, /`branch`\s*\/\s*`worktree` when\s+they are set/, 'ledger branch and worktree are not taken over');
  const block = DISPATCH.match(/```text\n([\s\S]*?)```/)[1];
  const deliverable = block.split('\n').find(l => l.startsWith('DELIVERABLE:'));
  assert.match(deliverable, /<dispatch branch> in <dispatch worktree>/);
  assert.doesNotMatch(deliverable.split(';')[0], /main checkout|\b(main|master|develop|trunk)\b|task\//);
});

test('rev10-1: the documented dispatch command stays out of the helper namespace of a run', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a.txt'])] });
  const run = sb.ok('worktree', 'T1');
  const before = sb.git(sb.repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/task/');
  const cmd = codeSpans(section(DISPATCH, '3. Settle where the commits go')).find(s => s.includes(' worktree add '));
  assert.ok(cmd, 'worktree command documented');
  const filled = cmd.replaceAll('<root>', sb.repo).replaceAll('<slug>', 'demo-t1').replaceAll('<base>', 'main');
  const args = filled.split(' ');
  assert.equal(args[0], 'git');
  sb.git(sb.repo, ...args.slice(1));
  // Even with a slug that looks like a run worktree name, the branch and worktree are not the run's.
  assert.equal(sb.tryGit(sb.repo, 'rev-parse', '--verify', '-q', 'refs/heads/dispatch/demo-t1'), 0);
  const worktree = path.join(sb.repo, '.claude', 'worktrees', 'dispatch-demo-t1');
  assert.ok(existsSync(worktree));
  assert.notEqual(worktree, run.worktree);
  assert.equal(sb.git(sb.repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/task/'), before);
  assert.equal(sb.git(sb.repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'main checkout not switched');
});

// 2. Dispatch next to a live run.
test('rev10-2: dispatch reads the ledger .lock and offers no run worktree while it is fresh', () => {
  const find = section(DISPATCH, '1. Find the task');
  const ledgerPart = flat(find.slice(find.indexOf('**A ledger id**'), find.indexOf('**Free text**')));
  assert.ok(ledgerPart.includes('`.lock`'), 'reads the .lock');
  assert.match(ledgerPart, /six hours/);
  assert.match(ledgerPart, /live/);
  assert.match(ledgerPart, /`runId`/);
  assert.match(ledgerPart, /\bage\b/);
  assert.match(ledgerPart, /Offer no worktree under `<root>\/\.claude\/worktrees\/<topic>-…`/);
  const freeText = flat(find.slice(find.indexOf('**Free text**')));
  assert.match(freeText, /no ledger and no lock/);
});

// 3. Cleanup next to a live run.
test('rev10-3: cleanup reads the .lock first and removes nothing while it is fresh', () => {
  const cleanup = section(TASKS, 'Cleanup');
  const lockAt = cleanup.indexOf('`.lock`');
  assert.ok(lockAt >= 0, 'cleanup reads the .lock');
  assert.ok(lockAt < cleanup.indexOf('**Collect.**'), 'before collecting anything');
  assert.ok(lockAt < cleanup.indexOf('git -C <root> worktree remove'), 'before removing anything');
  const step = flat(cleanup.slice(lockAt, cleanup.indexOf('**Collect.**')));
  assert.match(step, /six hours/);
  assert.match(step, /remove nothing/);
  assert.match(step, /run id and age/);
  assert.match(step, /stop/);
});

// 4. Named takeover.
test('rev10-4: takeover passes the run id shown to the user, never a bare true', () => {
  assert.ok(TASKS.includes('`prepare <runId> takeover <heldRunId>`'), 'names the helper call with the held run id');
  const lock = flat(section(TASKS, 'Live lock'));
  assert.ok(lock.includes('`"takeover": "<lock runId>"`'), 'the engine gets the lock run id');
  assert.match(lock, /the run id you showed the user/);
  // Every remaining `"takeover": true` is a prohibition.
  for (const m of flat(TASKS).matchAll(/`"takeover": true`/g)) {
    assert.match(flat(TASKS).slice(m.index - 20, m.index), /never a bare $/, 'a bare true only as a prohibition');
  }
  const start = flat(section(TASKS, 'Starting the engine'));
  assert.match(start, /`takeover` set to that run id/);
  assert.match(start, /takeover <heldRunId>/);
  const resume = flat(section(TASKS, 'Resume'));
  assert.match(resume, /`takeover` with the shown run id/);
});

// 5. Agent types in the ledger.
test('rev10-5: agent types go into the ledger agents object before the start, never while a run is live', () => {
  const agents = flat(section(TASKS, 'Agent types'));
  assert.ok(agents.includes("top-level `agents` object"), 'names the agents object');
  assert.ok(agents.includes('`implementer`') && agents.includes('`reviewer`'), 'names its members');
  assert.match(agents, /never while a run is live/);
  assert.match(agents, /only before the run starts/);
  assert.match(agents, /`implementerAgent`/);
  assert.match(agents, /overrides the ledger/);
  // The new run records them before it starts the engine.
  const newRun = section(TASKS, 'New run');
  assert.ok(newRun.indexOf('"Agent types"') >= 0 && newRun.indexOf('"Agent types"') < newRun.indexOf('"Starting the engine"'));
  // A resume does not pass them again.
  const resume = flat(section(TASKS, 'Resume'));
  assert.doesNotMatch(resume, /not stored in the ledger|pass those agent arguments again/);
  assert.match(resume, /`agents` object need no engine arguments/);
  assert.doesNotMatch(flat(section(TASKS, 'Starting the engine')), /Only when the user asks for their own agents, add/);
});

// 6. Tasks that need acceptance.
test('rev10-6: add writes a non-empty acceptance; status, report and retry handle needsAcceptance', () => {
  assert.match(flat(section(TASKS, 'Add')), /a non-empty `acceptance`/);
  assert.match(section(TASKS, 'Status'), /needsAcceptance/);
  assert.match(section(TASKS, 'Reporting'), /needsAcceptance/);
  const retry = section(TASKS, 'Retry');
  const flatRetry = flat(retry);
  assert.match(flatRetry, /needsAcceptance/);
  assert.match(flatRetry, /refuse the retry until the user supplies/);
  assert.match(flatRetry, /with no run live/);
  assert.match(flatRetry, /remove its `needsAcceptance` key/);
  // The acceptance is written only after the live-lock step and before the task is re-queued.
  const written = retry.indexOf('**Needs acceptance.**');
  assert.ok(retry.indexOf('"Live lock"') < written, 'lock handled before the ledger is written');
  assert.ok(written < retry.indexOf('node "<helper>" status'), 'acceptance supplied before the re-queue');
});

// 7. Prose tests pin key terms; the `..` overlap examples.
test('rev10-7: the overlap examples a/../b, a/.. and x..y overlap everything, as in the helper', () => {
  const rule = flat(section(PLAN, '3. Shape the tasks'));
  const m = rule.match(/`([^`]+)`, `([^`]+)` and `([^`]+)` each overlap every other pattern/);
  assert.ok(m, 'examples sentence found');
  const examples = m.slice(1);
  assert.deepEqual(examples, ['a/../b', 'a/..', 'x..y']);
  for (const p of examples) {
    for (const other of ['src/a.ts', 'lib/**', 'b', 'a/b/c', 'x/y', 'docs/*.md']) {
      assert.equal(globsOverlap(p, other), true, `${p} / ${other}`);
      assert.equal(globsOverlap(other, p), true, `${other} / ${p}`);
    }
  }
});

test('rev10-7: the key terms are present', () => {
  assert.ok(DISPATCH.includes('dispatch/<slug>'));
  assert.ok(DISPATCH.includes('.lock'));
  assert.ok(TASKS.includes('takeover <heldRunId>'));
  assert.ok(TASKS.includes('`agents`'));
  assert.ok(TASKS.includes('needsAcceptance'));
  assert.ok(CONVENTIONS.includes('dispatch/<slug>'));
});

// 8. Verify consent in the docs.
test('rev10-8: conventions state the terminal consent and the one-time warning next to the umask advice', () => {
  const verify = flat(section(CONVENTIONS, '`.claude/verify.cmd` (opt-in)'));
  assert.match(verify, /only after the user approved/);
  assert.match(verify, /in a terminal/);
  assert.ok(verify.includes('scripts/verify-consent.js" approve'), 'names the approve command');
  const warning = verify.search(/group- or world-writable `verify\.cmd` is skipped as well, with a one-time warning/);
  assert.ok(warning >= 0, 'loose permissions skipped with a one-time warning');
  const umask = verify.indexOf('umask `002`');
  assert.ok(umask > warning && umask - warning < 300, 'the umask advice follows the warning');
  assert.match(verify, /`umask 022`/);
});
