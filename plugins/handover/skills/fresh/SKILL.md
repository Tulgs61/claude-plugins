---
name: fresh
description: Lets the user empty the context window in the middle of a task and still continue it. Records the user's upcoming request as the next action in a compact HANDOVER.md, sets a single-use marker, and has the user run /clear followed by one further message, after which the SessionStart hook feeds the handover back in. Reach for it when the user wants to "clear the context and then ..." do something, or types /fresh with the request that should follow.
argument-hint: "<next prompt>"
---

# Fresh

What this skill delivers: the request the user wants to make next is not lost when the context is
wiped with `/clear`. It is stored as the next action in `HANDOVER.md`, and once the context is empty
the SessionStart hook hands that file to the new session, which picks the work up on its own.

## Procedure

1. **Get the follow-on request.** It is the argument to `/fresh`. When the argument is empty, ask the
   user what the session should do once the context is cleared.
2. **Write a compact handover.** The file is `<root>/HANDOVER.md`, where the root comes from
   `git rev-parse --show-toplevel` run in the session's project directory (or is that directory when
   there is no repository); note this absolute root path, step 3 needs it. Apply
   the handover skill and `${CLAUDE_PLUGIN_ROOT}/rules/conventions.md`, adjusted as follows:
   - put the user's request under `## Next action`, rewritten so it stands on its own: replace
     pointers such as "it", "this function" or "the failing test" with real file paths, identifiers
     and commands, because the reader will remember nothing;
   - fill `## Threads`, `## Open questions` and `## Traps` concisely without leaving gaps; only the
     opening lines and these sections are injected, and only up to 4000 characters;
   - if a handover already exists, carry over whatever in it still applies;
   - base the recorded state on commands you run, and leave out forge checks when neither `gh` nor
     `glab` is installed;
   - keep secrets and customer data out, and leave the file uncommitted.
3. **Set the marker.** Earlier commands may have left the shell in another directory, so first return
   it to the session's project directory: the repository root from step 2, whose `HANDOVER.md` you
   just wrote. Then run the script without a directory argument, in the same command:

   ```bash
   cd "<root from step 2>" &&
   node "${CLAUDE_PLUGIN_ROOT}/scripts/fresh-marker.js"
   ```

   The script works from its own process working directory, which is now the session's project
   directory, and arms the marker for the repository root containing it. On success it prints
   `fresh marker armed for <root> (<marker path>)`.

   Compare the `<root>` in that success line with the repository root from step 2. The arm failed
   when the script exits non-zero, when there is no success line, or when the line names a different
   root; a marker armed for another repository will not bring this handover back. In every one of
   these cases tell the user the marker was not set for this repository, pass on the script's output
   (its error output, or the success line with the wrong root), and explain that the handover will
   not load by itself after the clear; they can call `/pickup` once the context is empty.
4. **Give the user two short instructions:** run `/clear`, then send any further message, such as
   `go`. Mention that the marker works a single time and expires after 12 hours.

Leave the next action alone for now; it is meant for the session that starts after the clear.
