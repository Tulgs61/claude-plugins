// Tests for rev 13, amendments 5 to 8: approval on native Windows. approve reads the answer from the console
// (CONIN$) and writes to it (CONOUT$), closes both on every path and fails at once without a console; the
// gate offers a PowerShell command whose values are single-quoted with every quote character doubled; a
// Windows store location must be fully qualified. The console is injected through openTerminal's `io`
// (reached only by loading the script as a module), so those tests run on every platform; the PowerShell
// parse tests run wherever pwsh or powershell is found (under CI on Windows they must find one).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';
const consent = createRequire(import.meta.url)(CONSENT);

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-windows-rev13-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;
const freshEnv = () => withConsentStore(baseEnv, root);

const CONIN = '\\\\.\\CONIN$';
const CONOUT = '\\\\.\\CONOUT$';
const PROMPT = 'Run this command after Claude edits files here? [yes/N] ';

let repoCount = 0;
function makeRepo(name, body) {
  const repo = join(root, `${repoCount++}-${name}`);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'verify.cmd'), body);
  chmodSync(join(repo, '.claude', 'verify.cmd'), 0o644);
  return repo;
}

// PowerShell single quotes, written independently of the script under test.
const psq = s => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, m => m + m)}'`;

// A console made of fs-like functions. `fail` lists device names whose open throws; `answer` is what the
// console input holds (then end of input); `readThrows` / `writeThrows` / `closeThrows` make those calls
// throw. Writes take at most 7 bytes per call, so the write loop has to continue.
function fakeConsole({ fail = [], answer = 'yes\r\n', readThrows = false, writeThrows = false, closeThrows = [] } = {}) {
  const log = { opened: [], closed: [], written: [], readFrom: new Set() };
  const names = new Map();
  let next = 40;
  let pos = 0;
  const input = Buffer.from(answer, 'utf8');
  const io = {
    openSync(name, flags) {
      log.opened.push([name, flags]);
      if (fail.includes(name)) throw Object.assign(new Error(`cannot open ${name}`), { code: 'ENOENT' });
      const fd = next++;
      names.set(fd, name);
      return fd;
    },
    closeSync(fd) {
      assert.ok(names.has(fd), `closed an unknown descriptor ${fd}`);
      log.closed.push(names.get(fd));
      if (closeThrows.includes(names.get(fd))) throw new Error('close failed');
    },
    writeSync(fd, bytes, off) {
      if (writeThrows) throw Object.assign(new Error('write failed'), { code: 'EIO' });
      const n = Math.min(7, bytes.length - off);
      log.written.push([names.get(fd), Buffer.from(bytes.subarray(off, off + n))]);
      return n;
    },
    readSync(fd, buf, offset, length) {
      log.readFrom.add(names.get(fd));
      assert.equal(length, 1);
      if (readThrows) throw Object.assign(new Error('read failed'), { code: 'EIO' });
      if (pos >= input.length) return 0;
      buf[offset] = input[pos++];
      return 1;
    },
  };
  const textTo = name => Buffer.concat(log.written.filter(([n]) => n === name).map(([, b]) => b)).toString('utf8');
  // The devices that were opened successfully, each closed exactly once.
  const assertAllClosed = () => {
    const opened = log.opened.filter(([n]) => !fail.includes(n)).map(([n]) => n).sort();
    assert.deepEqual([...log.closed].sort(), opened);
  };
  return { io, log, textTo, assertAllClosed };
}

const sink = () => ({ text: '', write(t) { this.text += t; } });

// approve on the injected Windows console, in this process.
function approveOnConsole(dir, env, console) {
  const out = sink();
  const err = sink();
  let status;
  let thrown = null;
  try {
    status = consent.approve(dir, { env, out, err, terminal: () => consent.openTerminal({ platform: 'win32', io: console.io }) });
  } catch (e) {
    thrown = e;
  }
  return { status, thrown, out: out.text, err: err.text };
}

