// click-loop serve: binding, static files, request checks, picks, second server, idle shutdown.
// Run: node --test "plugins/mockup-loop/tests/*.test.mjs"
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { alive, initLoop, killAll, readPicks, request, run, sleep, startServer } from './helpers.mjs';

after(killAll);

const INDEX = '<!doctype html><title>variants</title><script src="/__loop.js"></script>';

function canConnect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function servedLoop(t, opts) {
  const dir = initLoop(t);
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  const srv = await startServer(t, dir, opts);
  return { dir, ...srv };
}

const pick = (port, id, query, headers = {}) => request(port, { method: 'POST', path: `/__pick/${id}?${query}`, headers });

test('spec 2: the server binds 127.0.0.1 and server.json names 127.0.0.1', async t => {
  const { dir, url, port, child } = await servedLoop(t);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
  assert.equal(new URL(info.url).hostname, '127.0.0.1');
  assert.equal(info.url, url);
  assert.equal(info.port, port);
  assert.equal(info.pid, child.pid);
  assert.match(info.nonce, /^[0-9a-f]{32}$/);
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));

  assert.equal(await canConnect('127.0.0.1', port), true);
  const external = Object.values(os.networkInterfaces())
    .flat()
    .filter(a => a && !a.internal && a.family === 'IPv4')
    .map(a => a.address);
  for (const address of external.slice(0, 2)) {
    assert.equal(await canConnect(address, port), false, `must not accept connections on ${address}`);
  }
  assert.equal(await canConnect('::1', port), false, 'must not listen on IPv6 loopback either');
});

test('spec 3: / serves index.html with no-store; the client helper is served from the plugin', async t => {
  const { port } = await servedLoop(t);
  const index = await request(port, { path: '/' });
  assert.equal(index.status, 200);
  assert.equal(index.body, INDEX);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['cache-control'], 'no-store');
  const named = await request(port, { path: '/index.html' });
  assert.equal(named.body, INDEX);
  const client = await request(port, { path: '/__loop.js' });
  assert.equal(client.status, 200);
  assert.match(client.headers['content-type'], /^text\/javascript/);
  assert.match(client.body, /window\.pick = pick/);
  assert.equal((await request(port, { path: '/__round' })).body, '1');
});

test('spec 3: traversal, malformed escapes, NUL, backslash and drive letters are 400/404 and never crash', async t => {
  const { dir, port, child } = await servedLoop(t);
  // A secret next to the loop dir (same parent) that must stay unreachable.
  const secretName = `${path.basename(dir)}-secret.txt`;
  const secret = path.join(path.dirname(dir), secretName);
  fs.writeFileSync(secret, 'secret');
  t.after(() => fs.rmSync(secret, { force: true }));

  const cases = [
    [`/../${secretName}`, 404],
    [`/sub/../../${secretName}`, 404],
    [`/%2e%2e/${secretName}`, 404],
    [`/%2E%2E%2F${secretName}`, 404],
    [`/x/..%2f..%2f${secretName}`, 404],
    ['/%zz', 400],
    ['/%E0%A4%A', 400],
    ['/%', 400],
    ['/index.html%00.png', 400],
    ['/..%5c' + secretName, 400],
    ['/sub\\..\\..\\' + secretName, 400],
    ['/C:/Windows/win.ini', 400],
    ['/c%3A/x', 400],
    ['/missing.html', 404],
  ];
  for (const [p, status] of cases) {
    const res = await request(port, { path: p });
    assert.equal(res.status, status, `${p} -> ${res.status}`);
    assert.doesNotMatch(res.body, /secret/);
  }
  assert.ok(alive(child), 'server survived every request');
  assert.equal((await request(port, { path: '/' })).status, 200);
});

test('spec 3: symlink escapes are 404', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const { dir, port } = await servedLoop(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'click-loop-test-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  fs.symlinkSync(outside, path.join(dir, 'linkdir'));
  fs.symlinkSync(path.join(dir, 'picks.jsonl'), path.join(dir, 'alias.txt'));
  fs.writeFileSync(path.join(dir, 'picks.jsonl'), '{"round":1,"id":"r1-a"}\n');
  for (const p of ['/link.txt', '/linkdir/secret.txt', '/alias.txt']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 404, p);
  }
});

