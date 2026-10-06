// Rev 10, amendment 5: verify and merge take the verify command from the base's committed
// .claude/verify.cmd, fail with `verify.cmd is not tracked` when the base has none, and refuse a
// branch that changes .claude/verify.cmd in any spelling of upper and lower case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sandbox, task } from './helpers/git-sandbox.mjs';

test('a task branch that edits the worktree\'s verify.cmd to exit 0 still runs the base\'s command', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const prep = sb.ok('prepare', 'run-one');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'FAIL_VERIFY', 'x\n');
  // Hidden from git status, so the worktree looks clean and the branch changes nothing.
  sb.git(w.worktree, 'update-index', '--skip-worktree', '.claude/verify.cmd');
  writeFileSync(path.join(w.worktree, '.claude', 'verify.cmd'), 'exit 0\n');
  assert.equal(sb.git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');

  const v = sb.run('verify', 'T1');
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.match(v.error, /verify\.cmd exited 1/);

  sb.ok('status', 'T1', 'verified');
  const m = sb.run('merge', 'T1');
  assert.equal(m.ok, false, JSON.stringify(m));
  assert.match(m.error, /combined check failed after merging \(test ! -e FAIL_VERIFY, exit 1\)/);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead);
});

for (const spelling of ['.claude/VERIFY.cmd', '.Claude/verify.CMD']) {
  test(`a task branch adding ${spelling} is refused by verify and merge`, t => {
    const sb = sandbox(t, { tasks: [task('T1')] });
    const prep = sb.ok('prepare', 'run-one');
    const intHead = sb.sha(prep.integration, 'HEAD');
    const w = sb.ok('worktree', 'T1');
    sb.commit(w.worktree, 'a.txt', 'a\n');
    // Added through the index, so a case-insensitive file system cannot fold it into verify.cmd.
    const blobFile = path.join(sb.tmp, 'blob');
    writeFileSync(blobFile, 'exit 0\n');
    const blob = sb.git(w.worktree, 'hash-object', '-w', blobFile);
    sb.git(w.worktree, 'update-index', '--add', '--cacheinfo', `100644,${blob},${spelling}`);
    sb.git(w.worktree, 'commit', '-q', '-m', `add ${spelling}`);

    const v = sb.run('verify', 'T1');
    assert.equal(v.ok, false, JSON.stringify(v));
    assert.ok(v.error.includes(`modifies ${spelling}`), v.error);
    assert.match(v.error, /outside a run/);

    sb.ok('status', 'T1', 'verified');
    const before = sb.ledger();
    const m = sb.run('merge', 'T1');
    assert.equal(m.ok, false, JSON.stringify(m));
    assert.match(m.error, /outside a run/);
    assert.equal(sb.sha(prep.integration, 'HEAD'), intHead, 'nothing merged');
    assert.deepEqual(sb.ledger(), before);
  });
}

test('verify and merge fail with "verify.cmd is not tracked" when the base has no verify.cmd', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  // origin/main (the start ref) loses verify.cmd; the main checkout keeps it tracked.
  sb.git(sb.repo, 'rm', '-q', '.claude/verify.cmd');
  sb.git(sb.repo, 'commit', '-q', '-m', 'drop verify.cmd');
  sb.git(sb.repo, 'push', '-q', 'origin', 'main');
  sb.git(sb.repo, 'reset', '-q', '--hard', 'HEAD~1');

  const prep = sb.ok('prepare', 'run-one');
  assert.equal(prep.start, 'origin/main');
  const intHead = sb.sha(prep.integration, 'HEAD');
  const w = sb.ok('worktree', 'T1');
  sb.commit(w.worktree, 'a.txt', 'a\n');

  const v = sb.run('verify', 'T1');
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.match(v.error, /verify\.cmd is not tracked/);

  sb.ok('status', 'T1', 'verified');
  const m = sb.run('merge', 'T1');
  assert.equal(m.ok, false, JSON.stringify(m));
  assert.match(m.error, /verify\.cmd is not tracked/);
  assert.equal(sb.sha(prep.integration, 'HEAD'), intHead);
  assert.equal(sb.taskOf('T1').status, 'verified');
});
