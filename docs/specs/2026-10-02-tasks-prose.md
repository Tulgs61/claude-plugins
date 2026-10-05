---
status: approved
component: tasks-prose
---
# Behaviour spec: tasks-ledger agents, skills and ledger schema

**Files to write** (under `plugins/tasks-ledger/`):
- `agents/reviewer.md`, `agents/task-implementer.md`;
- `skills/dispatch/SKILL.md`, `skills/tasks/SKILL.md`, `skills/tasks-plan/SKILL.md`;
- `schemas/tasks.schema.json`.

**How prose is specified here.** Agents and skills are given only as required outcomes and hard
limits. Wording, structure, examples and trigger phrases are the implementer's choice.

**Companion specs** that these files must agree with:
- `2026-10-02-tasks-git.md` (the helper);
- `2026-10-02-tasks-engine.md` (the engine);
- `2026-10-02-tasks-hooks.md` (the hooks).

## Purpose

- **Two agents** fill the writer and judge roles that the engine starts for every task.
- **Three skills** are the user's entry points:
  - running a list of tasks;
  - only planning such a list;
  - turning one task into a delegation contract.
- **The schema** fixes the ledger format that all of them share.

## Interface

**Front matter.**
- Every agent and skill has `name` and `description`, as the plugin validator requires.
- The names are `reviewer`, `task-implementer`, `dispatch`, `tasks` and `tasks-plan`.
- Inside a workflow, the agents are reached as `tasks-ledger:reviewer` and
  `tasks-ledger:task-implementer`, which are the engine's defaults.
- These fields are fixed because the kept README and `rules/conventions.md` document them:

| File | Required front matter |
|---|---|
| `agents/reviewer.md` | `model: opus`, `maxTurns: 40`, `tools: Read, Grep, Glob, Bash`, and no `memory` field |
| `agents/task-implementer.md` | `model: opus`, `maxTurns: 120` |
| `skills/tasks-plan/SKILL.md` | `context: fork` (it runs in a forked context) |

- All other front-matter fields (colours, hints, effort and the like) are free.

**Plugin files and arguments.**
- Skills refer to plugin files through `${CLAUDE_PLUGIN_ROOT}`.
- Skills receive the user's input through `$ARGUMENTS`.

**Vocabulary check.** The skills may name only these helper subcommands and engine arguments
(both lists alphabetical), and a planned test checks this:
- helper subcommands: `finish`, `merge`, `prepare`, `prs`, `status`, `sync`, `verify`, `worktree`;
- engine arguments: `implementerAgent`, `ledger`, `reviewerAgent`, `runId`, `script`, `takeover`.

## Behaviour

### Agents

**reviewer**

| Must achieve | Must never |
|---|---|
| An independent verdict on one task's change, judged on acceptance, file scope and constraints. | Modify files or repository state. It should be technically unable to: give it read-only tools and no persistent memory. |
| An answer the engine can consume: `verdict` (`verified`, `rejected`, `needs_input`), `acceptance_met`, `scope_ok`, `constraints_ok`, `findings` (each with a `message`, and optionally `file`, `line`, `severity`) and `evidence`. | Return `verified` while acceptance, scope or constraints fail, or while a high-severity finding exists. |
| An explicit request for missing information. | Guess a verdict from missing information. |

**task-implementer**

| Must achieve | Must never |
|---|---|
| The task's outcome, delivered as commits on the task branch inside the worktree the workflow gave it. | Push, merge, rebase, or create or remove branches and worktrees. |
| Its own run of the proof command and of `.claude/verify.cmd`, both passing, with their output visible in its transcript. | Leave its worktree. |
| A short final report that names the changed files, the proof output, the commit hash and anything left unverified. | Edit files outside the task's file scope. When such a file is needed, it stops and reports. |
| | Edit the ledger, or declare its own work verified. |
| | Proceed when its contract lacks parts it needs; it reports instead. |

### Skills

**dispatch**

| Must achieve | Must never |
|---|---|
| The output can be used directly in each of the three forms that kept README:36 and `conventions.md`:9-10 list, in their order: Agent call; `claude --bg` command; `/goal`. | Offer a merge, or a push to a permanent branch, as the deliverable. |
| dispatch-guard accepts its PROOF and BUDGET labels. | Emit a contract without a proof or without a budget. The user learns which of the two is absent. |
| From a ledger id or a free-text task, one contract with the six parts in the order fixed by `rules/conventions.md`. | |

**tasks**

**Invocation forms** (documented in the kept README), alphabetical: `add <task>`, `resume`,
`retry <Tn>`, `status`, and otherwise `<task list> [open PRs]`.