test('spec 3: the realpath containment check alone stops a symlink to a plain sibling dir', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const { dir, port } = await servedLoop(t);
  // A non-hidden sibling of the loop dir, holding non-hidden names: no other check can reject it.
  const sibling = `${dir}-sibling`;
  fs.mkdirSync(sibling);
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sibling, 'page.html'), 'outside-content');
  fs.symlinkSync(sibling, path.join(dir, 'assets'));
  fs.symlinkSync(path.join(sibling, 'page.html'), path.join(dir, 'page.html'));
  for (const p of ['/assets/page.html', '/page.html']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.body, /outside-content/);
  }
});

test('spec 3: picks.jsonl, server.json and dotfiles are 404; no directory listing', async t => {
  const { dir, port } = await servedLoop(t);
  fs.writeFileSync(path.join(dir, 'picks.jsonl'), '{"round":1,"id":"r1-a"}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'X=1');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'listed-file.css'), 'body{}');
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, '.hidden', 'a.html'), 'x');
  for (const p of ['/picks.jsonl', '/server.json', '/PICKS.JSONL', '/.click-loop', '/.env', '/round.txt/../.env', '/.hidden/a.html', '/sub', '/sub/']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.body, /listed-file|nonce|r1-a/);
  }
  const css = await request(port, { path: '/sub/listed-file.css' });
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  fs.writeFileSync(path.join(dir, 'data.bin'), 'x');
  assert.equal((await request(port, { path: '/data.bin' })).headers['content-type'], 'application/octet-stream');
});

test('spec 4: a wrong Host is 403', async t => {
  const { port } = await servedLoop(t);
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `0.0.0.0:${port}`]) {
    const res = await request(port, { path: '/', headers: { Host: host } });
    assert.equal(res.status, 403, host);
  }
  assert.equal((await request(port, { path: '/', headers: { Host: `localhost:${port}` } })).status, 200);
});

