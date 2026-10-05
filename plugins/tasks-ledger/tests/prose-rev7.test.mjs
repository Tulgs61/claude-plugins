// Rev 7 amendments of the tasks-prose spec: tasks-plan corrects `topic` only before the first run,
// and the reviewer never counts an unconfirmed proof, or a verify result without its tail, as met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const REVIEWER = read('../agents/reviewer.md');

// The body of a `## <heading>` section, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

const flat = text => text.replace(/\s+/g, ' ');

// 1. `topic` correction only before the first run.
test('rev7-1: topic is filled in or corrected only before the first run', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /a missing `topic` or one that differs from the slug may be filled in or corrected only before the first run/);
  assert.match(create, /`runStatus` is `planned` or absent/);
  assert.match(create, /every task is `todo`, with `branch`, `base` and `worktree` all null/);
  assert.match(create, /no `task\/<stored topic>\/` branch exists/);
  // The branch check is a read-only listing of the stored topic's branches.
  assert.match(create, /`git for-each-ref refs\/heads\/task\/<stored topic>\/ [^`]*` prints nothing/);
});

test('rev7-1: in every other case the mismatch is reported, not rewritten', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /In every other case, stop and report the mismatch/);
  assert.match(create, /instead of rewriting it or writing anything else/);
  const validate = flat(section(PLAN, '5. Validate and reply'));
  assert.match(validate, /except a `topic` mismatch that step 2 does not let you correct: that one you report/);
});

test('rev7-1: the rev 5 rule that let `blocked` tasks through is gone', () => {
  const plan = flat(PLAN);
  assert.doesNotMatch(plan, /a missing `topic` is filled in from the file name/);
  assert.doesNotMatch(plan, /corrected only while every task is still `todo` or `blocked`/);
  assert.doesNotMatch(plan, /any task has left `todo`\/`blocked`/);
});

// 2. Unconfirmed proof is never acceptance.
test('rev7-2: acceptance_met is never true on the proof only the implementer ran', () => {
  const decide = flat(section(REVIEWER, 'What to decide'));
  assert.match(decide, /answer `needs_input`, or record a finding and set `acceptance_met` to false/);
  assert.match(decide, /never set `acceptance_met` to true when it depends on the proof that only the implementer ran/);
  const verdict = flat(section(REVIEWER, 'The verdict'));
  assert.match(verdict, /unconfirmed proof[^.]*\. In that case `acceptance_met` is false, never true/);
});

// 3. Verify result only with evidence.
test('rev7-3: the verify result counts only together with its output tail', () => {
  const given = flat(section(REVIEWER, 'What you get'));
  assert.match(given, /only when the prompt actually includes that output tail/);
  assert.match(given, /Without it[^.]*, the verify result is unconfirmed as well/);
  const look = flat(section(REVIEWER, 'How to look'));
  assert.match(look, /Take the `\.claude\/verify\.cmd` result from the prompt, and only together with its output tail/);
});

test('rev7-3: the engine placeholder for an empty tail is not taken as evidence', () => {
  // The engine prints `(no output)` when verify produced nothing; the reviewer treats that as no tail.
  const engine = read('../workflows/tasks-engine.js');
  assert.match(engine, /'\(no output\)'/);
  assert.match(flat(section(REVIEWER, 'What you get')), /placeholder such as `\(no output\)`/);
});
