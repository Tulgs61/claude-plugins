# Changelog

All notable changes to the plugins in this marketplace are documented in this file, one section per
plugin. Each plugin is versioned on its own.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every plugin
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of plugin `<name>` at
version `<version>` is tagged `<name>--v<version>`.

## handover

### [0.1.2] - 2026-10-06

#### Changed

- The check that a `/fresh` marker owned by another user is neither honoured nor deleted is now tested on
  every platform without root, by running the hook with a stubbed `process.getuid`. A control test with
  the owner's uid shows the same setup resumes, so the foreign-owner result comes from the owner check.

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

### [0.4.1] - 2026-10-06

#### Security

- Atomic writes of the ledger and the run lock create their temporary file exclusively and never follow a
  symbolic link at that name. The name now carries a random part. When something already exists there,
  the write fails, nothing outside the runs directory is written, and the target is unchanged.
- Lines appended to the inbox while `sync` was reading it are carried over only into a new inbox or into
  an existing regular file with a single link. Before, they were appended through whatever was at the
  inbox path, including a symbolic link or a FIFO. In every other case the lines stay in the moved-aside
  inbox, and the answer warns and names that file.

#### Fixed

- A carry-over that cannot be written no longer fails `sync` or `prepare`, and no longer makes `prepare`
  roll back the run lock after the ledger was written: the answer stays successful and warns.
- A carry-over write that fails partway is undone. When another writer appended to the inbox in the
  meantime, or the truncation itself fails, the inbox is left as it is and the warning says it may hold
  part of the lines; when another writer's lines may have been joined to them, it also names the inbox
  to check.
- When a failed `prepare` cannot restore the previous lock, the answer keeps the original error, adds the
  restore error, and says when the lock still holds the failed call's text. Before, the restore error
  could replace the original one.
- Errors from closing the inbox no longer turn a successful `sync` or `prepare` into a failure.

### [0.4.0] - 2026-10-06

#### Changed

- An approval of `.claude/verify.cmd` now covers one check directory: the directory that contains
  `.claude/`, relative to the top level of its checkout. An identical `verify.cmd` in another directory of
  the same repository needs its own approval. Linked worktrees still share the main checkout's approvals.
  Existing approvals count as top-level approvals: a check below the top level that was approved before
  0.4.0 asks again and needs a new approval. `list` prints a third column for approvals below the top
  level; `revoke` still removes every approval for the repository.
- The approve command the gate prints also pins the `~/.claude` default store
  (`CLAUDE_PLUGIN_DATA=` and `CLAUDE_CONFIG_DIR='<home>/.claude'`, with the home directory the hook
  resolved), so it records into the store the gate reads even when the terminal's `HOME` differs.
- The approval request says the command is for a POSIX shell such as bash or zsh. A path with a backslash
  that shells read differently inside single quotes (before another backslash or a single quote, or at
  the end of the path) gets no command; the request names the path instead.
- `approve` refuses a check directory that cannot be stored (absolute, with a `..` segment, or with a
  control or invisible character) and exits 2.
- Going back to a version before 0.4.0 widens per-directory approvals: an earlier version reads an
  approval for a subdirectory as an approval of the same command in any directory of the repository, and
  rewrites it as a top-level approval the next time it rewrites the store. Revoke such approvals before
  downgrading.

#### Security

- The consent store is never resolved against the working directory. When the value that selects it
  (`CLAUDE_PLUGIN_DATA`, else `CLAUDE_CONFIG_DIR`, else the home directory) is not an absolute path, no
  approval applies, the request offers no command, and `approve`, `revoke` and `list` change nothing and
  exit 2. Before, a relative value let a file inside the repository act as the store and approve the
  repository's own `verify.cmd`.

### [0.3.2] - 2026-10-06

#### Fixed

- The tasks engine no longer reads the clock. The workflow runtime does not allow `Date.now()`, so the
  first successful `sync` ended every real run with "unexpected error". The run-lock refresh is now
  driven by a 10-minute timer.
- A single long implementer or reviewer call no longer lets the run lock go stale: while one runs, the
  engine refreshes the lock every 10 minutes (a heartbeat), and retries after a failed refresh. At most
  one refresh is in flight, and no timer outlives the run.

#### Changed

- The README notes the limits of the heartbeat: it waits for a free agent slot when every slot is busy,
  and timers do not fire while the computer sleeps.

### [0.3.1] - 2026-10-06

#### Fixed

- A bare `takeover` of an unreadable lock no longer leaves the moved-aside copy behind. If writing the
  new lock fails, the old lock is put back; after success, or when another run replaced the lock in the
  meantime (including when the lock path became a link or another unsafe file), the copy is removed.
  Only when the guard cannot be taken to restore the lock, or renaming the copy back fails, is the copy
  kept, and the error names its path after the original error. A failed atomic write leaves no
  temporary file.
- `cannot create guard` errors name the system error code once (`EACCES: permission denied, …`, not
  `EACCES: EACCES: …`).

#### Changed

- The test for a ledger swapped for a FIFO also checks the success case: the listing comes from the
  original file.

### [0.3.0] - 2026-10-06

#### Changed

- `dispatch` commits on `dispatch/<slug>` in `.claude/worktrees/dispatch-<slug>`, never on a `task/…` branch,
  so it can't collide with a run's branches. It refuses a live run's worktrees, and tasks-plan never
  picks a `dispatch` topic.
- Agent-type overrides are recorded in the ledger's `agents` object, so `resume` in a new session uses
  them again. Workflow args still take precedence.
- A takeover names the run it replaces (`prepare <runId> takeover <heldRunId>`). The tasks skill passes the
  run id it showed you, so a lock that changed in the meantime is not replaced.
- A title-only task added to the inbox is stored with `needsAcceptance: true`. The engine blocks it
  without stopping other work, and `retry` asks for its acceptance, proof and budget.
- `verify` and `merge` run the `verify.cmd` committed on the task's base. A branch that changes it in
  any letter case is refused, and an empty one fails.

#### Fixed

- The run lock and its guard: guards always name their owner and are broken only when the owner is gone
  or after 10 minutes, a live holder is never broken, and release removes only its own guard. Every
  ledger write is a read-modify-write under the guard. Overlapping `sync`, `prepare`, `finish`, `status`,
  `merge` and `worktree` calls can no longer undo each other or lose ingested inbox lines.
- `sync` without a run id no longer refreshes the lock. The engine refreshes it at agent boundaries, so
  long batches are not taken over as stale.
- An unreadable or unparsable lock is treated as held by `prepare` (a bare `takeover` still replaces
  it), and another user's lock or ledger is refused. The inbox may be written by others, so a foreign
  inbox is still ingested, but one that cannot be opened is owner-checked. Checked files and the guard are
  read through a single no-follow, non-blocking open, so a FIFO or symlink can neither redirect nor
  block the helper.
- `merge` reports untracked files in the integration worktree as such, not as a conflict, and overlap
  warnings skip merged tasks.
- The engine refuses whitespace and control characters in its path arguments, never splits a surrogate
  pair when shortening text, blocks invalid task ids, and reports a refused `finish` (`locked` in the
  result).
- The skills re-read the lock before they edit a ledger, and cleanup refuses while a run is live and
  collects only worktrees on `task/<topic>/…` branches.

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
