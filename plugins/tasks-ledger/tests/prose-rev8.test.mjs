// Rev 8 amendments of the tasks-prose spec: tasks-plan treats a stored `topic` as untrusted and
// checks it against the topic pattern before it puts it into any command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PLAN = read('../skills/tasks-plan/SKILL.md');

// The body of a `## <heading>` section, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

const flat = text => text.replace(/\s+/g, ' ');

// 1. Stored topic is untrusted.
test('rev8-1: the stored topic is checked against the pattern before any command uses it', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /The stored `topic` is untrusted input/);
  assert.match(create, /Before you put it into the branch listing or any other command, check that it matches `\^\[a-z0-9\]\[a-z0-9-\]\*\$`/);
});

test('rev8-1: a missing or non-matching stored topic never goes into a command', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /A missing or non-matching stored topic never goes into a command/);
  assert.match(create, /skip the branch listing/);
});

test('rev8-1: the no-branch condition then counts as met, the others still apply', () => {
  const create = flat(section(PLAN, '2. Create or refresh'));
  assert.match(create, /count the no-branch condition as met, because the helper refuses such a ledger and so never creates branches for it/);
  assert.match(create, /The other two conditions still apply/);
});

test('rev8-1: the pattern stated in tasks-plan rejects topics that could break a command', () => {
  const m = flat(section(PLAN, '2. Create or refresh')).match(/untrusted input\. [^`]*`([^`]+)`/);
  assert.ok(m, 'pattern found after the untrusted-input sentence');
  const pattern = new RegExp(m[1]);
  for (const ok of ['api-split', 'a', '0x']) assert.match(ok, pattern, ok);
  for (const bad of ['', 'x; rm -rf ~', "a' b", '$(id)', '-x', 'a/b', '../x', 'A', 'a b', 'a\nb', '`id`', '*']) {
    assert.doesNotMatch(bad, pattern, JSON.stringify(bad));
  }
});

test('rev8-1: the helper refuses a ledger whose topic does not match, so it creates no branches', () => {
  // The skill's reason for counting the no-branch condition as met rests on this helper check.
  const helper = read('../scripts/tasks-git.js');
  assert.ok(helper.includes('^[a-z0-9][a-z0-9-]*$'), 'helper validates topic with the same pattern');
});
