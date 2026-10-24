---
status: in-progress
issue: "#31"
branch: feature/tasks-dispatch-cleanup
---

# tasks-ledger: a cleanup command and a parallelism cap

## Problem

Two parts of a `/tasks` run are still loose. Both come from a review of how the
pipeline dispatches agents into worktrees and cleans up after them.

1. **Cleanup is prose, not code.** `finish` (`opFinish`, tasks-git.js) sets `runStatus`
   and releases the lock, and nothing more. Removing task worktrees, the integration
   worktree and `task/<topic>/*` branches is a five-step procedure in
   `skills/tasks/SKILL.md` "## Cleanup". The model carries it out by hand with raw `git`
   and `gh` calls, one tool call per item. That is slow and easy to get wrong: a `-D` on
   a branch whose merge was never confirmed, or a removed worktree that still had work
   in it. Worktrees pile up under `.claude/worktrees/`; the last run left 10.
2. **No limit on concurrent tasks.** The engine's main loop starts every ready task at
   once. On a wide ledger, ten file-disjoint tasks mean ten implementers and ten
   worktrees at the same time, which costs tokens, machine load and rate limits.
   Nothing in the ledger can say "at most N".

Already solved, so out of scope: the file-overlap check is glob-aware
(`globListsOverlap`, kept identical in helper and engine), and PR bodies carry no
attribution footer.

## Steps

### Phase 0: release the follow-ups (separate PR, merged first)

The follow-up PRs #22–#29 (issues #8, #11, #12, #13, #15, #19, #20, #21) land on `main`
without a version bump. A `chore(tasks-ledger): 0.5.1` PR does the bump:
- the version in `plugins/tasks-ledger/.claude-plugin/plugin.json`
- the tasks-ledger entry in `.claude-plugin/marketplace.json` (repo root, version at
  line 18)
- a 0.5.1 entry in the root `CHANGELOG.md` under `## tasks-ledger`

**Hard prerequisite:** Phase 0 and Phase 4 edit the same version files, so the
feature branch starts from `main` after the 0.5.1 PR has merged.

### Phase 1: helper `cleanup` command (`plugins/tasks-ledger/scripts/tasks-git.js`)

`cleanup <ledger> [dry-run]`. The optional last word is `dry-run`, written the same way
as `prepare`'s `takeover`. The answer is one sealed JSON line, as with every command.

**Lock.**
- `cleanup` takes the run lock for its whole duration, dry run included. It uses
  `acquireLock(ctx, <cleanup run id>, false)`, with no takeover, and removes the lock
  at the end.
- A live run, or a racing `prepare`/resume, is therefore refused with `ok:false` and
  `locked:true`, and nothing changes. A `prepare` that starts during cleanup is refused
  in the same way.
- The ledger file itself is never written.
- After a crashed engine the lock blocks cleanup for up to `LOCK_TTL_MS` (6 h). The way
  out is `/tasks resume` (takeover) followed by a normal `finish`. Cleanup gets no
  takeover of its own, and the skill says so.

**Items.**
- Items are local branches `task/<topic>/<id>`, `task/<topic>/<id>-base` and
  `task/<topic>/integration`, plus each worktree whose checked-out branch (from
  `git worktree list --porcelain`) is one of them. The match is on the branch, never on
  the directory name.
- The main worktree and branches outside `task/<topic>/` are never items.
- A worktree outside `<root>/.claude/worktrees/` is kept and reported as `outside`, for
  example a hand-made review checkout. Its branch stays too.

**Merge confirmation for a task branch.** A local branch is removed only when its
**local tip** is safe. Either condition is enough:
- **(a)** The tip is an ancestor of `<baseBranch>` or of `origin/<baseBranch>`. The
  command first runs `git fetch -q origin <baseBranch>`, and a failed fetch does not
  stop it. This covers merge-commit and fast-forward merges.
- **(b)** `t.pr` is set, the forge reports it merged (`gh pr view <url> --json
  state,headRefOid`, or `glab mr view <url> -F json` with `state` and `sha`), **and**
  the local tip equals that PR head sha. This covers squash merges.
- Otherwise the branch is kept as `unconfirmed`. If the PR is merged but the local tip
  has commits after its head, the reason is `unconfirmed: local commits after the
  merge`. If the PR is still open, the reason is `pr open`.
- A `-base` branch is confirmed when its tip is an ancestor of its task's confirmed
  tip, or when (a) holds.
- A stacked PR merges into its prerequisite's remote `task/` branch, not into the base.
  Its local branch is deleted once (b) holds, and its content then lives on in the
  remote branch, which cleanup never touches. The spec says so.

**Integration branch.** It is confirmed only when:
- its tip is an ancestor of the base, or
- `git rev-list <integration> --not <every task tip> --no-merges` is empty, meaning
  every non-merge commit on it came from a task, every task is confirmed, and no commit
  was made directly on the integration branch.

Otherwise it is kept as `unconfirmed`, which covers the taken-over case the skill
handles today. With `prs: false` and a squash landing, the user deletes it by hand.

