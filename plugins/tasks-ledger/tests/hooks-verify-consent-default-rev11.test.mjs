// Tests for the ~/.claude default store in the approval request: the printed command pins
// CLAUDE_CONFIG_DIR to the <home>/.claude the gate resolved, so it records into the gate's store even
// from a terminal with another HOME, and a default store path with control characters gets no command. A
// store location that is not an absolute path is never resolved against the working directory: the gate
// sees no approvals and offers no command, and approve records nothing.
// Answers are given only through the `terminal` option of approve(), reached by loading the script as a
// module, in a detached child (a new session, so no controlling terminal).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoIdentity, commandHash, STORE_NAME } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const POSIX = process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-default-rev11-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;

// A fake repository: a .git directory marks the root, but git does not accept it as a repository.
function makeRepo(name, body) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'verify.cmd'), body);
  chmodSync(join(repo, '.claude', 'verify.cmd'), 0o644);
  return repo;
}

function run(stdin, cwd, env) {
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env);
const stop = (env, session_id, cwd) => run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env);

function messageOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  return out.systemMessage;
}

function offeredCommand(message) {
  const marker = 'terminal): ';
  const at = message.indexOf(marker);
  assert.notEqual(at, -1, message);
  return message.slice(at + marker.length);
}

// Pastes `command` into bash with a fake `node` first on PATH that records the store variables it sees
// and its arguments; returns the assignments (set variables only) and the arguments.
function paste(command, env) {
  const bin = mkdtempSync(join(root, 'paste-bin-'));
  const record = join(bin, 'record');
  writeFileSync(join(bin, 'node'),
    '#!/bin/sh\n' +
    `printf '%s\\0' "\${CLAUDE_PLUGIN_DATA+=}\${CLAUDE_PLUGIN_DATA-}" "\${CLAUDE_CONFIG_DIR+=}\${CLAUDE_CONFIG_DIR-}" "$@" > '${record}'\n`);
  chmodSync(join(bin, 'node'), 0o755);
  const r = spawnSync('bash', ['-c', command], { cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [pluginData, configDir, ...args] = readFileSync(record, 'utf8').split('\0').slice(0, -1);
  const assignments = {};
  if (pluginData) assignments.CLAUDE_PLUGIN_DATA = pluginData.slice(1);
  if (configDir) assignments.CLAUDE_CONFIG_DIR = configDir.slice(1);
  return { assignments, args };
}

// approve() through the module seam in a detached child, answering `answer`.
function approveInChild(env, dir, answer, cwd = root) {
  const script = `
    const terminal = () => ({ write() {}, ask: () => ${JSON.stringify(answer)}, close() {} });
    const code = require(${JSON.stringify(CONSENT)}).approve(${JSON.stringify(dir)}, { terminal, out: { write() {} } });
    process.stdout.write(JSON.stringify({ code }) + '\\n');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => {
      assert.equal(status, 0, stderr);
      resolve({ ...JSON.parse(stdout.trim().split('\n').pop()), stderr });
    });
  });
}

test('the default store is pinned: a command printed with HOME=A records into A\'s store from a terminal with HOME=B', {
  skip: !POSIX,
}, async () => {
  const body = 'echo default-pinned-ran >&2; exit 1\n';
  const repo = makeRepo('default-pinned', body);
  const homeA = join(root, 'home-a');
  const homeB = join(root, 'home-b');
  mkdirSync(homeA);
  mkdirSync(homeB);
  const gateEnv = { ...baseEnv, HOME: homeA };
  const session = 'rev11-default-pinned';
  assert.equal(edit(gateEnv, session, repo).status, 0);
  const command = offeredCommand(messageOf(stop(gateEnv, session, repo)));

  const terminalEnv = { ...baseEnv, HOME: homeB };
  const { assignments, args } = paste(command, terminalEnv);
  assert.deepEqual(args.slice(0, 2), [CONSENT, 'approve']);
  const a = await approveInChild({ ...terminalEnv, ...assignments }, args[2], 'yes');
  assert.equal(a.code, 0, a.stderr);

  const storeA = join(homeA, '.claude', 'tasks-ledger', STORE_NAME);
  assert.ok(existsSync(storeA), 'no store under A');
  assert.deepEqual(JSON.parse(readFileSync(storeA, 'utf8')).entries, [{ repo: repoIdentity(repo), sha256: commandHash(body) }]);
  assert.equal(existsSync(join(homeB, '.claude')), false, 'a store was created under B');
  // The gate reads that store.
  assert.match(stop(gateEnv, session, repo).stderr, /default-pinned-ran/);
});

test('a default store path with a line feed gets no command, and the request names the consent store', { skip: !POSIX }, () => {
  const repo = makeRepo('default-control', 'touch default-control-ran.marker; exit 1\n');
  const home = join(root, 'home with\nline feed');
  mkdirSync(home);
  const env = { ...baseEnv, HOME: home };
  const session = 'rev11-default-control';
  assert.equal(edit(env, session, repo).status, 0);
  const message = messageOf(stop(env, session, repo));
  assert.match(message, /control characters/);
  assert.match(message, /consent store/);
  assert.doesNotMatch(message, /plugin directory|repository directory/);
  assert.doesNotMatch(message, /approve '/);
  assert.doesNotMatch(message, /node '/);
  assert.equal(existsSync(join(repo, 'default-control-ran.marker')), false);
});

test('a relative home directory gets no command, and the request says the home directory is not absolute', { skip: !POSIX }, () => {
  const repo = makeRepo('default-relative', 'touch default-relative-ran.marker; exit 1\n');
  const env = { ...baseEnv, HOME: 'relative-home' };
  const session = 'rev11-default-relative';
  assert.equal(edit(env, session, repo).status, 0);
  const message = messageOf(stop(env, session, repo));
  assert.match(message, /home directory/);
  assert.match(message, /not an absolute path/);
  assert.doesNotMatch(message, /approve '/);
  assert.doesNotMatch(message, /node '/);
  assert.doesNotMatch(message, /CLAUDE_CONFIG_DIR=/);
  assert.equal(existsSync(join(repo, 'default-relative-ran.marker')), false);
});

// For a store location that is not an absolute path: the repository holds, where that value would resolve
// to from its top level, an own store file approving its own verify.cmd. The gate runs from the top level.
for (const [label, variable, rel, storeRel, envOf] of [
  ['a relative home directory', /home directory/, 'rel-home', ['rel-home', '.claude', 'tasks-ledger'], v => ({ HOME: v })],
  ['a relative CLAUDE_CONFIG_DIR', /CLAUDE_CONFIG_DIR/, 'rel-config', ['rel-config', 'tasks-ledger'], v => ({ CLAUDE_CONFIG_DIR: v })],
  ['a relative CLAUDE_PLUGIN_DATA', /CLAUDE_PLUGIN_DATA/, 'rel-data', ['rel-data'], v => ({ CLAUDE_PLUGIN_DATA: v })],
]) {
  test(`${label} never selects a store inside the repository: the check does not run and no command is offered`, {
    skip: !POSIX,
  }, () => {
    const name = `relative-store-${rel}`;
    const body = `touch ${name}-ran.marker; exit 1\n`;
    const repo = makeRepo(name, body);
    const storeDir = join(repo, ...storeRel);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, STORE_NAME), JSON.stringify({ entries: [{ repo: repoIdentity(repo), sha256: commandHash(body) }] }));
    const env = { ...baseEnv, HOME: join(root, 'home-a'), ...envOf(rel) };
    const session = `rev11-${name}`;
    assert.equal(edit(env, session, repo).status, 0);
    const message = messageOf(stop(env, session, repo));
    assert.equal(existsSync(join(repo, `${name}-ran.marker`)), false, 'the check ran');
    assert.match(message, /not approved/);
    assert.match(message, /not an absolute path/);
    assert.match(message, variable);
    assert.doesNotMatch(message, /approve '/);
    assert.doesNotMatch(message, /node '/);
  });
}

test('approve with a relative CLAUDE_PLUGIN_DATA exits 2 and creates no file under its working directory', { skip: !POSIX }, async () => {
  const repo = makeRepo('relative-approve', 'exit 0\n');
  const work = mkdtempSync(join(root, 'relative-approve-cwd-'));
  const a = await approveInChild({ ...baseEnv, CLAUDE_PLUGIN_DATA: 'rel-data' }, repo, 'yes', work);
  assert.equal(a.code, 2, a.stderr);
  assert.match(a.stderr, /CLAUDE_PLUGIN_DATA/);
  assert.match(a.stderr, /not an absolute path/);
  assert.deepEqual(readdirSync(work), []);
});

// Coverage: revoke and list with a relative CLAUDE_PLUGIN_DATA, run as commands from a working directory
// that already holds a store file where that value would resolve to.
for (const [label, argsOf] of [
  ['revoke', repo => ['revoke', repo]],
  ['list', () => ['list']],
]) {
  test(`${label} with a relative CLAUDE_PLUGIN_DATA exits 2, names the variable and leaves the store file there unchanged`, {
    skip: !POSIX,
  }, () => {
    const body = 'exit 0\n';
    const repo = makeRepo(`relative-${label}`, body);
    const work = mkdtempSync(join(root, `relative-${label}-cwd-`));
    mkdirSync(join(work, 'rel-data'));
    const store = join(work, 'rel-data', STORE_NAME);
    const before = Buffer.from(JSON.stringify({ entries: [{ repo: repoIdentity(repo), sha256: commandHash(body) }] }));
    writeFileSync(store, before);
    const r = spawnSync(process.execPath, [CONSENT, ...argsOf(repo)], {
      cwd: work, env: { ...baseEnv, CLAUDE_PLUGIN_DATA: 'rel-data' }, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /CLAUDE_PLUGIN_DATA/);
    assert.match(r.stderr, /not an absolute path/);
    assert.equal(r.stdout, '');
    assert.deepEqual(readFileSync(store), before);
    assert.deepEqual(readdirSync(join(work, 'rel-data')), [STORE_NAME]);
  });
}
