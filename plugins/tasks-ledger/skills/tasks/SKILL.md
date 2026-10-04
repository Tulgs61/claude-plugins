---
name: tasks
description: Run a list of separable code changes as a tasks-ledger run - plan the ledger, show the rounds, and on the user's go start the tasks-engine workflow (an implementer per task in its own worktree, an independent reviewer, local merges, draft PRs only when asked). Also manages runs - "add <task>" joins a live run, "resume" continues a stopped one, "retry <Tn>" re-queues a blocked task, "status" shows progress.
argument-hint: "<task list> [open PRs] | add <task> | resume | retry <Tn> | status"
---

# tasks

Input: $ARGUMENTS

## Ground rules

These hold in every mode below.

- **Nothing leaves the machine except draft PRs the user asked for.** Never merge a PR, never
  deploy, never push the integration branch, never push to or merge into a permanent branch such
  as `main` or `develop`. Task branches are pushed and draft PRs opened only by the workflow, and
  only when the ledger has `prs: true`.
- **The user decides.** No workflow start without the user's go; an explicit `/tasks` invocation
  for `resume` or `retry` counts as that go. Nothing is removed before the user agrees to the exact
  list. `takeover` is passed only after the user confirms the run holding the lock is dead.
- **Local state stays put.** Never switch the branch of the main checkout. Never edit a ledger file
  while its run is live; a run is live while the ledger's `.lock` file exists with an `at` less than
  six hours old. Reading the ledger is always fine.

## Paths

- `<root>`: the main checkout's top level (`git rev-parse --show-toplevel`).
- `<ledger>`: the absolute path of a ledger in `<root>/.claude/runs/`. When the input does not name
  one, use the most recently modified `.json` there and say which.
- `<helper>`: `${CLAUDE_PLUGIN_ROOT}/scripts/tasks-git.js`, made absolute.
- `<engine>`: `${CLAUDE_PLUGIN_ROOT}/workflows/tasks-engine.js`, made absolute.

Helper calls look like `node "<helper>" <command> "<ledger>" [args]` and print one JSON line; read
`ok` and, on failure, `error`.

## Choose the mode

The first word of the input decides:

| Input | Mode |
|---|---|
| `add <task>` | Add |
| `resume` | Resume |
| `retry <Tn>` | Retry |
| `status` | Status |
| anything else | New run, from a task list; "open PRs" (or similar wording) means PRs were asked for |

## New run

1. **Precondition.** Check `git -C <root> ls-files --error-unmatch .claude/verify.cmd`. If the file
   is not committed, stop and ask the user to add and commit a `.claude/verify.cmd` with a fast,
   safe check command. Nothing else starts until it exists.
2. **Plan.** Run the `tasks-plan` skill with the task list, and say whether PRs were asked for. It
   writes the ledger and returns its path and rounds.
3. **Approve.** Show the rounds (which tasks run together, which wait for which), the base branch,
   and whether PRs will be opened. Ask once for the go. Changes the user wants go back through
   `tasks-plan` before you ask again.
4. **Start** the workflow as described under "Starting the engine".
5. **Report** as described under "Reporting".

## Add

Joins a live run without touching its ledger.

1. Turn the task into one JSON object with at least `title` and `acceptance`. Add `files`,
   `dependsOn`, `proof`, `budget` and `constraints` when you can work them out the way `tasks-plan`
   would (an implementer only starts when proof and budget are present). Leave out `id`; the
   helper assigns one.
2. Append it as a single line to the ledger's inbox, `<ledger without .json>.inbox.jsonl`, for
   example with `printf '%s\n' '<json>' >> "<inbox>"`. Never rewrite existing lines.
3. Tell the user the live run picks it up at its next check for new tasks. If no run is live, it
   is picked up when the run is resumed.

## Resume

1. Read the ledger. If its run is live, say so and stop; offer `status` instead.
2. Start the workflow as under "Starting the engine" with a new run id. If the user asked for their
   own agents for this run, pass those agent arguments again; they are not stored in the ledger.
3. Report.

## Retry

1. Read the ledger. The task must exist and be `blocked`, and the run must not be live; otherwise
   say why and stop.
2. Put it back in the queue through the helper:
   `node "<helper>" status "<ledger>" <Tn> todo "retry requested by the user"`.
3. Continue as in Resume.

## Status

Read the ledger and show, per task, its id, title, status, branch and PR, then the run's
`runStatus`, `stopReason`, and whether a lock makes the run live. Change nothing.

## Starting the engine

Start the Workflow with the script at `<engine>`. If this session may not read files in the
plugin directory, start it by its name `tasks-ledger:tasks-engine` instead. Its args:

```json
{
  "ledger": "<ledger, absolute>",
  "script": "<helper, absolute>",
  "runId": "<fresh id>"
}
```

- `runId` is new for every start and matches `^[A-Za-z0-9-]{4,64}$`, for example
  `run-20261004-153012-k3x9`.
- Only when the user asks for their own agents, add `implementerAgent` and/or `reviewerAgent`
  with the agent type they named (letters, digits, `_`, `-` and `:` only).
- If the result has `locked: true`, another run holds the ledger. Show its error and ask the user
  whether that run is dead. Only on a clear yes start again with `"takeover": true` added to the
  args.

## Reporting

When the workflow returns, read the ledger once more and tell the user:

- **Stopped because**: the result's `stopped`, or that the run completed.
- **Next step**: for example `/tasks retry <Tn>` after fixing what blocked a task, `/tasks resume`
  for waiting tasks, reviewing the draft PRs, or taking over the integration branch
  `task/<topic>/integration` (from the result's `integration` worktree) into the project's own flow.
- **Per task**: id, status, branch and PR (or "none").

## Cleanup

Once a run's work has landed (its PRs merged, or the user took over the integration branch), offer
to remove what the run left behind. List every item first: the worktrees under
`<root>/.claude/worktrees/<topic>-*` and the local `task/<topic>/*` branches. Only after the user
agrees to that list remove them with `git -C <root> worktree remove <path>` and
`git -C <root> branch -D <branch>`. Remote branches and PRs are left alone.
