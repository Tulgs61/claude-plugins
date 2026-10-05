// Test helper for the verify-gate consent store (rev 10 amendment 12): the approve command needs a
// terminal, so tests point CLAUDE_PLUGIN_DATA at a fresh temp directory and write the store entry
// directly. The identity and hash rules are computed here independently of the scripts under test.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STORE_NAME = 'verify-consent.json';

// `env` with CLAUDE_PLUGIN_DATA pointing at a fresh directory under `parent`.
export function withConsentStore(env, parent) {
  return { ...env, CLAUDE_PLUGIN_DATA: mkdtempSync(path.join(parent, 'plugin-data-')) };
}

export const storePath = env => path.join(env.CLAUDE_PLUGIN_DATA, STORE_NAME);

// The real path of `git rev-parse --git-common-dir` in `dir`, or of `dir` when git fails.
export function repoIdentity(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, env, encoding: 'utf8' });
  const out = r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : '';
  return realpathSync(out ? path.resolve(dir, out) : dir);
}

// sha256 hex of the bytes the gate passes to bash: the trimmed file content.
export const commandHash = content => createHash('sha256').update(Buffer.from(content.trim(), 'utf8')).digest('hex');

export function storeEntries(env) {
  const file = storePath(env);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).entries : [];
}

// Approves `content` (default: the current <dir>/.claude/verify.cmd) for the repository of `dir`, the
// directory that contains .claude/.
export function approveCheck(env, dir, content = readFileSync(path.join(dir, '.claude', 'verify.cmd'), 'utf8')) {
  const file = storePath(env);
  const entries = storeEntries(env);
  entries.push({ repo: repoIdentity(dir), sha256: commandHash(content) });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ entries }));
}
