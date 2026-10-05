// Rev 4 amendments 1-7 of the tasks-prose spec: live-lock handling, inbox appends, `topic`, the
// overlap rule, a read-only reviewer, the dispatch target and cleanup. Amendment 8 is
// frontmatter.test.mjs. Where a rule can be exercised, it is run against the helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCRIPT, markerBlock, sandbox } from './helpers/git-sandbox.mjs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TASKS = read('../skills/tasks/SKILL.md');
const PLAN = read('../skills/tasks-plan/SKILL.md');
const DISPATCH = read('../skills/dispatch/SKILL.md');
const REVIEWER = read('../agents/reviewer.md');

// The body of a `## <heading>` section, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `section ${heading} exists`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

const codeSpans = text => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

// The helper's own overlap functions, taken from its glob-overlap block.
const { globLiteralPrefix, globsOverlap } = new Function(`${markerBlock(readFileSync(SCRIPT, 'utf8'))}\nreturn { globLiteralPrefix, globsOverlap };`)();

// 1. Resume and retry with a live lock.
test('rev4-1: a fresh lock is shown with run id and age, takeover only after confirmation', () => {
  const lock = section(TASKS, 'Live lock');
  assert.match(lock, /`runId`/);
  assert.match(lock, /\bage\b/);
  assert.match(lock, /six hours/);
  assert.match(lock, /dead/);
  assert.match(lock, /Only on a clear yes[^.]*`"takeover": true`/);
  for (const mode of ['Resume', 'Retry']) {
    const body = section(TASKS, mode);
    assert.match(body, /"Live lock"/, `${mode} goes through the live-lock step`);
    assert.doesNotMatch(body, /say so and stop/, `${mode} no longer just stops on a live run`);
  }
  // Retry resets the task only after the lock question.
  const retry = section(TASKS, 'Retry');
  assert.ok(retry.indexOf('"Live lock"') < retry.indexOf('node "<helper>" status'), 'lock handled before the helper status call');
});

