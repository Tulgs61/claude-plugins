// ops-detach.js: a detached command's output arrives through `wait`, and a second `start` while the
// first still runs starts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DETACH = fileURLToPath(new URL('../scripts/ops-detach.js', import.meta.url));
const detach = (...args) => spawnSync(process.execPath, [DETACH, ...args], { encoding: 'utf8' });

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-detach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('start runs the script detached and wait prints its output once it ends', t => {
  const dir = scratch(t);
  const script = path.join(dir, 'answer.js');
  writeFileSync(script, 'setTimeout(() => console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) })), 300);\n');
  const out = path.join(dir, 'run.out');
  const started = detach('start', out, script, 'verify', 'T1');
  assert.match(started.stdout, /^STARTED \d+/);
  const waited = detach('wait', out);
  assert.equal(waited.stdout.trim(), JSON.stringify({ ok: true, args: ['verify', 'T1'] }));
  assert.equal(existsSync(`${out}.done`), false, 'the result is consumed');
});

test('a second start while the first run is alive prints RUNNING and starts nothing', t => {
  const dir = scratch(t);
  const script = path.join(dir, 'slow.js');
  const marker = path.join(dir, 'count.txt');
  writeFileSync(
    script,
    `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => console.log('{"ok":true}'), 1500);\n`
  );
  const out = path.join(dir, 'run.out');
  assert.match(detach('start', out, script).stdout, /^STARTED/);
  assert.match(detach('start', out, script).stdout, /^RUNNING$/m);
  assert.equal(detach('wait', out).stdout.trim(), '{"ok":true}');
  // Once done, a new start runs the command again.
  assert.match(detach('start', out, script).stdout, /^STARTED/);
  detach('wait', out);
  assert.equal(readFileSync(marker, 'utf8'), 'xx');
});

test('wait consumes the result: a second wait, or a wait without a start, says NOT RUNNING', t => {
  const dir = scratch(t);
  const script = path.join(dir, 'answer.js');
  writeFileSync(script, 'console.log(\'{"ok":true}\');\n');
  const out = path.join(dir, 'run.out');
  assert.equal(detach('wait', out).stdout.trim(), 'NOT RUNNING');
  detach('start', out, script);
  assert.equal(detach('wait', out).stdout.trim(), '{"ok":true}');
  assert.equal(detach('wait', out).stdout.trim(), 'NOT RUNNING');
  assert.equal(existsSync(out) || existsSync(`${out}.done`) || existsSync(`${out}.beat`), false, 'nothing is left behind');
});

test('a stale heartbeat (dead runner) is not RUNNING: wait says NOT RUNNING and start runs again', t => {
  const dir = scratch(t);
  const script = path.join(dir, 'answer.js');
  writeFileSync(script, 'console.log(\'{"ok":true}\');\n');
  const out = path.join(dir, 'run.out');
  writeFileSync(out, '');
  writeFileSync(`${out}.beat`, '');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(`${out}.beat`, old, old);
  assert.equal(detach('wait', out).stdout.trim(), 'NOT RUNNING');
  assert.match(detach('start', out, script).stdout, /^STARTED/);
  assert.equal(detach('wait', out).stdout.trim(), '{"ok":true}');
});

test('usage errors exit 1', () => {
  assert.equal(detach('start', 'x').status, 1);
  assert.equal(detach('other', 'x').status, 1);
});
