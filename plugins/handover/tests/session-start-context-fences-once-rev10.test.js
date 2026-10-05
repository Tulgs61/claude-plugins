'use strict';
// Spec rev 10, amendment 8 (fences found once, before any trimming). A four-space-indented run of
// backticks at the start of the reduced handover is no fence, for headings and for the cut alike, and
// trimming does not turn it into one. Every spawn gets an isolated HOME and TMPDIR.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const { markerPath } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-fences-once-rev10-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const LIMIT = 4000;

let n = 0;
// Runs a fresh resume over `handover` and returns the reduced handover the hook injected.
function freshResume(handover) {
  const dir = path.join(base, `case-${++n}`);
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  for (const d of [path.join(repo, '.git'), home, tmp]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), handover);
  const marker = path.join(tmp, path.basename(markerPath(repo)));
  fs.writeFileSync(marker, JSON.stringify({ createdAt: Date.now() }), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(marker, 0o600);
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd: repo }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n');
  assert.equal(lines[2], '', 'a fresh resume: two lines, a blank line, then the handover');
  return lines.slice(3).join('\n');
}

// `len` characters of filler lines, ending with a newline.
function filler(len) {
  let s = '';
  let i = 0;
  while (s.length < len) {
    const width = Math.min(len - s.length, 50);
    s += width === 1 ? '\n' : `${String(i++ % 10).repeat(width - 1)}\n`;
  }
  return s;
}

test('amendment 8: trimming keeps the indentation of a four-space backtick run at the start', () => {
  const out = freshResume('\n    ```\n# H\n\n## Next action\nNEXT\n\n## Follow-ups\nDROPPED\n');
  assert.ok(out.startsWith('    ```\n# H\n'), JSON.stringify(out.slice(0, 20)));
  assert.doesNotMatch(out, /DROPPED/);
});

test('amendment 8: a four-space backtick run at the start does not move the cut to the beginning', () => {
  const head = '    ```\n# Handover: cut\n\n## Next action\n';
  const text = head + filler(4600 - head.length).trimEnd();
  const out = freshResume(text);
  const i = out.lastIndexOf('\n');
  const body = out.slice(0, i).trimEnd();
  assert.ok(i > 0 && !text.includes(out.slice(i + 1)), 'the note follows on its own line');
  assert.ok(text.startsWith(body), 'the kept text is a prefix of the handover');
  assert.ok(body.length <= LIMIT, `cut at or before ${LIMIT}: ${body.length}`);
  assert.equal(body.length, text.slice(0, LIMIT).trimEnd().length, 'cut at the limit, as without a fence');
});

// Runs of blank lines collapse before the cut, so the fence's offsets in the reduced handover differ
// from those in the file; the cut must still land just before the fence's opening line.
test('amendment 8: with blank lines before and inside a kept fence across the limit, the cut falls just before the fence', () => {
  const head = '# Handover: blanks\n\n\n\n\n## Next action\n';
  const before = head + filler(3700 - head.length) + 'BEFORE-FENCE\n\n\n\n\n';
  const fence = '```js\nIN-FENCE\n\n\n\n\n' + filler(800) + '```\n';
  const text = before + fence + 'AFTER-FENCE\n';
  const out = freshResume(text);
  const i = out.lastIndexOf('\n');
  const body = out.slice(0, i).trimEnd();
  assert.ok(i > 0 && !text.includes(out.slice(i + 1)), 'the note follows on its own line');
  assert.ok(body.length <= LIMIT, `cut at or before ${LIMIT}: ${body.length}`);
  assert.ok(body.endsWith('\nBEFORE-FENCE'), JSON.stringify(body.slice(-40)));
  assert.doesNotMatch(out, /```|IN-FENCE|AFTER-FENCE/);
  // Without the cut moving, the limit would fall inside the fence: it opens before and closes after it.
  const reduced = text.replace(/\n{3,}/g, '\n\n');
  assert.ok(reduced.indexOf('```js') < LIMIT && reduced.lastIndexOf('```') > LIMIT, 'the kept fence crosses the limit');
});
