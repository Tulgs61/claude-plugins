// Tests for workflows/tasks-engine.js. The engine is a workflow script (top-level await/return,
// injected args/agent/phase/log), so it is not imported: the glob-overlap block is extracted and
// evaluated with node:vm, and the whole body is compiled and run with fake runtime functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ENGINE = fileURLToPath(new URL('../workflows/tasks-engine.js', import.meta.url));
const source = readFileSync(ENGINE, 'utf8');

function overlapBlock() {
  const m = source.match(/\/\/ BEGIN glob-overlap\r?\n[\s\S]*?\/\/ END glob-overlap\r?\n/);
  assert.ok(m, 'engine contains the glob-overlap marker block');
  const code = m[0].replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\brequire\s*\(|\bimport\b/, 'marker block uses no require/import');
  return m[0];
}

const ctx = vm.createContext({});
vm.runInContext(
  overlapBlock() + '\nthis.globsOverlap = globsOverlap; this.globListsOverlap = globListsOverlap;',
  ctx
);
const { globsOverlap, globListsOverlap } = ctx;

const both = (a, b) => globsOverlap(a, b) && globsOverlap(b, a);
const neither = (a, b) => !globsOverlap(a, b) && !globsOverlap(b, a);

test('identical globs overlap', () => {
  for (const g of ['src/a.js', 'src/**', '**/*.md', '', 'a/b/c']) assert.ok(both(g, g), g);
});

test('a directory glob overlaps a file inside it', () => {
  assert.ok(both('src/**', 'src/a/b.js'));
  assert.ok(both('src/*.js', 'src/a.js'));
});

test('distinct static paths and sibling trees do not overlap', () => {
  assert.ok(neither('src/a.js', 'src/b.js'));
  assert.ok(neither('src/**', 'lib/**'));
});

test('prefixes compare whole segments', () => {
  assert.ok(neither('srcx/**', 'src/**'));
  assert.ok(neither('src/ab.js', 'src/a'));
});

test('a glob without a static prefix overlaps everything', () => {
  for (const g of ['src/a.js', 'lib/**', 'docs/x.md', '']) assert.ok(both('**/*.md', g), g);
  assert.ok(both('{a,b}/x', 'a/x'));
  assert.ok(both('!src/**', 'lib/x'));
});

test('normalisation: ./, backslashes, repeated and trailing slashes', () => {
  assert.ok(both('./src/', 'src/x'));
  assert.ok(both('src\\a.js', 'src/a.js'));
  assert.ok(both('src//a//', 'src/a/b.js'));
  assert.ok(both('/src/a.js', './src/a.js'));
  assert.ok(neither('./src/', 'lib/x'));
});

test('extglob, parent segments and case differences stay conservative', () => {
  assert.ok(both('src/+(a|b).js', 'src/a.js'));
  assert.ok(both('src/@(x)/y', 'src/x/y'));
  assert.ok(both('src/../lib/x', 'lib/x'));
  assert.ok(both('src/**/../../lib/x', 'lib/x'));
  assert.ok(both('../x', 'src/a.js'));
  assert.ok(both('Src/A.js', 'src/a.js'));
});

test('list helper: any pair overlapping makes the lists overlap', () => {
  assert.ok(globListsOverlap(['docs/**', 'src/a.js'], ['lib/**', 'src/*.js']));
  assert.ok(!globListsOverlap(['docs/**', 'src/a.js'], ['lib/**', 'src/b.js']));
  assert.ok(!globListsOverlap([], ['**']));
  assert.ok(!globListsOverlap(undefined, ['**']));
});

test('corpus: patterns that match a common path are always reported as overlapping', () => {
  const patterns = [
    'src/**', 'src/*.js', 'src/a.js', 'src/b.js', 'src/a/**', 'src/a/b.js', 'src/a/*.js', 'src/?.js',
    'src/[ab].js', 'src/{a,b}.js', 'src/+(a|b).js', 'src/**/*.test.js', '**/*.md', '**/*.js', '**',
    '*', '*.md', 'lib/**', 'lib/x/**', 'srcx/**', 'docs/*.md', 'docs/a.md', '{src,lib}/**',
    '{a,b}/x', 'a/x', 'b/x', 'a/**', 'plugins/*/workflows/**', 'plugins/tasks-ledger/**',
    'plugins/tasks-ledger/workflows/tasks-engine.js', 'plugins/other/workflows/x.js', 'README.md',
  ];
  const paths = [
    'src/a.js', 'src/b.js', 'src/c.js', 'src/a/b.js', 'src/a/c.js', 'src/a/b/c.js', 'src/x.test.js',
    'src/a/x.test.js', 'srcx/a.js', 'lib/a.js', 'lib/x/y.js', 'docs/a.md', 'docs/b.md', 'README.md',
    'a/x', 'b/x', 'c/x', 'a/y', 'plugins/tasks-ledger/workflows/tasks-engine.js',
    'plugins/tasks-ledger/tests/t.mjs', 'plugins/other/workflows/x.js', 'x.js',
  ];
  let checked = 0;
  for (const a of patterns) {
    for (const b of patterns) {
      const shared = paths.find(p => path.matchesGlob(p, a) && path.matchesGlob(p, b));
      if (!shared) continue;
      checked++;
      assert.ok(globsOverlap(a, b), `${a} and ${b} both match ${shared} but were reported disjoint`);
    }
  }
  assert.ok(checked > 100, `corpus exercised ${checked} matching pairs`);
});

