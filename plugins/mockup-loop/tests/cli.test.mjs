// click-loop CLI: init, round, wait, stop. Run: node --test "plugins/mockup-loop/tests/*.test.mjs"
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { alive, initLoop, killAll, run, runAsync, sleep, startServer } from './helpers.mjs';

after(killAll);

const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const append = (dir, name, text) => fs.appendFileSync(path.join(dir, name), text);

test('spec 1: init creates the marker and round 1 and prints the native absolute dir', t => {
  const dir = initLoop(t);
  assert.ok(path.isAbsolute(dir));
  assert.equal(dir, fs.realpathSync.native(dir));
  assert.ok(path.basename(dir).startsWith('click-loop-'));
  assert.equal(path.dirname(dir), fs.realpathSync.native(os.tmpdir()));
  assert.ok(fs.statSync(path.join(dir, '.click-loop')).isFile());
  assert.equal(fs.readFileSync(path.join(dir, 'round.txt'), 'utf8').trim(), '1');
});

test('spec 1: round --next and --set print the new round and replace round.txt atomically', async t => {
  const dir = initLoop(t);
  const roundFile = path.join(dir, 'round.txt');
  const seen = [];
  const reader = setInterval(() => seen.push(fs.readFileSync(roundFile, 'utf8')), 1);
  t.after(() => clearInterval(reader));
  for (let i = 2; i <= 12; i++) {
    const r = await runAsync(['round', '--dir', dir, '--next']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${i}\n`);
  }
  clearInterval(reader);
  assert.ok(seen.length > 0);
  for (const text of seen) assert.match(text, /^\d+\n$/, 'a reader never sees a partial round.txt');

  const set = run(['round', '--dir', dir, '--set', '7']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout, '7\n');
  assert.equal(fs.readFileSync(roundFile, 'utf8'), '7\n');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp files left behind');
});

test('spec 1: round rejects bad usage and dirs without the marker', t => {
  const dir = initLoop(t);
  for (const args of [['--next', '--set', '2'], [], ['--set', '0'], ['--set', 'x']]) {
    const r = run(['round', '--dir', dir, ...args]);
    assert.equal(r.status, 1, `round ${args.join(' ')} must fail`);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'round.txt'), 'utf8').trim(), '1');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'click-loop-test-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const r = run(['round', '--dir', plain, '--next']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a click-loop dir/);
  assert.equal(fs.existsSync(path.join(plain, 'round.txt')), false);
});

test('spec 6: wait returns a pick written before it started', t => {
  const dir = initLoop(t);
  write(dir, 'picks.jsonl', '{"round":1,"id":"r1-b","note":"","at":"2026-01-01T00:00:00.000Z"}\n');
  const r = run(['wait', '--dir', dir, '--timeout-sec', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { round: 1, id: 'r1-b', note: '', at: '2026-01-01T00:00:00.000Z' });
});

test('spec 6: wait ignores other rounds and malformed lines', async t => {
  const dir = initLoop(t);
  run(['round', '--dir', dir, '--set', '2']);
  write(dir, 'picks.jsonl', '{"round":1,"id":"r1-a"}\nnot json at all\n{"round":"2","id":"string-round"}\n{broken\n');
  const pending = runAsync(['wait', '--dir', dir, '--timeout-sec', '10']);
  await sleep(800);
  append(dir, 'picks.jsonl', '{"round":3,"id":"r3-a"}\n{"round":2,"id":"r2-c","note":"wider"}\n');
  const r = await pending;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { round: 2, id: 'r2-c', note: 'wider' });
});

test('spec 6: wait handles a line written in two chunks', async t => {
  const dir = initLoop(t);
  write(dir, 'picks.jsonl', '{"round":1,"id":"r1-');
  const pending = runAsync(['wait', '--dir', dir, '--timeout-sec', '10']);
  await sleep(1200); // at least two polls see only the first chunk
  append(dir, 'picks.jsonl', 'c"}\n');
  const r = await pending;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { round: 1, id: 'r1-c' });
});

test('spec 6: wait escapes U+2028 and U+2029 so its output is exactly one line', t => {
  const dir = initLoop(t);
  // Raw separators inside the JSON string, as any writer of picks.jsonl may leave them.
  write(dir, 'picks.jsonl', '{"round":1,"id":"r1-a","note":"left\u2028right\u2029end"}\n');
  const r = run(['wait', '--dir', dir, '--timeout-sec', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(/\r?\n|\r|\u2028|\u2029/).filter(Boolean).length, 1);
  assert.doesNotMatch(r.stdout, /[\u2028\u2029]/);
  assert.match(r.stdout, /left\\u2028right\\u2029end/);
  assert.equal(JSON.parse(r.stdout).note, 'left\u2028right\u2029end');
});

test('spec 6: wait exits 3 when the round moves on', async t => {
  const dir = initLoop(t);
  const pending = runAsync(['wait', '--dir', dir, '--timeout-sec', '10']);
  await sleep(600);
  assert.equal(run(['round', '--dir', dir, '--next']).status, 0);
  const r = await pending;
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout), { superseded: true, round: 1 });
});

test('spec 6: wait exits 2 on timeout, and --round selects the round', t => {
  const dir = initLoop(t);
  write(dir, 'picks.jsonl', '{"round":1,"id":"r1-a"}\n');
  const r = run(['wait', '--dir', dir, '--round', '2', '--timeout-sec', '1']);
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout), { timeout: true, round: 2 });
});

test('spec 8: stop stops a confirmed server and removes server.json', async t => {
  const dir = initLoop(t);
  const srv = await startServer(t, dir);
  assert.ok(fs.existsSync(path.join(dir, 'server.json')));
  const r = run(['stop', '--dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^stopped http:\/\/127\.0\.0\.1:/);
  const { code } = await srv.exited;
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

const freePort = async () => {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  return port;
};

test('spec 8: stop leaves an answering but unconfirmed server alone and never signals its pid', async t => {
  const dir = initLoop(t);
  // A bystander process whose pid is named in server.json, and a port that answers with a foreign nonce.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => bystander.kill('SIGKILL'));
  let answered = 0;
  const decoy = http.createServer((req, res) => {
    answered++;
    res.end('some-other-nonce');
  });
  await new Promise(r => decoy.listen(0, '127.0.0.1', r));
  t.after(() => decoy.close());
  const port = decoy.address().port;
  const serverJson = JSON.stringify({ pid: bystander.pid, port, url: `http://127.0.0.1:${port}/`, nonce: 'mine' });
  write(dir, 'server.json', serverJson);

  // runAsync, not run: a blocking spawnSync would keep this process from answering as the decoy.
  for (const args of [[], ['--clean']]) {
    const r = await runAsync(['stop', '--dir', dir, ...args]);
    assert.equal(r.status, 1, `stop ${args} must fail`);
    assert.match(r.stderr, /could not confirm the server/);
    assert.equal(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'), serverJson, 'server.json left in place');
    assert.ok(fs.existsSync(path.join(dir, '.click-loop')), '--clean deleted nothing');
  }
  assert.ok(answered >= 2, 'stop asked the decoy for its nonce');
  await sleep(200);
  assert.ok(alive(bystander), 'the unconfirmed pid was not signalled');
});

test('spec 8: stop removes a stale server.json (nothing answers) without signalling its pid, idempotently', async t => {
  const dir = initLoop(t);
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => bystander.kill('SIGKILL'));
  const port = await freePort();
  write(dir, 'server.json', JSON.stringify({ pid: bystander.pid, port, url: `http://127.0.0.1:${port}/`, nonce: 'mine' }));

  const r = await runAsync(['stop', '--dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no running server/);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  await sleep(200);
  assert.ok(alive(bystander), 'the stale pid was not signalled');

  const again = await runAsync(['stop', '--dir', dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(alive(bystander));
});

test('spec 8: stop reports a timeout when a confirmed server does not go down', async t => {
  const dir = initLoop(t);
  let stopRequests = 0;
  // Answers /__id with the recorded nonce but ignores /__stop.
  const stubborn = http.createServer((req, res) => {
    if (req.url.startsWith('/__stop')) stopRequests++;
    res.end(req.url === '/__id' ? 'the-nonce' : '');
  });
  await new Promise(r => stubborn.listen(0, '127.0.0.1', r));
  t.after(() => stubborn.close());
  const port = stubborn.address().port;
  const serverJson = JSON.stringify({ pid: 1, port, url: `http://127.0.0.1:${port}/`, nonce: 'the-nonce' });
  write(dir, 'server.json', serverJson);

  const r = await runAsync(['stop', '--dir', dir, '--clean']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not stop within/);
  assert.doesNotMatch(r.stdout, /stopped/);
  assert.equal(stopRequests, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'), serverJson);
  assert.ok(fs.existsSync(dir), '--clean deleted nothing');
});

test('spec 8: stop refuses a dir without .click-loop and leaves its server.json untouched', t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'click-loop-test-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const serverJson = JSON.stringify({ pid: 1, port: 1, url: 'http://127.0.0.1:1/', nonce: 'x' });
  write(plain, 'server.json', serverJson);
  const r = run(['stop', '--dir', plain]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to touch .*no \.click-loop marker/);
  assert.equal(fs.readFileSync(path.join(plain, 'server.json'), 'utf8'), serverJson);
  assert.deepEqual(fs.readdirSync(plain), ['server.json']);
});

test('spec 8: stop --clean refuses a dir without .click-loop and deletes a loop dir', t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'click-loop-test-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  write(plain, 'keep.txt', 'important');
  const refused = run(['stop', '--dir', plain, '--clean']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to touch/);
  assert.ok(fs.existsSync(path.join(plain, 'keep.txt')));

  const dir = initLoop(t);
  write(dir, 'index.html', '<p>x</p>');
  const cleaned = run(['stop', '--dir', dir, '--clean']);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(fs.existsSync(dir), false);
  const again = run(['stop', '--dir', dir, '--clean']);
  assert.equal(again.status, 0, 'stop --clean on a removed dir is a no-op');
});

test('spec 8: SIGTERM stops the server and removes server.json', { skip: process.platform === 'win32' }, async t => {
  const dir = initLoop(t);
  const srv = await startServer(t, dir);
  srv.child.kill('SIGTERM');
  await srv.exited;
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});
