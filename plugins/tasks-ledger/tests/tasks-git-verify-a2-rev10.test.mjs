// Rev 10, amendment 16: merge reads the base's verify command only when it makes a merge, and an
// empty or whitespace-only verify.cmd on the base fails verify and merge with `verify.cmd is empty`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, task } from './helpers/git-sandbox.mjs';

test('merge of an already-merged task needs no verify.cmd on the base', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const prep = sb.ok('prepare', 'run-one');
  const merged = sb.complete('T1');
  // origin/main (the start ref) loses verify.cmd; the main checkout keeps it.
  sb.git(sb.repo, 'rm', '-q', '.claude/verify.cmd');
  sb.git(sb.repo, 'commit', '-q', '-m', 'drop verify.cmd');
  sb.git(sb.repo, 'push', '-q', 'origin', 'main');
  sb.git(sb.repo, 'reset', '-q', '--hard', 'HEAD~1');

  sb.ok('status', 'T1', 'verified');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const m = sb.run('merge', 'T1');
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(m.already, true);
  assert.equal(m.sha, merged.sha);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead);
  assert.equal(sb.taskOf('T1').status, 'merged');
});

test('a whitespace-only verify.cmd on the base fails verify and merge with "verify.cmd is empty"', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.commit(sb.repo, '.claude/verify.cmd', '  \n\t\n', 'empty verify.cmd');
  sb.git(sb.repo, 'push', '-q', 'origin', 'main');

  const prep = sb.ok('prepare', 'run-one');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');

  const v = sb.run('verify', 'T1');
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.match(v.error, /verify\.cmd is empty/);

  sb.ok('status', 'T1', 'verified');
  const before = sb.ledger();
  const m = sb.run('merge', 'T1');
  assert.equal(m.ok, false, JSON.stringify(m));
  assert.match(m.error, /verify\.cmd is empty/);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead, 'nothing merged');
  assert.deepEqual(sb.ledger(), before);
});
