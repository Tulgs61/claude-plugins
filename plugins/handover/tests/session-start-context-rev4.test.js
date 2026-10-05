'use strict';
// Spec rev 4, amendments 2 (no noise on failure), 3 (code fences) and 5 (hook registration).
// Every spawn gets an isolated HOME and TMPDIR, as in session-start-context.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const { markerPath } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-hook-rev4-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  for (const d of [path.join(repo, '.git'), home, tmp]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const marker = path.join(tmp, path.basename(markerPath(repo)));
  return { dir, repo, env, marker };
}

function runHook(env, stdin, hook = HOOK) {
  const r = spawnSync(process.execPath, [hook], { input: stdin, env, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function context(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  return out.hookSpecificOutput.additionalContext;
}

// --- Amendment 2: no noise on failure ---

test('amendment 2: a hook that cannot load its module exits 0 silently', () => {
  const { dir, repo, env } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), '# H\n');
  const lone = path.join(dir, 'plugin', 'hooks', 'session-start-context.js');
  fs.mkdirSync(path.dirname(lone), { recursive: true });
  fs.copyFileSync(HOOK, lone); // no ../scripts/fresh-marker.js next to it
  const r = runHook(env, JSON.stringify({ source: 'startup', cwd: repo }), lone);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

// The closed-stdout pipe and descriptor tests were replaced (spec rev 10, amendment 5) by tests that
// make only one guard reachable at a time. See session-start-context-rev10.test.js.

// --- Amendment 3: code fences ---

const FENCED = [
  '# Handover: fences',
  '',
  '## Next action',
  'Run the snippet:',
  '```markdown',
  '## Follow-ups',
  'FENCED-IN-NEXT-ACTION stays',
  '```',
  'AFTER-FENCE stays too',
  '',
  '## Follow-ups',
  'REAL-FOLLOWUP-DROPPED',
  '~~~~',
  '## Traps',
  'FENCED-IN-FOLLOWUPS dropped',
  '~~~',
  'still inside the tilde fence: DROPPED-TOO',
  '~~~~',
  'TAIL-OF-FOLLOWUPS dropped',
  '',
  '## Traps',
  'REAL-TRAP kept',
  '',
].join('\n');

test('amendment 3: a "## " line inside a fenced code block is content, not a heading', () => {
  const { repo, env, marker } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), FENCED);
  fs.writeFileSync(marker, JSON.stringify({ createdAt: Date.now() }), { mode: 0o600 });
  const r = runHook(env, JSON.stringify({ source: 'clear', cwd: repo }));
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r.stdout);
  assert.match(ctx, /Context was cleared with \/fresh/);
  assert.match(ctx, /```markdown\n## Follow-ups\nFENCED-IN-NEXT-ACTION stays\n```\nAFTER-FENCE stays too/);
  assert.doesNotMatch(ctx, /REAL-FOLLOWUP-DROPPED/);
  assert.doesNotMatch(ctx, /FENCED-IN-FOLLOWUPS/);
  assert.doesNotMatch(ctx, /DROPPED-TOO/);
  assert.doesNotMatch(ctx, /TAIL-OF-FOLLOWUPS/);
  assert.match(ctx, /## Traps\nREAL-TRAP kept/);
});

// --- Amendment 5: hook registration ---

test('amendment 5: hooks.json uses the exec form with a 10 second timeout', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const groups = cfg.hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].matcher.split('|').sort(), ['clear', 'compact', 'resume', 'startup']);
  assert.equal(groups[0].hooks.length, 1);
  const h = groups[0].hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.command, 'node');
  assert.deepEqual(h.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.js']);
  assert.equal(h.timeout, 10);
});
