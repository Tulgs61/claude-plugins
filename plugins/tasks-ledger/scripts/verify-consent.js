#!/usr/bin/env node
// Consent store for verify-gate. The gate only runs a project's .claude/verify.cmd after that exact
// command was approved for that repository, and only a person at a terminal (or a change to the store
// itself) can approve it. The gate never records consent.
//   approve <dir>  shows <dir>/.claude/verify.cmd (invisible characters escaped, with its line count and
//                  hash) on stdout and on the controlling terminal (/dev/tty, never stdin), then asks there;
//                  only the answer `yes` records it. Without a terminal: nothing on stdout, exit 2,
//                  `needs a terminal` on stderr.
//   revoke <dir>   removes every entry for the repository of <dir>.
// approve and revoke never replace an existing store they cannot use; they exit 2 and say why.
//   list           prints one line per entry: repository identity, then the first 12 hex digits of the hash.
// The store is $CLAUDE_PLUGIN_DATA/verify-consent.json, or <config>/tasks-ledger/verify-consent.json where
// <config> is $CLAUDE_CONFIG_DIR or ~/.claude. An entry is (repository identity, sha256 of the command).
// verify-gate loads this file as a module for the store rules. The answer can only be supplied through
// the `terminal` (or `ask`) option of approve(), reachable solely by code that loads this file as a module.
// git is never started by bare name or from the repository (see findProgram).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STORE_NAME = 'verify-consent.json';
const VERIFY_REL = path.join('.claude', 'verify.cmd');
const POSIX = process.platform !== 'win32';
const NOFOLLOW = (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const GIT_TIMEOUT_MS = 10 * 1000;
const PROMPT = 'Run this command after Claude edits files here? [yes/N] ';
const USAGE =
  'usage: verify-consent.js approve <dir>   approve <dir>/.claude/verify.cmd (asks on the terminal)\n' +
  '       verify-consent.js revoke <dir>    remove every approval for the repository of <dir>\n' +
  '       verify-consent.js list            list the approvals\n';

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

// Environment variables only choose where the store is. Returns the store file and the environment
// assignment that chose it: { file, name, value } with name CLAUDE_PLUGIN_DATA or CLAUDE_CONFIG_DIR and
// its resolved value, or name null for the ~/.claude default.
function storeSelection(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) {
    const value = path.resolve(env.CLAUDE_PLUGIN_DATA);
    return { file: path.join(value, STORE_NAME), name: 'CLAUDE_PLUGIN_DATA', value };
  }
  if (env.CLAUDE_CONFIG_DIR) {
    const value = path.resolve(env.CLAUDE_CONFIG_DIR);
    return { file: path.join(value, 'tasks-ledger', STORE_NAME), name: 'CLAUDE_CONFIG_DIR', value };
  }
  return { file: path.join(os.homedir(), '.claude', 'tasks-ledger', STORE_NAME), name: null, value: null };
}

function storeFile(env = process.env) {
  return storeSelection(env).file;
}

function validEntry(e) {
  return e && typeof e === 'object' && typeof e.repo === 'string' && e.repo !== '' &&
    typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256);
}

// The store's entries as { entries }, or { problem } saying why an existing store cannot be used. It is
// used only when it is a regular file owned by the current user (POSIX); a missing store has no entries.
function loadStore(file) {
  let before;
  try {
    before = fs.lstatSync(file);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { entries: [] };
    return { problem: `it cannot be inspected (${e && e.code ? e.code : e})` };
  }
  if (before.isSymbolicLink()) return { problem: 'it is a symbolic link' };
  if (!before.isFile()) return { problem: 'it is not a regular file' };
  if (POSIX && before.uid !== currentUid()) return { problem: 'it is owned by another user' };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    return { problem: `it cannot be opened (${e && e.code ? e.code : e})` };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      return { problem: 'it was replaced while it was read' };
    }
    if (POSIX && opened.uid !== currentUid()) return { problem: 'it is owned by another user' };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      return { problem: 'it cannot be parsed' };
    }
    if (!data || !Array.isArray(data.entries)) return { problem: 'it has no list of entries' };
    return { entries: data.entries.filter(validEntry) };
  } catch (e) {
    return { problem: `it cannot be read (${e && e.code ? e.code : e})` };
  } finally {
    fs.closeSync(fd);
  }
}