test('powerShellQuote doubles every single-quote character PowerShell knows and nothing else', () => {
  const q = consent.powerShellQuote;
  assert.equal(q('C:\\Program Files\\x\\'), "'C:\\Program Files\\x\\'");
  assert.equal(q("it's"), "'it''s'");
  assert.equal(q('\u2018a\u2019'), "'\u2018\u2018a\u2019\u2019'");
  assert.equal(q('\u201ab\u201b'), "'\u201a\u201ab\u201b\u201b'");
  assert.equal(q("''"), "''''''");
  assert.equal(q(''), "''");
  assert.equal(q('$env:PATH; `n "dq" & | (x) @y'), '\'$env:PATH; `n "dq" & | (x) @y\'');
  assert.equal(q('\u201cdouble\u201d'), "'\u201cdouble\u201d'");
});

function findPowerShell() {
  for (const name of ['pwsh', 'powershell']) {
    const r = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) return name;
  }
  return null;
}
const POWERSHELL = findPowerShell();
// Under CI on Windows the PowerShell tests must run; elsewhere they are skipped without PowerShell.
const psSkip = POWERSHELL === null && !(process.env.CI && !POSIX) ? 'no pwsh or powershell found' : false;

// Runs `script` in PowerShell (passed encoded, so every character arrives as written) and returns stdout.
function runPowerShell(script, env = baseEnv) {
  assert.ok(POWERSHELL, 'no pwsh or powershell found');
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', env, timeout: 60000,
  });
  assert.equal(r.status, 0, `${r.stderr}${r.error || ''}`);
  return r.stdout;
}

// PowerShell code that writes the strings of the array `expr` as their UTF-16 code units, so the output is
// ASCII whatever the console encoding: the units of one string joined with ',', the strings with '|'.
const ITEMS = expr => `[Console]::Out.Write(((${expr}) | ForEach-Object { (([string]$_).ToCharArray() | ForEach-Object { [int]$_ }) -join ',' }) -join '|')`;
const decode = out => out.trim().split('|').map(s => (s === '' ? '' : String.fromCharCode(...s.split(',').map(Number))));

const SAMPLES = ['plain', "it's", '\u2018left\u2019', '\u201abase\u201b', "''", "'", "a''b", 'C:\\Program Files\\x\\',
  '$env:PATH; `n "dq" & | (x) @y', '\u00e9 \u00fc \u{1f600}', "\u2019'\u2018", 'end\u2019'];

test('a PowerShell-quoted value reads back as exactly that value', { skip: psSkip }, () => {
  const out = runPowerShell(ITEMS(`@(${SAMPLES.map(consent.powerShellQuote).join(', ')})`));
  assert.deepEqual(decode(out), SAMPLES);
});

test('a Windows store location must be fully qualified', () => {
  for (const value of ['\\data', '/data', 'C:data', 'data', '.\\data']) {
    const sel = consent.storeSelection({ CLAUDE_PLUGIN_DATA: value }, 'win32');
    assert.equal(sel.file, null, value);
    assert.match(sel.unavailable, /CLAUDE_PLUGIN_DATA/, value);
    assert.equal(consent.storeSelection({ CLAUDE_CONFIG_DIR: value }, 'win32').file, null, value);
    assert.equal(consent.isFullyQualified(value, 'win32'), false, value);
  }
  assert.equal(consent.storeSelection({ CLAUDE_PLUGIN_DATA: 'C:\\data' }, 'win32').file, 'C:\\data\\verify-consent.json');
  assert.equal(consent.storeSelection({ CLAUDE_PLUGIN_DATA: 'c:/data' }, 'win32').file, 'c:\\data\\verify-consent.json');
  assert.equal(consent.storeSelection({ CLAUDE_PLUGIN_DATA: '\\\\srv\\share\\d' }, 'win32').file, '\\\\srv\\share\\d\\verify-consent.json');
  assert.equal(consent.storeSelection({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }, 'win32').file, 'D:\\cfg\\tasks-ledger\\verify-consent.json');
  // POSIX rules are unchanged.
  assert.equal(consent.storeSelection({ CLAUDE_PLUGIN_DATA: '/data' }, 'linux').file, '/data/verify-consent.json');
  assert.equal(consent.storeSelection({ CLAUDE_PLUGIN_DATA: 'data' }, 'linux').file, null);
});

