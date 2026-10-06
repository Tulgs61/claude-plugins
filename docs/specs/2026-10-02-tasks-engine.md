---
status: approved
component: tasks-engine
---
# Behaviour spec: tasks-engine workflow

**Scope:** `plugins/tasks-ledger/workflows/tasks-engine.js`.

**Tests:** `plugins/tasks-ledger/tests/tasks-engine.test.mjs` (`eng`) and `tasks-git-prepare.test.mjs`
(`prep`).

**Helper commands** are defined in `2026-10-02-tasks-git.md`, called "the helper spec"
below.

## Purpose

A Claude Code workflow that runs a task ledger to completion:
- each task is implemented by an agent in its own worktree;
- the result is checked by the helper and by an independent reviewer agent;
- accepted work is merged locally;
- PRs are opened only when the ledger asks for them.

The workflow has no file access, so every side effect is delegated to the helper.

## Interface

### Script form

- **Compilation (pinned by eng:109-114).** Delete the first line-initial `export ` from the file. The
  remaining text must then compile as the body of an `async` function with the parameters `args`,
  `agent`, `phase` and `log`.
- **Consequences:**
  - top-level `await` and `return` are allowed;
  - there is no other `export`, no `import` and no `require`;
  - nothing in the body may redeclare those four names.
- **Optional `meta` export.** The file may export a `meta` object for the workflow loader. If it
  does, its name is `tasks-engine`, so the workflow keeps the name the tasks skill uses.
- **Glob-overlap block.** The file contains the glob-overlap block from the helper spec, identical to
  the helper's copy (prep:15-22). Scheduling uses its `globListsOverlap`.

### Runtime calls

| Call | Meaning |
|---|---|
| `agent(prompt, options)` | Runs an agent. Resolves to the structured result when `options.schema` is given, otherwise to the agent's final text, and to `null` when the agent did not finish. Every call passes an options object (eng:143-160). |
| `phase(title)` | Marks progress. Titles are free. |
| `log(text)` | Reports progress. Text is free. |

### Arguments (`args`)

Required keys first, then optional ones; alphabetical within each group.

| Key | Required | Meaning |
|---|---|---|
| `ledger` | yes | absolute ledger path |
| `runId` | yes | must satisfy the helper's run-id rule |
| `script` | yes | absolute path of the helper |
| `implementerAgent` | no | agent type; default `tasks-ledger:task-implementer` |
| `reviewerAgent` | no | agent type; default `tasks-ledger:reviewer` |
| `takeover` | no | truthy: pass `takeover` to `prepare` |

**Agent-type validation** (eng:188-221):
- `undefined` or `null` selects the default.
- Any other value must be a string matching `^[A-Za-z0-9:_-]+$`.
- Otherwise the body throws an error whose message contains `args.<key> must match`. This happens
  before the first `agent()` call.

| Rejected values | Accepted values |
|---|---|
| `task implementer` | `task-implementer` |
| `''` | `other-plugin:review:strict_v2` |
| `42` | |
| a value containing a quote and a semicolon | |
| `tasks-ledger/reviewer` | |
| an array | |

Missing required arguments also throw before any agent runs.

### Result

**Successful prepare.** The return value is an object with these keys (listed alphabetically; the
order is free):

| Key | Content |
|---|---|
| `blocked` | ids `blocked` at the end |
| `integration` | the integration worktree path |
| `ledger` | the ledger path |
| `prs` | the helper's PR results, or `null` |
| `results` | one `{ id, status, note }` per finished task, with `status` either `merged` or `blocked` (eng:183) |
| `stopped` | `null` exactly when the run completed, otherwise a one-line reason (eng:182) |
| `waiting` | ids still `todo` at the end |

**Failed prepare.** The return value is `{ locked, results: [], stopped }`. `locked` comes from the
helper's answer, `stopped` contains the helper's error, and nothing else runs.

The tests pin only `stopped` and `results[].status`. The other keys are what the tasks skill reports
from.

## Behaviour

### End of run

- **Finish.** After a successful `prepare`, the helper's `finish` is always called, with the reason
  when there is one. The run status passed is `stopped` when `stopped` is non-null, else `finished`.
- **PRs.** The helper's `prs` runs only if the ledger asked for PRs and nothing stopped the run. If it
  fails, `stopped` becomes non-null.

### Scheduling invariants

- **Clean run.** On a run without failures, `stopped` is `null` and every task ends `merged`
  (eng:182-183).
- **Parallelism.** Ready tasks with disjoint files run in parallel (eng:185).
- **No overlapping pair.** Two tasks with overlapping files never run at the same time, even when
  both become ready in the same instant (eng:184).
