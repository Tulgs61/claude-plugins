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

No step changes the shell's directory: do not run `cd`, `pushd` or `popd` while writing the handover
or setting the marker. Read and write files by their absolute paths instead.

1. **Get the follow-on request.** It is the argument to `/fresh`. When the argument is empty, ask the
   user what the session should do once the context is cleared.
2. **Write a compact handover.** The file is `<root>/HANDOVER.md`, where the root comes from
   `git rev-parse --show-toplevel` run in the shell's current directory, which is the
   session's project directory (or is that directory when there is no repository); note the absolute path of the file, step 3 needs it. Apply
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
3. **Set the marker.** Run the bare command in the shell's current directory, which is the session's
   project directory. Do not `cd` anywhere first, not to the root from step 2 and not to any other
   path printed by git or another tool: the script must see the directory spelled the way the
   session sees it, symlinks included, or the hook will not find the marker.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/fresh-marker.js"
   ```

   The script arms the marker for the repository root containing its working directory. On success it
   prints `fresh marker armed for <root> (<marker path>)`.

   **Check that the marker belongs to this handover.** The root in the success line may be spelled
   differently from the root in step 2 (a symlink, other letter case, other separators), so never
   compare the two as strings. Compare files by identity instead:

   ```bash
   test '<root from the success line>/HANDOVER.md' -ef '<HANDOVER.md written in step 2>' && echo same-file
   ```

   Put every path into that command in single quotes, and write each single quote inside a path as
   `'\''` (so `/a/it's` becomes `'/a/it'\''s'`).

   The arm succeeded only when the script exited 0, printed the success line, and the check printed
   `same-file`. Anything else is a failed arm: a non-zero exit, no success line, a check that fails, or
   a check you cannot run. In that case tell the user the marker was not set for the `HANDOVER.md`
   you just wrote, pass on the script's output, and explain that the handover will not load by itself
   after the clear: they should run `/clear` and then continue with `/pickup`. Give only this
   fallback and stop; skip step 4.
4. **Only after a successful arm, give the user two short instructions:** run `/clear`, then send any
   further message, such as `go`. Mention that the marker works a single time and expires after 12
   hours.

Leave the next action alone for now; it is meant for the session that starts after the clear.
