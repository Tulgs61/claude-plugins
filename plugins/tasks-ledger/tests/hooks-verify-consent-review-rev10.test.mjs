// Tests for the rev 10 group D amendments (19-23): a copy-safe approval request that names the gate's
// store, an approve display that cannot hide anything, foreign-owner tests without root, and approve /
// revoke never discarding an unusable store. The yes/no answers are given only through the `ask` option
// of approve(), reached by loading the script as a module. A pasted approval request is run with a fake
// `node` first on PATH, so the real approve never runs from a shell here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync, readdirSync,
  lstatSync, readlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentStore, approveCheck, storePath, storeEntries, repoIdentity, commandHash } from './helpers/verify-consent.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'hooks', 'verify-gate.js');
const CONSENT = join(PLUGIN, 'scripts', 'verify-consent.js');
const OTHER_UID = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'other-uid.cjs');
const POSIX = process.platform !== 'win32';
const HAS_UID = typeof process.getuid === 'function';
const PROMPT = 'Run this command after Claude edits files here? [yes/N] ';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-ledger-consent-review-rev10-')));
after(() => rmSync(root, { recursive: true, force: true }));

const hookTmp = join(root, 'tmp');
mkdirSync(hookTmp);
const baseEnv = { ...process.env, TMPDIR: hookTmp, TEMP: hookTmp, TMP: hookTmp };
delete baseEnv.CLAUDE_PLUGIN_DATA;
delete baseEnv.CLAUDE_CONFIG_DIR;
const freshEnv = () => withConsentStore(baseEnv, root);

const stateFile = (session, project) =>
  join(hookTmp, `claude-verify-${session}-${createHash('sha256').update(realpathSync(project)).digest('hex').slice(0, 16)}.json`);

function writeVerify(dir, body, mode = 0o644) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'verify.cmd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

// A fake repository: a .git directory marks the root, but git does not accept it as a repository.
function makeRepo(name, verify) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (verify !== undefined) writeVerify(repo, verify);
  return repo;
}

// Runs the gate; `preload` adds `--require <module>` to the process under test.
function run(stdin, cwd, env, preload) {
  const args = preload ? ['--require', preload, GATE] : [GATE];
  return spawnSync(process.execPath, args, { input: JSON.stringify(stdin), cwd, env, encoding: 'utf8', timeout: 60000 });
}
const edit = (env, session_id, cwd, preload) =>
  run({ session_id, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit' }, cwd, env, preload);
const stop = (env, session_id, cwd, preload) =>
  run({ session_id, cwd, hook_event_name: 'Stop', stop_hook_active: false }, cwd, env, preload);

const consentCli = (env, preload, ...args) =>
  spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), CONSENT, ...args], {
    env, encoding: 'utf8', timeout: 60000, input: 'yes\n',
  });

// The single systemMessage of an allowed stop.
function messageOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  return out.systemMessage;
}

// The approve command offered by an approval request: everything after "...in a terminal): ".
function offeredCommand(message) {
  const marker = 'terminal): ';
  const at = message.indexOf(marker);
  assert.notEqual(at, -1, message);
  return message.slice(at + marker.length);
}

