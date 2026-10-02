#!/usr/bin/env node
// click-loop: serve UI mockups on 127.0.0.1 and collect the variant the user clicks.
// Node built-ins only. Commands:
//   init                                                   create a loop dir, print its absolute path
//   round --dir <dir> (--next | --set N)                   change the round atomically, print it
//   serve --dir <dir> [--port 0] [--idle-min 30] [--max-hours 4]
//   wait  --dir <dir> [--round N] [--timeout-sec 600]      exit 0 pick, 2 timeout, 3 superseded
//   stop  --dir <dir> [--clean]                            stop a confirmed server, optionally delete the dir
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(SCRIPT_DIR, 'loop-client.js');
const MARKER = '.click-loop';
const ROUND = 'round.txt';
const PICKS = 'picks.jsonl';
const SERVER = 'server.json';
const HIDDEN = new Set([PICKS, SERVER]);
// Dotfiles and the runtime files are never served (compared case-insensitively for case-insensitive file systems).
const hiddenSegment = s => s.startsWith('.') || HIDDEN.has(s.toLowerCase());
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTE = 500;
const MAX_TIMER_MS = 2 ** 31 - 1;
const STOP_WAIT_MS = 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

class UsageError extends Error {}

function fail(msg, code = 1) {
  process.stderr.write(`click-loop: ${msg}\n`);
  process.exitCode = code;
}

// One JSON record per line: U+2028/U+2029 are valid inside JSON strings but count as line breaks for
// some readers, so they are escaped too.
const jsonLine = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// Write a line to stdout and only then exit, so piped output is never lost.
function finish(line, code) {
  process.stdout.write(`${line}\n`, () => process.exit(code));
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (['next', 'clean'].includes(key)) {
      opts[key] = true;
    } else if (['dir', 'set', 'port', 'idle-min', 'max-hours', 'round', 'timeout-sec'].includes(key)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      opts[key] = argv[++i];
    } else {
      throw new UsageError(`unknown option: ${a}`);
    }
  }
  return opts;
}

function num(value, name, { min, integer = false }) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
  return n;
}

// The loop dir as its native absolute realpath. requireMarker: only dirs made by `init` qualify.
function loopDir(opts, { requireMarker = true } = {}) {
  if (!opts.dir) throw new UsageError('--dir is required');
  let dir;
  try {
    dir = fs.realpathSync.native(path.resolve(opts.dir));
  } catch {
    throw new UsageError(`no such directory: ${opts.dir}`);
  }
  if (!fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${opts.dir}`);
  if (requireMarker && !fs.existsSync(path.join(dir, MARKER))) {
    throw new UsageError(`${dir} is not a click-loop dir (no ${MARKER}); create one with init`);
  }
  return dir;
}

function readRound(dir) {
  const n = Number.parseInt(fs.readFileSync(path.join(dir, ROUND), 'utf8').trim(), 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${ROUND}`);
  return n;
}

// Temp file (a dotfile, never served) + rename: readers see the old or the new content, never a partial one.
function writeAtomic(dir, name, text) {
  const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function readServerJson(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, SERVER), 'utf8'));
    if (j && typeof j.url === 'string' && typeof j.nonce === 'string') return j;
  } catch {
    /* missing or malformed */
  }
  return null;
}

// Only loopback URLs are ever contacted, whatever server.json says.
function loopbackUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port ? u : null;
  } catch {
    return null;
  }
}

function request(url, { method = 'GET', timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    const req = http.request(url, { method, timeout: timeoutMs, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        if (body.length < 4096) body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// What server.json points at:
//   none        no readable server.json
//   stale       nothing answers at its url (or the url is not loopback, so it is never contacted)
//   unconfirmed something answers at its url, but not with its nonce
//   confirmed   its url answers /__id with its nonce
async function probeServer(dir) {
  const info = readServerJson(dir);
  if (!info) return { state: 'none' };
  const base = loopbackUrl(info.url);
  if (!base) return { state: 'stale', info };
  const res = await request(new URL('/__id', base));
  if (!res) return { state: 'stale', info };
  if (res.status === 200 && res.body === info.nonce) return { state: 'confirmed', info, base };
  return { state: 'unconfirmed', info, base };
}

// ---------- init / round ----------

function cmdInit() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'click-loop-')));
  fs.writeFileSync(path.join(dir, MARKER), 'click-loop directory; delete with: click-loop stop --clean\n');
  fs.writeFileSync(path.join(dir, ROUND), '1\n');
  process.stdout.write(`${dir}\n`);
}

function cmdRound(opts) {
  const dir = loopDir(opts);
  if (!!opts.next === (opts.set !== undefined)) throw new UsageError('round needs exactly one of --next or --set N');
  const next = opts.next ? readRound(dir) + 1 : num(opts.set, '--set', { min: 1, integer: true });
  writeAtomic(dir, ROUND, `${next}\n`);
  process.stdout.write(`${next}\n`);
}

