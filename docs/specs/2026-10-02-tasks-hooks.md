---
status: approved
component: tasks-hooks
---
# Behaviour spec: tasks-ledger hooks

Scope: `plugins/tasks-ledger/hooks/dispatch-guard.js`, `plugins/tasks-ledger/hooks/verify-gate.js`
and `plugins/tasks-ledger/hooks/hooks.json`. Tests: `plugins/tasks-ledger/tests/hooks.test.mjs`
(`h`).

## Purpose

- **verify-gate.** A project can commit a check command. After Claude has edited files, the turn
  cannot end while that command fails, up to a fixed number of attempts.
- **dispatch-guard.** An implementer agent is only launched when its prompt carries a proof and a
  budget.

## Interface

**Runtime.** Both scripts are Node.js using only built-in modules. Each reads one JSON object from
stdin.

**Exit codes.**
- `0` lets the action proceed.
- `2` blocks it, and stderr is passed to Claude as the reason.

**`hooks.json` registrations.** All three run `node` with a script path based on
`${CLAUDE_PLUGIN_ROOT}`.

| Event | Matcher | Script |
|---|---|---|
| `PreToolUse` | `Agent` | dispatch-guard |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | verify-gate |
| `Stop` | none | verify-gate |

The gate's own time limit for the check command is 3 minutes, and the `Stop` registration's timeout
is longer than that.

**dispatch-guard input.** It reads `tool_input.subagent_type` and `tool_input.prompt`.

**verify-gate input.** It reads `hook_event_name`, `session_id`, `cwd` and `stop_hook_active`. It
ignores `CLAUDE_PROJECT_DIR`, so the check always follows `cwd`, including inside a worktree.

**verify-gate state.**
- One small file per session in `os.tmpdir()`.
- Its name is exactly `claude-verify-<session>.json`, where `<session>` is the session id with every
  character outside `[A-Za-z0-9_-]` replaced by `_`. The tests look for files containing the id
  (h:157, h:185, h:275), and the plugin README documents this name.
- It records whether the session is dirty and how many failed runs it has seen.

## Behaviour

### dispatch-guard

**Which agent types are checked.**
- The agent type is guarded when its part after the last `:` is `implementer` or `task-implementer`
  (h:85-88).
- All other types pass with exit 0, among them `Explore`, `general-purpose`, `reviewer` and
  `tasks-ledger:reviewer` (h:101-106).

**What counts as a section.** Examples first:

| Accepted (h:56-64, h:96-99) | Not accepted |
|---|---|
| `1. **Budget:** stop after 10 turns` | `PROOFS:` |
| `## Proof` | `just do it` (h:80) |
| `PROOF: npm test` | the word anywhere in the middle of a sentence |

A line labels a PROOF (or BUDGET) section when, after any leading markdown markup and whitespace
are stripped, the line starts with the word (compared case-insensitively) as a whole label: the word
is followed by `:` or the end of the line, optionally with a closing `**` in between. A word with
ordinary text before it on the line is not a label.

**Outcomes.**

| Prompt | Exit | stderr |
|---|---|---|
| both sections present | 0 | empty (h:90-94) |
| one or both missing | 2 | names what is missing: `no PROOF`, `no BUDGET`, or `no PROOF and no BUDGET` when both are absent (h:67-83) |

When blocking, the message should also point the caller to the dispatch skill.

### verify-gate: PostToolUse

Marks the session dirty and resets its failure count. Exit 0, no output.

### verify-gate: Stop

**Allowed without running anything (exit 0).** Listed from the cheapest condition to establish to
the most expensive:
- `stop_hook_active` is `true` (h:150-151);
- the session is clean (h:128-133);
- no trusted check file is found (h:115-126, h:188-228). Stderr stays empty and the session state is
  untouched, so the session stays dirty and a later Stop runs the file once it is trusted
  (h:230-245).

**Which file is used.**
- Within a git repository (a `.git` directory or file marks the root), the nearest
  `.claude/verify.cmd` between `cwd` and that root inclusive is used.