test('on POSIX openTerminal still opens /dev/tty once for reading and writing and closes it once', () => {
  const c = fakeConsole({ answer: 'no\n' });
  const tty = consent.openTerminal({ platform: 'linux', io: c.io });
  assert.deepEqual(c.log.opened, [['/dev/tty', 'r+']]);
  tty.write('shown\n');
  assert.equal(tty.ask('? '), 'no');
  tty.close();
  assert.deepEqual(c.log.closed, ['/dev/tty']);
  assert.equal(c.textTo('/dev/tty'), 'shown\n? ');
});

test('without a console approve exits 2 at once, writes nothing to stdout and records nothing', () => {
  const env = freshEnv();
  const repo = makeRepo('no-console', 'exit 0\n');
  const c = fakeConsole({ fail: [CONIN] });
  const started = Date.now();
  const r = approveOnConsole(repo, env, c);
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.thrown, null);
  assert.equal(r.status, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /needs a terminal/);
  assert.deepEqual(c.log.opened, [[CONIN, 'r+']]);
  c.assertAllClosed();
  assert.equal(existsSync(storePath(env)), false);
});

test('when CONOUT$ cannot be opened, CONIN$ is closed and approve exits 2', () => {
  const env = freshEnv();
  const repo = makeRepo('no-conout', 'exit 0\n');
  const c = fakeConsole({ fail: [CONOUT] });
  const r = approveOnConsole(repo, env, c);
  assert.equal(r.status, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /needs a terminal/);
  assert.deepEqual(c.log.opened, [[CONIN, 'r+'], [CONOUT, 'r+']]);
  assert.deepEqual(c.log.closed, [CONIN]);
  assert.equal(existsSync(storePath(env)), false);
});

test('yes on the console records the approval; the answer is read from CONIN$ and everything is written to CONOUT$', () => {
  const env = freshEnv();
  const body = 'node scripts/check.mjs\nexit 0\n';
  const repo = makeRepo('yes', body);
  const c = fakeConsole({ answer: 'yes\r\nignored' });
  const r = approveOnConsole(repo, env, c);
  assert.equal(r.thrown, null);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(c.log.opened, [[CONIN, 'r+'], [CONOUT, 'r+']]);
  assert.deepEqual([...c.log.readFrom], [CONIN]);
  assert.deepEqual([...new Set(c.log.written.map(([n]) => n))], [CONOUT]);
  c.assertAllClosed();
  const shown = c.textTo(CONOUT);
  assert.ok(shown.endsWith(PROMPT), shown);
  assert.ok(shown.includes(join(repo, '.claude', 'verify.cmd')), shown);
  assert.ok(shown.includes('| node scripts/check.mjs\n| exit 0\n2 lines, sha256 '), shown);
  assert.ok(r.out.startsWith(shown.slice(0, -PROMPT.length)), r.out);
  assert.doesNotMatch(r.out, /\[yes\/N\]/);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: commandHash(body) }]);
});

test('any other answer, the end of console input or a failed read records nothing and closes both handles', () => {
  for (const [label, opts, status] of [['no', { answer: 'no\r\n' }, 1], ['yes then more', { answer: 'yess\r\n' }, 1],
    ['end of input', { answer: '' }, 1], ['read error', { readThrows: true }, 1]]) {
    const env = freshEnv();
    const repo = makeRepo(`answer-${status}`, 'exit 0\n');
    const c = fakeConsole(opts);
    const r = approveOnConsole(repo, env, c);
    assert.equal(r.thrown, null, label);
    assert.equal(r.status, status, label);
    assert.match(r.out, /Not approved/, label);
    c.assertAllClosed();
    assert.equal(c.log.closed.length, 2, label);
    assert.equal(existsSync(storePath(env)), false, label);
  }
});