test('spec 4: foreign Origin on pick is 403, GET on pick is 405, invalid id or long note is 400', async t => {
  const { dir, port } = await servedLoop(t);
  assert.equal((await pick(port, 'r1-a', 'round=1', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await pick(port, 'r1-a', 'round=1', { Origin: `http://127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await pick(port, 'r1-a', 'round=1', { Origin: 'null' })).status, 403);
  assert.equal((await request(port, { method: 'GET', path: '/__pick/r1-a?round=1' })).status, 405);
  for (const id of ['', 'a.b', 'a%20b', '..', 'x'.repeat(65), 'r1-a/extra']) {
    assert.equal((await pick(port, id, 'round=1')).status, 400, `id ${JSON.stringify(id)}`);
  }
  assert.equal((await pick(port, 'r1-a', `round=1&note=${'n'.repeat(501)}`)).status, 400);
  assert.equal((await pick(port, 'r1-a', 'round=abc')).status, 400);
  assert.equal((await pick(port, 'r1-a', '')).status, 400);
  assert.equal(readPicks(dir), '', 'no rejected pick was recorded');
  assert.equal((await pick(port, 'r1-a', 'round=1', { Origin: `http://127.0.0.1:${port}` })).status, 204);
  assert.equal((await pick(port, 'r1-b', `round=1&note=${'n'.repeat(500)}`)).status, 204);
});

test('spec 5: a pick with the current round is 204 and appended; an old round is 409 and not appended', async t => {
  const { dir, port } = await servedLoop(t);
  const ok = await pick(port, 'r1-a', 'round=1&note=' + encodeURIComponent('bigger "title"\nplease'));
  assert.equal(ok.status, 204);
  const lines = readPicks(dir).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.deepEqual({ round: rec.round, id: rec.id, note: rec.note }, { round: 1, id: 'r1-a', note: 'bigger "title"\nplease' });
  assert.ok(!Number.isNaN(Date.parse(rec.at)));

  assert.equal(run(['round', '--dir', dir, '--next']).status, 0);
  assert.equal((await request(port, { path: '/__round' })).body, '2');
  const stale = await pick(port, 'r1-b', 'round=1');
  assert.equal(stale.status, 409);
  assert.equal(readPicks(dir).split('\n').filter(Boolean).length, 1, 'stale pick not appended');
  assert.equal((await pick(port, 'r2-a', 'round=2')).status, 204);
  assert.equal(readPicks(dir).split('\n').filter(Boolean).length, 2);
});

test('spec 5: a note with U+2028/U+2029 is stored as exactly one escaped line', async t => {
  const { dir, port } = await servedLoop(t);
  const note = 'one\u2028two\u2029three';
  assert.equal((await pick(port, 'r1-a', `round=1&note=${encodeURIComponent(note)}`)).status, 204);
  const text = readPicks(dir);
  assert.doesNotMatch(text, /[\u2028\u2029]/);
  assert.equal(text.split(/\r?\n|\r|\u2028|\u2029/).filter(Boolean).length, 1);
  assert.equal(JSON.parse(text).note, note);
  const waited = run(['wait', '--dir', dir, '--timeout-sec', '5']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).note, note);
});

test('spec 7: a second serve on the same dir reuses the running server', async t => {
  const { dir, url } = await servedLoop(t);
  const before = fs.readFileSync(path.join(dir, 'server.json'), 'utf8');
  const second = run(['serve', '--dir', dir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), url);
  assert.equal(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'), before);
});

test('spec 7: a stale server.json (no answer or wrong nonce) is replaced', async t => {
  const dir = initLoop(t);
  // No answer: a port that was free a moment ago.
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise(r => probe.close(r));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: 1, port: deadPort, url: `http://127.0.0.1:${deadPort}/`, nonce: 'old' }));
  const first = await startServer(t, dir);
  let info = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
  assert.notEqual(info.nonce, 'old');
  assert.equal(info.url, first.url);
  first.child.kill('SIGKILL');
  await first.exited;

  // Wrong nonce: something answers /__id, but not with the recorded nonce.
  const decoy = http.createServer((req, res) => res.end('another-nonce'));
  await new Promise(r => decoy.listen(0, '127.0.0.1', r));
  t.after(() => decoy.close());
  const decoyUrl = `http://127.0.0.1:${decoy.address().port}/`;
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: 1, port: decoy.address().port, url: decoyUrl, nonce: 'old' }));
  const second = await startServer(t, dir);
  info = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
  assert.equal(info.url, second.url);
  assert.notEqual(second.url, decoyUrl);
  assert.equal((await request(second.port, { path: '/__id' })).body, info.nonce);
});

test('spec 9: idle shutdown, and /__round polls do not keep the server alive', async t => {
  const { dir, port, exited, child } = await servedLoop(t, { env: { CLICK_LOOP_TEST_IDLE_MS: '800' } });
  const started = Date.now();
  let polls = 0;
  const poller = setInterval(() => {
    request(port, { path: '/__round' }).then(() => polls++, () => {});
  }, 150);
  t.after(() => clearInterval(poller));
  const result = await Promise.race([exited, sleep(8000).then(() => 'still running')]);
  clearInterval(poller);
  assert.notEqual(result, 'still running', 'server must shut down while only polls arrive');
  assert.equal(result.code, 0);
  assert.ok(polls >= 2, `polls were answered (${polls})`);
  assert.ok(Date.now() - started < 8000);
  assert.equal(alive(child), false);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('spec 9: a non-poll request resets the idle timer', async t => {
  const { port, exited } = await servedLoop(t, { env: { CLICK_LOOP_TEST_IDLE_MS: '1000' } });
  let done = false;
  exited.then(() => (done = true));
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    assert.equal((await request(port, { path: '/' })).status, 200);
  }
  assert.equal(done, false, 'still alive after 2 s of page requests with a 1 s idle limit');
  await Promise.race([exited, sleep(5000)]);
  assert.equal(done, true);
});
