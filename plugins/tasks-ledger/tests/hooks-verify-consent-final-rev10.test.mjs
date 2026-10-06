// Tests for the rev 10 group E amendments (25-30): no program is taken from the repository, the foreign-owner
// preload aims at one file, the approve command pins the gate's store, the control-character message names
// the path, and approve shows its display on the terminal it asks on. Answers are given only through the
// `terminal` option of approve(), reached by loading the script as a module, and every approve here runs
// detached (a new session, so no controlling terminal). A pasted approval request runs a fake `node`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, copyFileSync, lstatSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck, storePath, storeEntries, repoIdentity, commandHash, STORE_NAME } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const OTHER_UID = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'other-uid.cjs');
const POSIX = process.platform !== 'win32';
const HAS_UID = typeof process.getuid === 'function';
const PROMPT = 'Run this command after Claude edits files here? [yes/N] ';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-final-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
delete baseEnv.TASKS_LEDGER_TEST_FOREIGN_FILE;
const freshEnv = () => withConsentStore(baseEnv, root);

const stateFile = (session, project) =>
  join(hookTmp, `claude-verify-${session}-${createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16)}.json`);

function writeVerify(dir, body) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, 0o644);
  return file;
}

// A fake repository: a .git directory marks the root, but git does not accept it as a repository.
function makeRepo(name, verify) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

// A real git repository.
function makeGitRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo);
  const r = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return repo;
}

// Runs the gate; `preload` adds `--require <module>` to the process under test.
function run(stdin, cwd, env, gate = GATE, preload) {
  const args = preload ? ['--require', preload, gate] : [gate];
  return spawnSync(process.execPath, args, { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd, gate, preload) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env, gate, preload);
const stop = (env, session_id, cwd, gate, preload) =>
  run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env, gate, preload);

// The single systemMessage of an allowed stop.
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

// Runs a node child detached (a new session, so it has no controlling terminal).
function detached(args, { env, cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

// approve() through the module seam in a detached child. The fake terminal records what is written to it
// and answers `answer`; with `answer` null there is no terminal. The child prints a JSON report as its
// last stdout line, after anything approve wrote to stdout.
function approveInChild(env, dir, answer, cwd) {
  const script = `
    const events = [];
    const answer = ${JSON.stringify(answer)};
    const terminal = () => answer === null ? null : {
      write: s => events.push(['tty', s]),
      ask: p => { events.push(['ask', p]); return answer; },
      close: () => events.push(['close']),
    };
    let out = '';
    const code = require(${JSON.stringify(CONSENT)}).approve(${JSON.stringify(dir)}, {
      terminal, out: { write: s => { out += s; events.push(['out', s]); } },
    });
    process.stdout.write(JSON.stringify({ code, out, events }) + '\\n');`;
  return detached(['-e', script], { env, cwd }).then(r => {
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr };
  });
}

// Pastes `command` into bash with `terminalEnv`, a fake `node` first on PATH that records the store
// variables it sees ('=' marks a set variable) and its arguments.
let pastes = 0;
function paste(command, terminalEnv) {
  const n = ++pastes;
  const bin = join(root, `paste-bin-${n}`);
  const record = join(root, `paste-record-${n}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'),
    '#!/bin/sh\n' +
    `printf '%s\\0' "\${CLAUDE_PLUGIN_DATA+=}\${CLAUDE_PLUGIN_DATA-}" "\${CLAUDE_CONFIG_DIR+=}\${CLAUDE_CONFIG_DIR-}" "$@" > '${record}'\n`);
  chmodSync(join(bin, 'node'), 0o755);
  const r = spawnSync('bash', ['-c', command], { cwd: root, env: { ...terminalEnv, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [pluginData, configDir, ...args] = readFileSync(record, 'utf8').split('\0').slice(0, -1);
  return { pluginData, configDir, args };
}

// The environment node saw, as recorded by paste().
const recordedEnv = rec => {
  const env = {};
  if (rec.pluginData) env.CLAUDE_PLUGIN_DATA = rec.pluginData.slice(1);
  if (rec.configDir) env.CLAUDE_CONFIG_DIR = rec.configDir.slice(1);
  return env;
};

// --- Amendment 25: no program from the untrusted directory ---

// Executable `git` and `bash` files that leave a marker in `markers` when run.
function plantPrograms(dir, markers) {
  for (const name of ['git', 'bash']) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${join(markers, `${name}-ran`)}'\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
}
const ranPrograms = markers => ['git', 'bash'].filter(name => existsSync(join(markers, `${name}-ran`)));

test('amendment 25 / 30: git and bash planted in the check directory and the repository root never run', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeGitRepo('e25-gate');
  const sub = join(repo, 'pkg');
  mkdirSync(sub);
  writeVerify(sub, 'echo e25-check-ran >&2; exit 1\n');
  const markers = mkdtempSync(join(root, 'e25-markers-'));
  plantPrograms(repo, markers);
  plantPrograms(sub, markers);
  approveCheck(env, sub);
  const hostile = { ...env, PATH: `.:${repo}:${sub}::${process.env.PATH}` };

  const session = 'rev10-e25-gate';
  assert.equal(edit(hostile, session, sub).status, 0);
  const r = stop(hostile, session, sub);
  assert.deepEqual(ranPrograms(markers), []);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /e25-check-ran/);
  // The check still runs in its own directory.
  writeVerify(sub, 'pwd >&2; exit 1\n');
  approveCheck(env, sub);
  assert.match(stop(hostile, session, sub).stderr, new RegExp(`^${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.deepEqual(ranPrograms(markers), []);
});

test('amendment 25 / 30: the consent script never runs a git from the repository', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const repo = makeGitRepo('e25-consent');
  const sub = join(repo, 'pkg');
  mkdirSync(sub);
  writeVerify(sub, 'exit 0\n');
  const markers = mkdtempSync(join(root, 'e25-consent-markers-'));
  plantPrograms(repo, markers);
  plantPrograms(sub, markers);
  const hostile = { ...env, PATH: `.:${repo}:${sub}:${process.env.PATH}` };

  // approve (answered through the seam) records the identity the real git reports.
  const a = await approveInChild(hostile, sub, 'yes', sub);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(ranPrograms(markers), []);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(sub), sha256: commandHash('exit 0\n'), dir: 'pkg' }]);
  assert.equal(repoIdentity(sub), join(repo, '.git'));

  const r = await detached([CONSENT, 'revoke', sub], { env: hostile, cwd: sub });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ranPrograms(markers), []);
  assert.deepEqual(storeEntries(env), []);
});

