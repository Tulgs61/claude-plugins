---
name: dispatch
description: Turn one task into a ready-to-use delegation contract with the six parts (outcome, proof, constraints, deliverable, budget, escalation), rendered as an Agent call, a `claude --bg` command and a `/goal`. Use when the user wants to hand a single change to an implementer agent or a background session, gives a ledger task id like T3, or when dispatch-guard blocked an implementer call for lacking PROOF or BUDGET.
argument-hint: "[ledger task id or task description]"
---

# dispatch

Input: $ARGUMENTS

You produce one contract for one task. You do not start the agent, the session or the goal
yourself unless the user asks for that afterwards.

## 1. Find the task

- **A ledger id** (`T` followed by digits): look in `.claude/runs/` of the current repository for
  the ledger that holds it. If several ledgers do, use the most recent one and say which. Take
  `title`, `acceptance`, `proof`, `budget`, `files`, `constraints`, and `branch`/`worktree` when
  they are set.
- **Free text**: read enough of the repository to know which files the change will touch and how
  the project checks its work (test scripts, `.claude/verify.cmd`, CI config).

If neither works (unknown id, no repository), say so and stop.

## 2. Make sure it is dispatchable

A contract needs a proof and a budget. If the task does not give one and the user has not stated
one, you may propose a concrete command or stop clause, but do not emit the contract until the
user has accepted it. When you cannot settle one of them, stop and tell the user plainly which is
absent: the proof, the budget, or both.

Ask as well, rather than inventing, when the outcome or the file scope is unclear.

## 3. Write the six parts

Use exactly these labels, each at the start of its own line and in this order, so the
dispatch-guard hook recognises the PROOF and BUDGET sections:

```text
OUTCOME: <observable end state, phrased as what is true afterwards, not as activity>
PROOF: <the exact command to run; its output must appear in the agent's transcript>
CONSTRAINTS: <what must stay unchanged; the only paths that may change: <globs>; other limits>
DELIVERABLE: commits on <branch> in <worktree or "the current worktree">; no merge, no push to a permanent branch
BUDGET: <stop clause, e.g. "stop after 40 turns and report what blocks">
ESCALATION: <when to stop and ask instead of guessing: schema or migration changes, auth or payment code, an ambiguous spec, any file outside the scope, plus task-specific cases>
```

Rules for the content:

- The deliverable is local commits. Add a draft PR only when the user asked for one. A merge, or a
  push to a permanent branch such as `main`, is never part of it.
- The constraints always include the file scope. If `.claude/verify.cmd` exists, the proof or the
  constraints also require that it passes.
- A multi-line part continues on indented lines below its label.

## 4. Render it three ways

Show the same contract in these three forms, in this order, each ready to paste:

1. **Agent call**: an Agent tool call with `subagent_type: "tasks-ledger:task-implementer"` (or the
   agent the user named), a short `description`, and the contract as `prompt`.
2. **`claude --bg` command**: one shell command, run from the repository or worktree, that passes
   the contract as the prompt, quoted so the shell leaves it intact (a single-quoted string or a
   heredoc).
3. **`/goal`**: `/goal` followed by the contract, for use inside an existing session.

End with one line naming any assumption you made while filling the parts.
