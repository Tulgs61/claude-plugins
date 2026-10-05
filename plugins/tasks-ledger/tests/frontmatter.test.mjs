// Front-matter check: every agent and skill carries the name and description the plugin validator
// requires, plus the fields the README and rules/conventions.md document. The dispatch skill's label
// block is fed through dispatch-guard, the way Claude Code runs the hook, so the contract it renders
// is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../hooks/dispatch-guard.js', import.meta.url));

const FILES = {
  reviewer: '../agents/reviewer.md',
  'task-implementer': '../agents/task-implementer.md',
  dispatch: '../skills/dispatch/SKILL.md',
  tasks: '../skills/tasks/SKILL.md',
  'tasks-plan': '../skills/tasks-plan/SKILL.md',
};

// The fields each file must carry with exactly these values, beyond name and description.
const FIXED = {
  reviewer: { model: 'opus', maxTurns: '40', tools: 'Read, Grep, Glob, Bash' },
  'task-implementer': { model: 'opus', maxTurns: '120' },
  dispatch: {},
  tasks: {},
  'tasks-plan': { context: 'fork' },
};

const text = name => readFileSync(new URL(FILES[name], import.meta.url), 'utf8');

// Top-level `key: value` pairs of the leading `---` block; quotes around a value are dropped.
function frontMatter(source) {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'file starts with a front-matter block');
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    assert.ok(!(kv[1] in fields), `duplicate key ${kv[1]}`);
    fields[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

function guard(prompt, subagentType = 'tasks-ledger:task-implementer') {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: subagentType, description: 'one task', prompt } });
  return spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' });
}

// The ```text block that holds the six labels.
function labelBlock() {
  const m = text('dispatch').match(/```text\n([\s\S]*?)```/);
  assert.ok(m, 'dispatch has a ```text label block');
  return m[1];
}

for (const name of Object.keys(FILES)) {
  test(`${name}: name, description and fixed fields`, () => {
    const fm = frontMatter(text(name));
    assert.equal(fm.name, name);
    assert.ok(fm.description && fm.description.length > 20, 'has a real description');
    for (const [key, value] of Object.entries(FIXED[name])) assert.equal(fm[key], value, `${name} ${key}`);
  });
}

test('reviewer has no memory field', () => {
  assert.ok(!('memory' in frontMatter(text('reviewer'))));
});

test('the dispatch label block has the six labels in order', () => {
  const labels = labelBlock().split('\n').filter(Boolean).map(l => l.split(':')[0]);
  assert.deepEqual(labels, ['OUTCOME', 'PROOF', 'CONSTRAINTS', 'DELIVERABLE', 'BUDGET', 'ESCALATION']);
});

test('dispatch-guard accepts the dispatch label block', () => {
  const block = labelBlock();
  for (const type of ['tasks-ledger:task-implementer', 'task-implementer']) {
    const r = guard(block, type);
    assert.equal(r.status, 0, `${type}: ${r.stderr}`);
  }
});

test('dispatch-guard still blocks the block without PROOF or BUDGET', () => {
  const block = labelBlock();
  const without = word => block.split('\n').filter(l => !l.startsWith(`${word}:`)).join('\n');
  for (const word of ['PROOF', 'BUDGET']) {
    const r = guard(without(word));
    assert.equal(r.status, 2, `${word} removed`);
    assert.match(r.stderr, new RegExp(`no ${word}`));
  }
});