test('a failed console write, a missing verify.cmd or a failed close still closes both handles', () => {
  {
    const env = freshEnv();
    const repo = makeRepo('write-fails', 'exit 0\n');
    const c = fakeConsole({ writeThrows: true });
    const r = approveOnConsole(repo, env, c);
    assert.ok(r.thrown, 'a failed write ends approve with an error');
    assert.equal(c.log.closed.length, 2);
    c.assertAllClosed();
    assert.equal(existsSync(storePath(env)), false);
  }
  {
    const env = freshEnv();
    const dir = join(root, 'no-check');
    mkdirSync(dir);
    const c = fakeConsole();
    const r = approveOnConsole(dir, env, c);
    assert.equal(r.status, 2);
    assert.match(r.err, /missing/);
    assert.equal(c.log.closed.length, 2);
    c.assertAllClosed();
    assert.deepEqual([...c.log.readFrom], []);
  }
  {
    const env = freshEnv();
    const repo = makeRepo('close-fails', 'exit 0\n');
    const c = fakeConsole({ answer: 'no\r\n', closeThrows: [CONIN] });
    const r = approveOnConsole(repo, env, c);
    assert.ok(r.thrown, 'a failed close ends approve with an error');
    assert.deepEqual(c.log.closed, [CONIN, CONOUT]);
  }
});

test('without a console the real script on Windows exits 2 at once instead of waiting', { skip: POSIX }, async () => {
  const env = freshEnv();
  const repo = makeRepo('detached', 'exit 0\n');
  // detached on Windows starts the child without a console (DETACHED_PROCESS).
  const child = spawn(process.execPath, [CONSENT, 'approve', repo], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 30000);
  const [code, signal] = await new Promise(resolve => child.on('close', (c, s) => resolve([c, s])));
  clearTimeout(timer);
  assert.equal(signal, null, 'approve waited instead of failing');
  assert.equal(code, 2, stderr);
  assert.match(stderr, /needs a terminal/);
  assert.equal(stdout, '');
  assert.equal(existsSync(storePath(env)), false);
});

function runGate(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
function requestOf(env, session, repo) {
  assert.equal(runGate({ session_id: session, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, repo, env).status, 0);
  const r = runGate({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }, repo, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout).systemMessage;
}

// PowerShell code that defines `node` as a function (functions come before programs) writing the two store
// variables and its arguments, then runs `command`.
const SHIM = `function node { $all = @($env:CLAUDE_PLUGIN_DATA, $env:CLAUDE_CONFIG_DIR) + $args; ${ITEMS('$all')} }`;

// The name has an ASCII quote, the typographic single quotes and a `$`.
const ODD = "it's \u2018q\u2019 \u201ab\u201b $x";

test('on Windows the request is a PowerShell command that pins the store and parses back exactly', { skip: POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo(ODD, 'exit 1\n');
  const message = requestOf(env, 'rev13-windows-ps', repo);
  assert.match(message, /in PowerShell in a console window/);
  assert.ok(message.includes('the $env: assignments stay set in that PowerShell window'), message);
  assert.doesNotMatch(message, /POSIX shell|contains a backslash/);
  const command = message.slice(message.indexOf('$env:CLAUDE_PLUGIN_DATA='));
  assert.equal(command, `$env:CLAUDE_PLUGIN_DATA=${psq(env.CLAUDE_PLUGIN_DATA)}; node ${psq(CONSENT)} approve ${psq(repo)}`);
  if (POWERSHELL === null) assert.fail('no pwsh or powershell found');
  assert.deepEqual(decode(runPowerShell(`${SHIM}\n${command}`)), [env.CLAUDE_PLUGIN_DATA, '', CONSENT, 'approve', repo]);
});

test('on Windows the default store is pinned as CLAUDE_CONFIG_DIR with CLAUDE_PLUGIN_DATA removed', { skip: POSIX }, () => {
  const home = join(root, `home ${ODD}`);
  mkdirSync(home);
  const env = { ...baseEnv, USERPROFILE: home, HOME: home };
  const repo = makeRepo('default-store', 'exit 1\n');
  const message = requestOf(env, 'rev13-windows-default', repo);
  const command = message.slice(message.indexOf('$env:CLAUDE_PLUGIN_DATA='));
  const value = join(home, '.claude');
  assert.equal(command, `$env:CLAUDE_PLUGIN_DATA=''; $env:CLAUDE_CONFIG_DIR=${psq(value)}; node ${psq(CONSENT)} approve ${psq(repo)}`);
  if (POWERSHELL === null) assert.fail('no pwsh or powershell found');
  const shellEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'exported-elsewhere') };
  assert.deepEqual(decode(runPowerShell(`${SHIM}\n${command}`, shellEnv)), ['', value, CONSENT, 'approve', repo]);
});
