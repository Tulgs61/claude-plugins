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
  list. `takeover` is passed only after the user confirms the run holding the lock is dead, and its
  value is always the run id shown to the user, never `true`.
- **Local state stays put.** Never switch the branch of the main checkout. Never edit a ledger file
  while its run is live; a run is live while the ledger's `.lock` file exists with an `at` less than
  six hours old and the user has not confirmed that its run is dead. Right before every edit of the
  ledger itself, read the `.lock` again as under "Before a ledger edit". Reading the ledger is
  always fine.
- **No runs on a `dispatch` topic.** A ledger whose `topic` is `dispatch` or starts with
  `dispatch-` is never started, resumed or retried; see "Dispatch topics".

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
   whether PRs will be opened, and the agent types if the user asked for their own. Ask once for the
   go. Changes the user wants go back through `tasks-plan` before you ask again.
4. **Agent types.** If the user asked for their own agents, record them in the ledger as under
   "Agent types" before the start.
5. **Start** the workflow as described under "Starting the engine", once the ledger's `topic` has
   passed the check under "Dispatch topics".
6. **Report** as described under "Reporting".

## Add

Joins a live run without touching its ledger.

1. Turn the task into one JSON object with at least `title` and a non-empty `acceptance`. If you
   cannot state an observable acceptance from the input, ask the user for one; never write the line
   without it. Add `files`,
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
3. Only on a clear yes continue, and start the engine with `"takeover": "<lock runId>"`, the run id
   you showed the user (never a bare `"takeover": true`, which would replace whatever run holds the
   lock by then). The helper call then reads `prepare <runId> takeover <heldRunId>`, so a lock that
   changed in the meantime is not replaced. On anything else, change nothing and stop.

A stale or missing lock needs no question and no `takeover`.

## Before a ledger edit

The lock can change while the user answers. Right before you edit the ledger file yourself
(recording `agents`, writing an acceptance, `proof` or `budget`), read its `.lock` again, even when
you read it a moment ago. Edit only when the lock is:

- missing;
- stale (`at` more than six hours ago); or
- still exactly the `runId` and `at` you showed the user when they confirmed that its run is dead.

Otherwise (a fresh lock you have not shown, or one whose `runId` or `at` changed since) edit nothing:
show the lock's run id and age, stop, and ask again as under "Live lock".

## Dispatch topics

New run, Resume and Retry first read the ledger's `topic`. If it is `dispatch` or starts with
`dispatch-`, refuse: start, resume and retry nothing, and tell the user

- **why**: `dispatch/<slug>` branches and `<root>/.claude/worktrees/dispatch-<slug>` worktrees
  belong to the dispatch skill, and a run under such a topic would put its `task/<topic>/…`
  branches and `<topic>-…` worktrees among them;
- **how to rename it**: pick a new slug that matches `^[a-z0-9][a-z0-9-]*$` and is neither
  `dispatch` nor starts with `dispatch-`, rename the ledger to `YYYY-MM-DD-<new slug>.json` (and its
  `.inbox.jsonl`, if there is one, to match), then run `tasks-plan` on it, which sets `topic` to the
  new slug. `tasks-plan` corrects a `topic` only before the first run; once the run has created
  branches or worktrees under the old topic, clean those up first or plan the remaining tasks into a
  new ledger.

You rename nothing yourself.

## Agent types

When the user asks for non-default agent types, record them in the ledger's top-level `agents`
object: `implementer` for the implementer's agent type, `reviewer` for the reviewer's, each only when
asked for (letters, digits, `_`, `-` and `:` only, at most 64 characters). Write the ledger with the
Edit tool only before the run starts, never while a run is live, and only after reading the `.lock`
again as under "Before a ledger edit"; the engine reads the object from
the ledger on every start, so a resume needs nothing more. Passing `implementerAgent` or
`reviewerAgent` as engine arguments still overrides the ledger; do that only when the user wants a
different agent for this one start.

## Resume

1. Read the ledger, refuse a `dispatch` topic as under "Dispatch topics", and handle a fresh lock
   as under "Live lock".
2. If the user asked for other agent types this time, record them as under "Agent types" (the run
   is not live now: its lock is stale, missing, or confirmed dead).
