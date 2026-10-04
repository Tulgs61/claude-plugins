#!/usr/bin/env node
'use strict';
// SessionStart hook for the handover plugin.
//
// - clear + trusted, fresh /fresh marker + HANDOVER.md: inject the handover essentials once.
// - compact / resume: remind to re-read the active plan and task ledger.
// - every source but compact (and not after a fresh resume): hint at /pickup when HANDOVER.md exists.
//
// Fail-open: on bad input or any internal error it exits 0 and prints nothing.
// Built-in modules only, no child processes.

const fs = require('node:fs');
const path = require('node:path');
const { markerPath, findRoot, markerTrusted, markerFresh, currentUid } = require(
  path.join(__dirname, '..', 'scripts', 'fresh-marker.js'),
);

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
  const p = markerPath(root);
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
    if (markerTrusted(stat)) {
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
    const uid = currentUid();
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

// Preamble plus the kept `## ` sections, capped at MAX_HANDOVER_CHARS.
function reduceHandover(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let keep = true; // preamble
  for (const line of lines) {
    if (/^## /.test(line)) {
      const title = line.slice(3).trim();
      keep = KEPT_SECTIONS.some(s => title.startsWith(s));
    }
    if (keep) out.push(line);
  }
  let reduced = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (reduced.length > MAX_HANDOVER_CHARS) {
    reduced = reduced.slice(0, MAX_HANDOVER_CHARS).trimEnd() +
      `\n\n[Truncated at ${MAX_HANDOVER_CHARS} characters; read the full file for the rest.]`;
  }
  return reduced;
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

function buildContext(input) {
  const source = typeof input.source === 'string' && input.source ? input.source : 'startup';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = findRoot(cwd);
  const handover = path.join(root, HANDOVER_FILE);

  if (source === 'clear') {
    const marker = consumeMarker(root);
    if (marker && markerFresh(marker.createdAt) && isFile(handover)) {
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
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const ctx = buildContext(input);
  if (!ctx) return;
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
