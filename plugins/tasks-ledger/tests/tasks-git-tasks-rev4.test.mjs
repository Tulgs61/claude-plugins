// Rev 4, amendment 3: verify and merge refuse a task whose branch modifies .claude/verify.cmd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC, sandbox, task } from './helpers/git-sandbox.mjs';

test('verify and merge refuse a task branch that modifies .claude/verify.cmd', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const prep = sb.ok('prepare', 'run-one');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.commit(w.worktree, '.claude/verify.cmd', 'true\n');

  const v = sb.run('verify', 'T1');
  assert.equal(v.ok, false);
  assert.match(v.error, /verify\.cmd/);
  assert.match(v.error, /outside a run/);

  sb.ok('status', 'T1', 'verified');
  const before = sb.ledger();
  const m = sb.run('merge', 'T1');
  assert.equal(m.ok, false);
  assert.match(m.error, /modifies \.claude\/verify\.cmd/);
  assert.match(m.error, /outside a run/);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead, 'nothing merged');
  assert.deepEqual(sb.ledger(), before);
});

test('a branch that changes verify.cmd and changes it back is not refused', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  const original = sb.git(w.worktree, 'show', 'HEAD:.claude/verify.cmd') + '\n';
  sb.commit(w.worktree, '.claude/verify.cmd', 'true\n');
  sb.commit(w.worktree, '.claude/verify.cmd', original);
  sb.commit(w.worktree, 'a.txt', 'a\n');
  sb.ok('verify', 'T1');
  sb.ok('status', 'T1', 'verified');
  sb.ok('merge', 'T1');
  assert.equal(sb.taskOf('T1').status, 'merged');
  assert.equal(sb.git(sb.repo, 'branch', '--show-current'), 'main', `the main checkout stays off task/${TOPIC}/`);
});