test('amendment 25: with no bash outside the repository the check is skipped as one that could not start', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('e25-no-bash', 'echo e25-no-bash-ran >&2; exit 1\n');
  const markers = mkdtempSync(join(root, 'e25-no-bash-markers-'));
  plantPrograms(repo, markers);
  approveCheck(env, repo);
  const session = 'rev10-e25-no-bash';
  assert.equal(edit(env, session, repo).status, 0);
  const before = readFileSync(stateFile(session, repo), 'utf8');

  const r = stop({ ...env, PATH: `${repo}:.` }, session, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.deepEqual(ranPrograms(markers), []);
  assert.equal(readFileSync(stateFile(session, repo), 'utf8'), before);
  // Control: with the normal PATH the check runs.
  assert.match(stop(env, session, repo).stderr, /e25-no-bash-ran/);
});

// --- Amendment 26: the foreign-owner preload aims at one file ---

const foreign = (env, file) => ({ ...env, TASKS_LEDGER_TEST_FOREIGN_FILE: file });

test('amendment 26: the preload reports another owner only for the file it is given', { skip: !HAS_UID }, () => {
  const a = join(root, 'e26-a');
  const b = join(root, 'e26-b');
  writeFileSync(a, 'a');
  writeFileSync(b, 'b');
  const script = `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(a)}, 'r');
    console.log(JSON.stringify([process.getuid(), fs.lstatSync(${JSON.stringify(a)}).uid, fs.statSync(${JSON.stringify(a)}).uid,
      fs.fstatSync(fd).uid, fs.lstatSync(${JSON.stringify(b)}).uid]));`;
  const r = spawnSync(process.execPath, ['--require', OTHER_UID, '-e', script], { env: foreign(baseEnv, a), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [uid, lst, st, fst, other] = JSON.parse(r.stdout);
  const me = process.getuid();
  assert.equal(uid, me);
  assert.equal(other, me);
  for (const seen of [lst, st, fst]) assert.notEqual(seen, me);
  assert.equal(lstatSync(a).uid, me);
});

test('amendment 26 / 30: a foreign store is ignored by the gate (request shown, check not run); an own store is used', {
  skip: !POSIX || !HAS_UID,
}, () => {
  const env = freshEnv();
  const repo = makeRepo('e26-store', 'echo e26-store-ran >&2; exit 1\n');
  approveCheck(env, repo);
  const session = 'rev10-e26-store';
  assert.equal(edit(env, session, repo).status, 0);

  const r = stop(foreign(env, storePath(env)), session, repo, GATE, OTHER_UID);
  assert.doesNotMatch(r.stderr, /e26-store-ran/);
  assert.match(messageOf(r), /not approved/);
  // Control: the same setup, with the preload aimed at another file, runs the check.
  const control = stop(foreign(env, join(root, 'e26-unrelated')), session, repo, GATE, OTHER_UID);
  assert.equal(control.status, 2, control.stdout);
  assert.match(control.stderr, /e26-store-ran/);
});

test('amendment 26 / 30: a foreign check file is not run by the gate; an own check file is', { skip: !POSIX || !HAS_UID }, () => {
  const env = freshEnv();
  const repo = makeRepo('e26-check', 'echo e26-check-ran >&2; exit 1\n');
  approveCheck(env, repo);
  const session = 'rev10-e26-check';
  assert.equal(edit(env, session, repo).status, 0);

  const r = stop(foreign(env, join(repo, '.claude', 'verify.cmd')), session, repo, GATE, OTHER_UID);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, /e26-check-ran/);
  // Control: the same setup, with the preload aimed at another file, runs the check.
  const control = stop(foreign(env, join(root, 'e26-unrelated')), session, repo, GATE, OTHER_UID);
  assert.equal(control.status, 2, control.stdout);
  assert.match(control.stderr, /e26-check-ran/);
});

// --- Amendment 27: the approve command pins the store ---

test('amendment 27 / 30: with CLAUDE_CONFIG_DIR, the pasted command records into the gate\'s store whatever the terminal exports', {
  skip: !POSIX,
}, async () => {
  const repo = makeRepo('e27-config', 'echo e27-config-ran >&2; exit 1\n');
  const config = join(root, 'e27 config\'s dir');
  const gateEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: '', CLAUDE_CONFIG_DIR: config };
  const session = 'rev10-e27-config';
  assert.equal(edit(gateEnv, session, repo).status, 0);
  const command = offeredCommand(messageOf(stop(gateEnv, session, repo)));
  assert.ok(command.startsWith(`CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR='${config.replace(/'/g, "'\\''")}' node '`), command);

  const terminalEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'e27-other-data'), CLAUDE_CONFIG_DIR: join(root, 'e27-other-config') };
  const rec = paste(command, terminalEnv);
  assert.equal(rec.pluginData, '=');
  assert.equal(rec.configDir, `=${config}`);
  assert.deepEqual(rec.args.slice(0, 2), [CONSENT, 'approve']);
  const a = await approveInChild({ ...terminalEnv, ...recordedEnv(rec) }, rec.args[2], 'yes');
  assert.equal(a.code, 0, a.stderr);
  assert.ok(existsSync(join(config, 'tasks-ledger', STORE_NAME)));
  assert.match(stop(gateEnv, session, repo).stderr, /e27-config-ran/);
});

