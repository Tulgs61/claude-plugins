# handover

Session continuity for Claude Code. One `HANDOVER.md` per repository, written at the end of a session and
picked up at the start of the next one, plus a way to clear the context mid-task without losing the
thread.

| Component | What it does |
|---|---|
| `/handover [focus]` | Writes or refreshes `HANDOVER.md` in the repo root. Merges the existing file instead of replacing it, records branch, SHA, PR and CI state from real commands, links follow-up issues, keeps private data out, and ends with one self-contained next action. |
| `/pickup` | Reads `HANDOVER.md` and what it points at (plan, ledger, PRs), checks the recorded state against `git` and the forge, reports drift, then carries out the next action unless an open question blocks it. |
| `/fresh <next prompt>` | Writes a lean handover whose next action is your next prompt, arms a one-shot marker, and asks you to type `/clear` and then `go`. After the clear, the hook re-injects the handover so the work continues. |
| SessionStart hook | See below. |

Skills are namespaced by the plugin: invoke them as `/handover:handover`, `/handover:pickup` and
`/handover:fresh`. Short names such as `/pickup` may also resolve when no other skill or command
claims the name, but that is not guaranteed; the table above uses them for brevity. Claude also
invokes the skills on phrases such as "wrap up", "continue where we left off" or "clear the context
and then ...".

## The SessionStart hook

`hooks/hooks.json` registers `hooks/session-start-context.js` for the `startup`, `resume`, `clear` and
`compact` sources. It runs with **`node`**, so Node.js must be on your `PATH`. It uses only Node
built-ins, never shells out, and is fail-open: on any error it exits 0 and prints nothing.

What it adds to the session context, by source:

| Source | Context injected |
|---|---|
| `clear`, with a trusted marker armed by `/fresh` for this repo less than 12 hours ago | The essentials of the repo root's `HANDOVER.md` (header, Next action, Threads, Open questions, Traps; capped at 4000 characters) and an instruction to verify state and carry out the next action. The marker is deleted, so this fires once. |
| `compact`, `resume` | "Re-read the plan ... read the task ledger ...", naming the active plan (newest `docs/plans/*.md` whose `status` is not `done`/`abandoned`, legacy fallback `.planning/*-plan.md`) and the newest `.claude/runs/*.json` ledger, when either exists. |
| `startup`, `resume`, `clear` without a valid marker | A one-line hint to run the pickup skill when `HANDOVER.md` exists in the repo root. |

The repo root is the nearest directory above the session's `cwd` that contains `.git`; outside a
repository it is the `cwd` itself.

### The /fresh marker

`scripts/fresh-marker.js` writes `claude-fresh-<hash>.json` into the OS temp directory
(`os.tmpdir()`), where `<hash>` is derived from the normalized repo root. Nothing is written into the
repository. The `/fresh` skill runs it from the installed plugin via `${CLAUDE_PLUGIN_ROOT}`.

The temp directory can be shared with other local users (for example `/tmp` on a multi-user Linux
machine), so the marker is treated as untrusted input:

- **Writing.** The marker is created with mode `0600` under a random name in the same directory and
  renamed over `claude-fresh-<hash>.json`. A symlink already sitting at that path is replaced, never
  followed, so its target is not written. If another user's file occupies the path and cannot be
  replaced, arming fails with a message instead of silently doing nothing.
- **Reading.** The hook opens the marker without following symlinks and honours it only when it is a
  regular file and, on POSIX, owned by the current user and not group- or world-writable. Its
  `createdAt` must lie in the past and be less than 12 hours old; a marker dated in the future is
  ignored. On Windows there is no ownership or mode check (the temp directory is per user there).
- **Content.** The marker supplies only `createdAt`. The hook always injects `<repo root>/HANDOVER.md`
  and ignores any file path named in the marker (older markers had a `handover` field).
- **Cleanup.** A marker owned by the current user is deleted once read, whether or not it was honoured.
  A marker owned by someone else is ignored and left in place.

## Conventions

The skills and the hook share the conventions in [`rules/conventions.md`](rules/conventions.md):

- exactly one `HANDOVER.md` in the repo root, replaced in place, with its git history as the archive;
  briefings and onboarding documents are not handovers;
- plans in `docs/plans/YYYY-MM-DD-<topic>.md` with a `status:` frontmatter, task ledgers in
  `.claude/runs/`, worktrees in `.claude/worktrees/`, private data in a self-ignored `.claude/private/`;
- follow-ups are forge issues (label `follow-up`), linked from the handover rather than listed in prose;
- after compaction or resume, re-read the plan and the ledger instead of working from memory.

A project's own `CLAUDE.md` that says otherwise wins.

## Requirements

- Node.js on `PATH` (hook and marker script).
- `git` for the state the skills collect; `gh` (GitHub) or `glab` (GitLab) optionally, for PR and CI
  state. The skills skip forge checks when the CLI is missing.

## Tests

```bash
node --test "plugins/handover/tests/**/*.test.*"
```

The tests use temporary directories and give the spawned hook an isolated `HOME` and `TMPDIR`, so real
markers are never read or deleted.

## Origin

Ported from a personal Claude Code configuration (its `handover`, `pickup` and `fresh` skills, the
`session-start-context.js` hook, the `fresh-marker.js` script and its repo-artifact rules), with
machine-specific paths replaced by `${CLAUDE_PLUGIN_ROOT}`.

## License

MIT