// ---- whole engine ------------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = source.replace(/^export\s+/m, '');

test('the whole engine compiles as an async workflow body', () => {
  assert.doesNotThrow(() => new AsyncFunction('args', 'agent', 'phase', 'log', body));
});

// Runs the engine against a fake helper: every ops command gets a canned JSON answer, implementers
// take a few milliseconds, and the test records which implementers ran at the same time and which
// agentType each role was started with. Ops agents are the calls without an agentType; implementer
// contracts start with `TASK:`, every other typed call is the reviewer.
async function runEngine(ledgerTasks, extraArgs = {}) {
  const run = new AsyncFunction('args', 'agent', 'phase', 'log', body);
  const active = new Set();
  const concurrent = [];
  const agentTypes = { implementer: new Set(), reviewer: new Set() };
  let calls = 0;
  const answer = cmd => {
    const [op, , id] = cmd.split(' ');
    switch (op) {
      case 'prepare':
        return { ok: true, start: 'abc123', integration: '/tmp/int', prs: false, tasks: ledgerTasks };
      case 'worktree':
        return { ok: true, worktree: `/tmp/wt-${id}`, branch: `task/t/${id}`, base: 'main' };
      case 'verify':
        return { ok: true, tail: 'ok' };
      case 'merge':
        return { ok: true, sha: 'def456' };
      case 'sync':
        return { ok: true, tasks: [] };
      default:
        return { ok: true };
    }
  };
  const agent = async (prompt, opts) => {
    calls++;
    if (opts.agentType !== undefined && /^TASK: /.test(prompt)) {
      agentTypes.implementer.add(opts.agentType);
      const id = prompt.match(/^TASK: (\S+)/)[1];
      for (const other of active) concurrent.push([other, id].sort().join('+'));
      active.add(id);
      await new Promise(r => setTimeout(r, 10));
      active.delete(id);
      return 'done';
    }
    if (opts.agentType !== undefined) {
      agentTypes.reviewer.add(opts.agentType);
      return { verdict: 'verified', acceptance_met: true, scope_ok: true, constraints_ok: true, findings: [], evidence: 'ok' };
    }
    const cmd = prompt.match(/node "[^"]*" (.*)\n/)[1].replace(/"/g, '');
    return { stdout: JSON.stringify(answer(cmd)) };
  };
  const engineArgs = { ledger: '/tmp/ledger.json', script: '/tmp/tasks-git.js', runId: 'test1', ...extraArgs };
  let result;
  try {
    result = await run(engineArgs, agent, () => {}, () => {});
  } catch (error) {
    error.agentCalls = calls;
    throw error;
  }
  return { result, concurrent, agentTypes, calls };
}

const task = (id, files, dependsOn = []) => ({
  id, title: id, files, dependsOn, status: 'todo', acceptance: 'a', proof: 'p', budget: 'b', constraints: [],
});

test('engine runs tasks with overlapping globs one after another, disjoint ones in parallel', async () => {
  const { result, concurrent } = await runEngine([
    task('T1', ['src/**']),
    task('T2', ['src/a.js']),
    task('T3', ['lib/**']),
  ]);
  assert.equal(result.stopped, null);
  assert.deepEqual(result.results.map(r => r.status), ['merged', 'merged', 'merged']);
  assert.ok(!concurrent.includes('T1+T2'), `T1 and T2 overlap but ran together: ${concurrent}`);
  assert.ok(concurrent.includes('T1+T3'), `T1 and T3 are disjoint and should run together: ${concurrent}`);
});

test('engine defaults to the plugin-scoped agent types', async () => {
  const { result, agentTypes } = await runEngine([task('T1', ['src/**']), task('T2', ['lib/**'])]);
  assert.equal(result.stopped, null);
  assert.deepEqual([...agentTypes.implementer], ['tasks-ledger:task-implementer']);
  assert.deepEqual([...agentTypes.reviewer], ['tasks-ledger:reviewer']);
});

test('engine uses implementerAgent and reviewerAgent overrides', async () => {
  const { result, agentTypes } = await runEngine([task('T1', ['src/**'])], {
    implementerAgent: 'task-implementer',
    reviewerAgent: 'other-plugin:review:strict_v2',
  });
  assert.equal(result.stopped, null);
  assert.deepEqual([...agentTypes.implementer], ['task-implementer']);
  assert.deepEqual([...agentTypes.reviewer], ['other-plugin:review:strict_v2']);
});

test('an invalid agent name throws before any agent runs', async () => {
  const bad = [
    { implementerAgent: 'task implementer' },
    { implementerAgent: '' },
    { implementerAgent: 42 },
    { reviewerAgent: 'reviewer"; rm -rf /' },
    { reviewerAgent: 'tasks-ledger/reviewer' },
    { reviewerAgent: ['reviewer'] },
  ];
  for (const extra of bad) {
    const key = Object.keys(extra)[0];
    await assert.rejects(
      runEngine([task('T1', ['src/**'])], extra),
      e => new RegExp(`args\\.${key} must match`).test(e.message) && e.agentCalls === 0,
      JSON.stringify(extra)
    );
  }
});