// Pastes `command` into bash in an empty directory, with a fake `node` first on PATH that records the
// store variables it sees ('=' marks a set variable) and its arguments. Returns what it recorded and the
// files the paste left in that directory.
let pastes = 0;
function paste(command) {
  const n = ++pastes;
  const bin = join(root, `paste-bin-${n}`);
  const scratch = join(root, `paste-cwd-${n}`);
  const record = join(root, `paste-record-${n}`);
  mkdirSync(bin);
  mkdirSync(scratch);
  writeFileSync(join(bin, 'node'),
    '#!/bin/sh\n' +
    `printf '%s\\0' "\${CLAUDE_PLUGIN_DATA+=}\${CLAUDE_PLUGIN_DATA-}" "\${CLAUDE_CONFIG_DIR+=}\${CLAUDE_CONFIG_DIR-}" "$@" > '${record}'\n`);
  chmodSync(join(bin, 'node'), 0o755);
  const env = { ...baseEnv, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync('bash', ['-c', command], { cwd: scratch, env, encoding: 'utf8', timeout: 60000 });
  const left = readdirSync(scratch);
  if (!existsSync(record)) return { status: r.status, stderr: r.stderr, left, recorded: null };
  const [pluginData, configDir, ...args] = readFileSync(record, 'utf8').split('\0').slice(0, -1);
  return { status: r.status, stderr: r.stderr, left, recorded: { pluginData, configDir, args } };
}

// Loads the script as a module (the only way to reach the answer seam) and records every output write
// and question in order.
function approveWith(env, dir, answer) {
  const consentModule = createRequire(import.meta.url)(CONSENT);
  const events = [];
  let out = '';
  let err = '';
  const code = consentModule.approve(dir, {
    env,
    ask: prompt => {
      events.push(['ask', prompt]);
      return answer;
    },
    out: { write: s => { out += s; events.push(['out', s]); } },
    err: { write: s => { err += s; events.push(['err', s]); } },
  });
  return { code, events, out, err, asked: events.filter(e => e[0] === 'ask').length };
}

// The same seam in a child process that preloads `preload`; the answer is always "no".
function approveInChild(env, dir, preload) {
  const script = `const code = require(${JSON.stringify(CONSENT)}).approve(${JSON.stringify(dir)}, ` +
    '{ ask: () => { process.stdout.write("ASKED\\n"); return "no"; } }); process.exitCode = code;';
  return spawnSync(process.execPath, ['--require', preload, '-e', script], { env, encoding: 'utf8', timeout: 60000 });
}

// --- Amendment 19: a copy-safe approve command ---

test('amendment 19 / 20: a pasted approval request with $(touch x) and other shell syntax in the directory name runs only node', {
  skip: !POSIX,
}, () => {
  const env = freshEnv();
  const name = 'd19 it\'s $(touch x) `touch y` "q" ; touch z & $HOME \\ end';
  const repo = makeRepo(name, 'touch d19-ran.marker; exit 1\n');
  const session = 'rev10-d19-paste';
  assert.equal(edit(env, session, repo).status, 0);
  const command = offeredCommand(messageOf(stop(env, session, repo)));
  assert.equal(existsSync(join(repo, 'd19-ran.marker')), false);

  const pasted = paste(command);
  assert.equal(pasted.status, 0, pasted.stderr);
  assert.deepEqual(pasted.left, [], 'the paste created files');
  for (const f of ['x', 'y', 'z']) assert.equal(existsSync(join(root, f)), false, f);
  assert.ok(pasted.recorded, 'node was not run');
  assert.deepEqual(pasted.recorded.args, [CONSENT, 'approve', repo]);
});

test('amendment 19: the plugin root and the directory are single-quoted, embedded single quotes escaped', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('d19 quote\'s', 'exit 1\n');
  const session = 'rev10-d19-quote';
  assert.equal(edit(env, session, repo).status, 0);
  const command = offeredCommand(messageOf(stop(env, session, repo)));
  const q = s => `'${s.replace(/'/g, "'\\''")}'`;
  assert.equal(command, `CLAUDE_PLUGIN_DATA=${q(env.CLAUDE_PLUGIN_DATA)} node ${q(CONSENT)} approve ${q(repo)}`);
});

