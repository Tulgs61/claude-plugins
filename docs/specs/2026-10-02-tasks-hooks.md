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
CLAUDE_CONFIG_DIR
CLAUDE_PLUGIN_DATA
${CLAUDE_PLUGIN_ROOT}
Edit|Write|MultiEdit|NotebookEdit
git rev-parse --git-common-dir
hook_event_name
implementer
needs a terminal
no BUDGET
no PROOF
no PROOF and no BUDGET
PostToolUse
PreToolUse
session_id
Stop
stop_hook_active
subagent_type
SubagentStop
systemMessage
task-implementer
timeout after 180s
tool_input
verification FAILED (exit
verify-consent.json
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

## Amendments (rev 10)

These amendments take precedence over every earlier section and amendment where they differ. They
concern verify-gate only. dispatch-guard is unchanged. Group A (1-7) comes first; group B (8-12)
builds on it.

### Group A: robustness

1. **Per-project state.** State is kept per session *and* per project, not per session alone.
   - The project of an edit is found by walking up from the directory of the edited file
     (`tool_input.file_path`, or `tool_input.notebook_path`) to the nearest ancestor that contains a
     `.git` entry, which can be a directory or a file. If the input names no path, or no such
     ancestor exists, the project is the event's `cwd`. The same walk, started at `cwd`, gives the
     project of a stop.
   - A linked worktree is its own project, because its `.git` is a file at its own root.
   - The state file name is `claude-verify-<session>-<p>.json`. `<session>` is sanitised as before,
     and `<p>` is the first 16 hex digits of the sha256 of the project's absolute path. The file
     still lies directly in the temp directory.
   - A stop only reads and writes the state of its own project. An edit in project X followed by a
     stop whose `cwd` lies in project Y does not run Y's check.
   - Kept tests that look for a state file "containing the session id" stay valid. Kept tests that
     build the exact old file name `claude-verify-<session>.json` (in `hooks-verify-gate-rev4.test.mjs`
     and `hooks-verify-gate-rev5.test.mjs`) may be changed to compute the new name, and only in that
     respect.
2. **Subagents.** `hooks.json` also registers verify-gate on `SubagentStop` (no matcher), with the same
   `timeout` as the `Stop` registration. A `SubagentStop` is handled exactly like a `Stop`, using its own
   `cwd` (the subagent's working directory, for example its worktree) and its own
   `stop_hook_active`. A blocking failure exits 2 with the same stderr. This keeps the subagent
   working. The failure count and give-up rule apply per session and project as in amendment 1.
3. **Process group on timeout.** The check runs in its own process group (detached on POSIX).
   - When the 3-minute limit passes, the gate sends SIGTERM to the whole group. If any member is
     still alive 5 seconds later, it sends SIGKILL to the group. The run counts as a failure with the
     exit label `timeout after 180s`, as before.
   - The check's time limit plus the grace period stays below the registered hook `timeout`.
   - On Windows only the direct child is ended, and the README says so.
   - The output limit from rev 5 still applies. A check ended for too much output also has its group
     ended the same way.
4. **Atomic state writes.** The state is written to a new file in the same directory, created
   exclusively with a random suffix and without following links, and then renamed over the state
   file. An interrupted write never leaves an empty or partial state file behind. A state file that
   cannot be parsed counts as dirty with 0 failures, never as clean.
5. **Session id types.** A `session_id` that is a number is used as its decimal string. Only a missing,
   `null` or empty-string id makes the gate do nothing (narrowing rev 4, amendment 3). Any other type
   (object, array, boolean) also makes the gate do nothing.
6. **Loose permissions warning.** When the only check file found is a regular file the user owns but
   that is writable by group or others, it is still not run (unchanged).
   - On the first stop per session and project where this happens, the gate prints one line of compact
     JSON on stdout, whose only key is `systemMessage`. Its value says that `.claude/verify.cmd` was
     skipped because it is group- or world-writable, and suggests `chmod 644`.
   - Exit 0. The session stays dirty. Later stops in the same session and project stay silent.
7. **Empty stdout.** Apart from the give-up message, the loose-permissions warning (amendment 6) and the
   approval request (amendment 10), stdout is always empty.

### Group B: consent

8. **Threat model.** A repository cloned from an untrusted source is owned by the user, so ownership
   and permission checks do not stop a hostile committed `verify.cmd`. Its `CLAUDE.md` may also
   instruct the model to approve the command. Hooks run outside Claude Code's permission prompts, so
   the gate must never run such a command on its own. It runs a check only after that exact command
   was approved for that repository. Approval needs either a person answering at a terminal
   (amendment 11) or a change to the consent store, which the model can only make through a tool call
   that Claude Code's permission system governs. The gate itself never records consent.
9. **Consent store.**
   - It is a JSON file at `$CLAUDE_PLUGIN_DATA/verify-consent.json`. When `CLAUDE_PLUGIN_DATA` is unset
     or empty, it is at `<config>/tasks-ledger/verify-consent.json`, where `<config>` is
     `$CLAUDE_CONFIG_DIR` if set and non-empty, otherwise `~/.claude`.
   - Environment variables only choose where the store is. Nothing bypasses it.
   - It is read only when it is a regular file owned by the current user (POSIX). It is written
     atomically as in amendment 4. Missing directories are created with mode 0700.
   - An entry is the pair (repository identity, sha256 hex of the command bytes).
     - The **repository identity** is the real path of the directory that `git rev-parse
       --git-common-dir` reports when run in the directory that contains `.claude/`. So a main checkout
       and all its linked worktrees share one identity. Outside a git repository, or when git fails,
       the identity is the real path of the directory that contains `.claude/`.
     - The **command bytes** are exactly the bytes that are passed to bash, taken from the content
       already read through the trusted file descriptor. The gate never reads the file a second time
       to hash it.
10. **Unapproved check.** When the trusted check's pair is not in the store, the gate does not run it.
    - It exits 0 and leaves the state untouched (the session stays dirty).
    - On the first such stop per session and project, it prints one line of compact JSON on stdout,
      whose only key is `systemMessage`. Its value names the check file's absolute path and the
      approve command `node "<plugin root>/scripts/verify-consent.js" approve "<dir>"`. `<plugin root>`
      is the gate's own plugin directory and `<dir>` is the directory containing `.claude/`. The value
      also says the command must be run in a terminal. Later unapproved stops in that session and
      project stay silent.
    - A changed `verify.cmd` (a different hash) is unapproved again.
11. **`scripts/verify-consent.js`.** A Node.js command-line script using only built-in modules. It
    shares the store rules of amendment 9.
    - `approve <dir>`: finds `<dir>/.claude/verify.cmd`, applies the same trust rules as the gate, and
      prints the path and the full command.
      - It then asks `Run this command after Claude edits files here? [yes/N]` and reads the answer
        **from the controlling terminal** (`/dev/tty`), never from stdin.
      - Only the exact answer `yes` records the pair and exits 0. Any other answer exits 1 and records
        nothing.
      - When there is no controlling terminal (opening `/dev/tty` fails), it exits 2 with
        `needs a terminal` on stderr and records nothing. The terminal requirement keeps a plain shell
        tool call from answering; it is not the security boundary. The boundary is amendment 8: anything
        that records consent other than a person at a terminal is a tool call under Claude Code's
        permission prompts.
      - No command-line argument, environment variable or file can supply the answer. A seam for
        tests, if any, is reachable only by code that loads the script as a module.
    - `revoke <dir>`: removes every entry for that repository identity. Exit 0.
    - `list`: prints one line per entry (identity, then the first 12 hex digits of the hash). Exit 0.
    - Anything else prints usage and exits 2.
12. **Tests.** Kept tests that expect the check to run must first approve it.
    - They point `CLAUDE_PLUGIN_DATA` at a fresh temp directory and write the store entry directly
      with a small test helper (the approve command cannot run without a terminal). The kept test
      files `hooks.test.mjs`, `hooks-verify-gate-rev4.test.mjs` and `hooks-verify-gate-rev5.test.mjs`
      may be changed for this setup only.
    - The new tests cover:
      - an unapproved check is not run, prints the request once, and keeps the session dirty;
      - an approval in the main checkout makes the check run in a linked worktree of the same
        repository;
      - a changed command is unapproved;
      - `approve` without a terminal exits 2 with `needs a terminal` and records nothing;
      - `revoke` removes the entry;
      - a store owned by another user, or a symlinked store, is ignored.
13. **Tests for group A**, in new test files. Each of these must be able to fail:
    - the failure count is clamped (a state file holding 99 failures gives up on the next failure and
      not before; a negative count behaves as 0);
    - as a non-root user, a directory or FIFO at the state path is not followed, opened or trusted;
    - an edit between two failures resets the count;
    - a symlinked `verify.cmd` is not run;
    - a session id with `/` or `..` gives a state file directly in the temp directory;
    - stdout is empty on block, pass and skip paths;
    - an over-limit check reports `output limit exceeded`;
    - plus one test per amendment 1-7, including a grandchild process ended by the timeout
      (POSIX only), a numeric session id, an unparsable state file counting as dirty, and a
      `SubagentStop` in another project's worktree running that worktree's check.

### Group C: fixes after review of group A (implemented together with group B)

14. **Fail-open covers asynchronous errors.** Any error the gate does not handle, including one thrown
    in a timer or child-process callback and an unhandled `error` event on a child's pipes or on
    stdout (for example EPIPE), ends the hook with exit 0 and no further output.
15. **Unreadable own state is dirty.** Only a missing state file, or one that is rejected because it is
    not a regular file or not owned by the user, counts as clean. Any other failure to read the user's
    own state file counts as dirty with 0 failures.
16. **Project identity from the real path.** The project path that names the state file (amendment 1)
    is the real path of the project directory. When the edited file's directory does not exist yet,
    the real path of its nearest existing ancestor is resolved and the rest is appended. An edit
    through one symlinked spelling and a stop through another reach the same state.
17. **Quoted hint.** The path in the `chmod 644` suggestion of amendment 6 is shell-quoted, single quotes
    with embedded single quotes escaped.
18. **Tests**, each able to fail before the change: an EPIPE on stdout gives exit 0; an own state file
    with mode 000 counts as dirty; an edit through a symlinked repo path followed by a stop through the
    real path runs the check; the loose-permissions warning is given once per project within one
    session (two projects, two warnings), and names the absolute path of the skipped file.

### Group D: security review of group B

19. **Copy-safe approve command.** In the approval request of amendment 10, the plugin root and `<dir>`
    are each shell-quoted with single quotes, embedded single quotes escaped (as in amendment 17). Pasting
    the command into a POSIX shell never runs anything but `node` on the consent script, whatever
    characters the paths contain (`$`, backticks, `"`, `;`, newlines). A path with a line break or other
    control character is not offered as a command at all; the request then says that the directory
    name contains control characters and gives no command.
20. **What the user approves is what they see.** `approve` shows the command in a form that cannot hide
    anything:
    - every character outside printable ASCII and the space, apart from line feeds, is shown as an
      escape such as `\x1b` or `‮`. This covers escape sequences, carriage returns, backspaces,
      bidirectional controls and other invisible characters, and each line is prefixed with `| `;
    - it also shows the line count and the first 12 hex digits of the sha256 that will be recorded;
    - the hash recorded is the hash of exactly the bytes that were read and shown, as before.
    The question is asked only after all of this has been written. Tests: a `verify.cmd` containing an
    escape sequence, a carriage return that would overwrite the line, and U+202E is shown escaped; a
    pasted approval request with `$(touch x)` in the directory name, run through `bash -c`, creates no
    file.
21. **The approve command reaches the gate's store.** The approval request names the store the gate
    actually uses. The printed command starts with the environment assignment that selected that store,
    shell-quoted: `CLAUDE_PLUGIN_DATA='<path>'` when `CLAUDE_PLUGIN_DATA` chose it, `CLAUDE_CONFIG_DIR='<path>'`
    when that did, and nothing for the `~/.claude` default. So the command records into the same file
    the gate reads, even when run from a plain terminal. Test: run the gate with `CLAUDE_PLUGIN_DATA` set,
    take the printed command, and check that its environment prefix and arguments select that store (run
    `approve` through the module seam with the parsed environment).
22. **Foreign stores are tested without root.** The tests for a store, state file or check file owned by
    another user run as a normal user. They preload a small module (`node --require`) that makes
    `process.getuid()` return a different uid in the process under test. They are not skipped unless
    the platform has no `getuid`.
23. **`approve` never discards approvals silently.** When the store file exists but is unusable
    (unparsable, a symlink, not a regular file, or owned by someone else), `approve` records nothing and
    exits 2, naming the file and why it was not used. `revoke` behaves the same.
24. **Kept tests and real paths.** The kept tests in `hooks-verify-gate-rev4.test.mjs` and
    `hooks-verify-gate-rev5.test.mjs` may compute the project path as its real path when they compute
    the state-file name (amendments 1 and 16), and only in that respect.

### Group E: final review of the consent feature

25. **No program from the untrusted directory.** The gate and the consent script never start a program
    by bare name with the repository (or any directory inside it) as the working directory. `git` and
    `bash` are resolved to absolute paths by searching `PATH` while skipping empty and relative entries
    and the repository's own directories. The program is started with a neutral working directory (the
    temp directory) and receives the repository through arguments (`git -C <dir>`). `bash` still runs the
    check with the check's directory as its working directory, because that is part of the contract,
    but it is started by absolute path. If no such program is found, the gate skips the check as for a
    check that could not start.
26. **Foreign-owner tests aim at one file.** The uid preload of amendment 22 takes the path it applies
    to (through an environment variable that only the tests set), and changes the reported owner only
    for that file. The gate-level tests then show that a foreign store is ignored (the approval request
    appears, the check does not run) and that a foreign check file is not run, each next to a control run
    in which the same setup with an own file runs the check.
27. **The approve command pins the store.** The printed command sets every store variable explicitly:
    the one that selected the store with its quoted value, and each higher-priority variable as empty
    (`CLAUDE_PLUGIN_DATA=` before `CLAUDE_CONFIG_DIR='…'`, both empty for the default). So the command
    records into the gate's store whatever the user's terminal exports. This replaces "nothing for the
    `~/.claude` default" in amendment 21.
28. **The right path is named.** When the command cannot be offered because a path contains control
    characters, the request names which path it is: the plugin directory, the consent store or the
    repository directory.
29. **Display and question go to the same terminal.** `approve` writes the display of amendment 20 to the
    controlling terminal it reads the answer from, synchronously, before the question. It also writes it
    to stdout. With no controlling terminal it writes nothing and exits 2 as before.
30. **Tests**, each able to fail before the change: a repository with an executable `git` (and `bash`)
    file in the check directory and in its root, which must never run (POSIX: simulate by putting `.` or
    the repository directory on `PATH`); the gate-level foreign-file tests of amendment 26; an approve
    command run in a terminal environment that exports the other variables still records into the
    gate's store; the control-character message names the plugin directory when only that path has one.
31. **Inside means inside.** A path is inside a directory when its path relative to that directory is
    empty, or is not absolute and its first segment is not exactly `..`. So `<repo>/..bin` is inside. The
    excluded directories of amendment 25 also include the main working tree of a linked worktree (the
    directory that contains the common git directory), as given and as its real path. With no
    controlling terminal, `approve` writes nothing to stdout either: it opens the terminal first and
    prints only `needs a terminal` on stderr when that fails. Tests: a planted `git` and `bash` in
    `<repo>/..bin` on `PATH` never run; a planted one in the main checkout of a linked worktree never runs;
    `approve` without a terminal leaves stdout empty.
32. **A repository cannot borrow another's identity.** The repository identity of amendment 9 is accepted
    only when the git directory really belongs to this checkout:
    - for a main checkout, the common git directory is `<top>/.git` (real paths compared), where `<top>`
      is the checkout's top level;
    - for a linked worktree, the common git directory must hold a `worktrees/<name>/gitdir` file whose
      content, resolved to a real path, is exactly this worktree's `.git` file. Git writes that back-reference
      inside the main repository's own git directory, which the linked worktree's content cannot change;
    - in every other case (a `.git` file or `commondir` pointing at a git directory that does not point
      back), the identity is the real path of the directory that contains `.claude/` and of nothing
      else. So no approval from another repository applies.
    Tests: a repository whose `.git` file points at an approved repository's git directory, with the same
    `verify.cmd`, does not run the check and shows the approval request; a real linked worktree of an
    approved repository still runs it; a forged `commondir` is ignored.

## Amendments (rev 11)

These amendments take precedence over every earlier section and amendment where they differ. They
concern verify-gate and `scripts/verify-consent.js`. dispatch-guard is unchanged.

1. **The default store is pinned too.** For the `~/.claude` default, the approval request's command
   sets `CLAUDE_PLUGIN_DATA=` (empty) and `CLAUDE_CONFIG_DIR='<home>/.claude'`. `<home>` is the home
   directory the gate itself resolved when it chose the store (`os.homedir()` in the hook process),
   shell-quoted as in rev 10, amendment 19. So the command records into the file the gate reads, even
   when the terminal's `HOME` differs from the hook's. This replaces "both empty for the default" in
   rev 10, amendment 27.
   - The consent script resolves `CLAUDE_CONFIG_DIR='<home>/.claude'` to
     `<home>/.claude/tasks-ledger/verify-consent.json`, which is the default store's file. The store
     rules of rev 10, amendment 9 are unchanged.
   - The control-character rule (rev 10, amendments 19 and 28) now also covers the default store's
     path, which is named "the consent store".
2. **Approve on a real terminal is tested.** `approve` is tested end to end on a pseudo-terminal
   on POSIX, so that the real `openTerminal` (opening `/dev/tty`, the synchronous write loop, the
   byte-wise read) runs without the module seam. No behaviour changes.
3. **The POSIX command names its shell and avoids the backslashes shells read differently.** Native Windows is
   unchanged (it still cannot record an approval). On every other platform:
   - the request says the command is for a POSIX shell such as bash or zsh;
   - when one of the quoted paths (the consent script, the store value, the directory) contains a
     backslash, no command is offered. The request names which path it is, as rev 10, amendment 28
     does for control characters, and says that it contains a backslash, which shells quote
     differently.
   With no backslash in any quoted path, the POSIX quoting of rev 10, amendment 19 gives the same
   result in fish. This amendment does not otherwise claim support for any particular shell.
4. **An approval covers one check directory.** A store entry is the triple (repository identity,
   check directory, sha256). The *check directory* is the path of the directory that contains `.claude/`,
   relative to the top level of its checkout, with `/` separators. The top level is the nearest ancestor
   holding a `.git` entry, the same walk the gate uses. Outside a repository it is `''`.
   - An entry for the top level has no `dir` key. An entry for any other directory has
     `dir: "<relative path>"`. An entry without `dir` is read as `''`. So existing stores keep approving
     exactly the top-level check they approved, and stores written before this change remain valid.
   - The gate runs a check only when (identity, check directory, hash) is in the store. An identical
     `verify.cmd` in another directory of the same repository is unapproved and gets the approval
     request.
   - Linked worktrees share the identity (rev 10, amendments 9 and 32), and the check directory is
     relative to each checkout's own top level. So an approval of `<main>/pkg` also covers
     `<worktree>/pkg`.
   - `approve <dir>` records the triple. `revoke <dir>` still removes every entry for the identity,
     whatever the directory. `list` prints `<identity>\t<hash12>` for a top-level entry, as now, and
     `<identity>\t<hash12>\t<dir>` for others.
   - A `dir` value that is absolute, empty when present, contains `..` as a segment, or contains a
     control character makes that entry invalid. It is skipped like any other invalid entry.
5. **Tests**, in new test files. Each test must be able to fail on the commit before the change, unless
   it is marked as coverage.
   - `plugins/tasks-ledger/tests/hooks-verify-consent-default-rev11.test.mjs`:
     - **Default store pinned (amendment 1).** Run the gate with `CLAUDE_PLUGIN_DATA` and
       `CLAUDE_CONFIG_DIR` unset and `HOME` set to a temporary directory A, on an unapproved check. Take
       the printed command, parse its assignments, and run `approve` through the module seam with
       `HOME` set to a different temporary directory B plus the parsed assignments, answering `yes`.
       Assert: the entry is in `A/.claude/tasks-ledger/verify-consent.json`, and no store exists under
       B. POSIX only.
     - **Control characters in the default store (amendment 1).** `HOME` with a line feed in its name:
       no command is offered, and the request names the consent store.
   - `plugins/tasks-ledger/tests/hooks-verify-consent-pty-rev11.test.mjs` (amendment 2, coverage, POSIX
     only). Drive the real script, `node scripts/verify-consent.js approve <dir>`, on a pseudo-terminal
     that it holds as its controlling terminal. Use Python's standard `pty` module (`pty.fork()`)
     through a small driver in `plugins/tasks-ledger/tests/helpers/pty-drive.py`. The driver reads the
     terminal until the question appears, then writes the answer or closes the terminal, and reports
     the terminal output and the exit status. `CLAUDE_PLUGIN_DATA` points at a temporary directory.
     - answer `yes`: exit 0; one entry recorded; the terminal output contains the file path, every
       `| ` line, the line count and the 12-digit hash, all before the question; a `verify.cmd` holding
       an escape sequence shows it as `\x1b` on the terminal;
     - answer `no`: exit 1; nothing recorded;
     - the terminal is closed after the question (hangup): the process ends within 10 seconds, its exit
       is non-zero or by a signal, and nothing is recorded.
     - The test is skipped when no `python3` with a working `pty` module is found. When the environment
       variable `CI` is set, it fails instead of skipping, so CI cannot pass it silently.
   - `plugins/tasks-ledger/tests/hooks-verify-consent-shells-rev11.test.mjs`. POSIX only.
     - **Backslash (amendment 3).** A repository directory whose name contains a backslash: on POSIX
       the request offers no command and names the repository directory. A directory without one: the
       request names a POSIX shell.
   - `plugins/tasks-ledger/tests/hooks-verify-consent-dir-rev11.test.mjs` (amendment 4):
     - approve the top-level check; an identical `verify.cmd` in `<repo>/sub/.claude/`, with the stop's
       `cwd` in `sub`, is not run and shows the request; after approving `sub`, it runs;
     - a store entry without `dir` (old format) still approves the top-level check and no other;
     - an approval of `<main>/pkg` runs the same check in `<linked worktree>/pkg`;
     - `list` prints the third column only for entries with a non-empty directory;
     - entries with `dir` set to `/abs`, `../x`, `a/../b` or `''` are ignored.
   - **Kept tests.** These kept files may be changed, and only in these respects:
     - `plugins/tasks-ledger/tests/hooks-verify-consent-final-rev10.test.mjs`. In the test
       "amendment 27 / 30: for the ~/.claude default, the pasted command empties both store variables",
       the expected prefix becomes `CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR='<home>/.claude' ` (amendment 1),
       and the test title may say so. In the test "amendment 25 / 30: the consent script never runs a
       git from the repository", the expected store entry gains `dir: 'pkg'` (amendment 4).
     - `plugins/tasks-ledger/tests/hooks-verify-consent-review-rev10.test.mjs`. The assertion that the
       plain command starts with `CLAUDE_PLUGIN_DATA= CLAUDE_CONFIG_DIR= node '…'` uses the pinned
       default prefix of amendment 1.
     - `plugins/tasks-ledger/tests/helpers/verify-consent.mjs`. `approveCheck` adds `dir` for a check
       directory below the top level, computed independently of the scripts under test (relative to the
       nearest ancestor holding `.git`). Root-level entries stay `{ repo, sha256 }`.
     Any other kept assertion that fails because of the "POSIX shell" wording, or because a kept test
     approves a check below its repository's top level, is reported by the implementer instead of being
     changed.
6. **README.** The consent section of `plugins/tasks-ledger/README.md` (and the root README's
   `.claude/verify.cmd` opt-in section) states: the printed command pins the store; it is for a POSIX
   shell, and paths with a backslash get no command; native Windows still cannot record an approval; an approval covers one check directory.
7. **Fix round.** These sharpen amendments 1, 3 and 4.
   - **Backslash rule, exact form.** Amendment 3's refusal applies to a backslash in a quoted path that is
     followed by another backslash or a single quote, or that ends the path. Those are the only
     backslashes fish reads as escapes inside single quotes, so the offered command means the same in
     bash, zsh and fish. Any other backslash (for example `a\b`) is kept and the command is offered.
     The `'\''` sequence that POSIX quoting uses for an embedded single quote is part of the quoting,
     not of a path, and is read the same way in those shells. The shells test adds an `a\b` directory,
     which gets a command.
   - **Invalid check directory on approve.** When the check directory that `approve` computes would be
     rejected as a stored `dir` (amendment 4: absolute, `..` segment, or a control character), `approve`
     records nothing, exits 2 and says the directory cannot be approved and why.
   - **Absolute default store.** The pinned default store of amendment 1 is the absolute path of
     `<home>/.claude`, resolved in the hook process. When the home directory is not absolute, no
     command is offered and the request says so.
   - **Tests**, added to the rev 11 test files: an `a\b` directory gets a command; `approve` in a check
     directory whose relative path holds a control character exits 2 and records nothing (POSIX only);
     a relative `HOME` gets no command.
   - **Kept test title.** In `plugins/tasks-ledger/tests/hooks-verify-consent-review-rev10.test.mjs`, the
     title of the test whose prefix assertion amendment 5 changed may be changed to match it.
8. **Fix round 2.** These sharpen amendments 1, 2, 5 and 7.
   - **The store location must be absolute.** The value that selects the store (rev 10, amendment 9) is
     `CLAUDE_PLUGIN_DATA`, else `CLAUDE_CONFIG_DIR`, else the home directory the process resolved. When
     that value is not an absolute path, the store is unavailable: it is never resolved against the
     working directory, so a file inside a repository can never act as the store.
     - The gate then sees no approvals. An unapproved check gets the approval request, which offers no
       command and says that the consent store's location is not an absolute path, naming the variable
       (`CLAUDE_PLUGIN_DATA`, `CLAUDE_CONFIG_DIR` or the home directory). This replaces the message of
       amendment 7's "Absolute default store" for that case.
     - `approve`, `revoke` and `list` record nothing, change nothing, exit 2 and say the same.
     - An empty variable still counts as unset, as before.
   - **The pty driver hangs up only after the question.** In `plugins/tasks-ledger/tests/helpers/pty-drive.py`,
     `hangup` closes the terminal only once the question has appeared, as `answer:` already does. When the
     question never appears, the driver kills the program and reports `timedOut: true` and `asked: false`.
   - **Tests**, added to `plugins/tasks-ledger/tests/hooks-verify-consent-default-rev11.test.mjs`. POSIX only.
     Each must be able to fail on the commit before this change.
     - For each of a relative `HOME` (with `CLAUDE_PLUGIN_DATA` and `CLAUDE_CONFIG_DIR` unset), a relative
       `CLAUDE_CONFIG_DIR` (with `CLAUDE_PLUGIN_DATA` unset) and a relative `CLAUDE_PLUGIN_DATA`: the
       repository holds, at the path that value would resolve to from the repository's top level, a store
       file owned by the current user that approves the repository's own `verify.cmd`. The gate runs with
       its working directory at the repository's top level. Assert: the check does not run, the request
       is shown, it offers no command, and it names the variable.
     - `approve` with a relative `CLAUDE_PLUGIN_DATA` exits 2 and creates no file under its working
       directory.
   - **Kept tests.** In `plugins/tasks-ledger/tests/hooks-verify-consent-final-rev10.test.mjs`, the test of
     amendment 5 that may change its prefix may also change `assert.equal(rec.configDir, …)` to expect the
     pinned `<home>/.claude` value. That follows from amendment 1. No other kept assertion may change.
   - **Release note.** The changelog entry of the release that adds per-directory approvals says that going
     back to an earlier version widens them: an earlier version reads an entry with `dir` as a top-level
     approval of the same hash in any directory of the repository, and rewrites it without `dir`.
9. **Coverage for fix round 2.** Tests only, all marked as coverage, POSIX only. No behaviour changes.
   - In `plugins/tasks-ledger/tests/hooks-verify-consent-default-rev11.test.mjs`: `revoke <repo>` and `list`,
     each with a relative `CLAUDE_PLUGIN_DATA` and run from a working directory that already holds a store
     file at the path that value would resolve to. Assert: exit 2, a message on stderr that names
     `CLAUDE_PLUGIN_DATA`, and the store file byte for byte unchanged.
   - In `plugins/tasks-ledger/tests/hooks-verify-consent-pty-rev11.test.mjs`: `approve` in a directory with
     no `.claude/verify.cmd`, driven with `hangup`. Assert: the driver reports `asked: false` and
     `timedOut: true`, and nothing is recorded. The skip and `CI` rules of amendment 5 apply.