// The store's entries for the gate and list: an unusable store (a symbolic link, another user's file,
// not a regular file, unparsable) gives no entries, like a missing one.
function readStore(file) {
  return loadStore(file).entries || [];
}

// Atomic: a new file in the same directory, created exclusively with a random suffix and without
// following links, renamed over the store. Missing directories are created with mode 0700.
function writeStore(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data = { entries: entries.map(e => ({ repo: e.repo, sha256: e.sha256 })) };
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  let done = false;
  try {
    try {
      fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    done = true;
  } finally {
    if (!done) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Already gone.
      }
    }
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The nearest directory at or above `dir` that contains a .git entry (directory or file), or null.
function findGitRoot(dir) {
  for (;;) {
    try {
      fs.lstatSync(path.join(dir, '.git'));
      return dir;
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The main working tree of the linked worktree at `root` (the directory that contains the common git
// directory), or null when `root` is not a linked worktree. Read from the files git keeps, without
// running git: `<root>/.git` is a `gitdir:` file naming the worktree's git directory, whose `commondir`
// file names the common git directory relative to it.
function mainWorkTree(root) {
  // Only regular files are read, so a FIFO or device planted in the repository never blocks.
  const readRegular = file => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : '';
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readRegular(path.join(root, '.git')));
    if (!m) return null;
    const gitdir = path.resolve(root, m[1]);
    const rel = readRegular(path.join(gitdir, 'commondir')).trim();
    return rel ? path.dirname(path.resolve(gitdir, rel)) : null;
  } catch {
    // Not a linked worktree (or its git directory is gone).
    return null;
  }
}

// The directories a program must never be taken from when working on `dir`: `dir` itself, its
// repository root and, for a linked worktree, the main working tree, each as given and as its real path.
function untrustedDirs(dir) {
  const base = path.resolve(dir);
  const dirs = [base, realPath(base)];
  const root = findGitRoot(base);
  if (root !== null) {
    dirs.push(root, realPath(root));
    const main = mainWorkTree(root);
    if (main !== null) dirs.push(main, realPath(main));
  }
  return dirs;
}

// `p` is inside `dir` when its path relative to `dir` is empty, or is not absolute and its first segment
// is not exactly `..` (so `<dir>/..bin` is inside).
function isWithin(p, dir) {
  const rel = path.relative(dir, p);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
}

// The absolute path of the program `name`, searched on PATH while skipping empty and relative entries and
// every entry at or inside one of `exclude` (the repository's own directories), or null. A program is
// never started by bare name, so neither PATH nor the working directory can pick one from the repository.
function findProgram(name, exclude = [], env = process.env) {
  const key = POSIX ? 'PATH' : Object.keys(env).find(k => k.toUpperCase() === 'PATH');
  const entries = (key && env[key] ? env[key] : '').split(path.delimiter);
  const exts = POSIX ? [''] : ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)];
  const inside = p => exclude.some(d => isWithin(p, d) || isWithin(realPath(p), d));
  for (const entry of entries) {
    if (entry === '' || !path.isAbsolute(entry) || inside(entry)) continue;
    for (const ext of exts) {
      const candidate = path.join(entry, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      if (!inside(candidate)) return candidate;
    }
  }
  return null;
}

// The content of `file` when it is a regular file (never following a symbolic link, never blocking on a
// FIFO or device), or null.
function readRegularFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Whether the common git directory `common` really belongs to the checkout whose top level is `top` (both
// real paths). A main checkout's common git directory is <top>/.git itself. For a linked worktree, whose
// <top>/.git is a file, the common git directory must hold a worktrees/<name>/gitdir back-reference that
// resolves to exactly <top>/.git: git writes it inside the main repository's own git directory, which the
// worktree's content cannot change. A .git file or commondir that points at a git directory that does not
// point back is not accepted.
function ownsGitDir(top, common) {
  const dotGit = path.join(top, '.git');
  let stat;
  try {
    stat = fs.lstatSync(dotGit);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return common === dotGit;
  if (!stat.isFile()) return false;
  const worktrees = path.join(common, 'worktrees');
  let names;
  try {
    names = fs.readdirSync(worktrees);
  } catch {
    return false;
  }
  return names.some(name => {
    const file = path.join(worktrees, name, 'gitdir');
    const content = readRegularFile(file);
    if (content === null) return false;
    const target = content.replace(/\r?\n$/, '');
    return target !== '' && realPath(path.resolve(path.dirname(file), target)) === dotGit;
  });
}

// The real path of the directory `git rev-parse --git-common-dir` reports in `dir` (the directory that
// contains .claude/), so a main checkout and its linked worktrees share one identity. It is accepted only
// when that git directory really belongs to this checkout (see ownsGitDir), and git's top level is the
// nearest directory with a .git entry. Otherwise, outside a repository, or when git fails or cannot be
// found, the identity is the real path of `dir`, so no approval of another repository applies. GIT_*
// variables are dropped so that only the directory decides. git is started by absolute path from the temp
// directory and gets the repository through `-C`.
function repoIdentity(dir) {
  const own = realPath(dir);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  try {
    const git = findProgram('git', untrustedDirs(dir));
    if (git === null) return own;
    const r = spawnSync(git, ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
      cwd: os.tmpdir(), env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const lines = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    if (lines.length !== 2 || !lines[0] || !lines[1]) return own;
    const top = realPath(path.resolve(dir, lines[0]));
    const common = realPath(path.resolve(dir, lines[1]));
    if (findGitRoot(own) !== top || !isWithin(own, top)) return own;
    if (ownsGitDir(top, common)) return common;
  } catch {
    // Fall back to the directory itself.
  }
  return own;
}

// The sha256 hex of exactly the bytes passed to bash.
function commandHash(command) {
  return crypto.createHash('sha256').update(Buffer.from(command, 'utf8')).digest('hex');
}

function isApproved(dir, command, env = process.env) {
  const repo = repoIdentity(dir);
  const sha256 = commandHash(command);
  return readStore(storeFile(env)).some(e => e.repo === repo && e.sha256 === sha256);
}

// The same trust rules as verify-gate: a regular file, on POSIX owned by the current user and not
// writable by group or others; the opened descriptor must be the inspected file.
function isTrusted(stat) {
  if (!stat.isFile()) return false;
  if (!POSIX) return true;
  return stat.uid === currentUid() && (stat.mode & 0o022) === 0;
}

// The trimmed command of <dir>/.claude/verify.cmd, or null when the file is missing or not trusted.
function readCheck(dir) {
  const file = path.join(dir, VERIFY_REL);
  let before;
  try {
    before = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!isTrusted(before)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !isTrusted(opened)) return null;
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

// The controlling terminal as { write(text), ask(prompt), close() }, or null when there is none (opening
// /dev/tty fails). Writes are synchronous; ask returns the answer line.
function openTerminal() {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
  } catch {
    return null;
  }
  const write = text => {
    const bytes = Buffer.from(text, 'utf8');
    for (let off = 0; off < bytes.length;) off += fs.writeSync(fd, bytes, off);
  };
  return {
    write,
    ask(prompt) {
      write(prompt);
      const bytes = [];
      const one = Buffer.alloc(1);
      for (;;) {
        let n;
        try {
          n = fs.readSync(fd, one, 0, 1, null);
        } catch {
          break;
        }
        if (n === 0 || one[0] === 0x0a) break;
        bytes.push(one[0]);
      }
      return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

// Escapes every character `pattern` matches as \x1b or \u202e (\u{...} beyond the BMP).
function escapeMatches(text, pattern) {
  return text.replace(pattern, ch => {
    const cp = ch.codePointAt(0);
    if (cp < 0x100) return `\\x${cp.toString(16).padStart(2, '0')}`;
    if (cp < 0x10000) return `\\u${cp.toString(16).padStart(4, '0')}`;
    return `\\u{${cp.toString(16)}}`;
  });
}

// A command line shown so that it cannot hide anything: every character outside printable ASCII and the
// space is escaped (escape sequences, carriage returns, backspaces, bidirectional controls, ...).
const visible = line => escapeMatches(line, /[^\x20-\x7e]/gu);
// A path shown with its control, format and line-separator characters escaped.
const shownPath = p => escapeMatches(p, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu);

// The store's entries, or null after naming the store and why it was not used: an existing store that
// cannot be used is never replaced, so approvals are never discarded silently.
function usableEntries(store, err) {
  const loaded = loadStore(store);
  if (loaded.entries) return loaded.entries;
  err.write(`verify-consent: ${shownPath(store)} was not used because ${loaded.problem}; nothing was recorded. ` +
    'Fix or remove the file and try again.\n');
  return null;
}

const NEEDS_TERMINAL = 'verify-consent: approve needs a terminal; run it yourself in a terminal.\n';

// The answer comes only from the terminal that `terminal()` opens (by default the controlling terminal).
// The `ask` option is the older form of the same seam: a terminal that only asks, where null means none.
// The terminal is opened first: without one, approve writes nothing but `needs a terminal` on stderr.
function approve(dir, { ask, terminal, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const open = terminal || (ask ? () => ({ write() {}, ask, close() {} }) : openTerminal);
  const tty = open();
  if (!tty) {
    err.write(NEEDS_TERMINAL);
    return 2;
  }
  let answer;
  let sha256;
  const base = path.resolve(dir);
  const store = storeFile(env);
  try {
    const file = path.join(base, VERIFY_REL);
    if (usableEntries(store, err) === null) return 2;
    const command = readCheck(base);
    if (command === null) {
      err.write(`verify-consent: ${shownPath(file)} is missing, or not a regular file that only you can modify.\n`);
      return 2;
    }
    // Everything is written before the question: the file, every line of the command with invisible
    // characters escaped and a `| ` prefix, the line count and the start of the hash that is recorded. It
    // goes to stdout and, synchronously, to the terminal the answer is read from.
    sha256 = commandHash(command);
    const lines = command.split('\n');
    const display = `${shownPath(file)}\n${lines.map(line => `| ${visible(line)}`).join('\n')}\n` +
      `${lines.length} line${lines.length === 1 ? '' : 's'}, sha256 ${sha256.slice(0, 12)}\n`;
    out.write(display);
    tty.write(display);
    answer = tty.ask(PROMPT);
  } finally {
    tty.close();
  }
  if (answer === null || answer === undefined) {
    err.write(NEEDS_TERMINAL);
    return 2;
  }
  if (answer !== 'yes') {
    out.write('Not approved.\n');
    return 1;
  }
  const repo = repoIdentity(base);
  const entries = usableEntries(store, err);
  if (entries === null) return 2;
  if (!entries.some(e => e.repo === repo && e.sha256 === sha256)) writeStore(store, [...entries, { repo, sha256 }]);
  out.write(`Approved for ${shownPath(repo)}.\n`);
  return 0;
}

function revoke(dir, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const store = storeFile(env);
  const repo = repoIdentity(path.resolve(dir));
  const entries = usableEntries(store, err);
  if (entries === null) return 2;
  const kept = entries.filter(e => e.repo !== repo);
  if (kept.length !== entries.length) writeStore(store, kept);
  out.write(`Revoked ${entries.length - kept.length} approval(s) for ${shownPath(repo)}.\n`);
  return 0;
}

function list({ env = process.env, out = process.stdout } = {}) {
  for (const e of readStore(storeFile(env))) out.write(`${shownPath(e.repo)}\t${e.sha256.slice(0, 12)}\n`);
  return 0;
}

// The command line never supplies an answer: approve always asks on the terminal.
function main(args) {
  const [cmd, ...rest] = args;
  if (cmd === 'approve' && rest.length === 1) return approve(rest[0]);
  if (cmd === 'revoke' && rest.length === 1) return revoke(rest[0]);
  if (cmd === 'list' && rest.length === 0) return list();
  process.stderr.write(USAGE);
  return 2;
}

module.exports = {
  storeSelection, storeFile, readStore, shownPath, findProgram, untrustedDirs, repoIdentity, commandHash, isApproved, approve,
  revoke, list,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`verify-consent: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}
