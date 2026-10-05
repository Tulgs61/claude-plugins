#!/usr/bin/env node
'use strict';
// One-shot marker for the /fresh skill.
//
// As a command, `node fresh-marker.js [dir]` arms the marker for the repository containing `dir`
// (default: the process working directory; the fresh skill passes no argument, and the marker is then
// armed under the root with symlinks resolved). As a module, it gives the SessionStart hook the
// helpers it needs to locate and judge a marker. Built-in modules only, no child processes.
//
// The marker lives in os.tmpdir(), which other local users may be able to write to, so it is written
// atomically with mode 0600 and the reader treats it as untrusted input.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const IS_WIN = process.platform === 'win32';

// Lexical normalisation: absolute, no trailing separator, symlinks left alone.
function normalizeRoot(root) {
  let p = path.resolve(String(root));
  if (IS_WIN) p = p.toLowerCase();
  return p;
}

function markerName(root) {
  const hash = crypto.createHash('sha256').update(normalizeRoot(root)).digest('hex').slice(0, 16);
  return `claude-fresh-${hash}.json`;
}

function markerPath(root) {
  return path.join(os.tmpdir(), markerName(root));
}

function findRoot(dir) {
  const start = path.resolve(String(dir));
  let d = start;
  for (;;) {
    try {
      fs.lstatSync(path.join(d, '.git'));
      return d;
    } catch {
      // keep walking up
    }
    const up = path.dirname(d);
    if (up === d) return start;
    d = up;
  }
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

// An omitted or undefined uid means the current user; only an explicit null disables the checks.
function markerTrusted(stat, uid) {
  if (uid === undefined) uid = currentUid();
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) return false;
  if (uid === null) return true;
  if (stat.uid !== uid) return false;
  return (Number(stat.mode) & 0o022) === 0;
}

function markerFresh(createdAt, now = Date.now()) {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false;
  if (typeof now !== 'number' || !Number.isFinite(now)) return false;
  const age = now - createdAt;
  return age >= 0 && age < MARKER_MAX_AGE_MS;
}

// Writes `body` under a random name in the same directory, then renames it over `target`.
// rename() replaces a symlink at the target instead of following it.
function writeMarkerFile(target, body) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    if (!IS_WIN) fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, body);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// Arms the marker for `root`. With `aliases` (other spellings of the same root), the same marker is
// also armed under each alias, and every copy lists all spellings in `roots`, so the hook can use up
// all of them when it honours one. Returns the marker path for `root`.
function armMarker(root, now = Date.now(), aliases = []) {
  const target = markerPath(root);
  const others = aliases.filter(a => markerPath(a) !== target);
  const data = { createdAt: now };
  if (others.length) data.roots = [root, ...others];
  const body = JSON.stringify(data) + '\n';
  writeMarkerFile(target, body);
  for (const a of others) writeMarkerFile(markerPath(a), body);
  return target;
}

// The root with symlinks resolved, or the root itself when it cannot be resolved.
function resolvedRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

// The process working directory, spelled as the shell knows it: $PWD when it names the same directory
// as process.cwd() (which has symlinks resolved), so the root matches the hook's lexical findRoot().
function workingDir() {
  const cwd = process.cwd();
  const pwd = process.env.PWD;
  if (pwd && path.isAbsolute(pwd) && pwd !== cwd) {
    try {
      const a = fs.statSync(pwd);
      const b = fs.statSync(cwd);
      if (a.dev === b.dev && a.ino === b.ino) return pwd;
    } catch {
      // fall back to process.cwd()
    }
  }
  return cwd;
}

function main(argv) {
  const dir = path.resolve(argv[0] || workingDir());
  let st;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    process.stderr.write(`fresh-marker: cannot access ${dir}: ${err.message}\n`);
    return 1;
  }
  if (!st.isDirectory()) {
    process.stderr.write(`fresh-marker: not a directory: ${dir}\n`);
    return 1;
  }
  const root = findRoot(dir);
  try {
    // Without an argument the marker is armed under the root with symlinks resolved, whatever
    // spelling the working directory has; the shell's spelling gets the same marker as an alias.
    const target = argv[0] ? armMarker(root) : armMarker(resolvedRoot(root), Date.now(), [root]);
    process.stdout.write(`fresh marker armed for ${root} (${target})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`fresh-marker: could not arm the marker for ${root}: ${err.message}\n`);
    return 1;
  }
}

module.exports = {
  MARKER_MAX_AGE_MS,
  markerPath,
  markerName,
  findRoot,
  markerTrusted,
  markerFresh,
  armMarker,
  resolvedRoot,
  currentUid,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