3. Start the workflow as under "Starting the engine" with a new run id, adding `takeover` with the
   shown run id only when the user confirmed under "Live lock" that the other run is dead. Agent
   types already in the ledger's `agents` object need no engine arguments.
4. Report.

## Retry

1. Read the ledger and refuse a `dispatch` topic as under "Dispatch topics". Retry admits two
   cases: a `blocked` task, and a `todo` task with `needsAcceptance` true. Any other task (or an
   unknown id) is refused: say why and stop.
2. Handle a fresh lock as under "Live lock". Nothing below happens until the user has confirmed
   that the locked run is dead.
3. **Needs acceptance.** If the task has `needsAcceptance` true (a title-only line someone
   appended to the inbox), refuse the retry until the user supplies an observable acceptance. Such a
   task usually lacks `proof` and `budget` as well, and without them it is blocked again: ask for
   the missing `proof` and `budget` together with the acceptance, or work them out with the user the
   way `tasks-plan` would. Then, with no run live and after reading the `.lock` again as under
   "Before a ledger edit", write the acceptance to the task's `acceptance` and any missing `proof`
   and `budget` in the ledger with the Edit tool, and remove its `needsAcceptance` key in the same
   edit.
4. Only if the task is `blocked`, put it back in the queue through the helper:
   `node "<helper>" status "<ledger>" <Tn> todo "retry requested by the user"`. A `todo` task is
   already queued and gets no `status` call.
5. Continue as in Resume from step 2, with `takeover` set to the run id shown in step 2 if the user
   confirmed there that its run is dead.

## Status

Read the ledger and show, per task, its id, title, status, branch and PR, then the run's
`runStatus`, `stopReason`, and whether a lock makes the run live. List every task with
`needsAcceptance` true as needing acceptance, with the hint `/tasks retry <Tn>` once the user has one.
Change nothing.

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

- Never start on a ledger whose `topic` is `dispatch` or starts with `dispatch-` (see "Dispatch
  topics").
- `takeover` is added only after the user confirmed that the locked run is dead, and its value is
  that run id as a string, for example `"takeover": "run-20261004-120000-ab12"`; never `true`.
- `runId` is new for every start and matches `^[A-Za-z0-9-]{4,64}$`, for example
  `run-20261004-153012-k3x9`.
- Agent types the user asked for are in the ledger's `agents` object (see "Agent types"). Add
  `implementerAgent` and/or `reviewerAgent` only when the user wants an override for this one start;
  they win over the ledger.
- If the result has `locked: true`, another run holds the ledger. Show its error, which names the
  lock's run id and age, and ask the user whether that run is dead. Only on a clear yes start again
  with `takeover` set to that run id, so the helper runs `prepare <runId> takeover <heldRunId>`.
  If the lock names another run by then, the start is refused again: show the new run id and ask
  anew.

## Reporting

When the workflow returns, read the ledger once more and tell the user:

- **Stopped because**: the result's `stopped`, or that the run completed.
- **Next step**: for example `/tasks retry <Tn>` after fixing what blocked a task, `/tasks resume`
  for waiting tasks, reviewing the draft PRs, or taking over the integration branch
  `task/<topic>/integration` (from the result's `integration` worktree) into the project's own flow.
- **Per task**: id, status, branch and PR (or "none").
- **Needs acceptance**: every task with `needsAcceptance` true, marked as needing an acceptance
  before `/tasks retry <Tn>` can run it.

## Cleanup

Once a run's work has landed (its PRs merged, or the user took over the integration branch), offer
to remove what the run left behind.

0. **Check the lock.** First read the ledger's `.lock`. While it is fresh (`at` less than six hours
   ago), the run is live: remove nothing, name the lock's run id and age, and stop.
1. **Collect.** Use the ledger's `topic` only when it matches `^[a-z0-9][a-z0-9-]*$`; otherwise
   collect nothing and say why. Collect the local `task/<topic>/*` branches, and the worktrees whose
   checked-out branch is one of them: in `git -C <root> worktree list --porcelain`, a worktree
   counts only when its `branch refs/heads/task/<topic>/…` line says so, never by its directory
   name alone. A `dispatch-<slug>` worktree on a `dispatch/<slug>` branch is never a cleanup item,
   whatever its directory is called.
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
