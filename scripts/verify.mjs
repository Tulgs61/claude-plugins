#!/usr/bin/env node
// Repo check, run by .claude/verify.cmd: leak scan, JSON validity, JS syntax, node tests.
// Exit 0 = clean. Every failure is printed; the first one does not hide the rest.
//
// Leak scan: the patterns are private, so they are not in this file. They live in
// .claude/private/leaks.txt (ignored by git), one pattern per line:
//   /source/flags   regex literal form (the g and y flags are dropped)
//   source          anything else, compiled case-insensitive
// Blank lines and lines starting with # are ignored. The file is looked up under the current
// worktree root first, then under the main checkout, so a task worktree uses the main checkout's file.
// Without a file the leak scan is skipped with a notice; the other checks still run.
// Findings name the pattern by its line number in leaks.txt, never by its text.
//
// --only <dir>  run only the tests under <dir> (the leak, JSON and syntax checks still cover every file).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LEAKS_REL = path.join('.claude', 'private', 'leaks.txt');
const problems = [];
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : (process.argv[onlyAt + 1] || '').replace(/\/+$/, '') + '/';
if (only === '/') {
  console.error('verify: --only needs a directory');
  process.exit(2);
}

const git = args => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function findLeaksFile() {
  const roots = [];
  const top = git(['rev-parse', '--show-toplevel']);
  if (top) roots.push(top);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) roots.push(path.dirname(common));
  for (const root of roots) {
    const p = path.join(root, LEAKS_REL);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadLeaks(file) {
  const leaks = [];
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const lit = /^\/(.*)\/([a-z]*)$/.exec(line);
      try {
        const re = lit ? new RegExp(lit[1], lit[2].replace(/[gy]/g, '')) : new RegExp(line, 'i');
        leaks.push({ re, id: `leaks.txt line ${i + 1}` });
      } catch {
        problems.push(`invalid leak pattern at leaks.txt line ${i + 1}`);
      }
    });
  return leaks;
}

const leaksFile = findLeaksFile();
const leaks = leaksFile ? loadLeaks(leaksFile) : [];
if (!leaksFile) console.log('verify: no .claude/private/leaks.txt, leak scan skipped');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  text.split('\n').forEach((line, i) => {
    for (const { re, id } of leaks) if (re.test(line)) problems.push(`leak (${id}) at ${f}:${i + 1}`);
  });
  if (f.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (e) {
      problems.push(`invalid JSON ${f}: ${e.message}`);
    }
  }
  if (/\.(js|mjs|cjs)$/.test(f) && !/^plugins\/[^/]+\/workflows\//.test(f)) {
    // Workflow scripts use top-level return/await inside the workflow runtime; they are checked by their tests.
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(`syntax ${f}: ${(r.stderr || '').trim().split('\n').slice(0, 3).join(' | ')}`);
  }
}

// Explicit list from git, so tests inside .claude/worktrees/ (ignored) never run from the main checkout.
const tests = files.filter(f => /\.test\.(js|mjs|cjs)$/.test(f) && (!only || f.startsWith(only)));
if (tests.length) {
  const t = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  if (t.status !== 0) problems.push(`node --test exited ${t.status}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`verify: ${files.length} files clean, tests passed`);