test('amendment 27 / 30: for the ~/.claude default, the pasted command empties CLAUDE_PLUGIN_DATA and pins CLAUDE_CONFIG_DIR to <home>/.claude', { skip: !POSIX }, async () => {
  const repo = makeRepo('e27-default', 'echo e27-default-ran >&2; exit 1\n');
  const home = join(root, 'e27-home');
  mkdirSync(home);
  const gateEnv = { ...baseEnv, HOME: home };
  const session = 'rev10-e27-default';
  assert.equal(edit(gateEnv, session, repo).status, 0);
  const command = offeredCommand(messageOf(stop(gateEnv, session, repo)));
  assert.ok(command.startsWith(`CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR='${join(home, '.claude').replace(/'/g, "'\\''")}' node '`), command);

  const terminalEnv = { ...gateEnv, CLAUDE_PLUGIN_DATA: join(root, 'e27-d-other-data'), CLAUDE_CONFIG_DIR: join(root, 'e27-d-other-config') };
  const rec = paste(command, terminalEnv);
  assert.equal(rec.pluginData, '=');
  assert.equal(rec.configDir, `=${join(home, '.claude')}`);
  const a = await approveInChild({ ...terminalEnv, ...recordedEnv(rec) }, rec.args[2], 'yes');
  assert.equal(a.code, 0, a.stderr);
  assert.ok(existsSync(join(home, '.claude', 'tasks-ledger', STORE_NAME)));
  assert.equal(existsSync(join(root, 'e27-d-other-data')), false);
  assert.match(stop(gateEnv, session, repo).stderr, /e27-default-ran/);
});