**Must achieve:**
- **Reporting.** At the end the user sees the stop reason, the next step, and each task's status,
  branch and PR.
- **Run management.**
  - `add <task>` joins a live run by appending one JSON line to the ledger's `.inbox.jsonl`. The
    line carries at least `title` and `acceptance`, so the ingested task is schema-valid.
  - `resume` continues a stopped run.
  - `retry <Tn>` sets a blocked task back to `todo` through the helper's `status`, then resumes.
  - `status` shows the per-task state.
- **Engine start.** The workflow is started from its file under `${CLAUDE_PLUGIN_ROOT}/workflows/`
  with absolute ledger and helper paths; when the session may not read the plugin directory, it is
  started by its workflow name instead (kept README:24-26).
- **Engine arguments.** A fresh valid run id, the helper path and the ledger path. Agent types
  differ from the defaults only when the user asks, and a resume passes them again.
- **Preconditions.** If `.claude/verify.cmd` is not committed, the user is asked to add it before
  anything starts.
- **Starting work.** For a list of tasks, `tasks-plan` writes the ledger, the user sees the planned
  rounds and approves, and the engine runs.
- **Cleanup.** Once their PRs have merged, task worktrees and branches can be removed.
- Pushes and draft PRs happen only when the ledger has `prs: true`.

**Hard limits, grouped by risk:**
- **Outside the machine:** never merge a PR, deploy, push the integration branch, or push to or
  merge into a permanent branch.
- **Needs the user's consent:** no engine start without the user's go (an explicit `/tasks` call is
  one); no removal before the user agrees to the listed items; no `takeover` unless the user
  confirmed the locked run is dead.
- **Local state:** never switch the main checkout; never edit the ledger file while its run is live.

**tasks-plan**

| Must achieve | Must never |
|---|---|
| A brief reply that names the ledger and warns when `.claude/verify.cmd` is missing. | Start agents or edit code. |
| `suite` only when running it locally is safe. A `setup` command, if the ledger has one, does nothing beyond installing dependencies: tracked files stay as committed. | When refreshing a ledger, change any task whose status is not `todo` or `blocked`. |
| `baseBranch` from the project's documented branching rule, else the repository's default branch. | Link tasks with no real dependency between them. |
| `prs` true only if PRs were asked for. | |
| Overlapping file globs are always linked through `dependsOn`, and work that shares a file is a single task. | |
| A schema-valid ledger in `<repo>/.claude/runs/`, every task with owned `files`, `dependsOn`, an observable `acceptance`, a runnable `proof` and a `budget`. | |

### Ledger schema (`schemas/tasks.schema.json`)

**Format.** A JSON Schema, draft 2020-12. `title` and `description` are free.

**Top level.**
- The document is an object, and `tasks` is required.
- Additional top-level keys are allowed.

Properties, alphabetical:

| Property | Type |
|---|---|
| `baseBranch` | string |
| `checkTimeoutMin` | number |
| `goal` | string |
| `integrationBranch` | string or null |
| `prs` | boolean |
| `runStatus` | string, one of `finished`, `planned`, `running`, `stopped` |
| `setup` | string |
| `stopReason` | string or null |
| `suite` | string |
| `tasks` | array of task objects |
| `topic` | string matching `^[a-z0-9][a-z0-9-]*$` |

**Task object.**
- Required keys: `acceptance`, `dependsOn`, `files`, `id`, `status`, `title`.
- No additional properties.

Properties, alphabetical:

| Property | Type |
|---|---|
| `acceptance` | string |
| `base` | string or null |
| `branch` | string or null |
| `budget` | string |
| `constraints` | array of strings |
| `dependsOn` | array of id strings matching `^T[0-9]+$` |
| `evidence` | string or null |
| `files` | array of strings |
| `id` | string matching `^T[0-9]+$` |
| `pr` | string or null |
| `proof` | string |
| `status` | string, one of `blocked`, `done`, `in_progress`, `merged`, `todo`, `verified` |
| `title` | string |
| `worktree` | string or null |

**Validation expectations** for the planned schema test:
- Accepted: ledgers created by the helper test sandbox, before and after helper commands have run
  (sb:17-31, sb:99-101), and tasks ingested from inbox lines that carry `title` and `acceptance`
  (the helper always stores `files` and `dependsOn`). The schema test uses only such inbox
  fixtures; title-only lines are a helper-test concern, not a schema case.
- Rejected: an unknown task key, a malformed id, or an unknown status.

## Errors

- **Prose components.** When information or permission is missing, they stop and ask or report.
  They never guess (see the "must never" columns).
- **Schema.** A ledger that violates it is rejected by validation.

## Security

