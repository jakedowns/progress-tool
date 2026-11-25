# Advanced guide: schema, relay internals, state store, files

Back to the [main README](./README.md).

**Versions:** MCP server `2.12.0` · OpenCode plugin `2.24.0`

This document is the reference half of the project: the portable contract, the
relay's behaviour, state-store guarantees, architecture, testing, every plugin
option, and the file map. The main README is the five-minute install and usage
page.

---

## Why: the token-burning polling loop

A blocking `question` tool pauses the agent until a human answers. A non-blocking `progress` tool returns immediately so the agent can keep working. That difference creates a structural problem during long-running background tasks (builds, test suites, downloads, deployments):

- An LLM has no background thread. Between tool calls it cannot see `stdout`/`stderr` or wall-clock time.
- To keep a UI updated with elapsed time, percentages, or log snippets, models fall back to `sleep` + `read_terminal_output` + `progress()` loops.
- Every tick burns input/output tokens, bloats context history, and slows the real work down.
- Every harness (OpenCode, Claude Code, Cursor, Cline, custom loops) manages background shells differently, so a single proprietary plugin API does not travel.

The fix is not a bigger prompt. It is to stop making the model the relay.

---

## Design: control plane + data plane

Progress has two kinds of updates, and they should not travel through the same pipe.

| Plane | Owner | Frequency | Cost |
|-------|-------|-----------|------|
| **Control plane** | The agent, via the MCP `progress` tool | Once per milestone / lifecycle transition | O(milestones) tokens |
| **Data plane** | An OS-level relay process, via `progress-relay` | Up to 4 writes/sec, driven by `stdout`/`stderr` and native `OSC 9;4` progress sequences | **Zero** model tokens |

Both planes converge on the same state file. The agent owns *meaning* (task topology, status transitions). The OS process owns *telemetry* (latest log line, percentage, elapsed time). The GUI just reads state.

```
┌──────────────────────────────────────────────────────────────┐
│  CONTROL PLANE (agent, token-bounded)                        │
│                                                              │
│  Agent ── progress({ id, status, title, parentId }) ──┐      │
│    • once when a phase starts                         │      │
│    • once when a child task is created                │      │
│    • once when a phase finishes / fails               │      │
└───────────────────────────────────────────────────────┼──────┘
                                                        │
                                                        ▼
                                    ~/.opencode-progress-state.json
                                                        ▲
                                                        │
┌───────────────────────────────────────────────────────┼──────┐
│  DATA PLANE (OS process, zero model tokens)           │      │
│                                                       │      │
│  npm run build ── stdout/stderr ── progress-relay ────┘      │
│    • latest non-empty line -> detail                         │
│    • "45%" or "6/10" -> progress                             │
│    • exit 0 -> done, exit != 0 -> error                      │
│    • throttled writes, atomic + locked state updates         │
└──────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
                                    GUI / TUI / status shim
                                    reads state, renders tree
```

### The one rule that makes it work

> **The agent calls `progress` at state boundaries. It never calls `progress` in a timer, sleep, or log-polling loop.**

If a command is long-running, attach the relay. If the relay is unavailable, still honor the boundary contract: call `progress` at start and end, and let the GUI derive elapsed time from `startedAt`.

---

## Progress tool schema

```ts
progress({
  id: "compile-1",           // stable id -> update / clear later
  status: "pending" | "running" | "done" | "error" | "waiting",
  title: "Waiting on tsc",
  detail?: "34s elapsed",    // optional detail text
  progress?: 0.65,           // optional 0-1 fraction
  parentId?: "build",        // optional: nest under a parent task (tree)
  sessionId?: "ses_abc123",  // optional override; auto from env when omitted
})
```

- **Fire-and-forget** — does not pause the agent
- **Same `id` updates in place** — call again with the same id to refresh
- **Never requires a human reply**
- **Tree-like dependencies** — pass `parentId` to nest a task under a parent; parent status rolls up from children, and parent progress is the mean of child progress when the parent has no explicit progress (bootvine-inspired)
- **Multi-line titles/details** — `title` and `detail` accept real newlines, escaped `\n` / `\r\n`, extra-escaped `\\n`, or `<br>` / `<br/>` tags. Writers normalize these to plain newlines; viewers wrap long lines and scroll long details. Prefer a short title line plus a few detail lines over one huge single-line string.
- **Session isolation** — `sessionId` resolves from an explicit input, then `PROGRESS_SESSION_ID`, then `OPENCODE_SESSION_ID`. When present, entries are namespaced internally as `${sessionId}:${id}` so identical task IDs in concurrent sessions never collide. Subagent (child) session ids resolve to their parent via `~/.opencode-progress-sessions.json`, so their progress rolls up where you can see it. When absent, the original flat `id` keying is preserved for 100% backwards compatibility. Keep task IDs clean (`"build-1"`); do not manually prefix them.
- Renders in the TUI above the composer and as a composer pill in desktop/web; the optional standalone GUI uses a floating top-right overlay. The TUI word-wraps, desktop/web wrap titles and scroll long details, and both expose the full text on hover where the host supports it.

### Drop-in tool definition (harness-agnostic)

Use this description anywhere an MCP tool is registered. It encodes both the tree semantics and the zero-polling rule, so the model learns the contract even if it ignores long system prompts. The live source of truth is `mcp-server/index.js`; keep this copy in sync when changing it.

```ts
{
  name: "progress",
  description: `Report non-blocking task progress and dependency trees to the user's GUI. Fire-and-forget: never pauses execution or waits for human input.

