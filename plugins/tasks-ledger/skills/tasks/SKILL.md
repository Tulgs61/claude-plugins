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
  six hours old and the user has not confirmed that its run is dead. Reading the ledger is always
  fine.

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
2. Write that object, on a single line followed by one newline, to a new scratch file with the
   Write tool (for example `<root>/.claude/runs/.add-<random>.jsonl`). The JSON never goes into a
   shell string: no `echo`, `printf`, heredoc or `node -e` carrying it.
3. Append the scratch file to the ledger's inbox, `<ledger without .json>.inbox.jsonl`, with
   `cat "<scratch>" >> "<inbox>"`, then delete the scratch file with `rm "<scratch>"`. Never rewrite
   existing inbox lines.
4. Tell the user the live run picks it up at its next check for new tasks. If no run is live, it
   is picked up when the run is resumed.

## Live lock

Resume and Retry first read the ledger's `.lock` file (`<ledger without .json>.lock`, a JSON object
with `runId` and `at` in epoch milliseconds). When it is fresh (`at` less than six hours ago):

1. Show the user the lock's run id and its age (now minus `at`, in minutes or hours).
2. Ask whether that run is dead, and stop until they answer. Offer `status` meanwhile.
3. Only on a clear yes continue, and start the engine with `"takeover": true`. On anything else,
   change nothing and stop.

A stale or missing lock needs no question and no `takeover`.

## Resume

1. Read the ledger and handle a fresh lock as under "Live lock".
2. Start the workflow as under "Starting the engine" with a new run id, adding `takeover` only when
   the user confirmed under "Live lock" that the other run is dead. If the user asked for their own
   agents for this run, pass those agent arguments again; they are not stored in the ledger.
3. Report.

## Retry

1. Read the ledger. The task must exist and be `blocked`; otherwise say why and stop.
2. Handle a fresh lock as under "Live lock". Nothing below happens until the user has confirmed
   that the locked run is dead.
3. Put the task back in the queue through the helper:
   `node "<helper>" status "<ledger>" <Tn> todo "retry requested by the user"`.
4. Continue as in Resume from step 2, with `takeover` if it was confirmed in step 2.

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
- If the result has `locked: true`, another run holds the ledger. Show its error, which names the
  lock's run id and age, and ask the user whether that run is dead. Only on a clear yes start again
  with `"takeover": true` added to the args.

## Reporting

When the workflow returns, read the ledger once more and tell the user:

- **Stopped because**: the result's `stopped`, or that the run completed.
- **Next step**: for example `/tasks retry <Tn>` after fixing what blocked a task, `/tasks resume`
  for waiting tasks, reviewing the draft PRs, or taking over the integration branch
  `task/<topic>/integration` (from the result's `integration` worktree) into the project's own flow.
- **Per task**: id, status, branch and PR (or "none").

## Cleanup

Once a run's work has landed (its PRs merged, or the user took over the integration branch), offer
to remove what the run left behind.

1. **Collect.** The worktrees under `<root>/.claude/worktrees/<topic>-*` and the local
   `task/<topic>/*` branches.
2. **Leave a taken-over integration branch alone.** When the user took over the integration branch
   `task/<topic>/integration` into the project's own flow, it and its worktree
   `<root>/.claude/worktrees/<topic>-integration` are not cleanup items. Ask when you cannot tell.
3. **Confirm each merge.** A task branch counts as merged only when its PR is merged
   (`gh pr view <pr> --json state` shows `MERGED`) or `git -C <root> branch --merged <baseBranch>`
   lists it. A `task/<topic>/<Tn>-base` branch counts as merged once task `<Tn>` does. Anything
   unconfirmed stays and is named in your report.
4. **List and ask.** Show every item you would remove, marked as merged-confirmed. Remove nothing
   before the user agrees to that list.
5. **Remove.** Worktrees with `git -C <root> worktree remove <path>`. Branches with
   `git -C <root> branch -d <branch>`; use `git -C <root> branch -D <branch>` only for a branch whose
   merge was confirmed in step 3 (a squash merge, for example, leaves `-d` refusing).

Remote branches and PRs are left alone.
