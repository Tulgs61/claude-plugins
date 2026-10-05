'use strict';
// Spec rev 10, amendments 2 (single link, at hook level), 3 (cutting the reduced handover) and 5
// (tests: stdout guards, fences, the finished-plan mtime case, another user's marker). Every spawn
// gets an isolated HOME and TMPDIR, as in session-start-context.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-start-context.js');
const { markerPath } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-hook-rev10-'));
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
  return { dir, repo, env, tmp, marker };
}

function runHook(env, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function context(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  return out.hookSpecificOutput.additionalContext;
}

function armMarker(marker, createdAt = Date.now()) {
  fs.writeFileSync(marker, JSON.stringify({ createdAt }), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(marker, 0o600);
}

// Runs a fresh resume over `handover` and returns the reduced handover the hook injected: the
// context after its two leading lines and the blank line that follows them.
function freshResume(handover) {
  const { repo, env, marker } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), handover);
  armMarker(marker);
  const r = runHook(env, { source: 'clear', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r.stdout);
  const lines = ctx.split('\n');
  assert.equal(lines[2], '', 'a fresh resume: two lines, a blank line, then the handover');
  return lines.slice(3).join('\n');
}

// --- Amendment 5: the stdout guards ---

// A preload for the hook that records every 'error' event on stdout in $PROBE, and, depending on
// $BLOCK, keeps the hook from installing one of its two guards, so only the other one is reachable.
const PRELOAD = path.join(base, 'preload.js');
fs.writeFileSync(PRELOAD, `'use strict';
const fs = require('node:fs');
const out = process.stdout;
const emit = out.emit;
out.emit = function (ev, ...args) {
  if (ev === 'error') fs.appendFileSync(process.env.PROBE, String(args[0] && args[0].code) + '\\n');
  return emit.call(this, ev, ...args);
};
function block(target, event) {
  for (const m of ['on', 'addListener', 'once', 'prependListener']) {
    const orig = target[m];
    target[m] = function (ev, ...rest) {
      return ev === event ? this : orig.call(this, ev, ...rest);
    };
  }
}
if (process.env.BLOCK === 'uncaughtException') block(process, 'uncaughtException');
if (process.env.BLOCK === 'stdout-error') block(out, 'error');
`);

// Runs the hook with a stdout pipe whose reader is gone before the hook writes (EPIPE).
async function closedPipe(block) {
  const { dir, repo, env } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), '# H\n');
  const probe = path.join(dir, 'probe');
  fs.writeFileSync(probe, '');
  const child = spawn(process.execPath, ['--require', PRELOAD, HOOK], {
    env: { ...env, PROBE: probe, BLOCK: block }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.end(JSON.stringify({ source: 'startup', cwd: repo }));
  const status = await new Promise(resolve => child.on('close', resolve));
  return { status, stderr, errors: fs.readFileSync(probe, 'utf8') };
}

test('amendment 5: a write to a closed stdout is handled by the stdout error guard', { skip: process.platform === 'win32' && 'EPIPE is POSIX' }, async () => {
  const r = await closedPipe('uncaughtException');
  assert.match(r.errors, /EPIPE/, 'the hook wrote to the closed stdout');
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});

test('amendment 5: without the stdout guard, the uncaught-exception guard still keeps exit 0 and silence', { skip: process.platform === 'win32' && 'EPIPE is POSIX' }, async () => {
  const r = await closedPipe('stdout-error');
  assert.match(r.errors, /EPIPE/, 'the hook wrote to the closed stdout');
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});

// --- Amendment 5: which lines count as headings, with fences ---

test('fences: an info string with a backtick does not open a backtick fence', () => {
  const out = freshResume([
    '# H', '', '## Next action', 'NEXT', '``` lang`x', '## Follow-ups', 'DROPPED-AFTER-INFO', '', '## Traps', 'TRAP-KEPT', '',
  ].join('\n'));
  assert.doesNotMatch(out, /DROPPED-AFTER-INFO/);
  assert.doesNotMatch(out, /## Follow-ups/);
  assert.match(out, /## Traps\nTRAP-KEPT/);
});

test('fences: a tilde fence may carry a backtick in its info string', () => {
  const out = freshResume([
    '# H', '', '## Next action', 'NEXT', '~~~ lang`x', '## Follow-ups', 'FENCED-KEPT', '~~~', '', '## Follow-ups', 'DROPPED', '',
  ].join('\n'));
  assert.match(out, /~~~ lang`x\n## Follow-ups\nFENCED-KEPT\n~~~/);
  assert.doesNotMatch(out, /DROPPED/);
});

for (const indent of [1, 2, 3]) {
  test(`fences: a fence indented by ${indent} space(s) still hides a "## " line`, () => {
    const pad = ' '.repeat(indent);
    const out = freshResume([
      '# H', '', '## Next action', 'NEXT', `${pad}\`\`\``, '## Follow-ups', 'FENCED-KEPT', `${pad}\`\`\``,
      '', '## Follow-ups', 'DROPPED', '', '## Traps', 'TRAP-KEPT', '',
    ].join('\n'));
    assert.match(out, /## Follow-ups\nFENCED-KEPT/);
    assert.doesNotMatch(out, /DROPPED/);
    assert.match(out, /## Traps\nTRAP-KEPT/);
  });
}

test('fences: a run indented by four spaces is not a fence', () => {
  const out = freshResume([
    '# H', '', '## Next action', 'NEXT', '    ```', '## Follow-ups', 'DROPPED-AFTER-INDENT', '    ```', '', '## Traps', 'TRAP-KEPT', '',
  ].join('\n'));
  assert.doesNotMatch(out, /DROPPED-AFTER-INDENT/);
  assert.match(out, /## Traps\nTRAP-KEPT/);
});

test('fences: a fence that is never closed runs to the end of the text', () => {
  const out = freshResume([
    '# H', '', '## Next action', 'NEXT', '```', '## Follow-ups', 'UNCLOSED-KEPT', '``` not-a-closer', '## Open questions x', 'ALSO-KEPT', '',
  ].join('\n'));
  assert.match(out, /```\n## Follow-ups\nUNCLOSED-KEPT\n``` not-a-closer\n## Open questions x\nALSO-KEPT$/);
});

// --- Amendment 3: cutting the reduced handover ---

const LIMIT = 4000;
const HEAD = '# Handover: cut\n\n## Next action\n';

// `len` characters of filler lines, ending with a newline.
function filler(len) {
  let s = '';
  let i = 0;
  while (s.length < len) {
    const room = len - s.length;
    const width = Math.min(room, 50);
    s += width === 1 ? '\n' : `${String(i++ % 10).repeat(width - 1)}\n`;
  }
  return s;
}

// A handover that reduces to itself, with `block` starting at offset `at`.
function handoverWith(at, block, tail = filler(600).trimEnd()) {
  return HEAD + filler(at - HEAD.length) + block + tail;
}

// Splits the reduced handover into the kept text and the note, which must stand on its own line.
function splitCut(out) {
  const i = out.lastIndexOf('\n');
  assert.ok(i > 0, 'the note follows on its own line');
  return { body: out.slice(0, i).trimEnd(), note: out.slice(i + 1) };
}

function assertCut(text, expectedEnd) {
  assert.ok(text.length > LIMIT);
  const { body, note } = splitCut(freshResume(text));
  assert.ok(note.trim() !== '' && !text.includes(note), 'a note is added');
  assert.ok(body.length <= LIMIT, `cut at or before ${LIMIT}: ${body.length}`);
  assert.ok(text.startsWith(body));
  assert.equal(body.length, text.slice(0, expectedEnd).trimEnd().length);
}

const inner = (ch = 'c') => filler(250).replace(/\d/g, ch);

test('cut: a limit inside a fenced code block moves the cut before the opening line', () => {
  const at = 3900;
  assertCut(handoverWith(at, '```js\n' + inner() + '```\n'), at);
});

for (const indent of [1, 2, 3]) {
  test(`cut: a fence indented by ${indent} space(s) also moves the cut`, () => {
    const pad = ' '.repeat(indent);
    const at = 3900;
    assertCut(handoverWith(at, `${pad}~~~\n` + inner() + `${pad}~~~\n`), at);
  });
}

test('cut: an unclosed fence runs to the end, so the cut moves before its opening line', () => {
  const at = 3900;
  assertCut(handoverWith(at, '```\n' + inner() + '``` not-a-closer\n', ''), at);
});

test('cut: a shorter run does not close a longer fence', () => {
  const at = 3800;
  assertCut(handoverWith(at, '~~~~\n' + filler(100) + '~~~\n' + inner() + '~~~~\n'), at);
});

test('cut: a backtick run with a backtick in its info string opens no fence', () => {
  // Read as a fence, the "``` a`b" line would pair with the real opener below and end it.
  const at = 3950;
  const text = HEAD + filler(3850 - HEAD.length) + '``` a`b\n' + filler(at - 3850 - 8) + '```\n' + inner() + '```\n' + filler(300).trimEnd();
  assertCut(text, at);
});

test('cut: a run indented by four spaces opens no fence', () => {
  const at = 3950;
  const text = HEAD + filler(3850 - HEAD.length) + '    ```\n' + filler(at - 3850 - 8) + '```\n' + inner() + '```\n' + filler(300).trimEnd();
  assertCut(text, at);
});

test('cut: a fence that closes before the limit leaves the cut at the limit', () => {
  const at = 3700;
  const text = handoverWith(at, '```\n' + filler(100) + '```\n', filler(800).trimEnd());
  assertCut(text, LIMIT);
});

test('cut: an emoji across the limit is never split', () => {
  // The emoji's high surrogate is the 4000th character, its low surrogate the 4001st.
  const text = HEAD + filler(LIMIT - 2 - HEAD.length) + 'b\u{1F600}' + filler(300).trimEnd();
  assert.equal(text.charCodeAt(LIMIT - 1), 0xd83d);
  const out = freshResume(text);
  assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate');
  const { body } = splitCut(out);
  assert.ok(body.endsWith('b'), JSON.stringify(body.slice(-5)));
  assertCut(text, LIMIT - 1);
});

// --- Amendment 5: the finished-plan test, by modification time ---

test('a finished plan is never named, even when its mtime is the newest; the newest open plan wins', () => {
  const { repo, env } = sandbox();
  const plans = path.join(repo, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const now = Date.now() / 1000;
  // Name order disagrees with mtime order, so only the modification time can pick the winner.
  const files = [
    ['a-older-open.md', 'in-progress', now - 3000],
    ['z-newer-open.md', 'approved', now - 2000],
    ['m-done.md', 'done', now - 1000],
    ['n-abandoned.md', 'abandoned', now],
  ];
  for (const [name, status, t] of files) {
    const p = path.join(plans, name);
    fs.writeFileSync(p, `---\nstatus: ${status}\n---\n# Plan\n`);
    fs.utimesSync(p, t, t);
  }
  const r = runHook(env, { source: 'resume', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r.stdout);
  assert.ok(ctx.includes(`re-read the plan ${path.join(plans, 'z-newer-open.md')};`), ctx);
  for (const name of ['a-older-open.md', 'm-done.md', 'n-abandoned.md']) assert.ok(!ctx.includes(name), name);
});

// --- Amendment 5: another user's marker, at hook level ---

const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test('a marker owned by another user is not honoured and is left in place', { skip: !AS_ROOT && 'needs root to chown the marker' }, () => {
  const { repo, env, marker } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), '# H\n\n## Next action\nNEXT\n');
  armMarker(marker);
  fs.chownSync(marker, 1, 1);
  const r = runHook(env, { source: 'clear', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(context(r.stdout), /Continuing from/);
  assert.ok(fs.existsSync(marker), 'another user\'s marker is not deleted');
});

// --- Amendment 2: single link, at hook level ---

test('amendment 2: a marker with a second hard link is not honoured', { skip: process.platform === 'win32' && 'POSIX link counts' }, () => {
  const { dir, repo, env, marker } = sandbox();
  fs.writeFileSync(path.join(repo, 'HANDOVER.md'), '# H\n\n## Next action\nNEXT\n');
  armMarker(marker);
  fs.linkSync(marker, path.join(dir, 'second-link'));
  const r = runHook(env, { source: 'clear', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r.stdout);
  assert.doesNotMatch(ctx, /Continuing from/);
  assert.match(ctx, /\/pickup/, 'falls back to startup behaviour');
});
