// Rev 10 amendments 13-17 of the tasks-prose spec: the lock is read again before every ledger edit,
// a refresh clears `needsAcceptance`, retry completes a title-only task, old `dispatch` topics are
// refused, and every engine start with a takeover names the confirmed run id. As amendment 7 asks,
// the prose is checked for key terms and commands, not for whole sentences; where a rule can be
// exercised, it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TASKS = read('../skills/tasks/SKILL.md');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const schema = JSON.parse(read('../schemas/tasks.schema.json'));

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

// 13. Re-check the lock before every ledger edit.
test('rev10-13: the lock is read again right before every ledger edit', () => {
  const recheck = flat(section(TASKS, 'Before a ledger edit'));
  assert.ok(recheck.includes('`.lock` again'), 'reads the .lock again');
  assert.ok(recheck.includes('`agents`') && recheck.includes('acceptance'), 'covers agents and acceptance edits');
  assert.match(recheck, /missing/);
  assert.match(recheck, /stale \(`at` more than six hours ago\)/);
  assert.match(recheck, /still exactly the `runId` and `at` you showed the user/);
  assert.match(recheck, /edit nothing/);
  assert.match(recheck, /ask again/);
  // Both places that edit the ledger go through it.
  assert.match(flat(section(TASKS, 'Agent types')), /`\.lock` again as under "Before a ledger edit"/);
  const write = flat(step(section(TASKS, 'Retry'), 3));
  const at = write.indexOf('"Before a ledger edit"');
  assert.ok(at >= 0, 'retry re-checks before writing the acceptance');
  assert.ok(at < write.indexOf('Edit tool'), 're-check comes before the edit');
  assert.match(flat(section(TASKS, 'Ground rules')), /Right before every edit of the ledger itself, read the `\.lock` again/);
});

// 14. Refresh clears `needsAcceptance`.
test('rev10-14: a refresh that gives an acceptance clears needsAcceptance in the same write', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.ok(codeSpans(create).includes('needsAcceptance'));
  assert.match(create, /non-empty `acceptance`, remove its `needsAcceptance` key in the same write/);
  assert.match(create, /still has no acceptance[^.]*reported as needing one[^.]*not counted as ready/);
  const validate = flat(section(PLAN, '5. Validate and reply'));
  assert.match(validate, /no task with a non-empty `acceptance` still has `needsAcceptance`/);
  assert.match(validate, /needs an acceptance[^;]*not ready/);
  // Removing the key leaves a task the schema accepts; the key itself is a schema task key.
  assert.equal(schema.properties.tasks.items.properties.needsAcceptance.type, 'boolean');
  assert.ok(!schema.properties.tasks.items.required.includes('needsAcceptance'), 'the key may be absent');
});

// 15. Retry completes a title-only task.
test('rev10-15: retrying a needsAcceptance task settles proof and budget with the acceptance', () => {
  const write = flat(step(section(TASKS, 'Retry'), 3));
  assert.match(write, /^3\. \*\*Needs acceptance\.\*\*/);
  assert.match(write, /missing `proof` and `budget` together with the acceptance/);
  assert.match(write, /work them out with the user/);
  assert.match(write, /blocked again/);
  // They are written in the same edit that removes `needsAcceptance`.
  const edit = write.slice(write.indexOf('Then,'));
  assert.ok(edit.indexOf('`proof`') >= 0 && edit.indexOf('`budget`') >= 0, 'proof and budget are written');
  assert.ok(edit.indexOf('`budget`') < edit.indexOf('remove its `needsAcceptance` key in the same edit'));
});

// 16. Old `dispatch` topics.
test('rev10-16: the tasks skill refuses to start, resume or retry on a dispatch topic and says how to rename', () => {
  const refuse = flat(section(TASKS, 'Dispatch topics'));
  assert.match(refuse, /ledger's `topic`\. If it is `dispatch` or starts with `dispatch-`, refuse/);
  assert.match(refuse, /start, resume and retry nothing/);
  assert.match(refuse, /\*\*why\*\*/);
  assert.match(refuse, /\*\*how to rename it\*\*/);
  assert.ok(refuse.includes('`dispatch/<slug>`'), 'names the dispatch branch namespace');
  assert.ok(refuse.includes('YYYY-MM-DD-<new slug>.json'), 'names the renamed ledger');
  for (const mode of ['Resume', 'Retry']) {
    const first = flat(step(section(TASKS, mode), 1));
    assert.ok(first.includes('"Dispatch topics"'), `${mode} checks the topic first`);
  }
  // Retry refuses before the lock question and the helper call; New run before the start.
  const retry = section(TASKS, 'Retry');
  assert.ok(retry.indexOf('"Dispatch topics"') < retry.indexOf('"Live lock"'));
  assert.ok(retry.indexOf('"Dispatch topics"') < retry.indexOf('node "<helper>" status'));
  assert.match(flat(step(section(TASKS, 'New run'), 5)), /"Starting the engine", once the ledger's `topic` has passed the check under "Dispatch topics"/);
  assert.match(flat(section(TASKS, 'Starting the engine')), /Never start on a ledger whose `topic` is `dispatch` or starts with `dispatch-`/);
  // The rule matches the topics tasks-plan never writes.
  const isDispatchTopic = t => t === 'dispatch' || t.startsWith('dispatch-');
  assert.deepEqual(['dispatch', 'dispatch-x', 'dispatcher', 'api-split'].map(isDispatchTopic), [true, true, false, false]);
});

// 17. Engine start uses the named takeover.
test('rev10-17: every takeover the tasks skill passes is the confirmed run id, never true', () => {
  const sentences = flat(TASKS).split(/(?<=[.;])\s+/);
  const passing = sentences.filter(s => /`takeover`|`"takeover":/.test(s) && !/no `takeover`/.test(s));
  assert.ok(passing.length >= 5, 'takeover named in the lock, resume, retry and start sections');
  for (const s of passing) assert.match(s, /run id|<lock runId>/, s);
  assert.match(flat(step(section(TASKS, 'Retry'), 5)), /`takeover` set to the run id shown in step 2/);
  assert.match(flat(section(TASKS, 'Ground rules')), /its value is always the run id shown to the user, never `true`/);
  // The documented example value is a run id the helper and the engine accept.
  const start = section(TASKS, 'Starting the engine');
  const example = codeSpans(start).map(s => s.match(/^"takeover": "([^"]+)"$/)).find(Boolean);
  assert.ok(example, 'a takeover example with a string value');
  assert.match(example[1], /^[A-Za-z0-9-]{4,64}$/);
  assert.ok(!/"takeover":\s*true/.test(start), 'the start section never shows a bare true');
});
