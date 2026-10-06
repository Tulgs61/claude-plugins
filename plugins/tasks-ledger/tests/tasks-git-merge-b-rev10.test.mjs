// Rev 10, amendments 10 and 11: a merge that would overwrite untracked files in the integration
// worktree fails with its own message and changes nothing; overlap warnings skip merged tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sandbox, task } from './helpers/git-sandbox.mjs';

test('amendment 10: untracked files in the integration worktree that the merge would overwrite block it', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const { integration } = sb.ok('prepare', 'run-one');
  const w = sb.ok('worktree', 'T1');
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
  for (const n of names) sb.write(w.worktree, `out/${n}`, `from T1 ${n}\n`);
  sb.git(w.worktree, 'add', '-A');
  sb.git(w.worktree, 'commit', '-q', '-m', 'T1: work');
  sb.ok('status', 'T1', 'verified', 'reviewed');
  for (const n of names) sb.write(integration, `out/${n}`, `local ${n}\n`);
  const head = sb.sha(integration, 'HEAD');
  const before = sb.ledger();

  const r = sb.run('merge', 'T1');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /^T1: untracked files in the integration worktree block the merge: /);
  assert.doesNotMatch(r.error, /conflicts with already-merged tasks/);
  const listed = r.error.slice(r.error.indexOf('merge: ') + 'merge: '.length).split(', ');
  assert.equal(listed.length, 5, r.error);
  for (const p of listed) assert.ok(names.map(n => `out/${n}`).includes(p), p);

  assert.equal(sb.taskOf('T1').status, 'verified');
  assert.deepEqual(sb.ledger(), before);
  assert.equal(sb.sha(integration, 'HEAD'), head);
  for (const n of names) assert.equal(readFileSync(path.join(integration, 'out', n), 'utf8'), `local ${n}\n`);
  assert.equal(sb.git(integration, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('amendment 11: a pair in which either task is merged gets no overlap warning', t => {
  const sb = sandbox(t, {
    tasks: [
      task('T1', ['src/**'], [], { status: 'merged' }),
      task('T2', ['src/a.js']),
      task('T3', ['src/b.js']),
      task('T4', ['lib/**'], [], { status: 'merged' }),
      task('T5', ['lib/x.js'], [], { status: 'merged' }),
    ],
  });
  const r = sb.ok('prepare', 'run-one');
  const pairs = r.warnings.filter(w => w.includes('have overlapping files globs')).map(w => w.split(' have ')[0]);
  assert.deepEqual(pairs, []);
});
