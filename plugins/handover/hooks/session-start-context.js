#!/usr/bin/env node
'use strict';
// SessionStart hook for the handover plugin.
//
// - clear + trusted, fresh /fresh marker + HANDOVER.md: inject the handover essentials once. The
//   marker is looked up under the lexical root and, failing that, under the root with symlinks
//   resolved. Honouring it also removes a trusted marker under the other of these two spellings.
// - compact / resume: remind to re-read the active plan and task ledger.
// - every source but compact (and not after a fresh resume): hint at /pickup when HANDOVER.md exists.
//
// Fail-open: on bad input or any internal error (a missing module, a closed stdout) it exits 0 and
// prints nothing. Built-in modules only, no child processes.

// Last-resort guard, installed before anything that can fail: swallow the error and keep exit 0.
process.on('uncaughtException', () => {
  process.exitCode = 0;
});

const fs = require('node:fs');
const path = require('node:path');

let fm = null;
try {
  fm = require(path.join(__dirname, '..', 'scripts', 'fresh-marker.js'));
} catch {
  // handled in main(): no module, no output
}

const HANDOVER_FILE = 'HANDOVER.md';
const MAX_HANDOVER_CHARS = 4000;
const MAX_MARKER_BYTES = 64 * 1024;
const KEPT_SECTIONS = ['Next action', 'Open questions', 'Threads', 'Traps'];
const FINISHED_STATUSES = new Set(['done', 'abandoned']);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Opens the marker without following symlinks or blocking, checks trust on the opened file, reads it,
// and deletes it when the current user owns it. Returns the parsed object when trusted, else null.
function consumeMarker(root) {
  const p = fm.markerPath(root);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let flags = O_RDONLY;
  if (typeof O_NOFOLLOW === 'number') flags |= O_NOFOLLOW;
  if (typeof O_NONBLOCK === 'number') flags |= O_NONBLOCK;

  if (typeof O_NOFOLLOW !== 'number') {
    // No O_NOFOLLOW (win32): refuse anything but a regular file before opening.
    try {
      if (!fs.lstatSync(p).isFile()) return null;
    } catch {
      return null;
    }
  }

  let fd;
  try {
    fd = fs.openSync(p, flags);
  } catch {
    return null;
  }

  let stat;
  let text = null;
  try {
    stat = fs.fstatSync(fd);
    if (fm.markerTrusted(stat)) {
      const size = Math.min(stat.size, MAX_MARKER_BYTES);
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const n = fs.readSync(fd, buf, off, size - off, off);
        if (n <= 0) break;
        off += n;
      }
      text = buf.subarray(0, off).toString('utf8');
    }
  } catch {
    text = null;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  // Delete a marker the current user owns, honoured or not, but only if the path still names the
  // file that was opened.
  if (stat && stat.isFile()) {
    const uid = fm.currentUid();
    if (uid === null || stat.uid === uid) {
      try {
        const now = fs.lstatSync(p);
        if (now.isFile() && now.ino === stat.ino && now.dev === stat.dev) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

// Fenced code blocks among `lines`, as [first, last] line indexes (inclusive). A fence opens with three
// or more backticks or tildes after at most three spaces (a backtick fence's info string may not
// contain a backtick) and closes with a bare run of the same character at least as long. A fence that
// is never closed runs to the last line.
function fencedBlocks(lines) {
  const blocks = [];
  let fence = null; // opening fence run (e.g. "```" or "~~~~") while inside a code block
  let start = -1;
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') {
        blocks.push([start, i]);
        fence = null;
      }
    } else if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      start = i;
    }
  });
  if (fence) blocks.push([start, lines.length - 1]);
  return blocks;
}

// Joins `lines` and cuts the text at or before MAX_HANDOVER_CHARS, never inside a surrogate pair or one
// of the fenced code `blocks` (the cut then moves to just before the fence's opening line), and adds
// the note on its own line.
function truncate(lines, blocks) {
  const text = lines.join('\n');
  if (text.length <= MAX_HANDOVER_CHARS) return text;
  let cut = MAX_HANDOVER_CHARS;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  const offsets = [];
  let off = 0;
  for (const line of lines) {
    offsets.push(off);
    off += line.length + 1;
  }
  for (const [first, last] of blocks) {
    const begin = offsets[first];
    const end = offsets[last] + lines[last].length;
    if (begin < cut && cut < end) {
      cut = begin;
      break;
    }
  }
  return text.slice(0, cut).trimEnd() +
    `\n\n[Truncated at ${MAX_HANDOVER_CHARS} characters; read the full file for the rest.]`;
}

