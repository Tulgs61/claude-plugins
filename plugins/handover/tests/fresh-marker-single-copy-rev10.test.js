'use strict';
// Spec rev 10, amendment 6 (one marker copy). Outcomes are judged by the temp directory and the hook.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { markerPath, resolvedRoot } = require('../scripts/fresh-marker.js');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const SH = { skip: process.platform === 'win32' && 'needs /bin/sh and symlinks' };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-single-copy-rev10-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const HANDOVER = '# Handover: single copy\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

let n = 0;
// A repository at <dir>/real/repo, reached through the symlink <dir>/link.
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'real', 'repo');
  const link = path.join(dir, 'link');
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  for (const d of [path.join(repo, '.git'), tmp, home]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(repo, link);
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), HANDOVER);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { dir, repo, real: resolvedRoot(repo), link, tmp, env };
}

// Runs the marker command from `dir`, PWD set as a shell sets it, with optional arguments.
function armInShell(env, dir, ...args) {
  const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && shift && exec "$@"', 'sh', dir, process.execPath, ARM, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function hook(env, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('amendment 6: a bare arm from the symlinked directory leaves exactly one marker file, under the resolved root', SH, () => {
  const { real, link, tmp, env } = sandbox();
  const r = armInShell(env, link);
  const marker = path.basename(markerPath(real));
  assert.deepEqual(fs.readdirSync(tmp), [marker]);
  // The success line still names the shell's spelling of the root.
  assert.equal(r.stdout, `fresh marker armed for ${link} (${path.join(tmp, marker)})\n`);
});

// Armed from the symlinked spelling and cleared through the resolved one: the hook's two candidates
// are both the resolved path, so a copy under the shell's spelling would survive and resume again.
test('amendment 6: armed from the symlinked directory and resumed through the resolved cwd, no marker is left and neither spelling resumes again', SH, () => {
  const { real, link, tmp, env } = sandbox();
  armInShell(env, link);
  assert.match(hook(env, real), /RUN-THE-NEXT-STEP/);
  assert.deepEqual(fs.readdirSync(tmp), [], 'no marker for the root is left');
  for (const cwd of [link, real]) assert.doesNotMatch(hook(env, cwd), /Continuing from/, cwd);
});
