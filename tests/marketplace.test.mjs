// Consistency checks between .claude-plugin/marketplace.json and the plugins it lists.
// Node built-ins only. Run: node --test tests/marketplace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const marketplace = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
const entries = marketplace.plugins || [];

const isDir = p => existsSync(p) && statSync(p).isDirectory();
const isFile = p => existsSync(p) && statSync(p).isFile();
const pluginDir = entry => path.resolve(ROOT, entry.source);
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

test('marketplace has a kebab-case name, an owner and plugin entries', () => {
  assert.match(marketplace.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(marketplace.owner.name.length > 0);
  assert.ok(Array.isArray(entries) && entries.length > 0, 'plugins must be a non-empty array');
  const names = entries.map(e => e.name);
  assert.equal(new Set(names).size, names.length, `duplicate plugin names: ${names}`);
});

test('every directory under plugins/ is listed in the marketplace', () => {
  const dirs = readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  const listed = entries.map(e => path.relative(path.join(ROOT, 'plugins'), pluginDir(e))).sort();
  assert.deepEqual(listed, dirs);
});

for (const entry of entries) {
  test(`${entry.name}: source dir holds a matching plugin.json and a README.md`, () => {
    assert.equal(typeof entry.source, 'string', 'source must be a relative path string');
    assert.ok(entry.source.startsWith('./'), `source must start with ./ (got ${entry.source})`);
    assert.ok(!entry.source.split('/').includes('..'), 'source must not contain ..');
    const dir = pluginDir(entry);
    assert.ok(inside(dir, ROOT), `source ${entry.source} resolves outside the repo`);
    assert.ok(isDir(dir), `missing plugin dir ${entry.source}`);

    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
    assert.ok(isFile(manifestPath), `missing ${entry.source}/.claude-plugin/plugin.json`);
    const manifest = readJson(manifestPath);
    assert.equal(manifest.name, entry.name, 'plugin.json name differs from the marketplace entry name');
    assert.equal(typeof entry.version, 'string', 'marketplace entry needs a version');
    assert.equal(manifest.version, entry.version, 'plugin.json version differs from the marketplace entry version');
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0, 'entry needs a description');
    assert.equal(entry.description, manifest.description, 'marketplace description differs from plugin.json description');

    assert.ok(isFile(path.join(dir, 'README.md')), `missing ${entry.source}/README.md`);
  });

  const hooksPath = path.join(pluginDir(entry), 'hooks', 'hooks.json');
  if (!isFile(hooksPath)) continue;

  test(`${entry.name}: every hook in hooks/hooks.json refers to an existing file in the plugin`, () => {
    const dir = pluginDir(entry);
    const { hooks } = readJson(hooksPath);
    assert.ok(hooks && typeof hooks === 'object', 'hooks.json needs a hooks object');
    let checked = 0;
    for (const [event, groups] of Object.entries(hooks)) {
      assert.ok(Array.isArray(groups), `${event} must be an array of matcher groups`);
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          if (hook.type !== 'command') continue;
          // Exec form puts the script in args; a shell-form command string is split into words.
          const parts = [
            ...(typeof hook.command === 'string' ? hook.command.split(/\s+/) : []),
            ...(Array.isArray(hook.args) ? hook.args : []),
          ]
            .filter(p => typeof p === 'string' && p.includes('${CLAUDE_PLUGIN_ROOT}'))
            .map(p => p.replace(/^["']|["']$/g, ''));
          assert.ok(parts.length > 0, `${event} hook does not reference \${CLAUDE_PLUGIN_ROOT}: ${JSON.stringify(hook)}`);
          for (const part of parts) {
            const target = path.resolve(dir, part.replaceAll('${CLAUDE_PLUGIN_ROOT}', '.'));
            assert.ok(inside(target, dir), `${event} hook path leaves the plugin: ${part}`);
            assert.ok(isFile(target), `${event} hook refers to a missing file: ${part}`);
            checked++;
          }
        }
      }
    }
    assert.ok(checked > 0, 'hooks.json has no command hooks to check');
  });
}

// scripts/verify.mjs reads its leak patterns from .claude/private/leaks.txt. These tests run a copy of it
// in throwaway git repositories with made-up patterns; the real pattern file is never read here.
const VERIFY = path.join(ROOT, 'scripts', 'verify.mjs');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, env: cleanEnv, encoding: 'utf8' });
const gitIn = (cwd, ...args) => {
  const r = run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

function scratchRepo(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-leaks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, 'init', '-q');
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(VERIFY, path.join(dir, 'scripts', 'verify.mjs'));
  writeFileSync(path.join(dir, '.gitignore'), '.claude/private/\nwt/\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const writeLeaks = (dir, text) => {
  mkdirSync(path.join(dir, '.claude', 'private'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'private', 'leaks.txt'), text);
};
const verifyIn = cwd => run(process.execPath, [path.join('scripts', 'verify.mjs')], cwd);

test('verify.mjs: without leaks.txt the leak scan is skipped with one notice and the rest runs', t => {
  const dir = scratchRepo(t, { 'notes.txt': 'zebra-quokka-7731\n', 'bad.json': '{' });
  const r = verifyIn(dir);
  assert.equal(r.stdout.split('\n').filter(l => l === 'verify: no .claude/private/leaks.txt, leak scan skipped').length, 1);
  assert.equal(r.status, 1, 'the JSON check must still run');
  assert.match(r.stderr, /invalid JSON bad\.json/);
  assert.doesNotMatch(r.stderr, /leak/);
});

test('verify.mjs: bare and literal patterns match, comments and blanks are ignored, the pattern text is not printed', t => {
  const dir = scratchRepo(t, { 'a.txt': 'ok\nZEBRA-QUOKKA-7731\n', 'b.txt': 'Mixed Case Wombat\nmixed case wombat\n' });
  writeLeaks(dir, '# comment line\n\nzebra-quokka-\\d+\n/Mixed Case Wombat/g\n');
  const r = verifyIn(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak \(leaks\.txt line 3\) at a\.txt:2/, 'bare pattern is case-insensitive');
  assert.match(r.stderr, /leak \(leaks\.txt line 4\) at b\.txt:1/);
  assert.doesNotMatch(r.stderr, /b\.txt:2/, 'literal form keeps its own flags (no i)');
  assert.doesNotMatch(r.stderr + r.stdout, /quokka|Wombat/, 'pattern text never appears in the output');
});

test('verify.mjs: an invalid pattern line is a reported problem, not a crash', t => {
  const dir = scratchRepo(t, { 'a.txt': 'fine\nnarwhal-3318\n' });
  writeLeaks(dir, 'narwhal-\\d+\n(unclosed\n/x/q\n');
  const r = verifyIn(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak \(leaks\.txt line 1\) at a\.txt:2/, 'the valid line still matches');
  assert.match(r.stderr, /invalid leak pattern at leaks\.txt line 2/);
  assert.match(r.stderr, /invalid leak pattern at leaks\.txt line 3/);
  assert.doesNotMatch(r.stderr, /SyntaxError|at file:/);
});

test('verify.mjs: a linked worktree uses the main checkout leaks.txt, and verify.mjs itself is scanned', t => {
  const dir = scratchRepo(t, { 'a.txt': 'clean\n' });
  writeLeaks(dir, 'platypus-0042\n');
  const wt = path.join(dir, 'wt');
  gitIn(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  writeFileSync(path.join(wt, 'scripts', 'verify.mjs'), readFileSync(VERIFY, 'utf8') + '\n// platypus-0042\n');
  const r = verifyIn(wt);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak \(leaks\.txt line 1\) at scripts\/verify\.mjs:\d+/);
  assert.doesNotMatch(r.stdout, /leak scan skipped/);
});

test('verify.mjs: worktree leaks.txt wins over the main checkout', t => {
  const dir = scratchRepo(t, { 'a.txt': 'clean\nmain-only-axolotl-11\nworktree-only-ibex-22\n' });
  writeLeaks(dir, 'main-only-axolotl-\\d+\n');
  const wt = path.join(dir, 'wt');
  gitIn(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  writeLeaks(wt, '# worktree patterns\nworktree-only-ibex-\\d+\n');
  const r = verifyIn(wt);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leak \(leaks\.txt line 2\) at a\.txt:3/, 'the worktree pattern is reported');
  assert.doesNotMatch(r.stderr, /a\.txt:2/, 'the main checkout pattern is not used');
  assert.equal(r.stderr.split('\n').filter(l => /leak \(/.test(l)).length, 1);
});
