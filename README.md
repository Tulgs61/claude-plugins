# tulgs61-plugins

A Claude Code plugin marketplace with three plugins: two for longer, multi-session and multi-agent work,
and one for deciding UI designs by clicking through variants.

| Plugin | What it does |
|---|---|
| [`handover`](plugins/handover/README.md) | Session continuity. `/handover` writes one `HANDOVER.md` per repository (merged in place, with branch, SHA, PR and CI state), `/pickup` continues from it after a drift check, and `/fresh <next prompt>` clears the context and carries the next prompt across `/clear`. A SessionStart hook re-injects the handover after `/fresh` and asks Claude to re-read the active plan and task ledger after compaction or resume. |
| [`tasks-ledger`](plugins/tasks-ledger/README.md) | Runs a list of tasks as a delegated, reviewed workflow. `/tasks` plans a JSON task ledger (acceptance, proof, file ownership, dependencies, budget), then the `tasks-engine` workflow starts one implementer per task in its own git worktree, an independent reviewer per task, dependency-ordered local merges and, only if you asked, one draft PR per task. Two hooks block implementer dispatches without proof and budget and send Claude back to work when the project's verify command fails at the end of a turn. |
| [`mockup-loop`](plugins/mockup-loop/README.md) | Pick UI variants by clicking. `/mockup-loop:click-loop` renders 2-4 variants side by side in one local page served on `127.0.0.1`, you click the one that fits, Claude builds the next round from your pick and the page reloads itself, until the design fits and is implemented 1:1. A small Node CLI serves the page, records picks and wakes Claude through a background waiter. No hooks. |

The plugins are independent; install any of them. Each plugin README has the full reference.

## Install

Inside Claude Code, add the marketplace from GitHub:

```text
/plugin marketplace add Tulgs61/claude-plugins
```

or from a local clone:

```text
/plugin marketplace add /path/to/clone
```

Then install the plugins you want. The install id is `<plugin>@<marketplace>`:

```text
/plugin install handover@tulgs61-plugins
/plugin install tasks-ledger@tulgs61-plugins
/plugin install mockup-loop@tulgs61-plugins
```

The same works from a shell with `claude plugin marketplace add ...` and `claude plugin install ...`.
Plugin skills are namespaced by the plugin, for example `/handover:pickup`, `/tasks-ledger:tasks` or
`/mockup-loop:click-loop`.

## Requirements

- Claude Code with plugin support.
- `node` on `PATH`: every hook, helper script and the `mockup-loop` server is a Node script that uses only
  built-ins. Nothing is installed from npm.
- `git`. Optionally an authenticated `gh` (GitHub) or `glab` (GitLab) for PR and CI state and, in
  `tasks-ledger`, for draft PRs.
