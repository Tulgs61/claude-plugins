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

// The two tests that pinned the rev 5 skill wording (cd before arming, string comparison of roots)
// were removed: spec rev 7 replaces that amendment. See fresh-marker-rev7.test.js.
