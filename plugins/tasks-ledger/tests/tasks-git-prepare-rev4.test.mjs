// Rev 4, amendments 2 and 4: the run lock is taken atomically and restored when prepare fails;
// a glob holding `..` anywhere overlaps everything, in both copies of the glob-overlap block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { ENGINE, SCRIPT, markerBlock, sandbox, task } from './helpers/git-sandbox.mjs';

function runAsync(sb, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: sb.repo, env: sb.env });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0);
        const lines = out.split('\n').filter(Boolean);
        assert.equal(lines.length, 1, out);
        resolve(JSON.parse(lines[0]));
      } catch (e) {
        reject(e);
      }
    });
  });
}

test('racing prepare calls with different run ids: exactly one takes the lock', async t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  const ids = ['race-0', 'race-1', 'race-2', 'race-3', 'race-4', 'race-5'];
  const answers = await Promise.all(ids.map(id => runAsync(sb, 'prepare', sb.ledgerFile, id)));
  const winners = answers.filter(a => a.ok);
  assert.equal(winners.length, 1, JSON.stringify(answers));
  for (const a of answers.filter(x => !x.ok)) assert.match(a.error, /another run \(/);
  const winner = ids[answers.findIndex(a => a.ok)];
  assert.equal(JSON.parse(readFileSync(sb.lockFile, 'utf8')).runId, winner);
});

test('a failed prepare restores the lock that was there before the call', t => {
  const sb = sandbox(t, { tasks: [task('T1')] });
  sb.ok('prepare', 'run-one');
  const L = sb.ledger();
  L.setup = 'exit 4';
  sb.writeLedger(L);

  const live = readFileSync(sb.lockFile, 'utf8');
  const r = sb.run('prepare', 'run-two', 'takeover');
  assert.equal(r.ok, false);
  assert.match(r.error, /exit 4/);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), live, 'a taken-over live lock comes back');

  const stale = JSON.stringify({ runId: 'run-old', at: Date.now() - 7 * 60 * 60 * 1000 }) + '\n';
  writeFileSync(sb.lockFile, stale);
  assert.equal(sb.run('prepare', 'run-three').ok, false);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), stale, 'a replaced stale lock comes back');

  assert.equal(sb.run('prepare', 'run-old').ok, false);
  assert.equal(readFileSync(sb.lockFile, 'utf8'), stale, 'the same run id gets its own old lock back');
});

test('a failed prepare without a previous lock leaves none behind', t => {
  const sb = sandbox(t, { setup: 'exit 2' });
  assert.equal(sb.run('prepare', 'run-one').ok, false);
  assert.equal(existsSync(sb.lockFile), false);
});

for (const [name, file] of [['tasks-git.js', SCRIPT], ['tasks-engine.js', ENGINE]]) {
  test(`${name}: a pattern containing .. anywhere overlaps every other pattern`, () => {
    const ctx = vm.createContext({});
    vm.runInContext(markerBlock(readFileSync(file, 'utf8')) + '\nthis.globsOverlap = globsOverlap;', ctx);
    const { globsOverlap } = ctx;
    for (const g of ['src/a..b.js', 'src/..x', 'x../y', 'src\\..\\lib', '..', 'a/b/c...']) {
      for (const other of ['lib/x', 'docs/a.md', 'z', '']) {
        assert.ok(globsOverlap(g, other) && globsOverlap(other, g), `${g} vs ${other}`);
      }
    }
    assert.ok(!globsOverlap('src/a.js', 'lib/x'), 'patterns without .. are still disjoint');
  });
}

test('prepare warns about a task whose files glob contains .. inside a segment', t => {
  const sb = sandbox(t, { tasks: [task('T1', ['src/a..b/**']), task('T2', ['lib/**'])] });
  const r = sb.ok('prepare', 'run-one');
  assert.ok(r.warnings.some(w => /^T1 and T2 have overlapping files globs/.test(w)), JSON.stringify(r.warnings));
});