// ---------- serve ----------

function send(res, status, body = '', type = 'text/plain; charset=utf-8', head = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(head ? undefined : buf);
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Resolves a request path to a file inside root, or returns an HTTP status (400/404).
function resolveStatic(root, rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return 400;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return 400;
  const segments = decoded.split('/').filter(s => s !== '');
  if (segments.some(s => /^[A-Za-z]:/.test(s))) return 400;
  if (segments.length === 0) segments.push('index.html');
  if (segments.some(hiddenSegment)) return 404;
  let real;
  try {
    real = fs.realpathSync.native(path.join(root, ...segments));
  } catch {
    return 404;
  }
  if (!inside(real, root)) return 404; // the one guard against escapes: '..', encoded '..', symlinks
  // Names only (containment is checked above): a symlink inside the dir must not reach a dotfile or a
  // runtime file inside it either.
  const relParts = path.relative(root, real).split(path.sep).filter(s => s !== '..');
  if (relParts.some(hiddenSegment)) return 404;
  try {
    if (!fs.statSync(real).isFile()) return 404; // no directory listing
  } catch {
    return 404;
  }
  return real;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function cmdServe(opts) {
  const root = loopDir(opts);
  const port = num(opts.port ?? '0', '--port', { min: 0, integer: true });
  if (port > 65535) throw new UsageError('--port must be <= 65535');
  const idleMin = num(opts['idle-min'] ?? '30', '--idle-min', { min: 0.001 });
  const maxHours = num(opts['max-hours'] ?? '4', '--max-hours', { min: 0.001 });
  // Test-only override, deliberately undocumented.
  const idleMs = Math.min(MAX_TIMER_MS, Number(process.env.CLICK_LOOP_TEST_IDLE_MS) || idleMin * 60_000);
  const maxMs = Math.min(MAX_TIMER_MS, maxHours * 3_600_000);

  const existing = await probeServer(root);
  if (existing.state === 'confirmed') {
    finish(existing.info.url, 0);
    return;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  let boundPort = 0;
  let idleTimer = null;
  let stopping = false;

  const cleanup = () => {
    const info = readServerJson(root);
    if (info && info.nonce === nonce) fs.rmSync(path.join(root, SERVER), { force: true });
  };
  const shutdown = (why, code = 0) => {
    if (stopping) return;
    stopping = true;
    cleanup();
    process.stderr.write(`click-loop: server stopped (${why})\n`);
    process.exit(code);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown('idle'), idleMs);
  };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
      process.stderr.write(`click-loop: ${e && e.message}\n`);
    }
  });

  function handle(req, res) {
    req.resume(); // bodies are never read
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return send(res, 403, 'forbidden host');
    const ownOrigin = `http://${host}`;
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const rawPath = q === -1 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
    const head = req.method === 'HEAD';
    const isGet = req.method === 'GET' || head;

    if (rawPath === '/__round') {
      if (!isGet) return send(res, 405, 'method not allowed');
      return send(res, 200, String(readRound(root)), undefined, head);
    }
    touch();
    if (rawPath === '/__id') {
      if (!isGet) return send(res, 405, 'method not allowed');
      return send(res, 200, nonce, undefined, head);
    }
    if (rawPath === '/__loop.js') {
      if (!isGet) return send(res, 405, 'method not allowed');
      return send(res, 200, fs.readFileSync(CLIENT_JS), MIME['.js'], head);
    }
    if (rawPath === '/__stop') {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      if (req.headers.origin !== undefined && req.headers.origin !== ownOrigin) return send(res, 403, 'forbidden origin');
      if (!safeEqual(query.get('nonce') ?? '', nonce)) return send(res, 403, 'wrong nonce');
      res.on('finish', () => shutdown('stop requested'));
      return send(res, 204);
    }
    if (rawPath.startsWith('/__pick/')) {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      if (req.headers.origin !== undefined && req.headers.origin !== ownOrigin) return send(res, 403, 'forbidden origin');
      const id = rawPath.slice('/__pick/'.length);
      const roundParam = query.get('round') ?? '';
      const note = query.get('note') ?? '';
      if (!ID_RE.test(id) || !/^[1-9]\d{0,8}$/.test(roundParam) || note.length > MAX_NOTE) {
        return send(res, 400, 'bad pick');
      }
      const round = Number(roundParam);
      if (round !== readRound(root)) return send(res, 409, 'stale page');
      const line = `${jsonLine({ round, id, note, at: new Date().toISOString() })}\n`;
      const fd = fs.openSync(path.join(root, PICKS), 'a');
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return send(res, 204);
    }
    if (!isGet) return send(res, 405, 'method not allowed');
    const target = resolveStatic(root, rawPath);
    if (typeof target === 'number') return send(res, target, target === 400 ? 'bad request' : 'not found', undefined, head);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, fs.readFileSync(target), type, head);
  }

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(e => {
    throw new UsageError(`cannot listen on 127.0.0.1:${port}: ${e.code || e.message}`);
  });
  boundPort = server.address().port;
  const url = `http://127.0.0.1:${boundPort}/`;
  writeAtomic(root, SERVER, `${JSON.stringify({ pid: process.pid, port: boundPort, url, nonce, startedAt: new Date().toISOString() }, null, 2)}\n`);

  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  touch();
  setTimeout(() => shutdown('max-hours reached'), maxMs);
  process.stdout.write(`${url}\n`);
}

