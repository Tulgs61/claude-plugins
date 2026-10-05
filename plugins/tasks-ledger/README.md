# tasks-ledger

A Claude Code plugin that turns a list of tasks into a delegated, reviewed run:

1. `/tasks-ledger:tasks` plans a JSON **task ledger** (acceptance, proof, file ownership, dependencies, budget).
2. On your go it starts the **`tasks-engine` workflow**: one `task-implementer` per task in its own git
   worktree, `.claude/verify.cmd` re-run per task, an independent `reviewer` per task, dependency-ordered
   local merges into an integration branch, and — only if you asked — one draft PR per task.
3. Two hooks keep delegation honest in every session: no implementer dispatch without proof and budget,
   and no end of a main-session turn after edits while the project's verify command fails.

The rules everything here follows (dispatch contract, writer ≠ reviewer, ledger/worktree/branch layout,
the `.claude/verify.cmd` opt-in) are in [`rules/conventions.md`](rules/conventions.md).

## Requirements

- Claude Code with plugin support, `node` on `PATH` (hooks and the helper are Node scripts using only
  built-ins), and `git`. For PRs: an authenticated `gh` (GitHub) or `glab` (GitLab).
- **Dynamic workflows** for `/tasks`: available on paid plans and with API access; on Pro, turn on
  *Dynamic workflows* in `/config`. They must not be disabled (`disableWorkflows` setting or
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1`). Planning (`tasks-plan`), `dispatch` and the hooks work without them.
- No extra install step for the workflow: Claude Code loads workflow scripts from a plugin's `workflows/`
  directory, so [`workflows/tasks-engine.js`](workflows/tasks-engine.js) ships with the plugin and is
  available as `/tasks-ledger:tasks-engine`. The `tasks` skill starts it with the absolute plugin path; if
  your session may not read files outside the project, allow the plugin directory (`/add-dir` or a Read
  allow rule) or let Claude run the workflow by name.
- A committed `.claude/verify.cmd` in the target repo (the workflow refuses to start without it), and
  `.claude/runs/` plus `.claude/worktrees/` in its `.gitignore`.

## Skills

| Skill | What it does |
|---|---|
| `/tasks-ledger:tasks <task list> [open PRs]` | Plans the ledger via `tasks-plan`, shows the rounds, asks once, runs the workflow, reports per task. Also `add <task>` (joins a running run through the ledger's `.inbox.jsonl`), `resume`, `retry <Tn>`, `status`. |
| `/tasks-ledger:tasks-plan [goal or spec]` | Writes or refreshes `.claude/runs/YYYY-MM-DD-<topic>.json` (schema: [`schemas/tasks.schema.json`](schemas/tasks.schema.json)) and stops. Partitions by file, serialises overlapping file globs with `dependsOn`, picks the base branch from the project's documented git rules or else the repo's default branch. Runs in a forked context. |
| `/tasks-ledger:dispatch [task id or task]` | Renders the six-part dispatch contract (outcome, proof, constraints, deliverable, budget, escalation) for one task, as an Agent call, a `claude --bg` command or a `/goal`. Refuses without proof and budget. |

## Agents

| Agent | Role |
|---|---|
| `tasks-ledger:task-implementer` | Implements exactly one ledger task inside the worktree the workflow created; stays in the task's `files` scope; runs the proof and `verify.cmd`; commits; never pushes, merges or edits the ledger. `model: opus`, `maxTurns: 120`. |
| `tasks-ledger:reviewer` | Independent, read-only review of a diff against the task's acceptance, scope and constraints; answers with a JSON verdict (`verified` / `rejected` / `needs_input`). Tools `Read, Grep, Glob, Bash` only and no `memory` field (agent memory would add Read/Write/Edit and share notes across repositories), so it stays read-only. `model: opus`, `maxTurns: 40`. |

The agent that wrote a change never certifies it.

### Using your own agents

Plugin agents are namespaced by the plugin name, so the workflow starts `tasks-ledger:task-implementer` and
`tasks-ledger:reviewer` by default. Two optional workflow args change that:

| Arg | Default | Use |
|---|---|---|
| `implementerAgent` | `tasks-ledger:task-implementer` | Agent type started once per task (and once more on a verification retry). |
| `reviewerAgent` | `tasks-ledger:reviewer` | Agent type that reviews each task's diff; it must answer with the JSON verdict the workflow asks for. |

A workflow's `agent()` call matches its agent type exactly (verified against Claude Code 2.1.265): a bare
name such as `reviewer` reaches a project (`.claude/agents/`) or user (`~/.claude/agents/`) agent of that
name and never this plugin's own agent. That is why the defaults are plugin-scoped. Pass a bare name such
as `task-implementer` to use your own project or user agent of that name, or another plugin's scoped name
such as `my-plugin:reviewer`.
Ask for it when starting the run (for example "run the tasks with my own `reviewer` agent") and the `tasks`
skill passes it in the Workflow args. A name may contain only letters, digits, `_`, `-` and `:`; any other
value stops the workflow before an agent starts. Whatever agent you pick still gets the contract the
workflow writes (worktree, proof, files scope, budget) and must respect it.

The overrides are not stored in the ledger. When you continue a run with `/tasks-ledger:tasks resume` in a
new session, repeat them (for example "resume with my own `reviewer` agent"), otherwise the resumed run
uses the defaults.

## Hooks

Registered in [`hooks/hooks.json`](hooks/hooks.json), each run in exec form as `node ${CLAUDE_PLUGIN_ROOT}/hooks/<script>`.
Both fail open: any internal error exits 0 and never wedges a turn.

If you already registered your own copies of `dispatch-guard` or `verify-gate` in your settings
(`~/.claude/settings.json` or a project's `.claude/settings.json`), remove them before you enable the
plugin. Otherwise both copies run on every event, and the two verify gates share the same per-session state
file name (`claude-verify-<session>.json` in the OS temp dir), so they clear and count each other's state.

| Event | Script | Effect |
|---|---|---|
| `PreToolUse` on `Agent` | [`dispatch-guard.js`](hooks/dispatch-guard.js) | Blocks (exit 2) an Agent call to `implementer` or `task-implementer` (any plugin prefix) whose prompt has no `PROOF` or no `BUDGET` section, and points at the dispatch skill. Other agents pass. |
| `PostToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit` | [`verify-gate.js`](hooks/verify-gate.js) | Marks the session dirty (state file in the OS temp dir). |
| `Stop` | [`verify-gate.js`](hooks/verify-gate.js) | If dirty, looks for `.claude/verify.cmd`: inside a repository from the working directory of the session that stops upward to the nearest directory that contains `.git` (the repository or worktree root) inclusive, nearest file wins; outside any repository only `<cwd>/.claude/verify.cmd`. On POSIX a `verify.cmd` not owned by the current user or group/world-writable is skipped. Runs it with bash in the directory where it was found (3-minute timeout). On failure it blocks that stop (exit 2) and hands Claude the output tail. It blocks once per stop chain: a stop that follows a block (`stop_hook_active`) is allowed without re-running the check. After 3 failed runs without a new edit it stops blocking and only warns. Does nothing without the file. It follows the hook input's `cwd` and ignores `CLAUDE_PROJECT_DIR`. Subagents fire `SubagentStop`, not `Stop`, so this gate does not run when a subagent finishes; task-implementers run `verify.cmd` themselves and the workflow re-runs it per worktree. |

## Files

```text
.claude-plugin/plugin.json   manifest
skills/                      tasks, tasks-plan, dispatch
agents/                      task-implementer, reviewer
hooks/                       hooks.json, dispatch-guard.js, verify-gate.js
workflows/tasks-engine.js    the workflow /tasks runs
scripts/tasks-git.js         every ledger and git side effect of the workflow (one JSON line per call)
schemas/tasks.schema.json    ledger schema
rules/conventions.md         conventions the skills, agents and hooks follow
tests/                       node:test suites
```

## Security notes

- **Hooks run `node`** on scripts from this plugin in every session where the plugin is enabled.
  `dispatch-guard.js` only reads stdin. `verify-gate.js` writes a small state file to the OS temp dir and,
  on `Stop` after edits, executes with bash and your user's rights the nearest `.claude/verify.cmd`
  between the working directory and its repository root (only `<cwd>/.claude/verify.cmd` outside a
  repository); on POSIX it ignores one not owned by you or writable by group or others. Review
  `.claude/verify.cmd` in a repository you did not write before editing files there with the plugin
  enabled.
- **Nothing is pushed by default.** [`scripts/tasks-git.js`](scripts/tasks-git.js) pushes only when the
  ledger has `prs: true` (set only when you asked for PRs), and then only `task/<topic>/*` branches —
  never `task/<topic>/integration`, never a permanent branch. It opens draft PRs and never merges them.
- The workflow's agents use your normal permission rules. The main checkout is never switched; all work
  happens in `.claude/worktrees/<topic>-*`.

## Tests

```bash
node --test plugins/tasks-ledger/tests/*.test.mjs
```

`tests/hooks.test.mjs` spawns both hooks with JSON on stdin in temp directories (with an isolated temp dir
for hook state) and removes them afterwards.

## License

MIT
