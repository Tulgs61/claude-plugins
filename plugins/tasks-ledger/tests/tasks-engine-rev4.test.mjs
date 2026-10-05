// Rev 4, amendments 1-4 of the tasks-engine spec: values from the helper are validated, git
// commands in the reviewer prompt quote their values, a review is merged only when it is
// consistent, and `result.stopped` is a single line of at most 300 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE, task } from './helpers/git-sandbox.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = readFileSync(ENGINE, 'utf8').replace(/^export\s+/m, '');

const GOOD_REVIEW = { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };

// Runs the engine against a fake helper. `answers` overrides the canned answer per subcommand
// (a function of the task id), `review` replaces the reviewer's result.
async function runEngine(ledgerTasks, { answers = {}, review = GOOD_REVIEW } = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const commands = [];
  const reviewerPrompts = [];
  const implementerPrompts = [];
  const canned = {
    prepare: () => ({ ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: ledgerTasks }),
    worktree: id => ({ ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' }),
    verify: () => ({ ok: true, tail: 'ok' }),
    merge: () => ({ ok: true, sha: 'def456' }),
    sync: () => ({ ok: true, tasks: [] }),
    ...answers,
  };
  const agent = async (prompt, opts) => {
    if (opts.agentType !== undefined && /^TASK: /.test(prompt)) {
      implementerPrompts.push(prompt);
      return 'done';
    }
    if (opts.agentType !== undefined) {
      reviewerPrompts.push(prompt);
      return review;
    }
    const cmd = prompt.match(/node "[^"]*" (.*)\n/)[1].replace(/"/g, '');
    commands.push(cmd);
    const [op, , id] = cmd.split(' ');
    return { stdout: JSON.stringify(canned[op] ? canned[op](id) : { ok: true }) };
  };
  const args = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1' };
  const result = await run(args, agent, () => {}, () => {});
  return { result, commands, reviewerPrompts, implementerPrompts };
}

const blockedWith = commands => commands.filter(c => / blocked /.test(c));

// ---- amendment 1 -------------------------------------------------------------------------------

test('amendment 1: the documented helper values pass', async () => {
  const values = [
    { worktree: '/tmp/wt-T1', branch: 'task/t/T1', base: 'main', start: 'abc123' },
    { worktree: '/repo root/.claude/worktrees/topic-T1', branch: 'task/t/T1', base: 'origin/main', start: 'main' },
  ];
  for (const v of values) {
    const { result, implementerPrompts } = await runEngine([task('T1', ['src/**'])], {
      answers: {
        prepare: () => ({ ok: true, start: v.start, integration: '/tmp/int', prs: false, tasks: [task('T1', ['src/**'])] }),
        worktree: () => ({ ok: true, worktree: v.worktree, branch: v.branch, base: v.base }),
      },
    });
    assert.equal(result.stopped, null, JSON.stringify(v));
    assert.deepEqual(result.results.map(r => r.status), ['merged']);
    assert.equal(implementerPrompts.length, 1);
  }
});

test('amendment 1: unsafe worktree, branch, base or start values block the task before any agent runs', async () => {
  const good = { ok: true, worktree: '/tmp/wt-T1', branch: 'task/t/T1', base: 'main' };
  const bad = [
    { worktree: 'relative/wt' },
    { worktree: '/tmp/wt"; rm -rf /' },
    { worktree: '/tmp/$HOME' },
    { worktree: '/tmp/`id`' },
    { worktree: '/tmp/a\\b' },
    { worktree: '/tmp/a!b' },
    { worktree: '/tmp/a\nb' },
    { worktree: 42 },
    { branch: '-delete' },
    { branch: 'task/t/T1; id' },
    { branch: 'task t' },
    { branch: undefined },
    { base: '--output=/x' },
    { base: 'main$(id)' },
    { base: 'a..b' },
  ];
  for (const override of bad) {
    const { result, implementerPrompts, reviewerPrompts, commands } = await runEngine([task('T1', ['src/**'])], {
      answers: { worktree: () => ({ ...good, ...override }) },
    });
    const label = JSON.stringify(override);
    assert.deepEqual(result.results.map(r => r.status), ['blocked'], label);
    assert.doesNotMatch(result.results[0].note, /\n/, label);
    assert.equal(implementerPrompts.length + reviewerPrompts.length, 0, label);
    assert.equal(blockedWith(commands).length, 1, label);
    assert.notEqual(result.stopped, null, label);
  }

  for (const start of ['-x', 'abc 123', 'abc;id']) {
    const { result, implementerPrompts } = await runEngine([task('T1', ['src/**'])], {
      answers: {
        prepare: () => ({ ok: true, start, integration: '/tmp/int', prs: false, tasks: [task('T1', ['src/**'])] }),
      },
    });
    assert.deepEqual(result.results.map(r => r.status), ['blocked'], start);
    assert.equal(implementerPrompts.length, 0, start);
  }
});

// ---- amendment 2 -------------------------------------------------------------------------------

test('amendment 2: every value in a git command of the reviewer prompt is quoted', async () => {
  const { result, reviewerPrompts } = await runEngine([task('T1', ['src/**'])]);
  assert.equal(result.stopped, null);
  assert.equal(reviewerPrompts.length, 1);
  const gitCommands = reviewerPrompts[0].match(/`git [^`]*`/g);
  assert.ok(gitCommands && gitCommands.length >= 2, reviewerPrompts[0]);
  for (const cmd of gitCommands) {
    // Strip the quoted parts; what remains are the git verbs and options only.
    const bare = cmd.slice(1, -1).replace(/"[^"]*"/g, '');
    for (const word of bare.split(/\s+/).filter(Boolean)) {
      assert.match(word, /^(git|-C|log|diff|--oneline)$/, `unquoted value ${word} in ${cmd}`);
    }
  }
  assert.ok(reviewerPrompts[0].includes('git -C "/tmp/wt-T1" log --oneline "abc123..HEAD"'));
  assert.ok(reviewerPrompts[0].includes('git -C "/tmp/wt-T1" diff "abc123...HEAD"'));
});

test('amendment 2: the ops prompt keeps its pinned form', async () => {
  const { commands } = await runEngine([task('T1', ['src/**'])]);
  assert.ok(commands.includes('prepare /tmp/ledger.json test1'), commands.join('\n'));
  assert.ok(commands.includes('worktree /tmp/ledger.json T1'), commands.join('\n'));
});

// ---- amendment 3 -------------------------------------------------------------------------------

test('amendment 3: a verified review with a false boolean or a high finding is blocked as inconsistent', async () => {
  const reviews = [
    { ...GOOD_REVIEW, acceptance_met: false },
    { ...GOOD_REVIEW, scope_ok: false },
    { ...GOOD_REVIEW, constraints_ok: false },
    { ...GOOD_REVIEW, constraints_ok: 'true' },
    { ...GOOD_REVIEW, findings: [{ message: 'breaks prod', severity: 'high' }] },
  ];
  for (const review of reviews) {
    const { result, commands } = await runEngine([task('T1', ['src/**'])], { review });
    const label = JSON.stringify(review);
    assert.deepEqual(result.results.map(r => r.status), ['blocked'], label);
    assert.equal(result.results[0].note, 'review inconsistent', label);
    assert.ok(!commands.some(c => c.startsWith('merge ')), label);
    assert.ok(!commands.some(c => / verified /.test(c)), label);
    assert.ok(blockedWith(commands).some(c => /review inconsistent/.test(c)), label);
  }
});

test('amendment 3: a consistent review with only medium and low findings is merged', async () => {
  const review = {
    ...GOOD_REVIEW,
    findings: [{ message: 'nit', severity: 'low' }, { message: 'style', severity: 'medium' }, { message: 'x' }],
  };
  const { result } = await runEngine([task('T1', ['src/**'])], { review });
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.status), ['merged']);
});

// ---- amendment 4 -------------------------------------------------------------------------------

test('amendment 4: stopped collapses whitespace and is cut to 300 characters', async () => {
  const error = `merge\n\tconflict   in   src/a.js\r\n${'x '.repeat(400)}`;
  const { result } = await runEngine([task('T1', ['src/**'])], {
    answers: { merge: () => ({ ok: false, error }) },
  });
  assert.equal(typeof result.stopped, 'string');
  assert.doesNotMatch(result.stopped, /\s\s|[\n\r\t]/);
  assert.ok(result.stopped.length <= 300, String(result.stopped.length));
  assert.match(result.stopped, /^T1 blocked: merge failed: merge conflict in src\/a\.js x x/);
});

test('amendment 4: a failed prepare also reports a single line', async () => {
  const { result } = await runEngine([], {
    answers: { prepare: () => ({ ok: false, locked: true, error: `locked\n\nby  another run\n${'y'.repeat(500)}` }) },
  });
  assert.deepEqual(result.results, []);
  assert.equal(result.locked, true);
  assert.doesNotMatch(result.stopped, /\n|\s\s/);
  assert.ok(result.stopped.length <= 300);
  assert.match(result.stopped, /^prepare failed: locked by another run y/);
});
