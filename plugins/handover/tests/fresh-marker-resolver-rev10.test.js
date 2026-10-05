'use strict';
// Spec rev 10, amendment 7 (canonical spelling): the marker module's resolver falls back to the plain
// resolution when the canonical one is missing or throws, and to the input when neither resolves it.
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvedRoot } = require('../scripts/fresh-marker.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-resolver-rev10-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const original = fs.realpathSync;
afterEach(() => { fs.realpathSync = original; });

let n = 0;
// A directory reached through a symlink, so the plain realpath differs from the input.
function linked() {
  const dir = path.join(base, `case-${++n}`);
  const target = path.join(dir, 'target');
  const link = path.join(dir, 'link');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, link);
  return { link, real: original(link) };
}

// Replaces fs.realpathSync with a counting wrapper of the plain resolver and the given `native`.
function stub(native) {
  const calls = { plain: 0, native: 0 };
  const plain = p => { calls.plain++; return original(p); };
  if (native) plain.native = p => { calls.native++; return native(p); };
  fs.realpathSync = plain;
  return calls;
}

const SYMLINK = { skip: process.platform === 'win32' && 'symlinks need privileges on win32' };

test('amendment 7: without a canonical resolver the plain realpath is returned', SYMLINK, () => {
  const { link, real } = linked();
  const calls = stub(null);
  assert.equal(resolvedRoot(link), real);
  assert.equal(calls.plain, 1);
});

test('amendment 7: when the canonical resolver throws the plain realpath is returned', SYMLINK, () => {
  const { link, real } = linked();
  const calls = stub(() => { throw new Error('canonical resolver unavailable'); });
  assert.equal(resolvedRoot(link), real);
  assert.deepEqual(calls, { plain: 1, native: 1 });
});

test('amendment 7: when neither resolver can resolve the path the input is returned unchanged', () => {
  const missing = path.join(base, 'does-not-exist', 'repo');
  const calls = stub(() => { throw new Error('canonical resolver failed'); });
  assert.equal(resolvedRoot(missing), missing);
  assert.deepEqual(calls, { plain: 1, native: 1 });
  fs.realpathSync = original;
  // The same with the real resolvers in place.
  assert.equal(resolvedRoot(missing), missing);
});
