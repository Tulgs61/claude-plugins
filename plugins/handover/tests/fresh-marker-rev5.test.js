'use strict';
// Spec rev 5, amendment 1 (arming in the right repository).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { markerPath } = require('../scripts/fresh-marker.js');

const PLUGIN = path.resolve(__dirname, '..');
const ARM = path.join(PLUGIN, 'scripts', 'fresh-marker.js');
const SKILL = fs.readFileSync(path.join(PLUGIN, 'skills', 'fresh', 'SKILL.md'), 'utf8');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-marker-rev5-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'repo');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { dir, repo, tmp, env };
}

const SUCCESS = /^fresh marker armed for (.+) \((.+)\)$/m;

test('amendment 1: the success line names the root the marker was armed for', () => {
  const { repo, tmp, env } = sandbox();
  const nested = path.join(repo, 'src');
  fs.mkdirSync(nested);
  const r = spawnSync(process.execPath, [ARM], { cwd: nested, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(SUCCESS);
  assert.ok(m, r.stdout);
  const real = fs.realpathSync(repo);
  assert.equal(m[1], real);
  assert.equal(path.basename(m[2]), path.basename(markerPath(real)));
  assert.ok(fs.existsSync(path.join(tmp, path.basename(markerPath(m[1])))));
});

test('amendment 1: a shell left in another repository arms that root, which the line reveals', () => {
  const { repo, env } = sandbox();
  const other = sandbox().repo;
  const r = spawnSync(process.execPath, [ARM], { cwd: other, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(SUCCESS);
  assert.ok(m, r.stdout);
  assert.notEqual(m[1], fs.realpathSync(repo), 'the success line exposes the wrong root');
});

// The fenced block in step 3 that runs the marker script.
function armBlock() {
  const blocks = [...SKILL.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(b => b[1]);
  return blocks.find(b => b.includes('scripts/fresh-marker.js'));
}

test('amendment 1: the skill returns the shell to the project root before arming', () => {
  const block = armBlock();
  assert.ok(block, 'a code block runs the marker script');
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const run = lines.findIndex(l => l.includes('scripts/fresh-marker.js'));
  const cd = lines.findIndex(l => /^cd\s+\S/.test(l));
  assert.ok(cd !== -1 && cd < run, block);
  // The cd only runs the script when it succeeded.
  assert.match(lines.slice(cd, run).join(' '), /&&\s*$/);
  assert.doesNotMatch(lines[cd], /CLAUDE_PLUGIN_ROOT/, 'returns to the project, not the plugin');
  assert.match(SKILL, /HANDOVER\.md` you\s+just wrote/);
  assert.match(SKILL, /session's project\s+directory/);
});

test('amendment 1: the skill compares the root in the success line and treats a mismatch as a failed arm', () => {
  const step = SKILL.slice(SKILL.indexOf('**Set the marker.**'), SKILL.indexOf('4. **'));
  assert.match(step, /fresh marker armed for <root>/);
  assert.match(step, /Compare the `<root>` in that success line with the repository root/);
  assert.match(step, /names a different\s+root/);
  // A mismatch is reported like a non-zero exit: no automatic load, fall back to /pickup.
  assert.match(step, /In every one of\s+these cases/);
  assert.match(step, /not\s+load by itself/);
  assert.match(step, /\/pickup/);
});
