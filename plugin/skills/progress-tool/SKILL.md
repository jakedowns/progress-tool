---
name: Progress Tool Usage
description: Use the progress-tool MCP correctly — report long-horizon work (research, planning, exploration, refactors, docs) with the fire-and-forget progress tool, structure multi-step plans as a parentId tree, keep entries current between tool calls, and wrap long-running commands with the out-of-band progress-relay at zero token cost
---

# Using the progress tool well

The `progress` tool (progress-server MCP) is **dual purpose**:

1. **Drop-in replacement for todo/task-tracking tools** (`todowrite` / `TaskCreate`):
   any multi-step plan belongs in this tree, where it also drives the user's
   live indicator.
2. **A wrapper for long-running programmatic tool calls** (build scripts,
   compilers, test suites, installs — anything that reports progress on
   stdout) via the out-of-band relay.

## When to report

Anything expected to run **longer than a couple of minutes or a single reply** —
including work with no shell command at all: research, planning, codebase
exploration, multi-file refactors, documentation.

- **Start:** one call with `status: "running"`, a clean stable `id`
  (e.g. `"build-1"` — never session-prefixed), short `title`; put detail in
  `detail`, not the title.
- **Keep it current while you work:** non-shell work has no relay, so spend
  one of your turns **between tool calls** — roughly every few calls, or
  whenever you start or finish a step — on an update (fresh `detail`, a
  `progress: 0.0–1.0` fraction, or a status change). This todowrite-style
  cadence keeps the summary rollup live.
- **Re-arm:** when your current tree is `done` and new work begins, open a
  **fresh tree**. And if you have already made 2+ consecutive edits or shell
  calls on one task with no active entry, that **is** multi-step work —
  start a tree now (never too late: record what is done and what remains).
- **Steering is work:** when the user redirects you mid-flight while a tree
  is in progress, record the steer as a child entry — one line summarizing
  the ask plus what you plan to do in reaction — and update it as you
  respond. The user should see their steer land in the rollup.
- **Close:** end with `status: "done"` or `"error"`. **Close what you open** —
  an abandoned `running` entry is a zombie the user has to dismiss by hand.
- Statuses are exactly `running | waiting | done | error` (use `waiting` for
  "not started yet / blocked"; there is no `pending`).

## Structure multi-step plans as a tree

One child entry per step — `progress({ id: "<parent>-step-1", status:
"running", title: "<step>", parentId: "<parent>" })` — then update each child
as you go. The parent's status/progress roll up automatically (error beats
running beats waiting; parent progress = mean of children). **Never embed a
numbered step list inside one title/detail** — the rollup cannot see
individual steps inside text.

## Long-running shell commands: use the relay

Call `progress` once (`status: "running"`), then run the command **through**
the out-of-band relay instead of waiting on it:

```sh
progress-relay --id <id> -- <cmd>     # wrap: exit 0 → done, non-zero → error
<cmd> | progress-relay --id <id>      # pipe: done on EOF
```

Use the exact relay command printed in the `progress` tool response (it
guarantees a working invocation path). When the harness supports background
commands, run the wrapped command in the background and keep working; the
completion notification is your cue for the final milestone.

The relay parses `OSC 9;4` terminal progress sequences (Gradle rich console,
mise, PowerShell 7.4+, …) before text heuristics like `"45%"`, and streams
throttled telemetry into the indicator at **zero token cost**.

## Never poll

No `sleep` loops, no re-calling `progress` on a timer for elapsed time or
percentages, no reading terminal output in a loop. Between-turn updates during
non-shell work are the intended cadence, not polling. The relay's exit code
maps to done/error automatically — do not re-call `progress` with `"done"`
unless adding semantic detail.

## See it live

- `bash demo/osc-demo.sh` — OSC 9;4 structured progress through the relay.
- `bash demo/tree-demo.sh` — nested parent/child roll-up
  (`PROGRESS_TREE_DEMO_FAIL=1` shows error roll-up).
- Full contract: `docs/out-of-band-relay-spec.md`.