// 2. Inbox lines never travel in a shell string.
test('rev4-2: the add procedure keeps the JSON out of the shell', () => {
  const add = section(TASKS, 'Add');
  assert.doesNotMatch(add, /printf '%s|echo '|'<json>'/);
  assert.match(add, /Write tool/);
  for (const span of codeSpans(add)) {
    if (/^(cat|rm|printf|echo|node)\b/.test(span)) assert.doesNotMatch(span, /<json>|\{/, `shell command ${span} carries no JSON`);
  }
});

test('rev4-2: the documented append delivers a hostile title to the ledger intact', t => {
  const sb = sandbox(t);
  const add = section(TASKS, 'Add');
  const append = codeSpans(add).find(s => s.startsWith('cat '));
  const remove = codeSpans(add).find(s => s.startsWith('rm '));
  assert.ok(append && remove, 'append and remove commands documented');

  const marker = path.join(sb.tmp, 'pwned');
  const title = `it's "quoted" $(touch ${marker}) \`touch ${marker}\` \\n done`;
  const scratch = path.join(sb.repo, '.claude', 'runs', '.add-test.jsonl');
  writeFileSync(scratch, JSON.stringify({ title, acceptance: 'title survives' }) + '\n'); // the Write tool's part
  const fill = cmd => cmd.replace('<scratch>', scratch).replace('<inbox>', sb.inboxFile);
  for (const cmd of [append, remove]) {
    const r = spawnSync('/bin/sh', ['-c', fill(cmd)], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${fill(cmd)}: ${r.stderr}`);
  }
  assert.ok(!existsSync(scratch), 'scratch file removed');

  const r = sb.ok('sync');
  assert.equal(r.added.length, 1);
  const added = sb.taskOf(r.added[0]);
  assert.equal(added.title, title);
  assert.equal(added.acceptance, 'title survives');
  assert.ok(!existsSync(marker), 'nothing in the title was executed');
});

// 3. tasks-plan always writes and checks `topic`.
test('rev4-3: tasks-plan always writes topic from the file name and checks it', () => {
  const create = section(PLAN, '2. Create or refresh');
  assert.match(create, /`topic`, always/);
  assert.match(create, /equal to the\s+slug in its file name/);
  assert.match(create, /new or refreshed/);
  const validate = section(PLAN, '5. Validate and reply');
  assert.match(validate, /`topic` is\s+present, matches `\^\[a-z0-9\]\[a-z0-9-\]\*\$`, and equals the slug/);
  // The slug of the documented file name is what the helper accepts as a topic.
  const slug = '2026-10-05-api-split.json'.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.json$/, '');
  assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
});

// 4. The overlap rule, stated as the helper implements it.
test('rev4-4: tasks-plan states the helper overlap rule', () => {
  const rule = section(PLAN, '3. Shape the tasks');
  assert.match(rule, /ignores case/);
  assert.match(rule, /`\\` counts as `\/`/);
  assert.match(rule, /contains `\.\.` anywhere[^\n]*\n?[^\n]*overlaps\s+every other pattern/);
  assert.match(rule, /literal segment\s+prefix/);
  assert.match(rule, /starts with `!`/);
  assert.match(rule, /disjoint only when their prefixes differ at a position where both have a\s+segment/);

  // The listed glob characters are exactly the ones the helper treats as such.
  const listed = rule.match(/holds a glob character([\s\S]*?)or starts with/);
  assert.ok(listed, 'glob characters listed');
  const stated = codeSpans(listed[1]).sort();
  const helper = [...'!"#$%&\'()*+,-:;<=>?@[]^_`{|}~'].filter(c => globLiteralPrefix(`a/x${c}y`).length === 1).sort();
  assert.deepEqual(stated, helper);

  // Case, backslashes and parent segments behave as stated.
  assert.equal(globsOverlap('SRC\\Api\\user.ts', 'src/api/**'), true);
  assert.equal(globsOverlap('../x', 'src/a.ts'), true);
  assert.equal(globsOverlap('!src/a', 'lib/b'), true);
  assert.equal(globsOverlap('./src/a/**', 'src/b/**'), false);
});

test('rev4-4: the overlap examples in tasks-plan agree with the helper', () => {
  const m = PLAN.match(/So `([^`]+)` and `([^`]+)` overlap, `([^`]+)` and `([^`]+)` do not, and\s+`([^`]+)` overlaps both\./);
  assert.ok(m, 'examples sentence found');
  const [, a, b, c, d, e] = m;
  assert.equal(globsOverlap(a, b), true, `${a} / ${b}`);
  assert.equal(globsOverlap(c, d), false, `${c} / ${d}`);
  assert.equal(globsOverlap(e, a), true, `${e} / ${a}`);
  assert.equal(globsOverlap(e, b), true, `${e} / ${b}`);
});

// 5. The reviewer only inspects.
test('rev4-5: the reviewer runs nothing that can write, tests included', () => {
  assert.doesNotMatch(REVIEWER, /may run[^.]*(proof|tests)/);
  assert.match(REVIEWER, /You only inspect/);
  assert.match(REVIEWER, /no tests, no proof command, no `\.claude\/verify\.cmd`/);
  // Every git command it names is a read-only inspection.
  const gitCalls = [...REVIEWER.matchAll(/`git ([^`]+)`/g)].map(m => m[1]);
  assert.ok(gitCalls.length > 0);
  for (const call of gitCalls) {
    const sub = call.split(/\s+/).filter(w => !w.startsWith('-') && !w.startsWith('<'))[0];
    assert.ok(['log', 'diff', 'show', 'ls-files', 'rev-parse', 'merge-base'].includes(sub), `git ${call}`);
  }
});

// 6. Dispatch never commits to a permanent branch or the main checkout.
test('rev4-6: the dispatch deliverable names a task branch in a task worktree', () => {
  const block = DISPATCH.match(/```text\n([\s\S]*?)```/)[1];
  const deliverable = block.split('\n').find(l => l.startsWith('DELIVERABLE:'));
  assert.ok(deliverable);
  const target = deliverable.split(';')[0];
  assert.match(target, /<task branch> in <task worktree>/);
  assert.doesNotMatch(target, /current worktree|main checkout|\b(main|master|develop|trunk)\b/);
  const where = section(DISPATCH, '3. Settle where the commits go');
  assert.match(where, /never on a permanent branch/);
  assert.match(where, /never in the main checkout/);
  assert.match(where, /`git -C <root> worktree add -b task\/<slug> <root>\/\.claude\/worktrees\/<slug> <base>`/);
  assert.doesNotMatch(DISPATCH, /current worktree/);
});

// 7. Cleanup.
test('rev4-7: cleanup spares a taken-over integration branch and uses -D only after a confirmed merge', () => {
  const cleanup = section(TASKS, 'Cleanup');
  assert.match(cleanup, /Leave a taken-over integration branch alone/);
  assert.match(cleanup, /`task\/<topic>\/integration`[^\n]*, it and its worktree\s+`<root>\/\.claude\/worktrees\/<topic>-integration` are not cleanup items/);
  const sentences = cleanup.split(/(?<=\.)\s+/);
  const withD = sentences.filter(s => /branch -D/.test(s));
  assert.ok(withD.length > 0, '-D is mentioned');
  for (const s of withD) assert.match(s, /only for a branch whose\s+merge was confirmed/, s);
  assert.match(cleanup, /`git -C <root> branch -d <branch>`/);
  assert.ok(cleanup.indexOf('Confirm each merge') < cleanup.indexOf('branch -D'), 'merge confirmed before removal');
});
