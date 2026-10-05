# Changelog

All notable changes to the plugins in this marketplace are documented in this file, one section per
plugin. Each plugin is versioned on its own.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and every plugin
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release of plugin `<name>` at
version `<version>` is tagged `<name>--v<version>`.

## handover

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