test('amendment 19: a directory name with a line break or another control character gets no command', { skip: !POSIX }, () => {
  const env = freshEnv();
  for (const [i, name] of ['d19 line\nbreak', 'd19 esc\x1b[2Jname', 'd19 cr\rname', 'd19 tab\tname'].entries()) {
    const repo = makeRepo(name, 'touch d19-ctl-ran.marker; exit 1\n');
    const session = `rev10-d19-control-${i}`;
    assert.equal(edit(env, session, repo).status, 0);
    const message = messageOf(stop(env, session, repo));
    assert.match(message, /control characters/, JSON.stringify(name));
    assert.doesNotMatch(message, /approve '/, message);
    assert.doesNotMatch(message, /node ["']/, message);
    // The check file is still named, with its control characters escaped.
    assert.doesNotMatch(message, /[\x00-\x1f]/, JSON.stringify(message));
    assert.match(message, /verify\.cmd/);
    assert.equal(existsSync(join(repo, 'd19-ctl-ran.marker')), false);
  }
});

// --- Amendment 20: what the user approves is what they see ---

test('amendment 20: approve shows escape sequences, carriage returns and U+202E escaped, every line prefixed, before asking', {
  skip: !POSIX,
}, () => {
  const env = freshEnv();
  const body = 'echo d20-shown\r echo harmless \x1b[2K\x1b[1A hidden\nexit 0 # ‮ txet\b\n';
  const repo = makeRepo('d20-display', body);

  const no = approveWith(env, repo, 'no');
  assert.equal(no.code, 1);
  assert.equal(existsSync(storePath(env)), false);
  // Nothing invisible reaches the output.
  assert.doesNotMatch(no.out, /[\x00-\x09\x0b-\x1f\x7f-￿]/u, JSON.stringify(no.out));
  const lines = no.out.split('\n');
  assert.ok(lines.includes('| echo d20-shown\\x0d echo harmless \\x1b[2K\\x1b[1A hidden'), no.out);
  assert.ok(lines.includes('| exit 0 # \\u202e txet\\x08'), no.out);
  assert.ok(lines.includes(join(repo, '.claude', 'verify.cmd')), no.out);
  const sha = commandHash(body);
  assert.match(no.out, new RegExp(`\\b2 lines\\b.*\\b${sha.slice(0, 12)}\\b`));
  // The question comes only after all of that was written, and nothing is written in between.
  const askAt = no.events.findIndex(e => e[0] === 'ask');
  assert.deepEqual(no.events[askAt], ['ask', PROMPT]);
  const before = no.events.slice(0, askAt).map(e => e[1]).join('');
  assert.ok(before.includes(sha.slice(0, 12)) && before.includes('| exit 0'), before);

  // The recorded hash is the hash of exactly the bytes shown.
  const yes = approveWith(env, repo, 'yes');
  assert.equal(yes.code, 0, yes.err);
  assert.deepEqual(storeEntries(env), [{ repo: repoIdentity(repo), sha256: sha }]);
});

// --- Amendment 21: the approve command reaches the gate's store ---

test('amendment 21: the printed command\'s environment prefix and arguments select the store the gate reads', { skip: !POSIX }, () => {
  const env = freshEnv();
  const repo = makeRepo('d21-store', 'echo d21-ran >&2; exit 1\n');
  const session = 'rev10-d21-store';
  assert.equal(edit(env, session, repo).status, 0);
  const pasted = paste(offeredCommand(messageOf(stop(env, session, repo))));
  assert.equal(pasted.recorded.pluginData, `=${env.CLAUDE_PLUGIN_DATA}`);
  assert.equal(pasted.recorded.configDir, '');
  const [script, verb, dir] = pasted.recorded.args;
  assert.equal(script, CONSENT);
  assert.equal(verb, 'approve');

  // approve with exactly the environment the paste gave node (the answer only through the seam).
  const r = approveWith({ CLAUDE_PLUGIN_DATA: pasted.recorded.pluginData.slice(1) }, dir, 'yes');
  assert.equal(r.code, 0, r.err);
  const block = stop(env, session, repo);
  assert.equal(block.status, 2, block.stdout);
  assert.match(block.stderr, /d21-ran/);
});

// Amendment 27 replaces "nothing for the ~/.claude default": every higher-priority store variable is set empty.
test('amendment 21 / 27: CLAUDE_CONFIG_DIR is named when it chose the store, and both are emptied for the ~/.claude default', {
  skip: !POSIX,
}, () => {
  const repo = makeRepo('d21-config', 'echo d21-config-ran >&2; exit 1\n');
  const config = join(root, 'd21 config\'s dir');
  const configEnv = { ...baseEnv, CLAUDE_PLUGIN_DATA: '', CLAUDE_CONFIG_DIR: config };
  assert.equal(edit(configEnv, 'rev10-d21-config', repo).status, 0);
  const command = offeredCommand(messageOf(stop(configEnv, 'rev10-d21-config', repo)));
  assert.ok(command.startsWith(`CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR='${config.replace(/'/g, "'\\''")}' node '`), command);
  const pasted = paste(command);
  assert.equal(pasted.recorded.configDir, `=${config}`);
  assert.equal(pasted.recorded.pluginData, '=');
  const r = approveWith({ CLAUDE_CONFIG_DIR: pasted.recorded.configDir.slice(1) }, pasted.recorded.args[2], 'yes');
  assert.equal(r.code, 0, r.err);
  assert.match(stop(configEnv, 'rev10-d21-config', repo).stderr, /d21-config-ran/);

  const homeEnv = { ...baseEnv, HOME: join(root, 'd21-home') };
  assert.equal(edit(homeEnv, 'rev10-d21-home', repo).status, 0);
  const plain = offeredCommand(messageOf(stop(homeEnv, 'rev10-d21-home', repo)));
  assert.ok(plain.startsWith(`CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR= node '${CONSENT}' approve '`), plain);
});

// --- Amendment 22: foreign owners without root ---

test('amendment 22: the preload makes the process under test see another uid', { skip: !HAS_UID }, () => {
  const r = spawnSync(process.execPath, ['--require', OTHER_UID, '-p', 'process.getuid()'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(Number(r.stdout), process.getuid());
});

test('amendment 22: a state file owned by another user is not read', { skip: !POSIX || !HAS_UID }, () => {
  const env = freshEnv();
  const repo = makeRepo('d22-state', 'echo d22-state-ran >&2; exit 1\n');
  approveCheck(env, repo);
  const session = 'rev10-d22-state';
  const flags = { dirty: true, failures: 2, looseWarned: true, consentAsked: true };
  // An edit by "another user" does not take over the flags or count of a state file it does not own.
  writeFileSync(stateFile(session, repo), JSON.stringify(flags));
  assert.equal(edit(env, session, repo, OTHER_UID).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')), { dirty: true, failures: 0 });
  // Control: its owner does take them over.
  writeFileSync(stateFile(session, repo), JSON.stringify(flags));
  assert.equal(edit(env, session, repo).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(stateFile(session, repo), 'utf8')),
    { dirty: true, failures: 0, looseWarned: true, consentAsked: true });
  // A stop by "another user" does not use the dirty state.
  const r = stop(env, session, repo, OTHER_UID);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, /d22-state-ran/);
});

test('amendment 22: a check file owned by another user is neither shown for approval nor run', { skip: !POSIX || !HAS_UID }, () => {
  const env = freshEnv();
  const repo = makeRepo('d22-check', 'echo d22-check-ran >&2; exit 1\n');
  const foreign = approveInChild(env, repo, OTHER_UID);
  assert.equal(foreign.status, 2, foreign.stderr);
  assert.doesNotMatch(foreign.stdout, /ASKED/);
  assert.match(foreign.stderr, /not a regular file that only you can modify/);
  // Control: its owner is asked.
  const own = approveWith(env, repo, 'no');
  assert.equal(own.asked, 1);

  approveCheck(env, repo);
  const session = 'rev10-d22-check';
  assert.equal(edit(env, session, repo).status, 0);
  const r = stop(env, session, repo, OTHER_UID);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /d22-check-ran/);
  assert.match(stop(env, session, repo).stderr, /d22-check-ran/);
});

test('amendment 22: a store owned by another user is ignored by list', { skip: !POSIX || !HAS_UID }, () => {
  const env = freshEnv();
  const repo = makeRepo('d22-store', 'exit 0\n');
  approveCheck(env, repo);
  const own = consentCli(env, null, 'list');
  assert.equal(own.stdout.split('\n').filter(Boolean).length, 1, own.stderr);
  const foreign = consentCli(env, OTHER_UID, 'list');
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.stdout, '');
});

// --- Amendment 23: approve and revoke never discard approvals silently ---

// Each case makes the store at storePath(env) unusable and returns a snapshot to compare against.
const unusable = {
  unparsable(env) {
    mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true });
    writeFileSync(storePath(env), '{"entries": [ {"repo": "/x", "sha256": "trunc');
    return /cannot be parsed/;
  },
  symlink(env) {
    const elsewhere = { CLAUDE_PLUGIN_DATA: mkdtempSync(join(root, 'd23-elsewhere-')) };
    approveCheck(elsewhere, root, 'echo elsewhere\n');
    symlinkSync(storePath(elsewhere), storePath(env));
    return /symbolic link/;
  },
  directory(env) {
    mkdirSync(storePath(env));
    return /not a regular file/;
  },
};
const snapshot = file => {
  const st = lstatSync(file);
  if (st.isSymbolicLink()) return `link:${readlinkSync(file)}:${readFileSync(file, 'utf8')}`;
  if (st.isDirectory()) return `dir:${readdirSync(file).join(',')}`;
  return `file:${st.ino}:${readFileSync(file, 'utf8')}`;
};

