'use strict';
// Spec rev 7, amendments 1 (no directory change before arming), 2 (same-file check), 3 (quoting) and
// 4 (whole-sequence tests). The marker is armed through a real shell, so PWD is set as a shell sets
// it, and the outcome is judged by running the SessionStart hook.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const SKILL = fs.readFileSync(path.join(PLUGIN, 'skills', 'fresh', 'SKILL.md'), 'utf8');
const SH = { skip: process.platform === 'win32' && 'needs /bin/sh and symlinks' };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev7-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const HANDOVER = '# Handover: rev7\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

let n = 0;
// A repository at <dir>/real/<name>, reached through the symlink <dir>/link.
function sandbox(name = 'repo') {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'real', name);
  const link = path.join(dir, 'link');
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  for (const d of [path.join(repo, '.git'), tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(repo, link);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { dir, repo, link, tmp, env };
}

// Arms the marker the way the skill does: the bare command, in the shell's current directory.
// `cd` here only stands in for the session's shell already being in `dir`; it sets PWD logically.
function arm(env, dir) {
  return spawnSync('/bin/sh', ['-c', 'cd "$1" && exec "$0" "$2"', process.execPath, dir, ARM], { env, encoding: 'utf8' });
}

function hook(env, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const SUCCESS = /^fresh marker armed for (.+) \((.+)\)$/m;
const q = s => `'${s.replace(/'/g, `'\\''`)}'`;

function codeBlocks(text) {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(b => b[1]);
}
const STEP3 = SKILL.slice(SKILL.indexOf('**Set the marker.**'), SKILL.indexOf('4. **'));
const CHECK = codeBlocks(STEP3).find(b => b.includes('-ef'));

// Runs the skill's same-file check with its placeholders filled in, quoted as amendment 3 requires.
function sameFile(env, successRoot, written) {
  const cmd = CHECK
    .replace(/'<root from the success line>/, () => q(successRoot).slice(0, -1))
    .replace(/'<HANDOVER\.md written in step 2>'/, () => q(written));
  const r = spawnSync('/bin/sh', ['-c', cmd], { env, encoding: 'utf8' });
  return r.status === 0 && /same-file/.test(r.stdout);
}

// --- Amendment 4: the whole sequence, judged by the hook ---

test('amendment 4: armed from a symlinked repository, a clear through the symlink resumes', SH, () => {
  const { repo, link, env } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const r = arm(env, link);
  assert.equal(r.status, 0, r.stderr);
  const ctx = hook(env, link);
  assert.match(ctx, /Continuing from /);
  assert.match(ctx, /RUN-THE-NEXT-STEP/);
});

test('amendment 4: armed from a nested directory under the symlink, the clear still resumes', SH, () => {
  const { repo, link, env } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  fs.mkdirSync(path.join(repo, 'src'));
  assert.equal(arm(env, path.join(link, 'src')).status, 0);
  assert.match(hook(env, link), /Continuing from /);
});

test('amendment 4: a marker armed for another repository does not resume', SH, () => {
  const { repo, link, env } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const other = path.join(path.dirname(repo), 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'HANDOVER.md'), HANDOVER);
  assert.equal(arm(env, other).status, 0);
  assert.doesNotMatch(hook(env, link), /Continuing from/);
  assert.doesNotMatch(hook(env, repo), /Continuing from/);
});

test('amendment 4: a path with a single quote survives the whole sequence', SH, () => {
  const { repo, link, env } = sandbox("it's repo");
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  assert.equal(arm(env, link).status, 0);
  assert.match(hook(env, link), /Continuing from /);
});

// --- Amendment 1: no directory change before arming ---

test('amendment 1: the skill arms with the bare command and no cd', () => {
  const blocks = codeBlocks(SKILL);
  const armBlock = blocks.find(b => b.includes('scripts/fresh-marker.js'));
  assert.ok(armBlock, 'a code block runs the marker script');
  assert.deepEqual(armBlock.split('\n').map(l => l.trim()).filter(Boolean),
    ['node "${CLAUDE_PLUGIN_ROOT}/scripts/fresh-marker.js"']);
  for (const b of codeBlocks(STEP3)) assert.doesNotMatch(b, /(^|[\s;&|(])cd(\s|$)/m, b);
  assert.match(STEP3, /Do not `cd`/);
});

// --- Amendment 2: same-file check by identity ---

test('amendment 2: the skill compares the HANDOVER.md files by identity, never as strings', () => {
  assert.ok(CHECK, 'a code block holds the same-file check');
  assert.match(CHECK, /^\s*test '<root from the success line>\/HANDOVER\.md' -ef '<HANDOVER\.md written in step 2>'/m);
  assert.match(STEP3, /never\s+compare the two as strings/);
  assert.doesNotMatch(STEP3, /Compare the `<root>` in that success line/, 'rev 5 string comparison is gone');
});

test('amendment 2: a failed arm sends the user to /pickup after /clear', () => {
  assert.match(STEP3, /Anything else is a failed arm/);
  assert.match(STEP3, /run `\/clear` and then continue with `\/pickup`/);
});

test('amendment 2: the check holds across a symlink and fails for another repository', SH, () => {
  const { repo, link, env } = sandbox("it's repo");
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  // The skill wrote the file under the root git prints, which has symlinks resolved.
  const written = path.join(fs.realpathSync(repo), 'HANDOVER.md');
  const m = arm(env, link).stdout.match(SUCCESS);
  assert.ok(m);
  assert.equal(m[1], link, 'the success line keeps the symlinked spelling');
  assert.ok(sameFile(env, m[1], written));
  const other = path.join(path.dirname(repo), 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'HANDOVER.md'), HANDOVER);
  const o = arm(env, other).stdout.match(SUCCESS);
  assert.ok(o);
  assert.ok(!sameFile(env, o[1], written), 'an equal-content file elsewhere is not the same file');
});

test('amendment 2: the check holds across letter case on a case-insensitive file system', SH, (t) => {
  const { repo, env } = sandbox('casedrepo');
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const upper = path.join(path.dirname(repo), 'CASEDREPO');
  if (!fs.existsSync(upper)) return t.skip('case-sensitive file system');
  assert.ok(sameFile(env, upper, path.join(repo, 'HANDOVER.md')));
});

// --- Amendment 3: quoting ---

test('amendment 3: paths in shell commands are single-quoted with single quotes escaped', () => {
  assert.match(CHECK, /^\s*test '[^']*' -ef '[^']*'/m);
  assert.match(STEP3, /single quotes, and write each single quote inside a path as\s+`'\\''`/);
  assert.match(STEP3, /`\/a\/it's` becomes `'\/a\/it'\\''s'`/);
});
