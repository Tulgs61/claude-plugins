# Changelog

All notable changes to the plugins in this marketplace are documented in this file, one section per
plugin. Each plugin is versioned on its own.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every plugin
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of plugin `<name>` at
version `<version>` is tagged `<name>--v<version>`.

## handover

### [0.1.1] - 2026-10-05

#### Fixed

- `/fresh` arms exactly one marker, under the repository root with symlinks resolved and in the file
  system's canonical spelling (on macOS this also fixes letter case). A `/clear` through a symlinked or
  differently cased path now resumes, and a marker can never be used twice, whatever the order of
  arming and clearing.
- The marker holds only `createdAt`. The hook no longer reads a list of root spellings from it and
  works out both candidate paths itself. A marker with more than one hard link is not trusted.
- The handover injected after `/fresh` is never cut inside a fenced code block or in the middle of a
  surrogate pair. The cut uses the same fence rules as heading detection.

#### Changed

- Tests that could not fail now pin real behaviour: which guard handles a closed or broken stdout,
  fence edge cases, the finished-plan modification-time case and a marker owned by another user.

### [0.1.0] - 2026-10-05

#### Added

- `/handover [focus]` writes or refreshes one `HANDOVER.md` in the repository root, merged in place, with
  branch, SHA, PR and CI state from real commands, linked follow-up issues and one next action.
- `/pickup` reads `HANDOVER.md` and what it points at, checks the recorded state against `git` and the
  forge, reports drift and then carries out the next action.
- `/fresh <next prompt>` writes a lean handover, arms a one-shot marker and carries the next prompt across
  `/clear`.
- SessionStart hook (`startup`, `resume`, `clear`, `compact`): re-injects the handover after `/fresh`,
  asks Claude to re-read the active plan and task ledger after compaction or resume, and hints at pickup
  when a `HANDOVER.md` exists. Node built-ins only, fail-open.
- The `/fresh` marker is honoured only when it is a regular file owned by the current user and not group-
  or world-writable.
- Shared repository conventions in `rules/conventions.md`.

## tasks-ledger

### [0.2.0] - 2026-10-06

#### Changed

- **The verify gate asks before it runs a repository's `verify.cmd`.** A cloned repository is owned by
  you, so ownership checks cannot tell a hostile command apart. The gate now runs a `verify.cmd` only
  after you approved that exact command for that repository. The first time it meets an unapproved one,
  it skips it and prints the approve command once. Paste it exactly as printed into bash or zsh in a
  terminal: its environment prefix selects the store the gate reads. It shows the command with control
  and invisible characters escaped, its line count and hash, and records it only when you type `yes` at
  the terminal. A changed `verify.cmd` needs a new approval, and linked worktrees (registered by git)
  share the main checkout's approval. `verify-consent.js list` and `revoke` manage approvals with the
  same prefix. The real boundary is Claude Code's permission prompt: deny tool calls that run
  `verify-consent.js` or write its store unless you asked for them. **After upgrading, approve
  `verify.cmd` once in each repository where you want the gate to keep running it.** On native Windows
  the approve prompt is not available yet, so the gate does not run `verify.cmd` there.
- The gate also runs on `SubagentStop`, so a subagent working in its own worktree is checked there.
- State is kept per session and project (`claude-verify-<session>-<project hash>.json`), so an edit in
  one repository and a stop in another no longer mix.

#### Fixed

- On timeout the whole process group of the check is ended (SIGTERM, then SIGKILL after 5 seconds), so
  grandchildren of `verify.cmd` no longer linger. On Windows only the direct child is ended.
- The state file is written atomically. An interrupted write can no longer leave an empty file that
  reads as clean, and an unreadable state file of your own counts as dirty.
- A numeric `session_id` no longer disables the gate.
- A group- or world-writable `verify.cmd` is still skipped, now with a one-time warning that suggests
  `chmod 644`.
- `git` and `bash` are started by absolute path from outside the repository, so a program planted in the
  repository can never be picked up.
- Asynchronous errors, including a broken stdout, keep the hook's fail-open promise (exit 0, no
  output).

### [0.1.0] - 2026-10-05

#### Added

- `/tasks-ledger:tasks` plans a JSON task ledger and, on your go, runs the `tasks-engine` workflow; also
  `add`, `resume`, `retry` and `status`.
- `/tasks-ledger:tasks-plan` writes or refreshes `.claude/runs/YYYY-MM-DD-<topic>.json` against
  `schemas/tasks.schema.json` and stops.
- `/tasks-ledger:dispatch` renders the six-part dispatch contract (outcome, proof, constraints,
  deliverable, budget, escalation) for one task.
- `tasks-engine` workflow: one `task-implementer` per task in its own git worktree, `.claude/verify.cmd`
  re-run per task, an independent `reviewer` per task, dependency-ordered local merges and, only when
  asked, one draft PR per task.
- Agents `task-implementer` and read-only `reviewer`, replaceable through the `implementerAgent` and
  `reviewerAgent` workflow args.
- `dispatch-guard` hook: blocks implementer dispatches without a proof or a budget section.
- `verify-gate` hook: runs `.claude/verify.cmd` before a turn ends after edits and blocks that stop once
  when it fails.
- `scripts/tasks-git.js` for every ledger and git side effect of the workflow.

## mockup-loop

### [0.1.0] - 2026-10-05

#### Added

- `/mockup-loop:click-loop` renders 2-4 UI variants side by side in one local page, records your click
  and builds the next round from it until the design fits, then implements it 1:1.
- `scripts/click-loop.mjs` CLI with `init`, `round`, `serve`, `wait` and `stop`; Node built-ins only.
- `scripts/loop-client.js` client helper, served as `/__loop.js`, with `pick('<id>', '<note>')`.
- Local server bound to `127.0.0.1` only, with Host and Origin checks, `POST`-only picks, bounded input,
  served files confined to the loop directory, and automatic exit after 30 idle minutes or 4 hours.
- No hooks: nothing runs unless the skill is invoked.