OWNERSHIP & ZERO-POLLING CONTRACT:
- You own TASK MILESTONES and TREE STRUCTURE: call this tool once when starting a phase (status: "running"), when creating child sub-tasks (parentId), and when a phase finishes ("done" | "error").
- NEVER poll, sleep, or loop on terminal output just to refresh progress percentages or elapsed time.
- For long-running shell commands, delegate live stdout/progress streaming to the out-of-band CLI relay (the exact command is returned in this tool's response, e.g. `progress-relay --id <id> -- <cmd>`) so the OS process updates the GUI directly without burning tokens.

TREE ROLLUP (BOOTVINE SEMANTICS):
- Pass `parentId` to nest sub-tasks under a parent task.
- Parent status and progress automatically roll up from children (any child "error" -> parent "error"; any child "running"/"waiting" -> parent "running"/"waiting"; pending children leave a non-active parent "pending"; parent progress = mean of child progress when the parent has no explicit progress).

SESSION ISOLATION:
- Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID (or an explicit `sessionId` override).
- Subagents report under their parent session; the server maps child ids through ~/.opencode-progress-sessions.json, and an explicit parent `sessionId` always wins.
- Keep using clean task IDs like `build-1`; do NOT manually prefix them with a session ID.

LINE BREAKS & LONG TEXT:
- `title` and `detail` support multi-line text. Use real newlines, escaped `\n` / `\r\n` (or an extra-escaped `\\n`), or `<br>` / `<br/>` tags.
- Keep `title` to a short headline and put verbose context in `detail` across a few lines instead of one huge single-line string.
- Viewers normalize these forms, wrap long lines, and scroll long details. Do not rely on the viewer to split a wall of text for you.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Stable task ID; re-using an ID updates the indicator in place." },
      status: { type: "string", enum: ["pending", "running", "waiting", "done", "error"] },
      title: { type: "string", description: "Short human-readable task label. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags." },
      detail: { type: "string", description: "Optional status detail, latest step, or multi-line context. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags; viewers wrap and scroll long text." },
      progress: { type: "number", minimum: 0, maximum: 1, description: "Optional completion fraction (0.0 to 1.0)." },
      parentId: { type: "string", description: "Optional parent task ID to nest this task in a dependency tree." },
      sessionId: { type: "string", description: "Optional session ID override; automatically resolved from PROGRESS_SESSION_ID or OPENCODE_SESSION_ID when set by the harness." }
    },
    required: ["id", "status", "title"]
  }
}
```

The server also returns the same contract in the MCP `initialize` instructions and repeats the relay command in every `running` tool response. That is deliberate: the command is visible immediately before the model invokes its shell tool, which is the moment the polling habit usually starts.

---

## The relay CLI (data plane)

The relay is a normal POSIX process. It needs no harness plugin, no daemon, and no model cooperation beyond using a shell pipe or wrapper. It writes to the same state file as the MCP server.

The command name and flags below are the reference implementation. The portable requirement is narrower: the agent must be able to attach *some* OS process that writes the shared state shape. Rename it, port it, or replace it with a native background-job hook; the contract lives in [`docs/out-of-band-relay-spec.md`](./docs/out-of-band-relay-spec.md), not in this particular binary.

> The relay does not make a blocking shell call asynchronous. It makes the progress display live and token-free while the command runs. Harnesses with background shells can attach the same relay to the background job and let the agent continue.

### Wrap a command (recommended: captures exit status)

```bash
progress-relay --id build-1 --title "Building" -- npm run build
```

The wrapped command inherits the relay's stdin. Its stdout/stderr are teed to the relay's own stdout/stderr, so the harness still captures the full output. The relay exits with the command's exit code.

### Pipe a command

```bash
npm run build | progress-relay --id build-1
```

Pipe mode cannot see the upstream command's exit code. It marks the task `done` when stdin closes. Use wrap mode when accurate failure detection matters.

### Emit a single milestone (no stream)

```bash
progress-emit --id build-1 --status running --title "Building"
progress-emit --id build-1 --status done --progress 1
```

`progress-emit` is for scripts that already know when a milestone happens and do not have a continuous output stream.

### Concurrent sessions

The relay resolves its session scope automatically: an explicit `--session <id>` wins, followed by `PROGRESS_SESSION_ID`, then `OPENCODE_SESSION_ID`. When a session is active, the state store keys entries as `${sessionId}:${id}` and records `sessionId` on the entry, so two sessions can both use `--id build-1` without overwriting each other. `entry.id` and `entry.parentId` stay clean, and parent roll-ups only match siblings in the same session.

```bash
progress-relay --id build-1 --session ses_abc123 -- npm run build
```

With no session flag and no session environment variables, keys stay flat (`build-1`) exactly as in previous versions.

### Subagent sessions

A subagent runs in its own child session, so its tool calls carry the child session id. Without help, its progress would land in a scope the parent's pill never shows. Three layers close that gap:

1. **Map (plugin):** the plugin subscribes to `session.created`, where OpenCode exposes `parentID` the moment a child session exists, and records `child → parent` (plus the agent type) in `~/.opencode-progress-sessions.json` (override with `PROGRESS_SESSION_MAP_PATH`). The MCP server and relay resolve that map before writing — following chains for nested subagents — and re-key any entries the child wrote before the link existed.
2. **Prompt stamping (fallback):** the plugin's `execute.before` hook appends `progress sessionId: <parent>` to the `subagent`/`task` prompt. That covers a child whose very first progress call beats the map write, and older engines without the event.
3. **Instruction fallback:** injected rules name the session id and explain that a prompt-supplied id wins.

The map is merge-written under a lock, pruned after 30 days, bounded to 8 hops (cycle-safe), and unknown sessions resolve to themselves. The agent type from `session.created` is persisted as `subagent` / `subagentAgent`, so roots render as `[Subagent (Explore)]: Title` (or `[Subagent]: Title` when unknown). The parent still mirrors the workstream as its own child task, per the delegation guidance.

### Options

| Option | Meaning |
|--------|---------|
| `--id <id>` | Stable task ID (or `PROGRESS_ID`) |
| `--title <title>` | Task label; only needed for a new task |
| `--parent <id>` | Nest under a parent task (or `PROGRESS_PARENT`) |
| `--detail <text>` | Initial detail line |
| `--progress <value>` | `0..1`, `45%`, or `6/10` |
| `--status <status>` | Initial status: `pending`, `running`, `waiting`, `done`, `error` |
| `--session <id>` | Session scope (or `PROGRESS_SESSION_ID` / `OPENCODE_SESSION_ID`); omit it to keep the legacy flat keying |
| `--max-hz <n>` | Max state writes per second (default `4`; `0` = unlimited) |
| `--quiet`, `--no-tee` | Do not echo command output back to the caller |
| `--state-path <path>` | Override `~/.opencode-progress-state.json` |
| `--once` | Emit one update and exit (same as `progress-emit`) |

### What the relay does

- Reads `stdin` line-by-line, splitting on `\n`, `\r\n`, and bare `\r` (progress bars often use `\r`).
- Strips ANSI escape sequences and collapses whitespace.
- Parses native **OSC 9;4** progress sequences before text heuristics (Gradle rich console, mise, PowerShell 7.4+, Windows Terminal), and keeps structured progress sticky once seen so a mixed stream cannot make the bar jump backwards.
- Falls back to parsing `45%` and `6/10` from plain output.
- Keeps the latest non-empty line as `detail` (truncated to 240 chars).
- Throttles writes to `--max-hz` so a noisy build cannot hammer the state file.
- **Preserves fields already set by the MCP tool** — attaching a relay does not clobber the agent's title, parent, or status.
- On exit `0`: `status: "done"`, `progress: 1.0`.
- On non-zero exit: `status: "error"`, with the exit code in `detail`.
- On signal: `status: "error"`, with the signal name in `detail`.

### If `progress-relay` is not on `$PATH`

Every form also works through the MCP server binary:

```bash
node /path/to/mcp-server/index.js relay --id build-1 -- npm run build
node /path/to/mcp-server/index.js emit --id build-1 --status running
```

From a checkout, run `cd mcp-server && npm link` to expose `progress-relay` and `progress-emit` globally. Set `PROGRESS_RELAY_CMD` to override the command printed in tool responses.

### A relay is optional

The relay is a convenience, not a requirement. Any process that writes the shared state shape with atomic semantics is a valid data-plane implementation. That is the interop boundary: **state file in, GUI out**. There is nothing OpenCode-specific about the contract.

### Minimal harness checklist

A harness can adopt the paradigm without any custom plugin:

1. Expose a fire-and-forget `progress` tool with the schema above.
2. Return the relay hint (or an equivalent command) whenever `status` is `running`.
3. Give the agent a normal shell that can run `progress-relay --id <id> -- <cmd>`.
4. Have the view read `~/.opencode-progress-state.json` (or `PROGRESS_STATE_PATH`). For a **shared global HUD** that shows several concurrent sessions, keep one state file and rely on `OPENCODE_SESSION_ID` / `PROGRESS_SESSION_ID` scoping; the view can group by `entry.sessionId` if desired.
5. For **per-session isolation** (separate HUD, history, or credentials), give each session its own `PROGRESS_STATE_PATH` instead of sharing one file.
6. Do not add a background polling loop in the model; let the OS process and the view do the waiting.

If you prefer a native implementation, replace step 3 with a stdout watcher or background-job hook that honors the same state shape. The [spec](./docs/out-of-band-relay-spec.md) includes pseudocode and a conformance checklist, which double as an RLHF/reference trajectory: milestone call → relay attach → no polling → one terminal report.

---

## Tool response: the self-teaching hint

When the agent calls `progress({ status: "running" })`, the tool response appends an actionable hint:

```text
Recorded progress [build-1] (running) - Running npm build - 10%
To stream live command output into this indicator without polling, use the out-of-band relay:
  progress-relay --id build-1 -- <cmd>
  # or: <cmd> | progress-relay --id build-1
