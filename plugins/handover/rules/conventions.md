# Repository artifact conventions

Shared by the handover, pickup and fresh skills and the SessionStart hook. Where a project's own
`CLAUDE.md` disagrees, the project's `CLAUDE.md` takes precedence.

## Handover

- Exactly one `HANDOVER.md` per repository, at the repository root (the nearest directory with a
  `.git` entry; outside a repository, the working directory).
- It is updated in place. Do not create dated copies or a second handover elsewhere; git history is
  the archive of earlier versions.
- Briefings, onboarding documents and design notes are not handovers, whatever their name.
- Structure: a short preamble (title plus a state line), then `## Next action`, `## Threads`,
  `## Open questions`, `## Traps`, and optionally `## Follow-ups`. The SessionStart hook injects only
  the preamble and the sections whose heading begins with `Next action`, `Open questions`, `Threads`
  or `Traps`, capped at 4000 characters.
- No secrets or customer data. Not committed unless the user asks.

## Plans

- Plans live in `docs/plans/YYYY-MM-DD-<topic>.md`.
- Each has front matter with a `status` field. Finished plans use `status: done` or
  `status: abandoned`; any other value means the plan is active.
- The active plan is the most recently modified one that is not finished. `docs/plans/README.md` is
  not a plan. Legacy repositories may still have `.planning/*-plan.md`, used only when no active plan
  exists under `docs/plans/`.

## Ledgers, worktrees, private data

- Task ledgers live in `.claude/runs/<name>.json`; the newest one is the active ledger.
- Worktrees live in `.claude/worktrees/`.
- Private data (notes with personal or customer information, credentials, local scratch) lives in
  `.claude/private/`, which contains a `.gitignore` with `*` so the directory ignores itself.

## Follow-ups

- Out-of-scope work becomes a forge issue labelled `follow-up`, created only after the user agrees.
- The handover links those issues instead of listing the work in prose.
- When the forge CLI (`gh` or `glab`) is missing, forge checks are skipped and the handover says so.

## After a compaction or a resume

- Re-read the active plan and the task ledger before continuing, instead of working from memory of
  the earlier context. The SessionStart hook names both files after `compact` and `resume`.