// --- Amendment 28: the right path is named ---

// A copy of the plugin's gate and consent script under `dir`.
function copyPlugin(dir) {
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(GATE, join(dir, 'hooks', 'verify-gate.js'));
  copyFileSync(CONSENT, join(dir, 'scripts', 'verify-consent.js'));
  return join(dir, 'hooks', 'verify-gate.js');
}

test('amendment 28 / 30: the control-character message names the plugin directory when only that path has one', { skip: !POSIX }, () => {
  const env = freshEnv();
  const gate = copyPlugin(join(root, 'e28 plugin\x1b[2Jdir'));
  const repo = makeRepo('e28-plugin', 'touch e28-ran.marker; exit 1\n');
  const session = 'rev10-e28-plugin';
  assert.equal(edit(env, session, repo, gate).status, 0);
  const message = messageOf(stop(env, session, repo, gate));
  assert.match(message, /control characters/);
  assert.match(message, /plugin directory/);
  assert.doesNotMatch(message, /repository directory|consent store/);
  assert.ok(message.includes('e28 plugin\\x1b[2Jdir'), message);
  assert.doesNotMatch(message, /[\x00-\x1f]/, JSON.stringify(message));
  assert.doesNotMatch(message, /approve '/);
  assert.equal(existsSync(join(repo, 'e28-ran.marker')), false);
});

test('amendment 28: the control-character message names the consent store or the repository directory', { skip: !POSIX }, () => {
  const storeEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'e28 store\rdir') };
  const repo = makeRepo('e28-store', 'exit 1\n');
  assert.equal(edit(storeEnv, 'rev10-e28-store', repo).status, 0);
  const m1 = messageOf(stop(storeEnv, 'rev10-e28-store', repo));
  assert.match(m1, /consent store/);
  assert.doesNotMatch(m1, /plugin directory|repository directory/);

  const env = freshEnv();
  const bad = makeRepo('e28 repo\tdir', 'exit 1\n');
  assert.equal(edit(env, 'rev10-e28-repo', bad).status, 0);
  const m2 = messageOf(stop(env, 'rev10-e28-repo', bad));
  assert.match(m2, /repository directory/);
  assert.doesNotMatch(m2, /plugin directory|consent store/);
});

// --- Amendment 29: display and question go to the same terminal ---

test('amendment 29: approve writes the display to the terminal it asks on, before the question, and to stdout', { skip: !POSIX }, async () => {
  const env = freshEnv();
  const body = 'echo e29 \x1b[2K shown\nexit 0\n';
  const repo = makeRepo('e29-display', body);
  const r = await approveInChild(env, repo, 'no');
  assert.equal(r.code, 1, r.stderr);
  const tty = r.events.filter(e => e[0] === 'tty').map(e => e[1]).join('');
  const askAt = r.events.findIndex(e => e[0] === 'ask');
  assert.deepEqual(r.events[askAt], ['ask', PROMPT]);
  assert.ok(r.events.slice(0, askAt).some(e => e[0] === 'tty'), JSON.stringify(r.events));
  for (const text of [tty, r.out]) {
    assert.ok(text.includes(join(repo, '.claude', 'verify.cmd')), text);
    assert.ok(text.includes('| echo e29 \\x1b[2K shown\n| exit 0\n'), text);
    assert.ok(text.includes(`2 lines, sha256 ${commandHash(body).slice(0, 12)}`), text);
  }
  assert.equal(existsSync(storePath(env)), false);

  // No terminal: exit 2, needs a terminal, nothing recorded.
  const none = await approveInChild(env, repo, null);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /needs a terminal/);
  assert.equal(existsSync(storePath(env)), false);
});
