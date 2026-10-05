# tasks-ledger conventions

The rules the `tasks`, `tasks-plan` and `dispatch` skills, the two agents and the two hooks of this
plugin follow. A project's own documented rules (CLAUDE.md, CONTRIBUTING, …) win where they say
otherwise.

## Dispatch contract

Every delegation of a code change (an Agent call to an implementer, a `claude --bg` session, a
`/goal`) carries all six parts, rendered by the `dispatch` skill:

| Part | Meaning |
|---|---|
| **Outcome** | Observable end state, not activity. |
| **Proof** | Exact command whose output lands in the agent's transcript. |
| **Constraints** | What must not change, including the `files` scope. |
| **Deliverable** | A commit on the worktree branch; a draft PR only if the user asked; never merge. |
| **Budget** | Stop clause (e.g. "stop after 40 turns and report what blocks"); the agent's `maxTurns` is the hard cap behind it. |
| **Escalation** | When to stop and ask instead of guessing (schema/migration changes, auth/payments, an ambiguous spec, any file outside the scope). |

No proof or no budget = not dispatchable. The `dispatch-guard` hook enforces this: an Agent call
to an agent named `implementer` or `task-implementer` (with or without a plugin prefix) whose
prompt has no `PROOF` or no `BUDGET` section is blocked.

## Writer ≠ reviewer

- The agent that wrote a change never certifies it. `verified` comes only from an independent
  `reviewer` agent (and, in a `/tasks` run, from the workflow re-running `.claude/verify.cmd`).
- A task-implementer reports files changed, proof output, commit hash and what is unverified; it
  never edits the ledger or marks its own task done.
- The reviewer is read-only and answers with a JSON verdict (`verified`, `rejected`,
  `needs_input`); `verified` requires acceptance met, scope ok, constraints ok and no high finding.
  Its tools are `Read, Grep, Glob, Bash` and it has no `memory` field: agent memory would add
  Read/Write/Edit and share notes across repositories.
- Both agents default to `model: opus` in their frontmatter. Use a model for the reviewer that is
  at least as strong as the writer's.

## Delegating a list of tasks (`/tasks`)

- A list of more than one separable task goes through `/tasks`: it writes the ledger, shows the
  rounds, and on the user's go runs the `tasks-engine` workflow (task-implementers in their own
  worktrees, a reviewer per task; each task starts as soon as its prerequisites are merged). New
  tasks join a running run with `/tasks add`. If only planning or estimating was asked, stop after
  the ledger (`tasks-plan`).
- **Partition by file, not by symptom.** Tasks that share files run sequentially (a `dependsOn`
  edge between them).
- **A dependency edge is a merge boundary.** A dependent task starts from its prerequisites'
  verified branches.
- **No task is done until `.claude/verify.cmd` passes in its own worktree.** The workflow runs it
  and refuses to start when the repo has no committed `.claude/verify.cmd`; the reviewer
  certifies.
- **What the user's go authorises:** local merges into the `task/<topic>/*` branches only. The
  integration branch `task/<topic>/integration` is never pushed; task branches `task/<topic>/<Tn>`
  and their `-base` branches are pushed, with one draft PR per task, only when the ledger has
  `prs: true` (the user asked for PRs). Never merge a
  PR, never push to or merge into the project's permanent branches, never deploy from this flow.
- The main checkout is never switched; uncommitted work there is safe.

## Layout

One kebab-case topic slug (e.g. `csv-export`) names the ledger, the branches and the worktrees.
The date in a file name is the day the file was written and never changes.

| What | Where | Git |
|---|---|---|
| Task ledger (one per `/tasks` run) | `.claude/runs/YYYY-MM-DD-<topic>.json` (schema: `schemas/tasks.schema.json`) | ignored |
| Tasks added to a running run | `.claude/runs/YYYY-MM-DD-<topic>.inbox.jsonl` (one task object per line) | ignored |
| Run lock (which run owns the ledger) | `.claude/runs/YYYY-MM-DD-<topic>.lock` | ignored |
| Task worktrees | `.claude/worktrees/<topic>-<Tn>/` | ignored |
| Integration worktree | `.claude/worktrees/<topic>-integration/` | ignored |
| Task branch | `task/<topic>/<Tn>` | local; pushed only with `prs: true` |
| Base of a task with several prerequisites | `task/<topic>/<Tn>-base` | local; pushed only as a PR target with `prs: true` |
| Integration branch (every verified task merged, full suite run) | `task/<topic>/integration` | local, never pushed |

Add these lines to the project's `.gitignore`:

```gitignore
.claude/runs/
.claude/worktrees/
```

The base branch for dependency-free tasks (`baseBranch` in the ledger) is the one the project's
documented git rules name for feature work; if they name none, the repository's default branch.

## `.claude/verify.cmd` (opt-in)

A repository opts in to verification by committing `.claude/verify.cmd`. Its content is one bash
command, usually a single line, that runs the repository's fast and safe checks (unit tests, lint, type
check; never a suite that reaches real databases or services) and exits 0 when they pass, for example
`npm test --silent && npm run lint`. The Stop hook is opt-in per project; a `/tasks` run requires
the file (committed, so every worktree has it).

- The `verify-gate` hook marks a session dirty after Edit/Write/MultiEdit/NotebookEdit and, when the
  turn would end, looks for `.claude/verify.cmd` with a bounded rule. It starts from the working
  directory of the session that stops (the hook input's `cwd`) and takes the nearest ancestor of
  it (that directory included) that contains `.git` (the repository or worktree root). Inside a
  repository it searches from the working directory upward to that root inclusive, and the nearest
  file wins. Outside any repository it checks only `<cwd>/.claude/verify.cmd`. On POSIX it skips
  (treats as absent) a `verify.cmd` that is not owned by the current user. A group- or
  world-writable `verify.cmd` is skipped as well, with a one-time warning per session and project
  that suggests `chmod 644`. Under umask `002` git checks the file out group-writable in every
  clone and worktree: run `chmod go-w .claude/verify.cmd` in each, or set `umask 022` before you
  clone or create worktrees.
- **Consent.** verify-gate runs a repository's `verify.cmd` only after the user approved that exact
  command for that repository in a terminal, with the approve command the gate prints
  (`node "<plugin root>/scripts/verify-consent.js" approve '<dir>'`, prefixed with the store it
  uses). The script reads the
  answer from the terminal, never from stdin or arguments, and a changed `verify.cmd` needs a new
  approval. Any other way of recording consent is a tool call under Claude Code's permission
  prompts; deny such a call unless you asked for it (a program can fake a terminal, so the prompt
  alone is not the boundary). Until then the gate skips the check and asks once per session and
  project. On native Windows the approve prompt is not available yet, so the gate never runs the
  check there.
- The command runs with bash in the directory where the file was found (timeout 3
  minutes; the whole process group is ended on timeout). The hook ignores `CLAUDE_PROJECT_DIR`. It is
  registered for `Stop` and `SubagentStop`, so a subagent working in its own worktree is gated in that
  worktree. Its state is kept per session and project. A failure blocks the stop
  with the output tail; after 3 failed attempts it stops blocking and leaves the decision to the
  human. Without the file the hook does nothing.
- Task-implementers run it before they finish, and the tasks workflow re-runs it in every task
  worktree and on the integration branch (after the ledger's `setup`, followed by its `suite`).
- Change `verify.cmd` outside a run: `tasks-git` `verify` and `merge` refuse a task whose branch
  modifies it compared with the task's base.
- The command runs with your user's rights. Read the command `approve` shows before you type `yes`.