- **reviewer:** read-only by construction.
- **task-implementer:** confined to its worktree, its file scope and local commits.
- **Skills:** push and merge only within the helper's allow-list, and only with `prs: true` and the
  user's go.

## Test-pinned items

- The agent names and the engine's default agent types (eng:191-192).
- The reviewer's answer keys and verdict values (eng:156).
- The `PROOF` and `BUDGET` labels (h:96-99).
- The schema's property names, types, required lists, enums and patterns.
- The vocabulary check.

## Allowlist

Entries are sorted alphabetically, ignoring case and leading punctuation.

```text
^[a-z0-9][a-z0-9-]*$
acceptance
acceptance_met
add
$ARGUMENTS
base
baseBranch
blocked
branch
BUDGET
budget
checkTimeoutMin
claude --bg
.claude/verify.cmd
constraints
constraints_ok
context
dependsOn
description
dispatch
done
evidence
files
findings
finished
fork
/goal
goal
https://json-schema.org/draft/2020-12/schema
id
in_progress
.inbox.jsonl
integrationBranch
maxTurns
memory
merged
message
model
name
needs_input
opus
planned
pr
PROOF
proof
prs
Read, Grep, Glob, Bash
rejected
resume
retry
reviewer
running
runStatus
scope_ok
setup
status
stopped
stopReason
suite
^T[0-9]+$
task-implementer
tasks
tasks-ledger:reviewer
tasks-ledger:task-implementer
tasks-plan
title
todo
tools
topic
verdict
verified
worktree
${CLAUDE_PLUGIN_ROOT}
```

## Amendments (rev 4)

These amendments take precedence over the sections above where they differ.

1. **Resume and retry with a live lock.** When the ledger's lock is fresh, the tasks skill shows the
   lock's run id and age, and continues with `takeover` only once the user has confirmed that the
   other run is dead.
2. **Inbox lines.** When the skill appends a task to the inbox, the JSON never ends up inside a shell
   string.
3. **`topic`.** tasks-plan always writes `topic` (the slug from the ledger's file name) and checks it.
4. **Overlap rule.** tasks-plan states the helper's overlap rule exactly as the helper implements it:
   matching ignores case, `\` counts as `/`, a pattern is compared by its literal segment prefix up to
   the first segment containing a glob character, and `..` anywhere in a pattern overlaps everything.
5. **Reviewer is read-only.** The reviewer agent only inspects. It runs no command that can write,
   so it runs no tests either.
6. **Dispatch target.** The dispatch skill never names a permanent branch or the main checkout as the
   place to commit.
7. **Cleanup.** Cleanup leaves an integration branch alone when it was taken over, and deletes a
   branch with `-D` only after its merge is confirmed.
8. **Front-matter test.** A new `tests/frontmatter.test.mjs` pins the fixed front matter of every
   agent and skill, and feeds the dispatch skill's label block through dispatch-guard.

## Amendments (rev 5)

1. **What the reviewer is given.** The reviewer agent is told that the workflow re-ran only
   `.claude/verify.cmd` (its output tail is in the prompt) and that the task's proof was run only by
   the implementer, so its outcome is unconfirmed. The reviewer judges acceptance from the diff and
   the code; when acceptance can only be shown by running the proof, it answers `needs_input` or
   records a finding instead of assuming the proof passed.
2. **`topic` on refresh.** tasks-plan fills in a missing `topic` from the file name. When an existing
   ledger holds a different `topic` and any task has left `todo`/`blocked`, it stops and reports the
   mismatch instead of rewriting it; only a ledger where no task has run yet may get its `topic`
   corrected.

## Amendments (rev 7)

1. **`topic` correction only before the first run.** tasks-plan may correct or fill in `topic` only
   when `runStatus` is `planned` or absent, every task is `todo` with `branch`, `base` and `worktree`
   all null, and no `task/<stored topic>/` branch exists. In every other case it stops and reports the
   mismatch. This replaces rev 5, amendment 2.
2. **Unconfirmed proof is never acceptance.** When acceptance depends on the proof that only the
   implementer ran, the reviewer does not set `acceptance_met` to true: it answers `needs_input`, or
   sets `acceptance_met` to false.
3. **Verify result only with evidence.** The reviewer relies on the `verify.cmd` result only when the
   prompt includes its output tail; without it, verify is unconfirmed as well.

## Amendments (rev 8)

1. **Stored topic is untrusted.** Before tasks-plan uses a stored `topic` in any command, it checks it
   against `^[a-z0-9][a-z0-9-]*$`. A missing or non-matching stored topic is never put into a command;
   the "no `task/<stored topic>/` branch exists" condition then counts as met, because the helper
   never creates branches for such a ledger.
