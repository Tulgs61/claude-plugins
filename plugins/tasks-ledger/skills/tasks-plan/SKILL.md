---
name: tasks-plan
description: Plan a list of tasks into a tasks-ledger JSON file under .claude/runs/ without running anything. Splits the work by file ownership, links overlapping work with dependsOn, and gives every task an acceptance, a proof and a budget. Use when the user only wants a plan or estimate for several changes, or when the tasks skill needs a ledger written or refreshed.
argument-hint: "[goal, task list or spec path] [open PRs]"
context: fork
---

# tasks-plan

Input: $ARGUMENTS

You write or refresh one ledger and stop. You start no agents, edit no code, and touch nothing in
the repository except the ledger file.

## 1. Understand the repository

- The repository root is the main checkout's top level (`git rev-parse --show-toplevel`). The
  ledger goes to `<root>/.claude/runs/`.
- Read what the project documents about branching (CLAUDE.md, CONTRIBUTING, docs on git workflow).
  If it names a branch that feature work starts from, that is `baseBranch`. Otherwise use the
  repository's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, minus the
  `origin/` prefix, or the current default when there is no remote).
- Check whether `.claude/verify.cmd` is committed (`git ls-files --error-unmatch .claude/verify.cmd`).
  You do not create it; you only report its absence.
- Look at how dependencies are installed and how tests run, so that `setup`, `suite` and each
  task's `proof` are commands that actually work here.

## 2. Create or refresh

- **New ledger**: name it `.claude/runs/YYYY-MM-DD-<topic>.json`, with today's date and a short
  kebab-case `topic` that matches `^[a-z0-9][a-z0-9-]*$`. Set `runStatus` to `planned`.
- **Existing ledger** (the input names one, or one for the same topic exists): first check for a
  `<same name>.lock` next to it. If that lock's `at` is less than six hours old, a run owns the
  ledger: do not write it; tell the caller to use `/tasks add` instead. Otherwise you may add tasks
  and rework tasks whose `status` is `todo` or `blocked`. Every other task (`in_progress`, `done`,
  `verified`, `merged`) stays exactly as it is, including its branch, worktree, evidence and PR.
  New ids continue after the highest existing one.

## 3. Shape the tasks

Each task gets:

- `id`: `T1`, `T2`, ... (pattern `^T[0-9]+$`);
- `title`: a few words;
- `acceptance`: an end state somebody else can observe and check, not an activity;
- `proof`: one command that runs in a worktree of this repository and whose output shows the
  acceptance holds;
- `budget`: a stop clause such as "stop after 40 turns and report what blocks";
- `files`: the globs of the files this task owns and may change;
- `dependsOn`: the ids it must wait for (possibly empty);
- `constraints`: what must not change, when there is anything to say;
- `status`: `todo`.

Partitioning rules:

- Split by file, not by symptom. Changes that need the same file belong to one task.
- Where two tasks' `files` globs could match a common path, link them through `dependsOn` (the
  later task depends on the earlier one, directly or through a chain). Judge this conservatively:
  compare the fixed leading directories of the two globs; if one is a prefix of the other, or a glob
  starts with a wildcard, a brace or `!`, or contains `..`, treat them as overlapping.
- Apart from overlaps, add a `dependsOn` edge only for a real dependency: one task needs code,
  an interface or data that another task produces. Independent work stays unlinked so it can run
  in parallel.
- No cycles, and every id in `dependsOn` exists in the ledger.

## 4. Run-level fields

- `goal`: one sentence for the whole run.
- `baseBranch`: as found in step 1.
- `prs`: `true` only when the input asks for pull requests (for example "open PRs"); otherwise
  `false`.
- `setup` (optional): a command that only installs dependencies in a fresh worktree, such as
  `npm ci`. It must leave every tracked file as committed: no code generation into tracked paths, no
  lockfile rewrites, no formatters.
- `suite` (optional): a broader check for the integration branch. Include it only when running it
  locally is safe: no real databases, external services, deployments or paid APIs.
- `checkTimeoutMin` (optional): only when the checks are known to need longer than usual.

## 5. Validate and reply

Check the file against `${CLAUDE_PLUGIN_ROOT}/schemas/tasks.schema.json`: the required keys are
present, ids and `dependsOn` entries match `^T[0-9]+$`, statuses and `runStatus` are from their
enums, and tasks carry no keys beyond the ones the schema lists. Fix anything that does not pass.

Then reply briefly:

- the ledger path;
- the tasks as rounds: tasks with no open prerequisites first, then those that wait for them, and
  so on;
- a warning, if `.claude/verify.cmd` is not committed, that a run cannot start until it is;
- any assumption you made about base branch, proofs or file ownership.
