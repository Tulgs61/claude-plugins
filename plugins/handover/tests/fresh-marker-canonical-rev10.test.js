'use strict';
// Spec rev 10, amendment 7 (canonical spelling). The resolved root is the operating system's canonical
// spelling, so on a case-insensitive volume a wrong letter case in PWD or cwd still finds the marker.
// Outcomes are judged by running the hook. Skipped where the temp volume is case-sensitive.
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-canonical-rev10-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

// The temp volume is case-insensitive when a directory is reachable under a different letter case.
fs.mkdirSync(path.join(base, 'Probe'));
const CASE_INSENSITIVE = fs.existsSync(path.join(base, 'pROBE'));
const OPTS = {
  skip: (process.platform === 'win32' && 'needs /bin/sh') ||
    (!CASE_INSENSITIVE && 'the temp volume is case-sensitive'),
};

const HANDOVER = '# Handover: canonical\n\n## Next action\nRUN-THE-NEXT-STEP\n\n## Traps\nnone\n';

let n = 0;
// A repository whose on-disk spelling is <dir>/Repo; `wrong` names it with another letter case.
function sandbox() {
  const dir = path.join(base, `case-${++n}`);
  const tmp = path.join(dir, 'tmp');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(dir, 'Repo', '.git'), { recursive: true });
  for (const d of [tmp, home]) fs.mkdirSync(d, { recursive: true });
  const onDisk = path.join(fs.realpathSync.native(dir), 'Repo');
  fs.writeFileSync(path.join(onDisk, 'HANDOVER.md'), HANDOVER);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PWD;
  return { onDisk, wrong: path.join(path.dirname(onDisk), 'rEPO'), tmp, env };
}

function hook(env, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'clear', cwd }), env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('amendment 7: resolvedRoot corrects the letter case to the on-disk spelling', OPTS, () => {
  const { onDisk, wrong } = sandbox();
  assert.equal(resolvedRoot(wrong), onDisk);
});

test('amendment 7: a bare arm from a shell whose PWD has the wrong letter case is resumed through the on-disk cwd', OPTS, () => {
  const { onDisk, wrong, tmp, env } = sandbox();
  const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && exec "$0" "$2"', process.execPath, wrong, ARM], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(hook(env, onDisk), /Continuing from [^\n]*\n[\s\S]*RUN-THE-NEXT-STEP/);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the marker is used up');
  for (const cwd of [onDisk, wrong]) assert.doesNotMatch(hook(env, cwd), /Continuing from/, cwd);
});

test('amendment 7: a marker under the on-disk spelling is resumed through a cwd with the wrong letter case', OPTS, () => {
  const { onDisk, wrong, tmp, env } = sandbox();
  const p = path.join(tmp, path.basename(markerPath(onDisk)));
  fs.writeFileSync(p, JSON.stringify({ createdAt: Date.now() }), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  assert.match(hook(env, wrong), /Continuing from /);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the marker is used up');
});