- For `/tasks` in `tasks-ledger`: **dynamic workflows**. They are available on paid plans and with API
  access; on Pro, turn on *Dynamic workflows* in `/config`. They must not be disabled (`disableWorkflows`
  setting or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`). There is no separate install step for the workflow:
  Claude Code loads workflow scripts from a plugin's `workflows/` directory, so `tasks-engine` ships with
  the plugin. Planning (`tasks-plan`), `dispatch` and the hooks work without workflows. See
  [tasks-ledger requirements](plugins/tasks-ledger/README.md#requirements).
- For `mockup-loop`: a browser on the same machine as Claude Code, since the mockup page is served on
  `127.0.0.1` only. See [mockup-loop requirements](plugins/mockup-loop/README.md#requirements).

## The `.claude/verify.cmd` opt-in

A repository opts in to verification by committing a `.claude/verify.cmd`: a bash script that exits 0
when the repository is clean (tests, lint, whatever you choose). With `tasks-ledger` enabled:

- the `Stop` hook runs it before a turn ends after edits. If it fails, the hook blocks that stop once and
  hands Claude the output tail. It blocks once per stop chain: the stop that follows a block is allowed
  (`stop_hook_active`), so a still-failing check does not hold the turn open. After 3 failed runs without a
  new edit it stops blocking and only warns. It is a nudge to fix the failure, not a guarantee that the
  turn ends green;
- the `tasks-engine` workflow requires it to start a run and re-runs it in every task's worktree.

Without the file the Stop gate does nothing.

**Which file runs.** The hook takes the nearest `.claude/verify.cmd` between its working directory and the
git root (the repository or worktree root, inclusive). Outside a repository it looks only at
`<cwd>/.claude/verify.cmd`. On POSIX it skips a `verify.cmd` that is not owned by the current user or is
group- or world-writable.

A skipped file silently disables the Stop gate. If your umask is `002` (common on Linux distributions
with per-user groups), new files are group-writable. Git records only the executable bit, not the write
bits, so every clone and every worktree created under umask `002` gets a group-writable `verify.cmd`
again. Run this in each clone and each worktree:

```bash
chmod go-w .claude/verify.cmd
```

or set `umask 022` in your shell profile before you clone or create worktrees.

The same trust rule applies to the `handover` plugin's `/fresh` marker: the SessionStart hook honours it
only when it is a regular file owned by you and not group- or world-writable. See
[The /fresh marker](plugins/handover/README.md#the-fresh-marker).

## Security notes

- **Hooks execute Node scripts from the plugin** in every session where `handover` or `tasks-ledger` is
  enabled (`mockup-loop` has no hooks). The hooks are registered in exec form (`node` with the script path
  under `${CLAUDE_PLUGIN_ROOT}`), use only Node built-ins and fail open on internal errors. Read
  [`plugins/handover/hooks/`](plugins/handover/hooks/) and
  [`plugins/tasks-ledger/hooks/`](plugins/tasks-ledger/hooks/) before you enable them.
- **`verify.cmd` runs with your user's rights.** Review `.claude/verify.cmd` in a repository you did not
  write before you edit files there with `tasks-ledger` enabled.
- **Nothing is pushed by default.** Only when a ledger has `prs: true` (set only when you ask for PRs)
  does `tasks-git` push, and then only `task/<topic>/<id>` branches and, for a merged task with several
  prerequisites, its `task/<topic>/<id>-base` branch (the stacked PR's target). It never pushes the
  integration branch (`task/<topic>/integration`) and never anything outside `task/<topic>/*`. It opens
  draft PRs and never merges them.
- The workflow's agents run under your normal permission rules. The main checkout is never switched; task
  work happens in `.claude/worktrees/<topic>-*`.
- **`mockup-loop` runs a local HTTP server** while a loop is active, started by its skill in the Bash
  tool's background mode. It binds `127.0.0.1` only, answers only requests whose `Host` is
  `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard), accepts picks only by `POST` and rejects
  them from a foreign `Origin`, serves only files inside its loop directory (never `picks.jsonl`, `server.json`
  or dotfiles), and exits after 30 idle minutes or 4 hours. It has no hooks. The text note of a pick is
  treated as untrusted data. See [mockup-loop security](plugins/mockup-loop/README.md#security).

## Repository layout

```text
.claude-plugin/marketplace.json   marketplace manifest
plugins/handover/                 handover plugin
plugins/tasks-ledger/             tasks-ledger plugin
plugins/mockup-loop/              mockup-loop plugin
docs/specs/                       design specs
tests/marketplace.test.mjs        manifest consistency, verify.mjs leak-list handling
scripts/verify.mjs                repo check: leak scan, JSON, JS syntax, all tests
.claude/verify.cmd                runs scripts/verify.mjs
```

Check everything locally:

```bash
claude plugin validate .
node scripts/verify.mjs
```

The leak scan in `verify.mjs` has no built-in patterns. It reads them from `.claude/private/leaks.txt`
(ignored by git), one per line: `/source/flags` in regex literal form, or a bare source that is matched
case-insensitive; blank lines and `#` comments are ignored. A task worktree uses the main checkout's file.
Without the file the leak scan is skipped with a notice and the other checks still run.

## Origin and status

Extracted from a personal Claude Code setup and packaged as plugins. Version 0.1.0. Tested on macOS with
Node 26; Linux and Windows are untested.

## License

[MIT](LICENSE)