Do NOT poll, sleep, or re-call progress in a loop for elapsed time or percentages.
Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID; keep task IDs clean (e.g. "build-1").
```

If an entry is scoped to a session, the hint also includes `--session <id>` so the relay attaches to the same namespace. If the bin is not on `$PATH`, the hint uses the exact `node /path/to/index.js relay ...` invocation instead. Either way, the model sees the correct command at the moment it is about to launch the shell command — before the polling loop starts.

---

## Tree-like dependencies (bootvine-inspired)

Both the MCP server and the views support nested tasks via `parentId`. A parent's status is derived from its children, and its progress is the mean of its children when it has no explicit progress:

```
├── build [██████░░░░] 6/10 · compiling SDL2
│   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
└── npm-install [██████████] 10/10 · done ✓
```

If any child errors, the parent shows `error`. If any child is still running/waiting, the parent shows `running`/`waiting`; if the remaining children are queued, the parent shows `pending`. Parent progress is the average of child progress values when the parent has no explicit progress; otherwise the parent's own value wins. The relay can attach to a child with `--parent`, so a long build can stream into `build-1` while the agent only reports milestone transitions.

---

## State store and conformance

Both the MCP server and the relay share [`mcp-server/state-store.js`](./mcp-server/state-store.js):

- **Atomic writes** — write to a temp file in the same directory, `fsync`, then `rename`. Readers never see partial JSON.
- **Cross-process lock** — a `.lock` file serializes read-modify-write cycles, so concurrent child relays updating sibling `parentId` nodes do not lose updates or corrupt parent roll-ups.
- **Stale-lock recovery** — a lock older than 15 seconds is broken rather than wedging the command.
- **TTL cleanup (opt-in)** — nothing is pruned by default; entries ride so the store doubles as a history/report. Enable completed-entry retention with `PROGRESS_AUTO_PRUNE_S=<seconds>` (legacy `PROGRESS_TTL_MS` also works), and the orphaned-`running` sweep with `PROGRESS_STALE_MS`.
- **Session scoping** — when `sessionId` is resolved, keys are `${sessionId}:${id}` and entries carry `sessionId`; parent lookups stay within that namespace. With no session, keys remain flat (`build`) for backwards compatibility.
- **Path override** — `PROGRESS_STATE_PATH` for tests, multiple harnesses, or fully isolated sessions. It must end in `.json`, and an existing file must parse as a progress state document (an `entries` object); otherwise writes are refused rather than clobbering the file.
- **Child→parent map** — `~/.opencode-progress-sessions.json` (`PROGRESS_SESSION_MAP_PATH`) records subagent attribution and is consumed by both the MCP server and the relay.

State file shape (session-scoped example):

```json
{
  "entries": {
    "<sessionId>:build": {
      "id": "build",
      "sessionId": "<sessionId>",
      "status": "running",
      "title": "building SDL2",
      "detail": "compiling source",
      "progress": 0.6,
      "parentId": null,
      "startedAt": 1794559267388,
      "createdAt": 1794559267388,
      "updatedAt": 1794559267388,
      "statusUpdatedAt": 1794559267388
    },
    "<sessionId>:link-lib": {
      "id": "link-lib",
      "sessionId": "<sessionId>",
      "status": "running",
      "title": "linking libSDL2.a",
      "detail": "ld -o libSDL2.a ...",
      "progress": 0.4,
      "parentId": "build",
      "startedAt": 1794559267388,
      "createdAt": 1794559267388,
      "updatedAt": 1794559267388,
      "statusUpdatedAt": 1794559267388
    }
  },
  "version": 2
}
```

The object key is the internal composite key (`"<sessionId>:<id>"`), while `entry.id` and `entry.parentId` stay clean for display and relay commands. Entries written without a session keep the legacy flat key (`"build"`) and omit `sessionId`. Subagent-authored entries additionally carry `subagent: true` and `subagentAgent`.

`startedAt` lets a GUI show true elapsed time even when no relay tick is writing `updatedAt` every second. `statusUpdatedAt` is the last agent-plane update; relay ticks only advance it on a status transition, so the Markdown mirror's "updated" label does not churn at telemetry rates.

The full normative spec, including conformance tests and harness integration notes, is in [`docs/out-of-band-relay-spec.md`](./docs/out-of-band-relay-spec.md).

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     OpenCode Desktop                      │
│                                                           │
│  ┌─────────────┐   milestones   ┌──────────────────────┐  │
│  │    Agent    │───────────────▶│  MCP `progress` tool │  │
│  └─────────────┘                └──────────┬───────────┘  │
│         │                                  │              │
│         │ shell command                    │ atomic write │
│         ▼                                  ▼              │
│  ┌─────────────────────┐      ┌────────────────────────┐  │
│  │ progress-relay      │─────▶│ progress state file    │  │
│  │ (OS data plane)     │      │ ~/.opencode-progress-  │  │
│  │ stdout/stderr/exit  │      │ state.json             │  │
│  └─────────────────────┘      └───────────┬────────────┘  │
│                                           │ read           │
│                               ┌───────────▼────────────┐  │
│                               │ GUI / plugin / TUI     │  │
│                               │ renders nested tree    │  │
│                               └────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

There is no requirement that the data plane be this CLI. A harness can implement the same behavior natively (stdout watcher, background job hook, PTY reader) as long as it honors the state shape and the zero-polling contract. The CLI is the reference implementation and the smallest common denominator.

---

## Testing

```bash
# MCP server, relay, concurrency, attribution
cd mcp-server && npm test        # 57 tests

