// tasks-git.js prepare: lock, integration worktree, setup, warnings; plus the glob-overlap copy check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ENGINE, SCRIPT, TOPIC, markerBlock, sandbox, task } from './helpers/git-sandbox.mjs';

const overlapPairs = warnings =>
  warnings
    .map(w => w.match(/^(T\d+) and (T\d+) have overlapping files globs/))
    .filter(Boolean)
    .map(m => `${m[1]}+${m[2]}`)
    .sort();

test('the glob-overlap block in tasks-git.js is identical to the one in workflows/tasks-engine.js', () => {
  const norm = s => s.replace(/\r\n/g, '\n'); // a CRLF checkout of either file is still the same code
  const engine = markerBlock(readFileSync(ENGINE, 'utf8'));
  const helper = markerBlock(readFileSync(SCRIPT, 'utf8'));
  assert.ok(engine, 'engine has the marker block');
  assert.ok(helper, 'tasks-git.js has the marker block');
  assert.equal(norm(helper), norm(engine));
});

test('marker block extraction tolerates CRLF line endings', () => {
  const crlf = 'x\r\n// BEGIN glob-overlap\r\nconst a = 1\r\n// END glob-overlap\r\ny\r\n';
  assert.equal(markerBlock(crlf), '// BEGIN glob-overlap\r\nconst a = 1\r\n// END glob-overlap\r\n');
});

test('prepare takes the lock, creates the integration worktree, runs setup and marks the run running', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/a.js'])], setup: 'echo ran > .setup-ran' });
  const r = sb.ok('prepare', 'run-one');
  assert.equal(r.start, 'origin/main');
  assert.equal(r.root, sb.repo);
  assert.equal(r.integration, path.join(sb.repo, '.claude', 'worktrees', `${TOPIC}-integration`));
  assert.equal(sb.git(r.integration, 'branch', '--show-current'), `task/${TOPIC}/integration`);
  assert.equal(sb.sha(r.integration, 'HEAD'), sb.sha(sb.repo, 'origin/main'));
  assert.equal(readFileSync(path.join(r.integration, '.setup-ran'), 'utf8').trim(), 'ran');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.prs, false);
  assert.deepEqual(r.tasks.map(x => x.id), ['T1']);
  const lock = JSON.parse(readFileSync(sb.lockFile, 'utf8'));
  assert.equal(lock.runId, 'run-one');
  const L = sb.ledger();
  assert.equal(L.runStatus, 'running');
  assert.equal(L.stopReason, null);
  assert.equal(L.integrationBranch, `task/${TOPIC}/integration`);
});

test('prepare refuses a second runId while the lock is held, allows the same runId and a takeover', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const refused = sb.run('prepare', 'run-two');
  assert.equal(refused.ok, false);
  assert.equal(refused.locked, true);
  assert.match(refused.error, /another run \(run-one/);
  assert.equal(JSON.parse(readFileSync(sb.lockFile, 'utf8')).runId, 'run-one', 'refusal leaves the lock alone');
  sb.ok('prepare', 'run-one'); // the same run resuming is not a conflict
  sb.ok('prepare', 'run-two', 'takeover');
  assert.equal(JSON.parse(readFileSync(sb.lockFile, 'utf8')).runId, 'run-two');
});

test('prepare rejects a malformed runId', t => {
  const sb = sandbox(t);
  const r = sb.run('prepare', 'x;y');
  assert.equal(r.ok, false);
  assert.match(r.error, /runId/);
});

test('prepare resets interrupted tasks to todo and keeps verified ones', t => {
  const sb = sandbox(t, {
    tasks: [task('T1', [], [], { status: 'in_progress' }), task('T2', [], [], { status: 'done' }), task('T3', [], [], { status: 'verified' })],
  });
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(r.tasks.map(x => x.status), ['todo', 'todo', 'verified']);
});

test('prepare warns about a missing setup command', t => {
  const sb = sandbox(t, { setup: null });
  const r = sb.ok('prepare', 'run-one');
  assert.ok(r.warnings.some(w => /no `setup` command/.test(w)), JSON.stringify(r.warnings));
});

test('prepare fails and releases the lock when setup fails', t => {
  const sb = sandbox(t, { setup: 'echo broken >&2; exit 3' });
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /setup .* failed .* exit 3/);
  assert.match(r.tail, /broken/);
  assert.equal(existsSync(sb.lockFile), false);
});

test('prepare warns when .claude/worktrees/ is not gitignored', t => {
  const sb = sandbox(t, { ignoreWorktrees: false });
  const r = sb.ok('prepare', 'run-one');
  assert.ok(r.warnings.some(w => /not gitignored/.test(w)), JSON.stringify(r.warnings));
});

test('prepare fails and releases the lock when verify.cmd is not tracked', t => {
  const sb = sandbox(t);
  sb.git(sb.repo, 'rm', '-q', '--cached', '.claude/verify.cmd');
  sb.git(sb.repo, 'commit', '-q', '-m', 'untrack verify.cmd');
  const r = sb.run('prepare', 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /verify\.cmd is not tracked/);
  assert.equal(existsSync(sb.lockFile), false);
});

test('prepare warns once per overlapping pair that no dependsOn path links', t => {
  const sb = sandbox(t, {
    tasks: [
      task('T1', ['src/**']),
      task('T2', ['src/a.js']), // overlaps T1, unlinked -> warning
      task('T3', ['src/b.js'], ['T1']), // overlaps T1, linked directly
      task('T4', ['lib/**']),
      task('T5', ['src/c/**'], ['T3']), // overlaps T1, linked through T3
      task('T6', ['**/*.md'], ['T5']), // overlaps all; linked to T5, T3, T1; not to T2, T4
    ],
  });
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(overlapPairs(r.warnings), ['T1+T2', 'T2+T6', 'T4+T6']);
});

test('prepare emits no overlap warning for disjoint tasks', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/**']), task('T2', ['lib/**']), task('T3', ['docs/a.md'])] });
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(overlapPairs(r.warnings), []);
});

test('prepare ingests the inbox and includes added tasks in the overlap check', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/**'])] });
  sb.write(path.dirname(sb.inboxFile), path.basename(sb.inboxFile), JSON.stringify({ title: 'added', files: ['src/x.js'] }) + '\n');
  const r = sb.ok('prepare', 'run-one');
  assert.deepEqual(r.added, ['T2']);
  assert.deepEqual(overlapPairs(r.warnings), ['T1+T2']);
});

test('a ledger outside <repo>/.claude/runs/ (the old .claude/tasks.json location) is refused', t => {
  const sb = sandbox(t);
  const legacy = path.join(sb.repo, '.claude', 'tasks.json');
  mkdirSync(path.dirname(legacy), { recursive: true });
  renameSync(sb.ledgerFile, legacy);
  const r = sb.runRaw('prepare', legacy, 'run-one');
  assert.equal(r.ok, false);
  assert.match(r.error, /not in <repo>\/\.claude\/runs\//);
});

test('unknown commands and missing arguments answer with ok:false', t => {
  const sb = sandbox(t);
  assert.match(sb.runRaw().error, /usage/);
  assert.match(sb.run('explode').error, /unknown command explode/);
});
