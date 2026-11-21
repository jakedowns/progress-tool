---
name: [progress-tool] Delegation (Subagents)
description: Use subagents well — fan out independent research and verification in parallel, pick explore vs general, inherit the session's model, and avoid parallel-edit conflicts
---

# [progress-tool] Delegation (Subagents)

OpenCode runs subagents in their own **child sessions** with fresh context. They
work in the background; you get a report when each goes idle, and again after
later rounds. Use them when parallel work genuinely exists.

## When to fan out

Good candidates — work that is **independent** and **read-heavy**:

- Research several files/areas/modules at once ("find every caller of X",
  "how does auth work here", "what does this API expect").
- Verify while you implement: one child runs the tests/build while you edit.
- Compare approaches: ask two children for different designs, synthesize.
- Broad searches (docs + code + web) that don't depend on each other.

Bad candidates:

- Sequential work where step 2 needs step 1's result.
- Trivial one-liners (a child's fresh context costs tokens for no gain).
- **Parallel edits in the same tree** — see safety below.

## `explore` vs `general`

| agent | mode | use for |
|---|---|---|
| `explore` | subagent, read-only | searches, reading code/docs, answering "where/what" — cannot edit |
| `general` | subagent, broad tools | multi-step research or implementation chunks; cannot launch its own subagents |

Rule of thumb: **`explore` for questions, `general` for work**.

## Model

- A subagent **inherits the parent session's model when no model is configured** —
  so simply **omit `model`** on subagent definitions you want on the session model.
- The V2 parent can override a subagent's configured model at dispatch time
  (highest priority). If you want this enforced regardless of config, the community
  plugin `opencode-subagent-model-selector` routes by the primary session's model/variant.

## Safety before delegating

- **Scope tightly**: one clear deliverable, explicit files/paths, "report
  file:line evidence", and what *not* to touch.
- **No concurrent edits to the same tree** without worktree isolation — two
  children editing overlapping files will conflict. For parallel editing, use
  `opencode-workflows` (git worktrees per agent) or serialize the edits.
- Children inherit permissions from their own agent config, not yours; the parent's
  `subagent` permission decides which agents it may launch.
- Ask for evidence (commands run, output) — subagent claims are not verification.

## Reporting

- Mirror delegation in the progress tree: one child `progress` entry per
  delegated workstream (`parentId` = the phase), updated when the subagent reports.
- **Attribute the child.** Child sessions are separate progress scopes. The
  plugin maps them automatically from `session.created` and stamps
  `progress sessionId: <your session id>` into the subagent prompt at launch,
  so you do not need to write it yourself — but including it in your own prompt
  text is harmless (the stamp is idempotent).
- The completion notification is your cue — do not poll the child.

## Related community plugins

- `opencode-workflows` — scripted parallel subagents, worktree isolation, resume.
- `opencode-smart-subagents` — two-way messages between child and parent, batching.
- `opencode-agent-tree` — enforces decomposition into many small parallel subagents.
- `opencode-subagent-model-selector` — routes subagent models by the session model.