**Worktree safety.** A worktree with any `git status --porcelain` output, tracked or
untracked, is kept and reported as `dirty`, whatever its merge state.

**Removal (not dry-run).**
- `git worktree remove <path>` runs without `--force`. If it refuses, that is reported
  and the branch stays.
- `git branch -D <branch>` runs only for a confirmed branch whose worktree is gone or
  never existed. `-D` is used because the tip check above already did the safety work
  that `-d` cannot do for squash merges.
- The command finishes with `git worktree prune`. Remote branches and PRs are left
  alone.

**Answer.**
- The answer is `{dryRun, removable: [{branch, worktree}], removed: [...], kept:
  [{branch, worktree, reason}]}`. In a dry run `removed` is empty. In a real run
  `removable` lists what it tried.
- Reasons are `dirty`, `outside`, `pr open`, `unconfirmed…` and `remove failed: …`.
- The forge CLI runs through the existing `forgeCli()` override (`TASKS_GIT_GH` /
  `TASKS_GIT_GLAB`).
- `tests/fixtures/fake-gh.mjs` gains `pr view` / `mr view` answers, driven by
  `FAKE_GH_STATE` and `FAKE_GH_HEAD`.
- The command is added to `COMMANDS` and the usage text.

### Phase 2: `maxParallel` (helper, engine, schema)

- **Schema:** an optional top-level integer `maxParallel` from 1 to 16 in
  `schemas/tasks.schema.json`. Top-level `additionalProperties` is already `true`, so
  existing ledgers load unchanged.
- **Helper validation:** `validateLedger` refuses a present `maxParallel` that is not
  an integer from 1 to 16. It runs on every command, so a bad value added mid-run also
  refuses `status`/`sync`/`finish`. The error names the field, and that behaviour is
  accepted.
- **Helper answer:** `prepare`'s answer gains `maxParallel`, defaulting to 3.
- **Engine:** `const maxParallel = prepared.maxParallel ?? 3`. The `??` default keeps
  an older helper's answer without the field working. In the main loop, a ready task
  starts only while `running.size < maxParallel`, in ledger order.
- **What stays the same in the engine:** the overlap check and the guarantee that
  `running` grows inside the loop. The loop keeps running while `running.size > 0`, so
  a task waiting for a free slot starts when one frees up. It neither deadlocks nor
  exits early.
- **Existing tests:** a default of 3 breaks none of them.
  - rev7's 5-task test is the badStart path, which does no scheduling.
  - The never-ready test chains T4 on T3.
  - The unstartable test sets T4 aside.
- **Behaviour change:** a ledger without the field used to run every ready task at
  once and now runs at most 3. The CHANGELOG says so.

### Phase 3: engine closing dry run

- After `finish` succeeds with `runStatus` `finished` and **`prs` is false**, the
  engine calls `ops('cleanup', 'dry-run')` through the existing serialised, checked
  relay. It returns the helper's `removable` and `kept` as `cleanup` in its result.
- With `prs: true` the dry run is skipped, because every item would be `pr open` right
  after the draft PRs open. The result says "cleanup after the PRs merge:
  `/tasks cleanup`".
- A failed dry run, which can take up to `OPS_ATTEMPTS` (3) relay rounds, is logged and
  never changes `stopped`.
- The engine never runs a real cleanup.

### Phase 4: skills and docs

- `skills/tasks/SKILL.md`:
  - Replace the "## Cleanup" procedure with `/tasks cleanup`: run `cleanup <ledger>
    dry-run`, show removable and kept items with their reasons, ask once, then run
    `cleanup <ledger>` and report.
  - Add a note on the stale-lock path: resume, then finish.
  - The run report names the engine's dry-run list, or the PR hint.
- `skills/tasks-plan/SKILL.md`:
  - Document `maxParallel`. Set it only when the user asks or the repo is heavy;
    otherwise leave it out.
  - The rounds reply (around line 140) says how many tasks run at once: `min(3 or
    maxParallel, widest round)`.
- `plugins/tasks-ledger/README.md`: a cleanup section and the `maxParallel` field.
- Specs, rev 14 amendments:
  - `docs/specs/2026-10-02-tasks-git.md`: `cleanup` with its lock, items, both
    confirmation paths, the stacked-PR note and the answer; `prepare`'s `maxParallel`.
  - `docs/specs/2026-10-02-tasks-engine.md`: the slot cap and the closing dry run.
  - `docs/specs/2026-10-02-tasks-prose.md`: `/tasks cleanup`.
- Version 0.6.0 in `plugins/tasks-ledger/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`, and a 0.6.0 entry in the root `CHANGELOG.md`.

### Phase 5: tests (rev 14)

**`tests/tasks-git-cleanup-rev14.test.mjs`** (git sandbox and fake gh):
- A dry run lists items and changes nothing.
- A real run removes a task merged by merge commit (path a) and ends with `worktree
  prune`.
- A squash-merged task is removed when the local tip equals the PR head (path b).
- It is kept as `unconfirmed: local commits after the merge` when a commit was added
  after the PR head.
