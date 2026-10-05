'use strict';
// Spec rev 9, amendments 1 (one canonical spelling when arming), 2 (single use across spellings) and
// 3 (tests). Outcomes are judged by running the hook.
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev9-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const HANDOVER = '# Handover: rev9\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

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
  return { dir, repo, real: resolvedRoot(repo), link, tmp, env };
}

// Arms the marker with the bare command from `dir`, PWD set as a shell sets it.
function armInShell(env, dir) {
  const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && exec "$0" "$2"', process.execPath, dir, ARM], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function writeMarker(tmp, root, data) {
  const p = path.join(tmp, path.basename(markerPath(root)));
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
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

// --- Amendment 1: one canonical spelling when arming ---

test('amendment 1: armed through a shell in the symlinked directory, the marker sits under the resolved root', SH, () => {
  const { real, link, tmp, env } = sandbox();
  armInShell(env, link);
  const p = path.join(tmp, path.basename(markerPath(real)));
  assert.ok(fs.lstatSync(p).isFile(), fs.readdirSync(tmp).join(', '));
  assert.equal(typeof JSON.parse(fs.readFileSync(p, 'utf8')).createdAt, 'number');
});

test('amendment 1: armed from a nested symlinked directory, the marker still sits under the resolved root', SH, () => {
  const { real, link, tmp, env } = sandbox();
  fs.mkdirSync(path.join(real, 'src'));
  armInShell(env, path.join(link, 'src'));
  assert.ok(fs.existsSync(path.join(tmp, path.basename(markerPath(real)))));
});

// --- Amendment 3: the whole sequence, judged by the hook ---

test('amendment 3: armed through a shell from the symlinked directory, a clear through the resolved cwd resumes', SH, () => {
  const { real, link, env } = sandbox();
  armInShell(env, link);
  const ctx = hook(env, real);
  assert.match(ctx, /Continuing from /);
  assert.match(ctx, /RUN-THE-NEXT-STEP/);
});

test('amendment 3: armed from the resolved directory, a clear through the symlinked cwd resumes', SH, () => {
  const { real, link, env } = sandbox();
  armInShell(env, real);
  const ctx = hook(env, link);
  assert.match(ctx, /Continuing from /);
  assert.match(ctx, /RUN-THE-NEXT-STEP/);
});

for (const armFrom of ['link', 'real']) {
  for (const first of ['link', 'real']) {
    test(`amendment 3: armed from the ${armFrom} spelling and resumed through ${first}, a second clear under either spelling does not resume`, SH, () => {
      const s = sandbox();
      armInShell(s.env, s[armFrom]);
      assert.match(hook(s.env, s[first]), /Continuing from /);
      for (const second of [s.link, s.real]) {
        assert.doesNotMatch(hook(s.env, second), /Continuing from/, second);
      }
      assert.deepEqual(fs.readdirSync(s.tmp), [], 'no marker is left under any spelling');
    });
  }
}

test('amendment 3: a marker for another repository still never resumes, under any spelling', SH, () => {
  const { repo, real, link, env } = sandbox();
  const other = path.join(path.dirname(repo), 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'HANDOVER.md'), HANDOVER);
  armInShell(env, other);
  for (const cwd of [link, repo, real]) assert.doesNotMatch(hook(env, cwd), /Continuing from/, cwd);
});

// --- Amendment 2: single use across spellings ---

test('amendment 2: honouring the lexical marker removes the one under the resolved spelling', SH, () => {
  const { real, link, tmp, env } = sandbox();
  const lexical = writeMarker(tmp, link, { createdAt: Date.now() });
  const resolved = writeMarker(tmp, real, { createdAt: Date.now() });
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(!fs.existsSync(lexical));
  assert.ok(!fs.existsSync(resolved));
  assert.doesNotMatch(hook(env, real), /Continuing from/);
});

test('amendment 2: a symlink under the other spelling is not followed and its target survives', SH, () => {
  const { real, link, tmp, env } = sandbox();
  writeMarker(tmp, link, { createdAt: Date.now() });
  const victim = path.join(tmp, 'victim.json');
  fs.writeFileSync(victim, JSON.stringify({ createdAt: Date.now() }), { mode: 0o600 });
  const resolved = path.join(tmp, path.basename(markerPath(real)));
  fs.symlinkSync(victim, resolved);
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(fs.existsSync(victim), 'the symlink target is not removed');
  assert.ok(fs.lstatSync(resolved).isSymbolicLink(), 'the symlink is not a marker the hook owns');
});

test('amendment 2: a marker listing another repository as a spelling does not remove that repository\'s marker', SH, () => {
  const { repo, link, tmp, env } = sandbox();
  const other = path.join(path.dirname(repo), 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  writeMarker(tmp, link, { createdAt: Date.now(), roots: [link, other] });
  const otherMarker = writeMarker(tmp, other, { createdAt: Date.now() });
  assert.match(hook(env, link), /Continuing from /);
  assert.ok(fs.existsSync(otherMarker), 'only spellings of the same root are removed');
});
