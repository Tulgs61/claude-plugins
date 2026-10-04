---
name: pickup
description: Resume work from HANDOVER.md in the repository root. Checks the recorded state against git and the forge, reports drift, then carries out the next action unless an open question blocks it. Use when the user wants to continue where they left off ("continue where we left off", "pick up", "where were we"), or when the SessionStart hook says HANDOVER.md exists.
---

# Pickup

Goal: work resumes from `HANDOVER.md`. Before acting, every mismatch between the file and the actual
repository and PR state is reported. A blocking open question is asked, not guessed.

Conventions: see `${CLAUDE_PLUGIN_ROOT}/rules/conventions.md`. A project's own `CLAUDE.md` wins where
it disagrees.

## Steps

1. **Find the file.** `git rev-parse --show-toplevel` (outside a repository: the working directory),
   then read `<root>/HANDOVER.md` fully. If it does not exist, say so and stop.
2. **Read what it points at:** the plan, the task ledger in `.claude/runs/`, linked issues and PRs.
   When the handover names no plan, look for the active one in `docs/plans/` (front-matter `status`
   not `done` or `abandoned`).
3. **Check for drift** with real commands:
   - `git status --short --branch`, `git rev-parse --short HEAD`, `git log --oneline -5`: branch,
     commit and working tree against what the preamble records;
   - `git stash list`, `git worktree list` when the handover mentions them;
   - PR and CI state with `gh` (GitHub) or `glab` (GitLab). If the CLI is missing, skip the forge
     checks and say that they were skipped.
4. **Report** before acting: a short list of mismatches (new commits, other branch, uncommitted
   changes, merged or closed PRs, failed CI), or "no drift". If the drift makes the next action
   wrong or unsafe, stop and ask.
5. **Open questions.** If an open question blocks the next action, ask it, with the recorded
   recommendation, and wait for the answer. Non-blocking questions can be mentioned and left open.
6. **Carry out the next action**, then continue with the threads as the plan and the user direct.

## Limits

- Do not commit, push or create issues on the strength of the handover alone; those still need the
  user's go-ahead as usual.
- Update `HANDOVER.md` in place (via the handover skill) when the session ends; do not create a
  second file.
