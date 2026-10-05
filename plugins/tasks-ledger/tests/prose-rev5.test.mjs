// Rev 5 amendments of the tasks-prose spec: what the reviewer is told about the checks and the
// proof, and how tasks-plan treats `topic` when it refreshes a ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const REVIEWER = read('../agents/reviewer.md');
const ENGINE = read('../workflows/tasks-engine.js');

// The body of a `## <heading>` section, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

const flat = text => text.replace(/\s+/g, ' ');

// 1. What the reviewer is given.
test('rev5-1: the reviewer knows only verify.cmd was re-run and the proof is unconfirmed', () => {
  const given = flat(section(REVIEWER, 'What you get'));
  assert.match(given, /re-ran only `\.claude\/verify\.cmd`/);
  assert.match(given, /tail of its output is in the prompt/);
  assert.match(given, /proof was run only by the implementer/);
  assert.match(given, /outcome is unconfirmed/);
  // The old claim that the workflow ran the proof is gone.
  assert.doesNotMatch(flat(REVIEWER), /workflow has already run the proof/);
  assert.doesNotMatch(flat(REVIEWER), /proof already passed/i);
});

test('rev5-1: the engine prompt matches what the reviewer is told', () => {
  // The engine re-runs verify.cmd, passes its tail, and only names the proof.
  const prompt = ENGINE.slice(ENGINE.indexOf('function reviewerPrompt'));
  assert.match(prompt, /re-ran `\.claude\/verify\.cmd`/);
  assert.match(prompt, /verifyTail/);
  assert.match(prompt, /Proof the implementer had to run/);
});

test('rev5-1: acceptance is judged from the diff and code, never from an assumed proof', () => {
  const decide = flat(section(REVIEWER, 'What to decide'));
  assert.match(decide, /Judge it from the diff and the code/);
  assert.match(decide, /can only be shown by running the proof, do not assume the proof passed: answer `needs_input`, or record a finding/);
  const verdict = flat(section(REVIEWER, 'The verdict'));
  assert.match(verdict, /`needs_input` when[^.]*unconfirmed proof/);
  const look = flat(section(REVIEWER, 'How to look'));
  assert.match(look, /Never assume the proof passed/);
  // Still read-only: it does not run the proof to find out.
  assert.match(look, /no proof command/);
});

// 2. `topic` on refresh.
test('rev5-2: a missing topic is filled in from the file name', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /a missing `topic` is filled in from the file name/);
});

test('rev5-2: a different topic is corrected only before any task has run, else reported', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /may be corrected only while every task is still `todo` or `blocked`/);
  assert.match(create, /differs and any task has left `todo`\/`blocked`, stop and report the mismatch/);
  assert.match(create, /instead of rewriting it/);
  // The unconditional overwrite of rev 4 is gone, and validation does not bring it back.
  assert.doesNotMatch(create, /holds a different value, set it from the file name/);
  const validate = flat(section(PLAN, '5. Validate and reply'));
  assert.match(validate, /except a `topic` mismatch on a ledger where a task has already run: that one you report/);
});

test('rev5-2: the not-yet-run statuses are the schema statuses that the plan leaves editable', () => {
  // Every schema status other than `todo`/`blocked` is one the plan keeps untouched, so it counts as run.
  const schema = JSON.parse(read('../schemas/tasks.schema.json'));
  const ran = schema.properties.tasks.items.properties.status.enum.filter(s => !['todo', 'blocked'].includes(s));
  const kept = flat(PLAN).match(/Every other task \(([^)]*)\) stays exactly as it is/);
  assert.ok(kept, 'kept statuses listed');
  assert.deepEqual([...kept[1].matchAll(/`([a-z_]+)`/g)].map(m => m[1]).sort(), ran.sort());
});
