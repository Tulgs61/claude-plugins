// Throwaway git sandboxes for the tasks-git tests: a repo with a local bare repo as origin, a ledger
// in <repo>/.claude/runs/, and an environment that isolates git from the user's configuration
// (temp global config, no system config, no prompts) and points gh/glab at the fake CLI fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = fileURLToPath(new URL('../../scripts/tasks-git.js', import.meta.url));
export const ENGINE = fileURLToPath(new URL('../../workflows/tasks-engine.js', import.meta.url));
export const FAKE_GH = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url));
export const TOPIC = 'demo';
export const VERIFY_CMD = 'test ! -e FAIL_VERIFY';

// A ledger task with every field the engine needs.
export function task(id, files = [], dependsOn = [], extra = {}) {
  return {
    id,
    title: `task ${id}`,
    acceptance: `acceptance of ${id}`,
    proof: 'true',
    constraints: [],
    files,
    dependsOn,
    status: 'todo',
    budget: '5 turns',
    ...extra,
  };
}

// Extracts the `// BEGIN glob-overlap` ... `// END glob-overlap` block; tolerates CRLF line endings.
export function markerBlock(source) {
  const m = source.match(/\/\/ BEGIN glob-overlap\r?\n[\s\S]*?\/\/ END glob-overlap(?:\r?\n|$)/);
  return m ? m[0] : null;
}

function isolatedEnv(tmp) {
  const env = {};
  // Drop every GIT_* variable (GIT_DIR, GIT_INDEX_FILE, ... are set when tests run from a git hook).
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const home = path.join(tmp, 'home');
  mkdirSync(path.join(home, '.config'), { recursive: true });
  const globalConfig = path.join(tmp, 'gitconfig');
  writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[core]\n\tautocrlf = false\n');
  const fake = `${process.execPath}|${FAKE_GH}`;
  return Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TASKS_GIT_GH: fake,
    TASKS_GIT_GLAB: fake,
    FAKE_GH_LOG: path.join(tmp, 'gh.log'),
  });
}

// Creates the sandbox and registers its removal on the test context `t`.
export function sandbox(t, opts = {}) {
  const { tasks = [], setup = 'true', prs = false, ignoreWorktrees = true, ledgerExtra = {} } = opts;
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'tasks-git-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = isolatedEnv(tmp);
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');

  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status;
  const write = (dir, rel, text) => {
    const f = path.join(dir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, text);
  };

  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  write(repo, 'README.md', 'demo\n');
  write(repo, '.gitignore', (ignoreWorktrees ? '.claude/worktrees/\n' : '') + '.claude/runs/\n');
  write(repo, '.claude/verify.cmd', VERIFY_CMD + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');

  const ledgerFile = path.join(repo, '.claude', 'runs', `2026-01-01-${TOPIC}.json`);
  const ledger = { topic: TOPIC, goal: 'demo run', baseBranch: 'main', prs, tasks, ...ledgerExtra };
  if (setup) ledger.setup = setup;
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');

  const sb = {
    tmp,
    env,
    origin,
    repo,
    ledgerFile,
    lockFile: ledgerFile.replace(/\.json$/, '.lock'),
    inboxFile: ledgerFile.replace(/\.json$/, '.inbox.jsonl'),
    git,
    tryGit,
    write,
    // Runs the helper with raw arguments and checks the protocol: exit 0, exactly one JSON line.
    runRaw(...args) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, `tasks-git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
      const lines = r.stdout.split('\n').filter(Boolean);
      assert.equal(lines.length, 1, `tasks-git ${args.join(' ')} printed ${lines.length} lines: ${r.stdout}`);
      return JSON.parse(lines[0]);
    },
    // run('worktree', 'T1') -> node tasks-git.js worktree <ledger> T1
    run(cmd, ...rest) {
      return sb.runRaw(cmd, ledgerFile, ...rest);
    },
    ok(cmd, ...rest) {
      const r = sb.run(cmd, ...rest);
      assert.equal(r.ok, true, `${cmd} ${rest.join(' ')} failed: ${JSON.stringify(r)}`);
      return r;
    },
    ledger() {
      return JSON.parse(readFileSync(ledgerFile, 'utf8'));
    },
    writeLedger(L) {
      writeFileSync(ledgerFile, JSON.stringify(L, null, 2) + '\n');
    },
    taskOf(id) {
      return sb.ledger().tasks.find(x => x.id === id);
    },
    commit(dir, rel, text, message = `edit ${rel}`) {
      write(dir, rel, text);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', message);
      return git(dir, 'rev-parse', 'HEAD');
    },
    // worktree -> one commit -> verified -> merged into integration.
    complete(id, rel = `${id}.txt`, text = `${id}\n`) {
      const w = sb.ok('worktree', id);
      sb.commit(w.worktree, rel, text, `${id}: work`);
      sb.ok('status', id, 'verified', 'reviewed');
      return sb.ok('merge', id);
    },
    sha(cwd, ref) {
      return git(cwd, 'rev-parse', ref);
    },
    originHeads() {
      return git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
        .split('\n')
        .filter(Boolean)
        .sort();
    },
    ghCalls() {
      const f = env.FAKE_GH_LOG;
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    },
  };
  return sb;
}
