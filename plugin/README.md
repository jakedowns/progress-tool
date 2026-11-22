# @jakedowns/progress-tool-opencode-plugin

OpenCode plugin that gives agents a **fire-and-forget progress tool** and an
**out-of-band relay** for long-running commands — a live, glance-able tree above
the transcript, at zero model tokens for telemetry.

## Install

```bash
opencode plugin add @jakedowns/progress-tool-opencode-plugin@latest
```

Restart the service (or reload the window) and a progress pill appears above the
composer. The plugin also installs and registers the MCP server
(`@jakedowns/progress-tool-mcp`) automatically, and ships four skills:
`progress-tool` and `delegation` register by default, while `osc-demo` and
`tree-demo` live in `optional-skills/` and only register with `demoSkills: true`.

The MCP entrypoint is spawned with a real JavaScript runtime (`node`, then
`bun`, then `npx -y @jakedowns/progress-tool-mcp`). It deliberately never uses
`process.execPath`, which is the `opencode` binary in OpenCode Desktop. If no
runtime is found, auto-registration is skipped with a warning, and the progress
rules / strict-mode nudges stay off until the `progress` tool is actually
available to the model. Pin a runtime with
`{ "options": { "mcpRuntime": "/absolute/path/to/node" } }` if detection picks
the wrong one.

Prefer manual configuration? Add to `opencode.json`:

```jsonc
{
  "plugins": ["@jakedowns/progress-tool-opencode-plugin"],
  "mcp": {
    "servers": {
      "progress-server": {
        "type": "local",
        "command": ["npx", "-y", "@jakedowns/progress-tool-mcp"]
      }
    }
  }
}
```

## What it does

- **`progress` tool** — dual purpose: a drop-in replacement for todo/task
  trackers (tree of tasks, parent/child roll-up) *and* a milestone reporter.
- **`list` tool** — read-only view of your session's trees (dismissed hidden).
- **`progress-relay`** — wraps long commands so stdout/stderr drive the UI
  (`progress-relay --id build-1 -- npm run build`); exit code maps to
  done/error. Parses `OSC 9;4` progress sequences natively.
- **Desktop pill** — `(N · agg%)` title, collapsible trees (animated),
  dismissals that persist, started/last-updated tooltips, nudge telemetry.
- **Guidance that adapts** — injected rules, skill playbooks, pre-flight relay
  hints, strict-mode nudges (silent runs, stale progress with one synthetic
  escalation after 3 entry reminders), a turn-end idle reminder, and an
  optional 2-minute wall-clock nudge.
- **Subagent attribution** — child→parent links are recorded from
  `session.created` (map in `~/.opencode-progress-sessions.json`, override
  `PROGRESS_SESSION_MAP_PATH`) and the parent id is stamped into each subagent
  prompt at launch, so child work rolls up in the parent's pill instead of an
  orphaned child scope. Child rows are labeled `[Subagent (Explore)]` (or
  `[Subagent]`) so delegated work is obvious at a glance.

## Options

Pass under the plugin entry's `options` in `opencode.json`:

| option | default | meaning |
|---|---|---|
| `injectInstructions` | `true` | inject progress/relay rules into every session |
| `registerSkills` | `true` | register the default skills (usage + delegation) |
| `demoSkills` | `false` | also register the demo skills (`osc-demo`, `tree-demo`) |
| `autoRegisterMcp` | `true` | register `@jakedowns/progress-tool-mcp` automatically |
| `mcpRuntime` | auto | absolute path to the `node`/`bun` used to spawn the MCP server (auto-detected; set this if detection picks wrong) |
| `strictMode` | `"nudge"` | `"nudge"` / `"force"` / `"off"` tool-call monitor |
| `staleEscalateAfter` | `3` | entry-based stale reminders before one synthetic escalation (`0` disables) |
| `wallClockMs` | `120000` | wall-clock nudge threshold (`0` disables) |
| `idleReminder` | `true` | turn-end nudge when open tasks remain |
| `unhinged` | `false` | append a task-list reminder to every user message |
| `verboseLogging` | `false` | JSONL nudge telemetry (`~/.opencode-progress-nudges.log`) |
| `autoHideDone` | `false` | hide completed tasks after the success hold |
| `expandRootsByDefault` | `false` | expand pill tree roots by default |
| `barStyle` | `"blocks"` | `"blocks"` or `"emoji"` |
| `refreshMs` | `1000` | view refresh interval |
| `tuiMaxRows` | `8` | max TUI tree rows above the prompt; `/progress` expands or dismisses |
| `tuiMaxRoots` | `3` | root tasks shown before the full-tree summary; palette has "Progress: set root cap" |
| `tuiLayout` | `"composer"` | TUI placement: `"composer"` (above the prompt) or `"sidebar"`; `/progress swap-layout` toggles it |
| `tuiSidebarRows` | `0` | sidebar viewport height in rows (0-100); `0` renders the full tree and lets the sidebar scroll |

State lives in `~/.opencode-progress-state.json` (override with
`PROGRESS_STATE_PATH`). Retention is opt-in (`PROGRESS_AUTO_PRUNE_S`); entries
ride by default so the store doubles as a report.

## Links

- Repository & full docs: <https://github.com/jakedowns/progress-tool>
- Spec: `docs/out-of-band-relay-spec.md`
- License: MIT