test('amendment 23: approve with an unusable store records nothing and exits 2, naming the file and why', { skip: !POSIX }, () => {
  for (const [name, make] of Object.entries(unusable)) {
    const env = freshEnv();
    const repo = makeRepo(`d23-approve-${name}`, 'exit 0\n');
    const why = make(env);
    const before = snapshot(storePath(env));
    const r = approveWith(env, repo, 'yes');
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.ok(r.err.includes(storePath(env)), `${name}: ${r.err}`);
    assert.match(r.err, why, name);
    assert.equal(snapshot(storePath(env)), before, name);
  }
});

test('amendment 23: revoke with an unusable store changes nothing and exits 2, naming the file and why', { skip: !POSIX }, () => {
  for (const [name, make] of Object.entries(unusable)) {
    const env = freshEnv();
    const repo = makeRepo(`d23-revoke-${name}`, 'exit 0\n');
    const why = make(env);
    const before = snapshot(storePath(env));
    const r = consentCli(env, null, 'revoke', repo);
    assert.equal(r.status, 2, `${name}: ${r.stdout}`);
    assert.ok(r.stderr.includes(storePath(env)), `${name}: ${r.stderr}`);
    assert.match(r.stderr, why, name);
    assert.equal(snapshot(storePath(env)), before, name);
  }
});

test('amendment 22 / 23: a store owned by another user makes approve and revoke exit 2 and stay untouched', { skip: !POSIX || !HAS_UID }, () => {
  const env = freshEnv();
  const repo = makeRepo('d23-foreign', 'exit 0\n');
  approveCheck(env, repo, 'echo an earlier approval\n');
  const before = snapshot(storePath(env));

  const a = approveInChild(env, repo, OTHER_UID);
  assert.equal(a.status, 2, a.stdout);
  assert.doesNotMatch(a.stdout, /ASKED/);
  assert.ok(a.stderr.includes(storePath(env)), a.stderr);
  assert.match(a.stderr, /owned by another user/);

  const r = consentCli(env, OTHER_UID, 'revoke', repo);
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.stderr.includes(storePath(env)), r.stderr);
  assert.match(r.stderr, /owned by another user/);
  assert.equal(snapshot(storePath(env)), before);
});
