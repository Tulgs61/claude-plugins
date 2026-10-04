---
name: handover
description: Creates or updates the single HANDOVER.md at the top of the repository, so that a later session starting with an empty memory knows where things stand and what to do first. Reach for it when the user says they want to "wrap up", is about to end the session, or types /handover with an optional focus topic.
argument-hint: "[focus]"
---

# Handover

The point of this skill: someone opening the repository tomorrow, with none of today's conversation
in their head, reads `HANDOVER.md` and can get going. The file must tell them what the repository
looks like right now (verified by commands you actually ran), which lines of work are still in
flight, which decisions are pending along with what you would choose, and a single concrete step
they can execute first.

Shared rules live in `${CLAUDE_PLUGIN_ROOT}/rules/conventions.md`. If the project ships its own
`CLAUDE.md` with different instructions, follow the project.

## Focus argument

The skill is invoked as `/handover [focus]`. A focus names the topic the user cares about most: list
its thread before any other and draw the next action from it. With no focus, describe everything
this session touched.

## Procedure

1. **Locate the file.** Ask git for the top-level directory (`git rev-parse --show-toplevel`); if the
   working directory is not inside a repository, use the working directory itself. The handover is
   always `<root>/HANDOVER.md`. A repository has exactly one; edit that file rather than adding a
   copy with a date or placing another one in a subfolder. Onboarding guides and briefing notes are
   different documents and do not replace it.
2. **Merge, do not overwrite blindly.** When the file is already there, read all of it first. Carry
   forward anything that still matters: unresolved threads, questions nobody has answered yet,
   pitfalls that remain real. Remove only what is done or no longer true, and tell the user what you
   removed.
3. **Gather facts by running commands.** Memory of the conversation is not evidence. Useful sources:
   - git: `git status --short --branch`, `git rev-parse --short HEAD`, `git log --oneline -5`,
     `git stash list`, `git worktree list`;
   - the plan currently in force, meaning a `docs/plans/*.md` file whose front-matter `status` is
     neither `done` nor `abandoned`, plus the most recent ledger under `.claude/runs/*.json`, if
     either exists;
   - pull or merge request and pipeline status through the forge CLI: `gh pr status` and
     `gh pr checks` on GitHub, `glab mr list` and `glab ci status` on GitLab. When no such CLI is on
     the machine, leave this step out and write in the preamble that forge state is unverified.
4. **Out-of-scope work.** Anything that belongs to a later effort becomes an issue on the forge with
   the `follow-up` label. Suggest the issues, wait for the user to say yes, and only then open them.
   In the handover, point to those issues by link; do not describe the work again in prose.
5. **Write `HANDOVER.md`** using the layout below.
6. **Wrap up with the user:** give the file path, quote the next action, and mention anything you
   removed. Leave the file uncommitted unless the user explicitly wants a commit.

## Layout

After a `/clear` started through the fresh skill, the SessionStart hook injects only the opening
lines of the file and the sections whose `## ` heading starts with `Next action`, `Threads`,
`Open questions` or `Traps`. Do not rename those four headings.

```markdown
# Handover: <what this work is about, in one line>
As of <YYYY-MM-DD HH:MM>, on <branch> at <short sha>, working tree <clean or "N files changed">
Plan <path | none>; ledger <path | none>; review <PR/MR link with pipeline result | forge unverified>

## Next action
<A single step the reader can run as written: the command or edit, the file it concerns, and how
to tell that it worked.>

## Threads
### <thread name>: <short status>
- Done so far: <facts, file paths, links to PRs or issues>
- Still needed: <the remaining work on this thread>

## Open questions
1. <The decision that is pending>? I would pick: <choice>, because <reason>.

## Traps
- <Something that is easy to get wrong here, and the way around it>

## Follow-ups
- <issue link>: <issue title>
```

The opening block should be the title and at most two more lines. Be brief in the four extracted
sections too, since the hook stops after 4000 characters.

## Hard limits

- Keep secrets (tokens, passwords, keys) and any customer data out of the file. Material that must
  stay private goes under `.claude/private/`.
- Do not commit `HANDOVER.md` unless the user requests it.
- Do not open forge issues until the user has approved them.