# Plugin: view helpers, lifecycle, skills, TUI packaging
cd plugin && npm test            # 174 tests
```

The MCP smoke suite covers one-shot emits, session resolution and isolation, subagent mapping and adoption, pipe mode, wrap mode with a failing exit code, field preservation when attaching a relay, the MCP handshake and relay hint, and 16 concurrent writers against one state file.

The plugin suite covers dismissal revival semantics, feedback/monitor decisions, instruction text, MCP launch resolution, tree roll-up, session-map writing, skills packaging/tiers, subagent attribution and prompt stamping, telemetry, TUI row budgeting, and the compiled TUI guard (no React runtime, host imports stay bare).

For manual demos, keep the real state clean by pointing the server, relay, and view at a throwaway file:

```bash
PROGRESS_STATE_PATH=/tmp/progress-demo.json ...
```

---

## Plugin options (full list)

Both the TUI and GUI parts read these options.

```json
{
  "plugins": [
    {
      "package": "@jakedowns/progress-tool-opencode-plugin",
      "options": {
        "barStyle": "emoji",
        "barSegments": 6,
        "barTotal": 420
      }
    }
  ]
}
```

- `barStyle`: `"blocks"` (default, ASCII) or `"emoji"`. The **Progress: switch tree theme** preset picker shows rendered previews for both and writes this option together with `treeTheme`.
- `barSegments`: cells per bar (default 10 for blocks, 6 for emoji).
- `barTotal`: denominator for the `(done/total)` label (default 100).
- `successHoldMs`: how long a `done` task stays visible after its last update (default `8000`). Only applies when `autoHideDone` is enabled.
- `autoHideDone`: hide completed tasks after `successHoldMs`, regardless of dismissal. **Default `false`** — done entries you never dismissed stay visible indefinitely (retention is opt-in, see `PROGRESS_AUTO_PRUNE_S`), including across plugin reloads.
- `retainDeletedSessionProgress`: **Default `false`**. When a session is deleted, its plugin-store entries and child/parent links are purged to reclaim space. Set to `true` to keep them for auditing. The mirrored Markdown tasklist (`PROGRESS_TASKLIST`) is never deleted, only the store copy. A later progress write for the same session can regenerate that mirror from the remaining store entries.
- `relayMirrorLevel`: **Default `0`** when the Markdown tasklist mirror is enabled. `0` omits entries the relay created (successful build spam), `1` mirrors every relay entry (the old behavior), and `2` mirrors relay entries only while their current status is `error`. Agent-created tasks always mirror. The marker is set only when the relay creates an entry; an agent task later driven by relay remains a normal task. Pre-upgrade relay entries have no marker and stay visible until cleared.
- **Nested dismissal:** every row, not just a root, has a dismiss control. Dismissing a descendant hides that node and its subtree and rebuilds the parent’s status/progress from the remaining children; revival semantics are unchanged (a re-report or a child failure can bring a dismissed node back).
- **Clear/delete palette commands**: *Progress: clear list (this session)* soft-deletes done/error and already-dismissed entries by setting `cleared: { at, status }`; records stay on disk and views/counts ignore them. Any agent update revives a cleared entry. *Progress: hard clear this session* permanently removes that session's entries (simple confirmation). *Progress: hard clear entire progress store* wipes every entry and requires typing `DELETE` (no admin gate). All three are palette-only in both the GUI and TUI: there are no pill buttons, clickable links, default keybinds, or slash commands.
- `showDone`: set to `false` to drop completed tasks immediately.
- `scope`: `"session"` (default) shows only the current chat's tasks; `"all"` shows every session sharing the state file.
- `tuiMaxRows`: rows the TUI progress tree may occupy above the prompt (default `8`, max `50`). Roots are collapsed by default; `/progress` expands a tree or dismisses tasks.
- `guiLayout`: desktop/web placement — `"composer"` (default) keeps the pill above the composer; `"sidebar"` registers a pinned Progress tab in the session's side region. The "Progress: swap layout (composer/sidebar)" command flips it at runtime.
- `guiSidebarWidth`: desktop sidebar initial width in CSS pixels (default `360`, clamped to `240-800`). A user drag still overrides it.
- `guiDetailLines`: detail text cap in the pill menu and sidebar rows (default `1` line, rendered with an ellipsis). `0` hides details for titles only; `-1` disables truncation and shows the full text; any positive number clamps to that many lines (max `100`).
- `treeTheme`: tree-row rendering for the GUI pill popover, GUI sidebar panel, and TUI tree — `"default"` (default) or `"compact"`. `"compact"` removes every progress-bar glyph from those rows (no blocks, emoji bar, or fraction), hides the GUI `started …` line, keeps one detail line regardless of `guiDetailLines` (`guiDetailLines: 0` still hides it), tightens GUI row padding, and shows the percentage plus a `& N more` collapsed-descendant suffix instead. It is view-only: the GUI composer pill capsule and its `barStyle` rendering are unchanged. The **Progress: switch tree theme** palette command now presents three presets with inline previews — **ASCII** (`treeTheme: "default"`, `barStyle: "blocks"`), **Emoji** (`"default"`/`"emoji"`), and **Compact** (`treeTheme: "compact"`) — applies the choice immediately, and writes both `treeTheme` and `barStyle` into the OpenCode config that declares the plugin (project `opencode.json`/`.jsonc` first, then the global config); a config it cannot find or parse leaves the runtime choice applied and reports why nothing was saved. Expanded child rows in the GUI pill popover and sidebar are prefixed with `└─` before the status dot, matching the TUI.
- `refreshMs`: how often the views re-read progress state in milliseconds (default `1000`, minimum `100`). Applies to the TUI poller, desktop GUI refresh loop, and the plugin's server-side state watcher. The standalone GUI server has the same knob via `PROGRESS_GUI_REFRESH_MS`.
- `taskListFile`: set `true` to mirror the session's tasks to `tasklist-<session>.md` on every progress write. **Default `false`**. The file is plaintext and may contain sensitive detail; see the mirror section below.
- `taskListLocation`: `1` (default) writes `<project>/tasklist-<session>.md`; `0` writes `<project>/.progress/tasklist-<session>.md`; `2` writes `~/.opencode-progress/tasklist-<session>.md`. There is no raw path option, so `..`/absolute paths are not part of the config.
- `taskListView`: `"ui"` (default) hides dismissed/cleared entries and rolls child status up so the Markdown matches the UI; `"raw"` keeps every entry and the stored status. The TUI/GUI palette command **Progress: task-list mirror view** toggles this when the mirror is active; the change applies to the next render, not to existing entries.
- `taskListDetail`: `"code"` (default) renders detail in a fenced code block; `"escaped"` renders inline Markdown-escaped text; `"raw"` is an explicit opt-in for trusted content.
- `taskListOrder`: `"newest-first"` (default; newest `createdAt` at the top) or `"oldest-first"` (append at the bottom).
- `strictMode`: `"nudge"` (default), `"force"`, or `"off"`. Watches **model steps** (not raw tool calls, so parallel tools in one step count once): without any task entry, or with pending tasks whose progress has not changed, it writes one compact standing `progress-reminder` entry (`[info]`/`[warn]`/`[block]` prefix) that names the oldest stale entry and one action. Tune with `strictThreshold` (default `3` steps), `staleAfterMs` (default `5` min), `cooldownMs` (default `2` min), and `staleEscalateAfter` (default `3`). The first `staleEscalateAfter` stale reminders ride the context entry; the next one escalates **once** to a synthetic `[block]` message so it is a real turn input. Set `staleEscalateAfter: 0` to disable escalation. A `waiting` entry with a non-empty detail touched within `staleAfterMs` is considered healthy blocked work and does not trigger strict/idle/wall nudges; stale or detail-less waiting still counts. Unchanged reminder text is deduped inside `cooldownMs`, counters reset on a new prompt and on any progress write, and `warn`-level reminders are suppressed while a tool is in flight.
- `idleReminder`: set to `false` to disable the turn-end nudge. By default, when a session is about to go idle with stale running/waiting/pending entries still open, the plugin admits **one `[block]` synthetic message** ("turn ending with N open tasks: …") into the same execution. Healthy fresh-detail waiting entries are excluded. Debounced by entry signature, a 2-minute cooldown, and a per-run cap.
- `unhinged`: set to `true` to append `[did the user's message just change your workload? update your task list!]` to every user message. **Default `false`** — it edits user input text, so it is strictly opt-in.
- `expandRootsByDefault`: roots with children are collapsed by default in the pill menu and TUI. Set to `true` to expand them by default; per-root toggles still work.
- `registerSkills`: set to `false` to skip skill registration entirely. Default: the usage and delegation skills register automatically.
- `demoSkills`: set to `true` to also register the two demo skills (`osc-demo`, `tree-demo`) shipped in `optional-skills/`. **Default `false`**.
- `injectInstructions`: set to `false` to skip the injected progress/relay rules (useful if you maintain your own `AGENTS.md`).
- `relayHints`: set to `false` to disable the pre-flight "wrap this in the relay" hint.
- `customNudges`: set to `true` to enable custom nudge rules, the `progress_nudge` agent tool, and the TUI/palette commands. **Default `false`**; with it off, rule files are ignored and nothing is registered.
- `notifyOnLoad`: set to `true` for a toast when the plugin loads.
- `verboseLogging`: record every nudge the plugin injects as JSONL in `~/.opencode-progress-nudges.log` (override with `PROGRESS_NUDGE_LOG`). Events: `config`, `strict` (including `action: "stale-escalate"` and `priorNudged`/`staleNudges`), `compliance` (a standing nudge cleared by a real progress write, with `afterMs`), `wall-clock`, `idle-reminder`, `child-list-error`, `transition`, `relay-hint`, `subagent`, `unhinged`. **Default `false`**. Wall-clock tuning: `wallClockMs` (default 120s), only fires for sessions with a tool call in the last 10 minutes, is measured from `max(lastProgressAt, promptAt)` so resumed sessions do not print absurd ages, pauses while a tool is in flight, and caps at 3 reminders per non-progress stretch.
- `autoRegisterMcp`: set to `false` to keep the plugin from registering the MCP server itself (you manage `mcp.servers` manually).
- `mcpRuntime`: absolute path to the `node`/`bun` used to spawn the MCP server (auto-detected). Set it if detection picks the wrong runtime.

### `say` (experimental, opt-in)

`say` is the narration channel beside the task tree. Opt in with
`{ "options": { "say": true } }`. The agent gets a tool that posts a short note
mid-turn — what it is about to do plus a rough ETA — so the user is not left
watching a spinner or digging through the thought trace while a long tool runs.
Because it is a tool call, the turn cannot end on a note.

- `say`: register the tool and inject its rules. **Default `false`**.
- `sayMinChars` / `sayMaxChars`: preferred range (default `180`–`260`). Notes outside it are accepted **in full**; the success result carries a reminder (`aim for <min>–<max> next time`). Length never skips, rejects, or rewrites a note. Both clamp to `20..600`, with `sayMaxChars` raised to `sayMinChars` when inverted.
- `sayBudgetPerTurn`: accepted notes per user turn (default `3`).
- `sayCooldownMs`: minimum gap between accepted notes (default `15000`).
- `sayChatNotes`: set to `false` for the instant progress line only, without the durable synthetic note.
- `sayFinalGuard`: if the agent posts a note and then stops without a conclusion, resume the turn once (default `true`).
- `sayModes`: where note surfaces appear. **Default `["tree"]`**. Accepts a string or an array of `"pill"`, `"toast"`, `"tree"`; `sayMode` is a scalar alias. Unknown values are dropped, duplicates collapse, and an explicit `[]` records notes with no surface. This is view config only: the tool, its budget, and `sayChatNotes` stay independent.
- `sayAutoHideTimeoutMs`: hide notes older than this from every notes surface (default `60000`, clamp `0..86400000`; `0` disables auto-hide and keeps notes until manually dismissed). A note is visible only while `now - note.at < timeout`; hidden notes remain in the shared ring buffer, so this is view-only and never changes the tool, store, or purge rules.
- `sayToastScope`: which rolled-up notes may raise a toast when `toast` is in `sayModes`: `"own"` (default; notes authored by the viewed session), `"warnings"` (own plus child `blocked`/`question`), or `"all"`. Child notes still roll up in the line, pill, and history regardless. `blocked`/`question` toasts last `12000`ms; other notes `5000`ms, in both clients.
- `sayNudge`: opt-in reminder, **only active when `say: true`**. `"long-tool"` (or `true`) leaves one **context-only** nudge after a tool runs longer than `sayNudgeAfterMs` with no accepted say this turn. `"silent-run"` is the forgot-to-narrate nudge: it fires after `sayNudgeMinCalls` non-`say`/progress tool calls in a row with no note. `"both"` fires on either condition. **Default `off`.** A nudge cannot reach the model while the tool is still running, so it is deliberately retrospective: it asks for a say before the *next* step. It never sends a synthetic message, never fires for `say`/progress calls, is suppressed while any standing reminder entry exists, and clears when a note is accepted. `sayNudgeMinCalls` defaults to `3` (clamp `1..50`); `sayNudgeCooldownMs` (default `120000`) and `sayNudgeMaxPerTurn` (default `1`, max `3`) bound repeats; per-turn counts reset on the next prompt while the cooldown timestamp persists.

Budget and cooldown skips return a result that points the agent at the `progress`
tool for any further backchannel updates in that turn.

**Mode matrix.** `pill` is a desktop/web composer capsule; the TUI has no pills,
so it maps `pill` to the tree line and dedupes when `tree` is also enabled. The
GUI composer layout has no tree, so `tree` falls back to the pill there.

| mode | TUI | GUI composer layout | GUI sidebar layout |
|---|---|---|---|
| `tree` | dim latest-note line above the tree | falls back to the notes pill | latest-note line above the panel tree (plus the pill popover when `pill` is also on) |
| `pill` | latest-note line (pill has no TUI equivalent) | notes composer pill | notes composer pill |
| `toast` | one toast per new note | one toast per new note | one toast per new note |

Toasts dedupe by note id and only fire for notes that appear after the view
loaded. `sayToastScope` controls which rolled-up notes may toast (default
`"own"`); child notes always roll up in the line/pill/history with
`[Subagent (X)]` attribution. `blocked`/`question` toasts use the warning
variant in the TUI and the warning icon in the GUI, and stay for 12s instead of
5s. Every surface also applies `sayAutoHideTimeoutMs`: an expired latest
note falls back to the next visible note, and the surface disappears when none
remain. Expired notes are still in the shared state and never toasted.

**Notes lane.** Every accepted note is also persisted in the shared state
document (last 20 per author session, newest first) — independently of the
transcript and of `sayChatNotes`:

- **TUI:** a dim latest-note line above the tree (`notes: … (N notes)`) when
  `sayModes` includes `tree` or `pill`. Click the line (or pick **Notes (N)** in
  `/progress`) for the newest-first history; the trailing `✕` on the line
  dismisses the latest note, and each note in the history can be dismissed
  individually or with **Dismiss all notes**.
- **Desktop/web:** the `pill` mode adds a composer pill showing the latest
  snippet, warning-tinted for `blocked`/`question`; its popover lists
  newest-first history with a `×` per note and **Dismiss all notes**. `tree`
  adds the latest-note line above the sidebar panel tree and in the pill
  popover. Pills float above the timeline, so they stay visible in both
  composer and sidebar layouts; `toast` works independently of layout.
- **Subagents:** child-session notes roll up to the parent view (prefixed
  `[Subagent (Explore)]`), including toasts, and each child keeps its own note
  budget.
- **Dismissal:** dismissing removes the note from the shared ring buffer, so
  every open client updates on its next poll/event. **Dismiss all notes** is
  root-scoped: it clears the same rolled-up tree the viewer is reading.
- **Lifecycle:** notes survive **Progress: clear list**; they are deleted with
  the session and by the hard-clear commands. The per-session ring buffer keeps
  the store bounded.

---

## Custom nudges

A **custom nudge** is a user- or agent-defined reminder delivered to the
**model**, not the user. The feature is **opt-in**: set
`{ "customNudges": true }` on the plugin entry to enable the rule engine, the
`progress_nudge` agent tool, and the TUI/palette commands. With the flag off,
no rule files are read and no commands or tools are registered. It reuses the reminder engine from 2.22.0 (severity
tiers, one standing `progress-reminder` entry, dedupe, model-step counting,
in-flight suppression) and adds configurable text, trigger, cooldown,
criteria, lifetime, and delivery.

### Rule files

Rules live in dedicated files; `opencode.json` is never modified.

| Scope | File | Applies to |
|---|---|---|
| global | `~/.config/opencode/progress-nudge.json` | every session |
| project | `<projectRoot>/.opencode/progress-nudge.json` | sessions in that project |
| session | `~/.config/opencode/progress-nudge-sessions.json` | one session id, stored separately |

`<projectRoot>` is the nearest ancestor containing `.git` or `.opencode`
(falling back to the current directory). Writes are atomic (temp + rename).
Invalid rules are ignored at load and reported by `status`/`list`; a malformed
file never breaks startup.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "stale-build",
      "title": "Stale build reminder",
      "enabled": true,
      "scope": "project",
      "text": "{count} open: {id} ({status}, {age}) — {action}",
      "severity": "warn",
      "trigger": { "type": "interval", "everyMs": 300000 },
      "cooldownMs": 120000,
      "criteria": { "statuses": ["running", "waiting"], "staleAfterMs": 600000 },
      "delivery": "context-replace",
      "ttlMs": 3600000,
      "maxFires": 0
    }
  ]
}
```

Durations accept milliseconds or strings (`30s`, `5m`, `2h`, `1d`).
Placeholders: `{id}`, `{title}`, `{status}`, `{age}`, `{count}`, `{action}`.
Unknown placeholders are rejected at save/preview time; text is capped at 240
characters. Limits: 20 rules per scope, 50 total.

### Triggers

- `{ "type": "interval", "everyMs": ... }` — clock-based; minimum 5s.
- `{ "type": "steps", "everySteps": n }` — logical model steps (parallel tool
  calls in one step count once); resets on any progress write.
- `{ "type": "either", "everyMs"?: ..., "everySteps"?: ... }` — whichever comes
  first.
- `{ "type": "event" }` — evaluated on tool completion, turn end, and progress
  events; `cooldownMs` is the only rate gate.

### Criteria

All specified categories must pass (**AND**); arrays are **OR** inside the
category. Entry categories narrow the matched set used for `{id}`/`{count}`.

| Field | Meaning |
|---|---|
| `statuses` | any entry with one of these statuses |
| `staleAfterMs` | an entry untouched longer than this; fresh-detail `waiting` is healthy unless `waiting` is listed explicitly |
| `noProgressAfterMs` | no progress write for this long |
| `noProgressAfterSteps` | at least this many model steps since progress |
| `inFlight` | `only`, `never`, or `any` (tool/background work) |
| `tree` | `empty` or `nonempty` |
| `idleOnly` | evaluate only at turn end |
| `entryIds` | restrict to specific storage keys/ids |
| `sessions` | `self` (default), `children`, or `all` |

### Delivery and lifetime

- `context-replace` — standing context entry; **pauses built-in nudges**
  (strict/wall/idle/relay/say) while the rule is live.
- `context-alongside` — crowds in beside built-ins; identical rendered text is
  deduped, narrower scope wins.
- `synthetic` — a real turn input; allowed only with `severity: "block"` because
  it resumes the model.
- `ttlMs` (`0` = no expiry) and `maxFires` (`0` = unlimited, `1` = one-shot).
  Expired/exhausted rules stay listed until cleared.
- Priority is `block > warn > info`; a lower tier cannot overwrite a standing
  higher-tier reminder.
- Runtime counters are per session, even for global/project rules.

### Presets

1. **Replace built-ins (recommended)** — context `warn`, every 5m, 2m cooldown,
   1h TTL, unlimited fires; suppresses built-ins while active.
2. **Alongside** — same timing, built-ins remain.
3. **Synthetic block** — one-shot `block` + synthetic delivery.
4. **Custom** — choose trigger, criteria, delivery, TTL, and fire cap.

### Surfaces

```text
/progress nudge                         # wizard
/progress nudge list
/progress nudge status
/progress nudge set --id build --text "{id} stale — {action}" --every 5m --cooldown 2m --status running
/progress nudge on  session:build
/progress nudge off session:build
/progress nudge clear project:build
```

CLI `set` flags: `--scope`, `--severity`, `--delivery`, `--preset`, `--every`,
`--steps`, `--cooldown`, `--ttl`, `--max-fires`, `--one-shot`, `--status`,
`--stale`, `--no-progress`, `--in-flight`, `--tree`, `--idle`, `--ids`,
`--sessions`, `--event`. With no `--id`/`--text`, the wizard runs.

Palette commands:

- **Progress: custom nudge…** — preset → scope → id → text → interval →
  severity → confirm.
- **Progress: custom nudge status** — list rules; enable, disable, or clear one.

Agent tool `progress_nudge` (`set`, `list`, `status`, `on`, `off`, `clear`)
defaults to **session scope**. It refuses project/global rules because the tool
surface cannot show a host permission prompt; ask the user to create those via
the slash command, palette, or rule files. Agents should use it for a temporary
self-reminder, not to nag the user — `say` remains the user-facing channel.

### Disable and tombstones

`enabled: false` in a narrower scope with the same `id` mutes that id in broader
scopes (project mutes global; session mutes both). This lets a user silence one
project rule without editing the global file. `on`/`off <scope>:<id>` targets a
single rule.

---

### Local task-list mirror

The optional mirror is enabled with `taskListFile: true` (or
`PROGRESS_TASKLIST=1` when configuring the MCP server manually). It writes
`tasklist-<session>.md` on progress writes; `tasklistLocation` chooses
`<project>/` (default), `<project>/.progress/`, or `~/.opencode-progress/`.
There is deliberately no free-form path, so project config cannot point it at
`~/.bashrc` or `../outside`.

- `ui` view (default) hides dismissed/cleared entries and rolls child status
  up, matching the UI. `raw` keeps everything and shows stored status.
- Detail is a fenced code block by default; `escaped` and `raw` are opt-ins.
- The mirror never overwrites a non-empty file unless it begins with the
  progress-tool mirror marker.
- Runtime prefs/status live next to the state file
  (`.opencode-progress-tasklist-prefs.json` and `-status.json`). The palette
  command **Progress: task-list mirror view** appears only while the mirror is
  active and toggles UI/raw.
- The file is plaintext. Add `tasklist-*.md` (and `.progress/`) to
  `.gitignore`, or use location `2`.
- `relayMirrorLevel` defaults to `0` (omit relay-created command entries); `1`
  mirrors every relay entry, and `2` mirrors only relay entries whose current
  status is `error`. Agent-created tasks always mirror.
- See [`mcp-server/README.md`](./mcp-server/README.md#local-task-list-mirror)
  for the env vars and an example.

---

## Components and files

| Component | Path |
|-----------|------|
| MCP server (`progress`, `list` tools; stdio + CLI dispatch) | `mcp-server/index.js` |
| Shared atomic, locked state store + tree roll-up | `mcp-server/state-store.js` |
| Optional Markdown task-list mirror | `mcp-server/task-list.js` |
| Out-of-band relay (pipe, wrap, emit) | `mcp-server/relay.js` |
| Subagent usage report CLI | `mcp-server/report.js` |
| `progress-relay` / `progress-emit` bin shims | `mcp-server/progress-relay.js`, `mcp-server/progress-emit.js` |
| MCP test suite (57 tests) | `mcp-server/test/smoke.test.js`, `mcp-server/test/task-list.test.js` |
| OpenCode plugin: server part (RPC, hooks, nudges) | `plugin/src/index.ts` |
| Desktop/web composer pill | `plugin/src/gui.tsx` |
| TUI composer footer + bounded tree | `plugin/src/tui.tsx`, `plugin/src/tui-view.ts` |
| Shared RPC contract (`list`, `updated`) | `plugin/src/rpc.ts` |
| State reader + dismissal/session-map writer | `plugin/src/state.ts` |
| Tree helpers (scope, visibility, roll-up, labels) | `plugin/src/tree.ts` |
| Injected rules + session attribution block | `plugin/src/instructions.ts` |
| Strict/wall-clock/idle logic | `plugin/src/monitor.ts` |
| Subagent prompt stamping | `plugin/src/subagent.ts` |
| Skill registry tiers | `plugin/src/skills.ts` |
| MCP launch resolution | `plugin/src/mcp.ts` |
| `say` narration tool + notes persistence | `plugin/src/say.ts`, `plugin/src/state.ts` |
| Nudge telemetry | `plugin/src/telemetry.ts` |
| Feedback record/read | `plugin/src/feedback.ts` |
| Types | `plugin/src/types.ts` |
| Default skills (registered) | `plugin/skills/progress-tool/`, `plugin/skills/delegation/` |
| Demo skills (opt-in) | `plugin/optional-skills/osc-demo/`, `plugin/optional-skills/tree-demo/` |
| Prebuilt desktop/web bundle | `plugin/dist/gui-experimental.cjs` |
| Precompiled TUI entry | `plugin/dist/tui.js` |
| TUI build script | `plugin/scripts/build-tui.mjs` |
| Plugin test suite (174 tests) | `plugin/test/*.test.cjs` |
| Standalone desktop GUI server | `progress-gui-server.js` |
| Launch / setup scripts | `launch-gui.sh`, `setup.sh` |
| GUI build script (stages off the repo mount) | `scripts/build-gui.sh` |
| Demos | `demo/osc-demo.sh`, `demo/tree-demo.sh` |
| Relay spec / status-shim notes | `docs/out-of-band-relay-spec.md`, `docs/desktop-status-shim.md` |
| Text/CLI guide | `tui-progress-guide.md` |

V2 loads the server part from `plugin/src/index.ts` (via the package `exports` map) and the prebuilt GUI/TUI bundles from `plugin/dist/`. The legacy V1 entrypoints (`plugin/index.js`, `plugin/gui-experimental.js`) have been removed; they were never loaded by V2.

### Build notes

`npm run build` (in `plugin/`) does two things:

1. **GUI** — `scripts/build-gui.sh` stages the plugin sources in `/tmp/opencode/build/progress-gui`, symlinks the installed deps, builds there, and copies only `dist/gui-experimental.cjs` back. This keeps slow network/VM mounts out of the build path (override with `PROGRESS_BUILD_DIR`).
2. **TUI** — `scripts/build-tui.mjs` runs Babel's Solid transform (via `@opentui/solid`'s pure transform) and esbuild, leaving `solid-js`, `@opentui/*`, and `@opencode/plugin/tui` external so the host bridges its own runtime. The compiled `dist/tui.js` is required for npm installs: raw TSX under `node_modules` is skipped by OpenCode's Solid transform and falls back to React's JSX runtime.

`dist/gui-experimental.cjs` and `dist/tui.js` are committed, so a fresh checkout already has working bundles.

## Future enhancements / backlog

- **Pill virtualization or pagination (P4).** Deferred until the visible row count exceeds roughly 100, or users still report frame drops after the memoized derivation and stable-row work. Virtualization reduces DOM/paint cost; it does not replace the tree/dismissal memoization.