- An open PR is kept as `pr open`.
- A dirty worktree is kept as `dirty`, both with a modified tracked file and with an
  untracked file.
- A worktree outside `.claude/worktrees/` is kept as `outside`.
- The integration branch:
  - It is removed when only task commits are on it.
  - It is kept as `unconfirmed` with an extra direct commit.
  - With `prs: false`, it is removed when its tip is an ancestor of the base.
- A live run lock gives `locked:true` with nothing removed. A `prepare` started while
  cleanup holds the lock is refused.
- The main worktree and a branch outside `task/<topic>/` are never items.
- The answer is sealed.

**`tests/tasks-engine-parallel-rev14.test.mjs`:**
- `tests/helpers/relay.mjs` `runEngine` gains an `agent` hook. Implementer calls block
  on a deferred, and the test records the in-flight count.
- With five independent tasks and `maxParallel: 2`, there are never more than 2 in
  flight.
- Without the field, there are never more than 3.
- **Red control:** with the cap code removed (the hook's maximum seen with
  `maxParallel: 99`), 5 are in flight. This shows the hook can observe concurrency.
- All tasks still merge.
- A finished run with `prs: false` calls `cleanup … dry-run` exactly once and returns
  its list.
- A finished run with `prs: true` and a stopped run do not call it.

**`tests/schema.test.mjs`:** `maxParallel` is accepted when valid and refused when 0,
17 or 2.5. The existing fixtures still pass.

**Proof:** `node scripts/verify.mjs` (all tests and lint) and `claude plugin validate
--strict .`. A code-reviewer pass follows before the PR is opened.

## Files changed

| File | Change |
|---|---|
| `plugins/tasks-ledger/scripts/tasks-git.js` | `cleanup` command, `maxParallel` validation and in `prepare` |
| `plugins/tasks-ledger/workflows/tasks-engine.js` | slot cap, closing dry run |
| `plugins/tasks-ledger/schemas/tasks.schema.json` | `maxParallel` |
| `plugins/tasks-ledger/skills/tasks/SKILL.md` | `/tasks cleanup`, stale-lock note, report |
| `plugins/tasks-ledger/skills/tasks-plan/SKILL.md` | `maxParallel`, rounds reply |
| `plugins/tasks-ledger/README.md` | cleanup, `maxParallel` |
| `plugins/tasks-ledger/tests/fixtures/fake-gh.mjs` | `pr view` / `mr view` |
| `plugins/tasks-ledger/tests/helpers/relay.mjs` | `agent` hook in `runEngine` |
| `plugins/tasks-ledger/tests/tasks-git-cleanup-rev14.test.mjs` | new |
| `plugins/tasks-ledger/tests/tasks-engine-parallel-rev14.test.mjs` | new |
| `plugins/tasks-ledger/tests/schema.test.mjs` | `maxParallel` cases |
| `docs/specs/2026-10-02-tasks-{git,engine,prose}.md` | rev 14 amendments |
| `plugins/tasks-ledger/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md` | 0.5.1 (Phase 0 PR), 0.6.0 (this PR) |

## What does not change

- The overlap rule and the `glob-overlap` and `relay-check` blocks, which stay
  byte-identical in helper and engine. New engine calls go through `ops()`/`runOps`,
  and the new answer is sealed.
- The `serialised()` discipline. `cleanup` is a helper op like any other.
- PR creation and bodies, the verify gate and its consent, and `prepare`'s `verify.cmd`
  requirement. A ledger-level `verify` fallback is deliberately not added, because it
  would bypass per-repository consent.
- The ledger task-item schema. Existing ledgers in `.claude/runs/` load unchanged.
- Remote branches and PRs: cleanup never deletes them.
- Nothing in `~/.claude`: this changes the plugin only.

## Deviations during implementation

- The prose tests that pinned the old hand-run cleanup procedure (`prose-rev4` amendment 7,
  `prose-rev10` amendment 3, `prose-topics-retry-rev10` amendment 9) now check the new wording, and
  the amendment 9 sandbox test runs the helper's dry run instead of replaying the documented git
  command. `vocabulary.test.mjs` lists `cleanup` among the helper commands. The plan's file table
  did not name these four tests.
- `runEngine`'s hook is named `taskAgent` (it answers implementer and reviewer calls); the tests
  count in-flight implementers with a timed hold instead of a deferred.
- The schema test's validator gained `minimum` and `maximum`, which `maxParallel` needs.
- tasks-plan owns `maxParallel` on a refresh, next to `checkTimeoutMin`.
- **Phase 3 dropped after review.** Right after a run nothing has landed (PRs open, or the
  integration branch not merged), so the closing dry run would keep every item. The engine returns
  a `/tasks cleanup` hint for every finished run instead and makes no `cleanup` call; the rev 11
  timer test is unchanged again.
- Review fixes in `cleanup`: the integration branch also counts the merged heads of ledger tasks
  whose branch an earlier pass removed; a real run prunes first; `pr` must be an http(s) URL; fetch
  and forge calls never prompt and time out; a failed lock restore after a real run is a warning.
