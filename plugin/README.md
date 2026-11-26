# @jakedowns/progress-tool-opencode-plugin

[![npm version](https://img.shields.io/npm/v/@jakedowns/progress-tool-opencode-plugin?style=flat-square&logo=npm)](https://www.npmjs.com/package/@jakedowns/progress-tool-opencode-plugin)
[![monthly downloads](https://img.shields.io/npm/dm/@jakedowns/progress-tool-opencode-plugin?style=flat-square&label=downloads%2Fmo)](https://www.npmjs.com/package/@jakedowns/progress-tool-opencode-plugin)
[![license](https://img.shields.io/npm/l/@jakedowns/progress-tool-opencode-plugin?style=flat-square)](https://github.com/jakedowns/progress-tool/blob/master/LICENSE)

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
  Set `guiLayout: "sidebar"` for a pinned tab in the session's side panel, or
  flip placements from the pill's `[Sidebar]` action / the "Progress: swap
  layout" command.
- **Optional Markdown mirror** — opt-in `tasklist-<session>.md` under the
  project, `.progress/`, or `~/.opencode-progress/`; UI/raw views, safe
  code-block detail, and a palette toggle.
- **Guidance that adapts** — injected rules, skill playbooks, pre-flight relay
  hints, strict-mode nudges (silent runs, stale progress with one synthetic
  escalation after 3 entry reminders), a turn-end idle reminder, and an
  optional 2-minute wall-clock nudge.
- **Subagent attribution** — child→parent links are recorded from
  `session.created` (map in `~/.opencode-progress-sessions.json`, override
  `PROGRESS_SESSION_MAP_PATH`) and the parent id is stamped into each subagent
  prompt at launch, so child work rolls up in the parent's pill instead of an
  orphaned child scope. Child rows are labeled `[subagent <session name>]` (name truncated to 20 chars; the type shows in the GUI hover tooltip), or
  `[Subagent]`) so delegated work is obvious at a glance.

## Options

Pass under the plugin entry's `options` in `opencode.json`:

| option | default | meaning |
|---|---|---|
| `injectInstructions` | `true` | inject progress/relay rules into every session |
| `registerSkills` | `true` | register the default skills (usage + delegation) |
| `demoSkills` | `false` | also register the demo skills (`osc-demo`, `tree-demo`) |
| `autoRegisterMcp` | `true` | register `@jakedowns/progress-tool-mcp` automatically |
| `taskListFile` | `false` | mirror the session's tasks to a local Markdown checklist |
| `taskListLocation` | `1` | `0` = `.progress/`, `1` = project root, `2` = `~/.opencode-progress/` |
| `taskListView` | `"ui"` | `"ui"` hides dismissed entries and rolls status up; `"raw"` keeps everything |
| `taskListDetail` | `"code"` | `"code"` fenced block, `"escaped"` inline, `"raw"` unescaped |
| `taskListOrder` | `"newest-first"` | `"newest-first"` (new at top) or `"oldest-first"` (append at bottom) |
| `relayMirrorLevel` | `0` | `0` omit relay-created entries, `1` mirror all relay entries, `2` relay errors only |
| `mcpRuntime` | auto | absolute path to the `node`/`bun` used to spawn the MCP server (auto-detected; set this if detection picks wrong) |
| `strictMode` | `"nudge"` | `"nudge"` / `"force"` / `"off"` model-step monitor |
| `staleEscalateAfter` | `3` | entry-based stale reminders before one synthetic escalation (`0` disables) |
| `wallClockMs` | `120000` | wall-clock nudge threshold (`0` disables) |
| `idleReminder` | `true` | turn-end nudge when open tasks remain |
| `indicatorStyle` | `"dot"` | `"dot"`, `"circles"`, or `"checkbox"`; also the **Progress: indicator style** command |
| `customNudges` | `false` | opt-in custom rule editor and TUI/palette commands; agent mute stays available |
| `idleStaleMs` | `600000` | owned-entry staleness before the turn-end nudge |
| `nudgeGapMs` | `60000` | quiet period between non-block reminders |
| `unhinged` | `false` | append a task-list reminder to every user message |
| `verboseLogging` | `false` | JSONL nudge telemetry (`~/.opencode-progress-nudges.log`) |
| `autoHideDone` | `false` | hide completed tasks after the success hold |
| `expandRootsByDefault` | `false` | expand pill tree roots by default |
| `barStyle` | `"blocks"` | `"blocks"` (ASCII) or `"emoji"`; preset picker writes it with `treeTheme` |
| `refreshMs` | `1000` | view refresh interval |
| `retainDeletedSessionProgress` | `false` | keep store entries when a session is deleted |
| `tuiMaxRows` | `8` | max TUI tree rows above the prompt; `/progress` expands or dismisses |
| `tuiMaxRoots` | `3` | root tasks shown before the full-tree summary; palette has "Progress: set root cap" |
| `tuiLayout` | `"composer"` | TUI placement: `"composer"` (above the prompt) or `"sidebar"`; `/progress swap-layout` toggles it |
| `tuiSidebarRows` | `0` | sidebar viewport height in rows (0-100); `0` renders the full tree and lets the sidebar scroll |
| `guiLayout` | `"composer"` | Desktop/web placement: `"composer"` pill or a pinned `"sidebar"` panel; the "Progress: swap layout" command toggles it |
| `guiSidebarWidth` | `360` | Desktop sidebar initial width in CSS pixels (clamp 240-800); dragging still wins |
| `guiDetailLines` | `1` | Detail line cap in the pill menu and sidebar rows: `-1` full text, `0` titles only, `n` lines with `…` (max 100) |
| `treeTheme` | `"ultra-compact"` | Tree row theme: `"default"`, `"compact"` (no bars/started line, one detail line, `40% · & N more`), or `"ultra-compact"` (title + status-light emoji + started/updated/elapsed prefix + dismiss). The command offers ASCII/Emoji/Compact/Ultra presets and saves both options |

### Experimental: `say` (opt-in)

`say` lets the agent post a short note mid-turn: what it is about to do and a
rough ETA. The note appears immediately on the tool's progress line and is also
admitted as a durable synthetic note (`resume: false`), so the user does not have
to open the thought trace while a long tool runs. It is a tool call, so the turn
cannot end on a note.

Accepted notes also feed a small persistent lane (last 20 per session). Pick
the surfaces with `sayModes` (default `["tree"]`; `sayMode` is a scalar alias):
`tree` renders the latest note above the tree (TUI; GUI sidebar panel and pill
popover), `pill` adds the notes composer pill, and `toast` raises one toast per
new note. The TUI maps `pill` to its tree line, and the GUI composer layout maps
`tree` back to the pill. An empty array records notes without showing them.
Child-session notes roll up to the parent with `[Subagent (X)]` attribution.
Click the TUI line or `/progress` → **Notes** / the pill popover for newest-first
history; dismiss one note with its `×` or all notes at once. Dismissals delete
the note from the shared ring buffer, so every client updates. Notes older than
`sayAutoHideTimeoutMs` are hidden from every surface (default 60s; `0` keeps
them until dismissed) without being deleted. Notes survive clear-list and are
removed with the session or a hard clear.

```jsonc
{ "options": { "say": true } }
```

| option | default | meaning |
|---|---|---|
| `say` | `false` | register the `say` tool and inject its narration rules |
| `sayMinChars` | `180` | soft target; shorter notes are accepted with a warning |
| `sayMaxChars` | `260` | preferred max; longer notes are accepted in full with a reminder |
| `sayBudgetPerTurn` | `3` | accepted notes per user turn |
| `sayCooldownMs` | `15000` | minimum gap between accepted notes |
| `sayChatNotes` | `true` | `false` = progress line only, no synthetic note |
| `sayFinalGuard` | `true` | if the agent posts a note and stops without concluding, resume once |
| `sayModes` | `["tree"]` | surfaces: string/array of `"pill"`, `"toast"`, `"tree"`; `sayMode` alias; `[]` records only |
| `sayAutoHideTimeoutMs` | `60000` | hide notes older than this from every surface; `0` keeps until dismissed; view-only |
| `sayToastScope` | `"own"` | toast `own` notes, own + child `warnings`, or `all`; child notes always roll up in the line/pill |
| `sayNudge` | `off` | opt-in reminder, only with `say: true`: `"long-tool"`/`true`, `"silent-run"` (forgot-to-narrate call count), or `"both"`; context-only, never synthetic |
| `sayNudgeAfterMs` | `20000` | minimum tool duration before a `"long-tool"` reminder |
| `sayNudgeMinCalls` | `3` | tool calls with no note before a `"silent-run"` reminder (clamp `1..50`) |
| `sayNudgeCooldownMs` | `120000` | minimum gap between say reminders |
| `sayNudgeMaxPerTurn` | `1` | max reminders per user turn (max `3`) |

Length never skips a note. Budget and cooldown skips return a result that points
the agent at the progress tool for any further backchannel updates in that turn.

---

### Local task-list mirror

`taskListFile: true` writes `tasklist-<session>.md` on progress writes. It is disabled by default and never calls the model.

- **Location:** `0` → `<project>/.progress/tasklist-<session>.md`; `1` → `<project>/tasklist-<session>.md` (default); `2` → `~/.opencode-progress/tasklist-<session>.md`.
- **View:** `ui` (default) hides dismissed/cleared entries and rolls child status up so the Markdown matches the UI. `raw` keeps everything and shows stored status. The palette command **Progress: task-list mirror view** appears once the mirror is active and toggles this; the change applies to the next render, not retroactively to existing entries.
- **Detail:** a fenced code block by default. `taskListDetail: "escaped"` renders inline Markdown-escaped text; `"raw"` is an explicit opt-in for trusted content.
- **Hygiene/security:** the file is plaintext and may contain sensitive task titles/details. Add `tasklist-*.md` (and `.progress/` if you use location `0`) to `.gitignore`, or use location `2` to keep it outside the repo. It never overwrites a non-empty file unless that file starts with the progress-tool mirror marker.
- **Manual MCP config:** plugin options are only mapped when the plugin auto-registers `progress-server`. If you configure that server yourself, set `PROGRESS_TASKLIST` / `PROGRESS_TASKLIST_LOCATION` / `PROGRESS_TASKLIST_MODE` / `PROGRESS_TASKLIST_DETAIL` / `PROGRESS_TASKLIST_ORDER` / `PROGRESS_TASKLIST_RELAY_LEVEL` in its `environment` instead (see the MCP README).
- **Relay entries:** `relayMirrorLevel` defaults to `0` (omit relay-created command entries); `1` mirrors every relay entry, and `2` mirrors only relay entries whose current status is `error`. Agent-created tasks always mirror.
- **Custom state path:** prefs/status live next to the state file. If you override `PROGRESS_STATE_PATH` only in the MCP server's environment, also export it for the OpenCode/plugin process, or the palette toggle will write its preference beside the default state file.

State lives in `~/.opencode-progress-state.json` (override with
`PROGRESS_STATE_PATH`). Retention is opt-in (`PROGRESS_AUTO_PRUNE_S`); entries
ride by default so the store doubles as a report.

## Links

- Repository & full docs: <https://github.com/jakedowns/progress-tool>
- Spec: `docs/out-of-band-relay-spec.md`
- License: MIT