- **Readiness.** A task can start when every one of these independent conditions holds (listed
  alphabetically): all its prerequisites exist and are `merged`; it is `todo`; no running task's
  files overlap its own (`globListsOverlap`).
- **Added tasks.** New tasks that the helper's `sync` reports join the schedule. A `sync` answer never
  removes or overwrites a task already known. Before the run ends, it checks for new tasks at least
  once.
- **Resumed verified tasks.** A task that `prepare` reports as `verified` is merged when it starts,
  with no new implementation or review.
- **First failure.** When the first task ends in any state other than `merged`, `stopped` names that
  task and its reason. Tasks already running are allowed to finish and are recorded, but nothing new
  starts.
- **Unfinished work.** When no task failed but the run still ends with tasks in `todo` or
  `blocked`, `stopped` is non-null and names them.

### Per-task guarantees

- **Merged result.** A successful merge yields a `merged` result.
- **Blocking.** Any failure blocks the task with a note, both in `results` and in the ledger (through
  the helper's `status ... blocked`). Failures include:
  - a review verdict other than `verified`;
  - an implementer or reviewer agent that never finishes;
  - an unexpected exception;
  - a refusal by the helper.
- **Retry.** A failed `verify` gives the implementer exactly one more attempt, in the same worktree and
  with the failure output.
- **Ordering.** The ledger records `verified` before the helper's `merge` runs. The reviewer starts
  only after the helper's `verify` passed. The implementer works only inside the task's worktree that
  the helper made.
- **Dispatchability.** A task missing `budget` or `proof` is blocked and no agent is started for it.

### Agent prompts

**Review schema.** All keys required (eng:156):
- `acceptance_met`, `constraints_ok` and `scope_ok`: booleans;
- `evidence`: a string;
- `findings`: an array of objects with a required string `message`, and optional `file`, `line` and
  `severity`;
- `verdict`: one of `needs_input`, `rejected`, `verified`.

**Reviewer.**
- Started with `options.agentType` equal to the reviewer type. Its prompt does not begin with
  `TASK: ` (eng:154-157).
- It requests the review schema above.
- Outcome: from the prompt alone, without asking back, the reviewer can locate the change, diff it
  against its base, and decide every field of the review schema. It also learns that verification
  already passed.

**Implementer.**
- Started with `options.agentType` equal to the implementer type and no `options.schema`. Its
  prompt begins with `TASK: <id>` followed by whitespace (eng:145-147).
- Any non-null result counts as finished; its content is not interpreted (eng:152).
- Its `PROOF` and `BUDGET` sections must satisfy the dispatch-guard hook.
- It is a complete dispatch contract in the six parts that the kept tasks-ledger `conventions.md`
  fixes, in that document's order. Branch and worktree come on top, and the deliverable is commits
  only, never a push or merge.

### Helper calls ("ops" agents)

**Recognition (eng:143-160).**
- A helper call is an `agent()` call without `agentType` in its options.
- Its options ask for a structured result with a string field `stdout`.
- Its prompt holds a line `node "<script>" <command>` ending in a newline, and no `node "` appears
  earlier in the prompt.
- The ledger path is double-quoted. With the quotes removed and the command split on spaces, the
  parts are the subcommand, the ledger path and, where present, the task id, in that order
  (eng:126-128, eng:158).

**Outcome of a helper call.** `stdout` holds the helper's unmodified stdout from one foreground run
of exactly that command.

**Helper-call contract.** Each command's answer is the last line of `stdout` that is a JSON object,
and an `ok: false` answer is final; only a missing answer or a `null` agent result lets the identical
command be repeated, a bounded number of times; and no two commands that change ledger or git state
ever run at the same time (`verify` changes neither and may overlap with others).

**Fields relied on** (all others optional, because the fake helper omits them; eng:126-142):

| Command | Fields |
|---|---|
| any command, on failure | `error` |
| `merge` | `ok`, `sha` |
| `prepare` | `ok`, `integration`, `prs`, `start`, `tasks` |
| `sync` | `ok`, `tasks` |
| `verify` | `ok`, `tail` |
| `worktree` | `ok`, `base`, `branch`, `worktree` |

## Errors

- Invalid arguments throw before any agent call (eng:205-221).
- Any other failure ends up in the result: either as a blocked task or as a non-null `stopped`.
  Once `prepare` has succeeded, the body itself does not throw.

## Security

- Agent type names are validated before use.
- Text inserted into command lines is restricted to a safe character set.
- Pushing, merging and branch handling happen only through the helper, so its allow-lists apply.
- The reviewer is always a separate agent from the implementer.

## Test-pinned items

- The body signature after removing the export (eng:109-114).
- The glob-overlap block and its byte identity with the helper (eng:14-27, prep:15-22).
- `TASK: <id>` and how typed and untyped calls are recognised (eng:143-157).
- The ops command line format (eng:126-128, eng:158).
- The default agent types (eng:191-192).
- `args.<key> must match`, thrown with zero agent calls (eng:218).
- The reviewer result shape (eng:156).
- `stopped` is `null` and every `results[].status` is `merged` on a clean run (eng:182-183).
- Scheduling without overlap, but in parallel where possible (eng:176-186).

## Allowlist

Entries are sorted alphabetically, ignoring case and leading punctuation.

```text
// BEGIN glob-overlap
// END glob-overlap
^[A-Za-z0-9:_-]+$
acceptance_met
agent
agentType
args
args.<key> must match
blocked
BUDGET
constraints_ok
evidence
findings
globListsOverlap
globsOverlap
implementerAgent
integration
ledger
locked
log
merged
message
meta
needs_input
phase
PROOF
rejected
results
reviewerAgent
runId
schema
scope_ok
script
stdout
stopped
takeover
TASK:
tasks-engine
tasks-ledger:reviewer
tasks-ledger:task-implementer
verdict
verified
waiting
```

## Amendments (rev 4)

These amendments take precedence over the sections above where they differ.

1. **Values from the helper.** `base`, `branch` and `start` are accepted only as git ref names made
   of `[A-Za-z0-9._/-]` that do not begin with `-`. `worktree` is accepted only as an absolute path
   with none of `"`, `$`, `` ` ``, `\`, `!` or control characters; spaces are fine. Any other value
   blocks the task with a one-line reason. Values that must pass: `abc123`, `main`, `origin/main`,
   `task/t/T1`, `/tmp/wt-T1`, `<root>/.claude/worktrees/<topic>-T1`.
2. **Quoting in the reviewer prompt.** Every value inserted into a git command of the reviewer prompt
   is quoted. The pinned ops prompt keeps its exact form.
3. **Consistent review.** A task is merged only when all three review booleans are true and no
   finding has severity `high`. Otherwise the task is blocked with the reason `review inconsistent`.
4. **`stopped` text.** `result.stopped` is always a single line: whitespace runs collapse to one
   space and the text is cut to at most 300 characters.
5. **Glob block.** The block follows amendment 4 of the tasks-git spec (`..` anywhere overlaps
   everything) and stays byte-identical with the helper's copy.

## Amendments (rev 5)

1. **`start` is always checked.** Whenever `prepare` returns a `start` value, it must satisfy the
   ref-name rule of amendment 1 (rev 4), independent of whether a task uses it as its diff base. An
   invalid `start` blocks every task the run would drive, each with a one-line reason.
2. **`..` in ref names** is rejected, as git itself rejects it.
3. **Tests** cover an invalid `start` for a task whose base begins with `task/`, a `stopped` text
   coming from unfinished tasks, and that the reason passed to `finish` has no line break.

## Amendments (rev 6)

1. **Run id on `sync`.** Every `sync` call the engine makes carries the run's own run id as its
   argument, so the helper refreshes the lock only while it still names this run (tasks-git rev 5,
   amendment 2). The ops prompt keeps its pinned form, with the run id as the one argument after
   `sync`.

## Amendments (rev 7)

1. **`start` is checked once.** Right after a successful `prepare`, the engine checks `start` (when
   present). If it is invalid, the engine starts no agent: every task it would otherwise drive
   (`todo` or `verified`) is blocked with a one-line reason, and `stopped` names the invalid `start`,
   even when there is no task to drive. This replaces the per-task check of rev 5, amendment 1.
2. **Run id on `finish`.** The engine passes its run id as the last argument of `finish`, so the
   helper removes only this run's lock (tasks-git rev 7). The ops prompt keeps its pinned form.

## Amendments (rev 10)

These amendments take precedence over every earlier section and amendment where they differ. They
rely on tasks-git rev 10 (the `agents` key in the `prepare` answer, `needsAcceptance`, and the
refusal of invalid task ids).

1. **Lock refresh during long batches.** The engine refreshes the run lock not only when a task
   finishes but at every agent boundary: right before it starts an implementer or reviewer agent,
   and right after such an agent returns. To refresh, it calls the existing `sync <runId>` (no new
   helper command).
   - A refresh is skipped when the previous successful `sync` of this run is less than 10 minutes
     old, measured with the clock.
   - Tasks that a refresh's `sync` reports as added join the schedule as usual.
   - A failed refresh is logged and does not stop the run.
2. **Agent types from the ledger.** The agent type for implementers is `args.implementerAgent` when
   given, otherwise `agents.implementer` from the `prepare` answer, otherwise the default. The same
   order applies to the reviewer with `reviewerAgent` and `agents.reviewer`. A value taken from the
   ledger must pass the same agent-type rule. If it does not, no agent starts and `stopped` contains
   `agents.<key> must match`.
3. **Tasks that need acceptance.** A task with `needsAcceptance: true` is never started. It is
   blocked, through the helper's `status … blocked`, with the reason `needs acceptance`, and no agent
   runs for it.
4. **Task ids.** A task in the `prepare` answer whose id does not match `^T[0-9]+$` is never started
   and appears in `blocked` and in `stopped`. The helper refuses such ledgers (tasks-git rev 10), so
   this is a second line of defence. It makes no `status` call for that id.
5. **Path arguments.** `args.ledger` and `args.script` must be absolute paths with no whitespace, no
   control characters (C0, DEL and C1) and neither U+2028 nor U+2029. Otherwise the body throws, before
   any agent runs, with `args.<key> must match`. The same character rule applies to a `worktree`
   value from the helper (in addition to rev 4, amendment 1), but spaces stay allowed there.
6. **One-line cut.** Shortening a text to one line never splits a surrogate pair. When the cut would
   fall between the two halves of a pair, it falls before the pair.
7. **Comment.** The comment above the `finish` calls says that a finished run passes an empty reason,
   which the helper stores as `null` (tasks-git rev 8).
8. **Named takeover.** When `args.takeover` is a string matching the helper's run-id rule, the engine
   calls `prepare <runId> takeover <args.takeover>`. Any other truthy value calls `prepare <runId>
   takeover` as before. A string that does not match the run-id rule throws before any agent runs,
   with `args.takeover must match`. The ops prompt keeps its pinned form, with the extra argument
   after `takeover`.
9. **Tests**, in new test files, each able to fail before the change:
   - failure paths: helper refusal on `worktree`, `verify`, `merge` and `status`, an implementer that
     never finishes, a thrown exception, each giving a blocked task with a note;
   - a task that becomes ready later and has an invalid `start` is not started;
   - the 300-character cut applied to a `stopped` text built from unfinished tasks;
   - `finish`: the engine's handling of the helper's answer, both `ok: false` and a superseded
     run, not only where the run id sits in the command;
   - one test per amendment 1-6 and 8, including a refresh between two long agent calls, ledger `agents`
     used and overridden by `args`, a `needsAcceptance` task, a whitespace `args.ledger`, a U+2028 in
     `args.script`, and a cut through an emoji.

### Fixes after review (rev 10, continued)

10. **Unstartable tasks never halt the run.** Tasks with `needsAcceptance: true` and tasks with an invalid
    id are handled once, right after `prepare` and after every `sync` that reports them, whether or not
    they are ready. Each is blocked through the helper's `status … blocked` (a `needsAcceptance` task with
    the reason `needs acceptance`; an invalid id gets no `status` call, as in amendment 4). They do not
    count as the run's first failure, so the other tasks keep running. At the end `stopped` names each of
    them exactly once, by exact id (no substring matching), for example `T4 needs acceptance; invalid
    task ids: 1`. This replaces the "is never started" handling of amendments 3 and 4 where it differs.
11. **Result keys.** The result also carries `locked`: `true` when `finish` was refused because another
    run holds the lock, otherwise `false`. A refused `finish` makes `stopped` non-null with the reason
    `finish failed: <error>`, added after any earlier reason. The Result table includes `locked`.
12. **Visible test data.** Invisible characters in test sources (no-break space, line and paragraph
    separators, other format characters) are written as `\u` escapes.
13. **Tests**, each able to fail before the change: ids `1` and `T1` where `T1` fails, so `stopped` names
    both; `[T1 needsAcceptance, T2, T3 dependsOn T2]`: T2 and T3 merge and T1 is blocked and named;
    a `needsAcceptance` task whose prerequisite never merges is still blocked in the ledger; `locked`
    in the result. The amendment 9 tests that pin behaviour that already existed may pass before the
    change. They are coverage.
14. **Unstartable means never ready.** The readiness check itself excludes every task with
    `needsAcceptance: true` and every task with an invalid id, so no scheduling step can start one, whatever
    order the helper calls finish in. Such a task is marked as set aside in the engine's own state
    synchronously, as soon as an answer reports it and before any further `await`. The helper's
    `status … blocked` call follows. A title-only task that also lacks `proof` or `budget` is set aside the same
    way (reason `needs acceptance`) and never counts as the run's first failure. Test: a lock-refresh `sync`
    during two running tasks reports five `needsAcceptance` tasks; none of them gets an implementer,
    reviewer, `status verified` or `merge`, and all five are named in `stopped`.
