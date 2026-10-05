'use strict';
// Spec rev 8, amendments 1 (any spelling of the root), 2 (no directory change while writing),
// 3 (instructions follow the outcome) and 4 (tests). Outcomes are judged by running the hook.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { markerPath } = require('../scripts/fresh-marker.js');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const SKILL = fs.readFileSync(path.join(PLUGIN, 'skills', 'fresh', 'SKILL.md'), 'utf8');
const SH = { skip: process.platform === 'win32' && 'needs /bin/sh and symlinks' };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev8-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const HANDOVER = '# Handover: rev8\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

let n = 0;
// A repository at <dir>/real/<name> (spelled `real` with symlinks resolved), reached through the
// symlink <dir>/link.
function sandbox(name = 'repo') {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'real', name);
  const link = path.join(dir, 'link');
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  for (const d of [path.join(repo, '.git'), tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(repo, link);
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { dir, repo, real: fs.realpathSync(repo), link, tmp, env };
}

// Arms the marker with the bare command from `dir`, PWD set as a shell sets it.
function armInShell(env, dir) {
  const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && exec "$0" "$2"', process.execPath, dir, ARM], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

// Arms the marker with the bare command from `dir`, without a PWD: the script sees only the
// process working directory, which the OS reports with symlinks resolved.
function armWithoutPwd(env, dir) {
  const r = spawnSync(process.execPath, [ARM], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function writeMarker(tmp, root, createdAt) {
  const p = path.join(tmp, path.basename(markerPath(root)));
  fs.writeFileSync(p, JSON.stringify({ createdAt }), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

function hook(env, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// --- Amendments 1 and 4: any spelling of the root ---

test('amendment 4: armed from the resolved path, a clear through the symlinked cwd resumes', SH, () => {
  const { real, link, env } = sandbox();
  armInShell(env, real);
  const ctx = hook(env, link);
  assert.match(ctx, /Continuing from /);
  assert.match(ctx, /RUN-THE-NEXT-STEP/);
});

test('amendment 4: armed from the symlinked path, a clear through the resolved cwd resumes', SH, () => {
  const { real, link, env } = sandbox();
  armWithoutPwd(env, link);
  const ctx = hook(env, real);
  assert.match(ctx, /Continuing from /);
  assert.match(ctx, /RUN-THE-NEXT-STEP/);
});

// Was a todo until spec rev 9, amendment 1: the script now arms under the resolved root.
test('amendment 4: armed from the symlinked path with a shell PWD, a clear through the resolved cwd resumes', SH, () => {
  const { real, link, env } = sandbox();
  armInShell(env, link);
  assert.match(hook(env, real), /Continuing from /);
});

test('amendment 4: a marker for another repository never resumes, under any spelling', SH, () => {
  const { repo, real, link, env } = sandbox();
  const other = path.join(path.dirname(repo), 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'HANDOVER.md'), HANDOVER);
  armInShell(env, other);
  armInShell(env, fs.realpathSync(other));
  for (const cwd of [link, repo, real]) assert.doesNotMatch(hook(env, cwd), /Continuing from/, cwd);
});

test('amendment 1: the marker found under the resolved root is deleted and works only once', SH, () => {
  const { real, link, tmp, env } = sandbox();
  armInShell(env, real);
  const p = path.join(tmp, path.basename(markerPath(real)));
  assert.ok(fs.existsSync(p));
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(!fs.existsSync(p), 'the winning marker is deleted');
  assert.doesNotMatch(hook(env, link), /Continuing from/);
});

test('amendment 1: a stale marker under the lexical root does not hide a fresh one under the resolved root', SH, () => {
  const { real, link, tmp, env } = sandbox();
  writeMarker(tmp, link, Date.now() - 13 * 60 * 60 * 1000);
  writeMarker(tmp, real, Date.now());
  assert.match(hook(env, link), /Continuing from /);
});

test('amendment 1: a fresh marker under the lexical root wins first', SH, () => {
  const { real, link, tmp, env } = sandbox();
  const lexical = writeMarker(tmp, link, Date.now());
  const resolved = writeMarker(tmp, real, Date.now());
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(!fs.existsSync(lexical), 'the lexical marker is consumed');
  // Spec rev 9, amendment 2: honouring one spelling also removes the marker under the other.
  assert.ok(!fs.existsSync(resolved), 'the resolved marker is removed too');
});

test('amendment 1: an untrusted marker under the resolved root is not honoured', { skip: (process.platform === 'win32') && 'POSIX modes' }, () => {
  const { real, link, tmp, env } = sandbox();
  const p = writeMarker(tmp, real, Date.now());
  fs.chmodSync(p, 0o666);
  assert.doesNotMatch(hook(env, link), /Continuing from/);
});

// --- Amendment 2: no directory change while writing ---

const STEPS = SKILL.slice(SKILL.indexOf('## Procedure'));
const STEP2 = STEPS.slice(STEPS.indexOf('**Write a compact handover.**'), STEPS.indexOf('3. **'));

test('amendment 2: the skill writes and arms without changing the shell directory', () => {
  for (const b of [...STEPS.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1])) {
    assert.doesNotMatch(b, /(^|[\s;&|(])(cd|pushd|popd)(\s|$)/m, b);
  }
  assert.match(STEPS, /No step changes the shell's directory/);
  assert.match(STEP2, /shell's current directory/);
});

// --- Amendment 3: instructions follow the outcome ---

test('amendment 3: the /clear + any message instructions come only after a successful arm', () => {
  const STEP3 = STEPS.slice(STEPS.indexOf('**Set the marker.**'), STEPS.indexOf('4. **'));
  const STEP4 = STEPS.slice(STEPS.indexOf('4. **'));
  assert.match(STEP3, /run `\/clear` and then continue with `\/pickup`/);
  assert.match(STEP3, /Give only this\s+fallback/);
  assert.match(STEP4, /^4\. \*\*Only after a successful arm/);
  assert.match(STEP4, /send any\s+further message/);
});