// Preamble plus the kept `## ` sections, capped at MAX_HANDOVER_CHARS. Fenced code blocks are found
// once, before any trimming, and serve both heading detection (a `## ` line inside one is content, not
// a heading) and the cut. Trimming works on whole lines, so it never re-indents one into a fence.
function reduceHandover(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blockOf = new Array(lines.length).fill(-1);
  fencedBlocks(lines).forEach(([first, last], b) => {
    for (let i = first; i <= last; i++) blockOf[i] = b;
  });
  const out = []; // [line, block index or -1]
  let keep = true; // preamble
  lines.forEach((line, i) => {
    if (blockOf[i] === -1 && /^## /.test(line)) {
      const title = line.slice(3).trim();
      keep = KEPT_SECTIONS.some(s => title.startsWith(s));
    }
    // Runs of empty lines collapse to one.
    if (keep && !(line === '' && out.length && out[out.length - 1][0] === '')) out.push([line, blockOf[i]]);
  });
  // Blank lines at either end go, and so does trailing whitespace on the last line.
  const blank = ([line]) => line.trim() === '';
  while (out.length && blank(out[0])) out.shift();
  while (out.length && blank(out[out.length - 1])) out.pop();
  if (out.length) out[out.length - 1][0] = out[out.length - 1][0].trimEnd();

  const kept = new Map(); // block index -> [first, last] in `out`
  out.forEach(([, b], i) => {
    if (b === -1) return;
    if (kept.has(b)) kept.get(b)[1] = i;
    else kept.set(b, [i, i]);
  });
  return truncate(out.map(([line]) => line), [...kept.values()]);
}

function frontMatterStatus(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = head.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = /^status\s*:\s*(.*)$/i.exec(lines[i]);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  }
  return null;
}

// Newest regular file in `dir` that passes `accept`, or null.
function newest(dir, accept) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  let bestTime = -Infinity;
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile() || !accept(name, full)) continue;
    if (st.mtimeMs > bestTime) {
      best = full;
      bestTime = st.mtimeMs;
    }
  }
  return best;
}

function findOpenPlan(root) {
  const plan = newest(path.join(root, 'docs', 'plans'), (name, full) =>
    name.toLowerCase().endsWith('.md') &&
    name.toLowerCase() !== 'readme.md' &&
    !FINISHED_STATUSES.has(frontMatterStatus(full)));
  if (plan) return plan;
  return newest(path.join(root, '.planning'), name => name.endsWith('-plan.md'));
}

function findNewestLedger(root) {
  return newest(path.join(root, '.claude', 'runs'), name => name.toLowerCase().endsWith('.json'));
}

function reminderLine(root) {
  const plan = findOpenPlan(root);
  const ledger = findNewestLedger(root);
  if (!plan && !ledger) return null;
  let line = 'Before continuing:';
  if (plan) line += ` re-read the plan ${plan};`;
  if (ledger) line += ` read the task ledger ${ledger};`;
  return line + ' work from these files, not from memory of the earlier context.';
}

function freshContext(handover, text) {
  return [
    `Context was cleared with /fresh. Continuing from ${handover}.`,
    'Before carrying out the next action, check the repository state recorded in the handover ' +
      '(branch, commit, working tree, PRs) against reality and report any mismatch. ' +
      'Then carry out the next action below.',
    '',
    reduceHandover(text),
  ].join('\n');
}

// The root as found lexically, then the same root with symlinks resolved (in the operating system's
// canonical spelling) when that is spelled differently, so a marker armed under either is found.
function rootSpellings(root) {
  const roots = [root];
  const real = fm.resolvedRoot(root);
  if (fm.markerPath(real) !== fm.markerPath(root)) roots.push(real);
  return roots;
}

// Removes the marker of `root` when it passes the trust check, without following symlinks and only
// if the path still names the file that was checked.
function removeTrustedMarker(root) {
  const p = fm.markerPath(root);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (typeof O_NOFOLLOW !== 'number') {
    try {
      const st = fs.lstatSync(p);
      if (fm.markerTrusted(st)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
    return;
  }
  let flags = O_RDONLY | O_NOFOLLOW;
  if (typeof O_NONBLOCK === 'number') flags |= O_NONBLOCK;
  let stat;
  try {
    const fd = fs.openSync(p, flags);
    try {
      stat = fs.fstatSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!fm.markerTrusted(stat)) return;
    const now = fs.lstatSync(p);
    if (now.isFile() && now.ino === stat.ino && now.dev === stat.dev) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

// The first trusted, fresh marker among the root's two candidate spellings, or null. The winner is
// consumed, and the marker at the other candidate path is removed too when it passes the same trust
// check, so it works only once whatever the spelling. A `roots` key in the marker is ignored.
function findFreshMarker(root) {
  const spellings = rootSpellings(root);
  for (const r of spellings) {
    const marker = consumeMarker(r);
    if (!marker || !fm.markerFresh(marker.createdAt)) continue;
    for (const other of spellings) {
      if (other !== r) removeTrustedMarker(other);
    }
    return marker;
  }
  return null;
}

function buildContext(input) {
  const source = typeof input.source === 'string' && input.source ? input.source : 'startup';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = fm.findRoot(cwd);
  const handover = path.join(root, HANDOVER_FILE);

  if (source === 'clear') {
    const marker = findFreshMarker(root);
    if (marker && isFile(handover)) {
      const text = fs.readFileSync(handover, 'utf8');
      return freshContext(handover, text);
    }
  }

  const parts = [];
  if (source === 'compact' || source === 'resume') {
    const line = reminderLine(root);
    if (line) parts.push(line);
  }
  if (source !== 'compact' && isFile(handover)) {
    parts.push(`${handover} exists. Run /pickup (the handover:pickup skill) to continue from it.`);
  }
  return parts.length ? parts.join('\n') : null;
}

function main() {
  if (!fm) return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const ctx = buildContext(input);
  if (!ctx) return;
  // A closed stdout reports EPIPE/EBADF asynchronously; ignore it instead of crashing.
  process.stdout.on('error', () => {});
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
}

try {
  main();
} catch {
  // fail-open
}
process.exitCode = 0;
