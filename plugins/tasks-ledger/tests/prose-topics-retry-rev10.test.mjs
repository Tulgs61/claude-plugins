// Rev 10 amendments 9-12 of the tasks-prose spec: no `dispatch` topics and cleanup by checked-out
// branch, refresh keeps the top-level keys tasks-plan does not own, retry admission, and ledger keys
// written as code spans. As amendment 7 asks, the prose is checked for key terms and commands, not
// for whole sentences; where a rule can be exercised, it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TASKS = read('../skills/tasks/SKILL.md');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const SKILLS = { dispatch: read('../skills/dispatch/SKILL.md'), tasks: TASKS, 'tasks-plan': PLAN };
const schema = JSON.parse(read('../schemas/tasks.schema.json'));
const TOP_KEYS = Object.keys(schema.properties);
const LEDGER_KEYS = [...TOP_KEYS, ...Object.keys(schema.properties.tasks.items.properties)];

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

// One numbered step of a list, from its number up to the next one.
function step(text, n) {
  const start = text.search(new RegExp(`\\n${n}\\. `));
  assert.ok(start >= 0, `step ${n} exists`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n\d+\. /);
  return end < 0 ? rest : rest.slice(0, end);
}

// 9. No `dispatch` topics.
test('rev10-9: tasks-plan never writes a dispatch topic, picks another slug and says so', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /never `dispatch` and never starts with `dispatch-`/);
  assert.match(create, /pick another one and say so/);
  const validate = flat(section(PLAN, '5. Validate and reply'));
  assert.match(validate, /not `dispatch` and does not start with `dispatch-`/);
});

test('rev10-9: cleanup collects worktrees by checked-out task/<topic>/ branch, never by directory name', () => {
  const collect = flat(step(section(TASKS, 'Cleanup'), 1));
  assert.match(collect, /^1\. \*\*Collect\.\*\*/);
  assert.ok(codeSpans(collect).includes('git -C <root> worktree list --porcelain'), 'lists worktrees with their branches');
  assert.ok(codeSpans(collect).includes('branch refs/heads/task/<topic>/…'), 'matches on the branch line');
  assert.match(collect, /never by its directory name alone/);
  assert.match(collect, /`dispatch-<slug>` worktree on a `dispatch\/<slug>` branch is never a cleanup item/);
  assert.doesNotMatch(collect, /worktrees\/<topic>-\*/, 'no collection by directory glob');
});

test('rev10-9: the documented collection keeps dispatch and foreign worktrees out of cleanup', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['a.txt'])] });
  const run = sb.ok('worktree', 'T1');
  const wt = name => path.join(sb.repo, '.claude', 'worktrees', name);
  // A dispatch worktree, and a worktree whose directory looks like the run's but holds another branch.
  sb.git(sb.repo, 'worktree', 'add', '-q', '-b', 'dispatch/x', wt('dispatch-x'), 'main');
  sb.git(sb.repo, 'worktree', 'add', '-q', '-b', 'other', wt(`${TOPIC}-T9`), 'main');
  // A detached worktree whose directory is named like a task worktree of the run.
  sb.git(sb.repo, 'worktree', 'add', '-q', '--detach', wt(`${TOPIC}-T8`), 'main');
  const collect = step(section(TASKS, 'Cleanup'), 1);
  const cmd = codeSpans(collect).find(s => s.includes('worktree list'));
  const line = codeSpans(collect).find(s => s.startsWith('branch refs/heads/'));
  const args = cmd.replaceAll('<root>', sb.repo).split(' ');
  const listing = sb.git(sb.repo, ...args.slice(1));
  const prefix = line.replace('<topic>', TOPIC).replace(/…$/, '');
  const collected = listing.split(/\n\n+/)
    .filter(entry => entry.split('\n').some(l => l.startsWith(prefix)))
    .map(entry => entry.match(/^worktree (.*)$/m)[1]);
  assert.deepEqual(collected.map(p => path.basename(p)), [path.basename(run.worktree)]);
});

// 10. Refresh keeps top-level keys.
test('rev10-10: a refresh keeps every top-level key tasks-plan does not own, agents among them', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  const m = create.match(/you own only ([^.]*)\. Every other top-level key, among them ([^,]*(?:, [^,]*)*?) and any key the schema does not list, is kept exactly as it was/);
  assert.ok(m, 'owned keys and kept keys stated');
  const owned = codeSpans(m[1]);
  const kept = codeSpans(m[2]);
  assert.ok(kept.includes('agents'), 'agents is kept');
  for (const key of [...owned, ...kept]) assert.ok(TOP_KEYS.includes(key), `${key} is a top-level ledger key`);
  for (const key of ['agents', 'runStatus', 'stopReason', 'integrationBranch']) assert.ok(!owned.includes(key), `${key} not owned`);
  assert.match(create, /never dropped, renamed or given another value/);
  assert.match(flat(section(PLAN, '5. Validate and reply')), /every top-level key you do not own is unchanged/);
});

// 11. Retry admission.
test('rev10-11: retry admits a blocked task and a todo task with needsAcceptance, nothing else', () => {
  const admit = flat(step(section(TASKS, 'Retry'), 1));
  assert.match(admit, /a `blocked` task, and a `todo` task with `needsAcceptance` true/);
  assert.match(admit, /Any other task \(or an unknown id\) is refused/);
});

test('rev10-11: the helper status call happens only for a blocked task', () => {
  const retry = section(TASKS, 'Retry');
  const calls = retry.split('\n').filter(l => l.includes('node "<helper>" status'));
  assert.equal(calls.length, 1, 'one status call');
  const requeue = flat(step(retry, 4));
  assert.ok(requeue.includes('node "<helper>" status'), 'the call is in step 4');
  assert.match(requeue, /^4\. Only if the task is `blocked`/);
  assert.match(requeue, /A `todo` task is already queued and gets no `status` call/);
});

// 12. Key spelling.
test('rev10-12: every camelCase ledger key the skills name is a code span', () => {
  for (const [name, text] of Object.entries(SKILLS)) {
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
    for (const key of LEDGER_KEYS.filter(k => /[A-Z]/.test(k))) {
      assert.doesNotMatch(prose, new RegExp(`\\b${key}\\b`), `${name} names ${key} outside a code span`);
    }
  }
  assert.ok(LEDGER_KEYS.includes('needsAcceptance'), 'the schema has needsAcceptance');
  for (const heading of ['Retry', 'Status', 'Reporting']) {
    assert.ok(codeSpans(section(TASKS, heading)).includes('needsAcceptance'), `${heading} spells needsAcceptance as a code span`);
  }
});