// ---------- wait ----------

async function cmdWait(opts) {
  const dir = loopDir(opts);
  const round = opts.round !== undefined ? num(opts.round, '--round', { min: 1, integer: true }) : readRound(dir);
  const timeoutMs = num(opts['timeout-sec'] ?? '600', '--timeout-sec', { min: 0 }) * 1000;
  const deadline = Date.now() + timeoutMs;
  const picksPath = path.join(dir, PICKS);
  let offset = 0;
  let tail = Buffer.alloc(0);

  // Reads what was appended since the last poll; returns the first complete matching line, if any.
  const scan = () => {
    let fd;
    try {
      fd = fs.openSync(picksPath, 'r');
    } catch {
      return null;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) {
        offset = 0; // truncated or replaced: start over
        tail = Buffer.alloc(0);
      }
      if (size === offset) return null;
      const chunk = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset += n;
      let buf = Buffer.concat([tail, chunk.subarray(0, n)]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // malformed line
        }
        if (obj && typeof obj === 'object' && obj.round === round) return jsonLine(obj);
      }
      tail = Buffer.from(buf);
      return null;
    } finally {
      fs.closeSync(fd);
    }
  };

  for (;;) {
    const hit = scan();
    if (hit) return finish(hit, 0);
    let current = round;
    try {
      current = readRound(dir);
    } catch {
      /* keep waiting */
    }
    if (current > round) return finish(jsonLine({ superseded: true, round }), 3);
    if (Date.now() >= deadline) return finish(jsonLine({ timeout: true, round }), 2);
    await new Promise(r => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
}

// ---------- stop ----------

async function cmdStop(opts) {
  if (!opts.dir) throw new UsageError('--dir is required');
  let dir;
  try {
    dir = fs.realpathSync.native(path.resolve(opts.dir));
  } catch {
    process.stdout.write('nothing to stop\n'); // already gone: stop is idempotent
    return;
  }
  if (!fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${opts.dir}`);
  if (!fs.existsSync(path.join(dir, MARKER))) {
    throw new UsageError(`refusing to touch ${dir}: no ${MARKER} marker, not a click-loop dir`);
  }

  const probe = await probeServer(dir);
  if (probe.state === 'unconfirmed') {
    // Something answers at the recorded url but cannot prove it is this dir's server: leave it alone.
    throw new UsageError(`could not confirm the server at ${probe.info.url} (it answers without this dir's nonce); server.json left in place`);
  }
  if (probe.state === 'confirmed') {
    const { info, base } = probe;
    await request(new URL(`/__stop?nonce=${encodeURIComponent(info.nonce)}`, base), { method: 'POST' });
    const deadline = Date.now() + STOP_WAIT_MS;
    let down = false;
    while (!down && Date.now() < deadline) {
      const res = await request(new URL('/__id', base), { timeoutMs: 300 });
      down = !res || res.body !== info.nonce;
      if (!down) await new Promise(r => setTimeout(r, 100));
    }
    if (!down) throw new UsageError(`the server at ${info.url} did not stop within ${STOP_WAIT_MS / 1000} s; server.json left in place`);
    process.stdout.write(`stopped ${info.url}\n`);
  } else {
    // No server.json, or nothing answers at its url: a stale file. Its pid is never signalled.
    process.stdout.write('no running server\n');
  }
  fs.rmSync(path.join(dir, SERVER), { force: true });
  if (opts.clean) {
    fs.rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`removed ${dir}\n`);
  }
}

// ---------- main ----------

const USAGE = `usage: click-loop.mjs <command>
  init
  round --dir <dir> (--next | --set N)
  serve --dir <dir> [--port 0] [--idle-min 30] [--max-hours 4]
  wait  --dir <dir> [--round N] [--timeout-sec 600]
  stop  --dir <dir> [--clean]`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const opts = parseArgs(rest);
    switch (cmd) {
      case 'init':
        return cmdInit();
      case 'round':
        return cmdRound(opts);
      case 'serve':
        return await cmdServe(opts);
      case 'wait':
        return await cmdWait(opts);
      case 'stop':
        return await cmdStop(opts);
      default:
        throw new UsageError(cmd ? `unknown command: ${cmd}\n${USAGE}` : USAGE);
    }
  } catch (e) {
    fail(e instanceof UsageError ? e.message : `error: ${e && e.message}`);
  }
}

main();