- Outside a repository, only `<cwd>/.claude/verify.cmd` is considered.
- Files above the root, or above `cwd` when there is no repository, are never used (h:188-228).
- An untrusted file counts as absent.

**Trusted file.**
- It is a regular file.
- On POSIX it is also owned by the current user and not writable by group or others. Modes 0664 and
  0646 are rejected; 0644 is accepted (h:230-247).

**Running the check.**
- The trimmed file content runs with bash.
- The working directory is the directory that contains `.claude/` (h:170-186).
- A time limit applies.

**Result.**
- **Pass.** The session's state file is removed and the hook exits 0 (h:153-157).
- **Failure.** The first and second consecutive failures block, the third gives up. A blocking
  failure exits 2. Stdout is empty. Stderr contains
  `verification FAILED (exit <code>)` and the command's output (h:139-148, h:255-260).
- **Giving up** on the third consecutive failure, with no edit in between (h:249-276):
  - exit 0;
  - stdout is exactly one line of compact JSON (no indentation), an object whose only key is
    `systemMessage` (h:263-273);
  - its value contains `3 failed runs` and the command text, with runs of whitespace in the command
    collapsed to single spaces so the value stays on one line;
  - stderr holds the command's output;
  - the state file is removed.

**Other events.** Any other event, or none, gives exit 0.

## Errors

- **Fail-open.** Unparseable stdin, or any internal error, gives exit 0 (h:108-113, h:135-137).
- **dispatch-guard** writes nothing to stdout.

## Security

- **Check-file selection.** The gate runs repository-provided commands as the user, so a command
  comes only from a file the user owns and others cannot modify. The file must also sit inside the
  current repository, or in `cwd` itself.
- **File handling.** Non-regular files are never opened. The file that is checked is the file that
  is read.
- **Bounded blocking.** After 3 failed runs the gate only warns. A stop that follows one of its own
  blocks passes unchecked.
- **State file name.** The session id is sanitised before it becomes part of a path, so the state
  file always lies directly in the temp directory.

## Test-pinned items

- Exit codes and the dispatch-guard stderr fragments (h:67-99).
- Guarded and unguarded agent types (h:85-88, h:101-106).
- The stderr fragment `verification FAILED (exit <code>)` and the command output in stderr
  (h:147-148).
- `stop_hook_active` (h:151).
- The state file named after the session and removed on pass and on give-up (h:157, h:275).
- The give-up stdout: only `systemMessage`, a single line, containing `3 failed runs` and the command
  (h:263-273).
- The lookup bounds and trust rules (h:170-247).

## Allowlist

Entries are sorted alphabetically, ignoring case and leading punctuation.

```text
3 failed runs
Agent
claude-verify-
.claude/verify.cmd
Edit|Write|MultiEdit|NotebookEdit
hook_event_name
implementer
no BUDGET
no PROOF
no PROOF and no BUDGET
PostToolUse
PreToolUse
session_id
Stop
stop_hook_active
subagent_type
systemMessage
task-implementer
tool_input
verification FAILED (exit
${CLAUDE_PLUGIN_ROOT}
```

## Amendments (rev 4)

These amendments take precedence over the sections above where they differ. They concern verify-gate.

1. **Check could not start.** When the verify check cannot be started at all (a spawn error that is
   not the timeout), the gate lets the stop through and leaves its state as it was.
2. **State file.** The state file is written without following symbolic links, is read only when it
   belongs to the current user, and its failure count is clamped to the range 0 to 3.
3. **No session id.** When the hook input carries no session id, the gate does nothing.
4. **One-line message.** The complete `systemMessage` value contains no line break.

## Amendments (rev 5)

1. **"Could not start" is narrow.** Only a check for which no process was created counts as "could
   not start" (rev 4, amendment 1). A check that started and was ended for producing more output than
   the hook accepts counts as a failed run, with the exit label `output limit exceeded`; it blocks
   and counts towards giving up like any other failure.
