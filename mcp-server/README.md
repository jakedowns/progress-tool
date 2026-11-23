# @jakedowns/progress-tool-mcp

MCP server and out-of-band relay for agent progress reporting. Fire-and-forget
progress states, dependency trees that roll up, and zero-token telemetry for
long-running commands.

## Run as an MCP server

```jsonc
{
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

Exposes two tools:

- `progress` — record/update a task; bulk `entries[]` creates a whole tree in
  one atomic write; `status` is `pending | running | waiting | done | error`.
- `list` — read-only: session's trees as text, dismissed entries hidden.

## Relay long-running commands

```bash
progress-relay --id build-1 -- npm run build   # wrap: exit code → done/error
npm test | progress-relay --id test-1          # pipe: done on EOF
progress-emit --id build-1 --status running --title "Build"
```

The relay parses `NN%` / `N/M` and native `OSC 9;4` progress sequences,
throttles state writes (default 4/s), renders `done`/`error` from the exit
status, and tees output. Zero model tokens for telemetry.

## Subagent attribution

Subagents report with their own child session id. Before writing, the server
resolves that id through `~/.opencode-progress-sessions.json` (written by the
plugin's idle hook, override with `PROGRESS_SESSION_MAP_PATH`), following chains
for nested subagents, and re-keys any entries the child wrote earlier. Pass an
explicit parent `sessionId` / `--session` when known — that always wins.

## Reports

```bash
node index.js report
```

Reads the local OpenCode database read-only (requires `python3`) and prints the
`general` vs `explore` subagent split plus your delegation rate.

## Options (environment)

| variable | default | meaning |
|---|---|---|
| `PROGRESS_STATE_PATH` | `~/.opencode-progress-state.json` | shared state file |
| `PROGRESS_SESSION_ID` | `$OPENCODE_SESSION_ID` | session scope |
| `PROGRESS_SESSION_MAP_PATH` | `~/.opencode-progress-sessions.json` | child→parent map used to roll subagent progress up under the parent |
| `PROGRESS_TTL_MS` | — | legacy completed-entry retention |
| `PROGRESS_AUTO_PRUNE_S` | off | completed-entry retention in seconds |
| `PROGRESS_STALE_MS` | off | sweep `running` entries untouched this long |
| `PROGRESS_RELAY_MAX_HZ` | `4` | relay write throttle |
| `PROGRESS_TASKLIST` | off | mirror the session's tasks to a local Markdown checklist |
| `PROGRESS_TASKLIST_LOCATION` | `1` | `0` = `<cwd>/.progress/`, `1` = `<cwd>/`, `2` = `~/.opencode-progress/` |
| `PROGRESS_TASKLIST_MODE` | `ui` | `ui` (hide dismissed + rolled-up status) or `raw` (everything, stored status) |
| `PROGRESS_TASKLIST_DETAIL` | `code` | `code` (safe fenced block), `escaped` (inline), `raw` (opt-in) |
| `PROGRESS_TASKLIST_ORDER` | `newest-first` | `newest-first` (new tasks at top) or `oldest-first` (append at bottom) |
| `PROGRESS_TASKLIST_RELAY_LEVEL` | `0` | relay-created entries: `0` omit, `1` all, `2` errors only |

## Local task-list mirror

Set `PROGRESS_TASKLIST=1` to keep a Markdown checklist in sync with every
progress write. It is disabled by default and never calls the model.

```jsonc
{
  "mcp": {
    "servers": {
      "progress-server": {
        "type": "local",
        "command": ["npx", "-y", "@jakedowns/progress-tool-mcp"],
        "environment": {
          "PROGRESS_TASKLIST": "1",
          "PROGRESS_TASKLIST_LOCATION": "1",
          "PROGRESS_TASKLIST_MODE": "ui",
          "PROGRESS_TASKLIST_DETAIL": "code"
        }
      }
    }
  }
}
```

The filename is always `tasklist-<session>.md` (`tasklist-shared.md` when no
session is resolved):

- `PROGRESS_TASKLIST_LOCATION=0` → `<cwd>/.progress/tasklist-<session>.md`
- `PROGRESS_TASKLIST_LOCATION=1` → `<cwd>/tasklist-<session>.md` (default)
- `PROGRESS_TASKLIST_LOCATION=2` → `~/.opencode-progress/tasklist-<session>.md`

`ui` mode (default) mirrors what the UI shows: dismissed/cleared entries are
omitted and a parent rolls up to done/error/running/waiting from its children.
`raw` keeps every entry (including dismissed/cleared) and shows the stored
status. A palette command in the plugin toggles this when the mirror is active.

Detail is a fenced code block by default, so links, images, and HTML cannot
execute in a preview. `PROGRESS_TASKLIST_DETAIL=escaped` renders inline escaped
text; `raw` is an explicit opt-in for trusted content.

The mirror rewrites only when the rendered checklist changes — relay ticks that
only update percentages or `updatedAt` do not touch the file. Rendered content
is cached in memory, so unchanged writes do not re-read the file. Each task
shows its checkbox, effective status, creation time, and last agent update
(relay ticks only advance that timestamp on a status transition).

Safety and hygiene:

- The file is plaintext and may contain sensitive task titles/details. Add
  `tasklist-*.md` (and `.progress/` for location 0) to `.gitignore`, or use
  location 2.
- The mirror never overwrites a non-empty file unless it starts with the
  progress-tool mirror marker. Delete or migrate a hand-written `TASKS.md` first.
- `PROGRESS_STATE_PATH` must end in `.json` and, if it already exists, parse as
  a progress state document (an `entries` object). The state store refuses to
  overwrite anything else.
- Runtime prefs/status live next to the state file
  (`.opencode-progress-tasklist-prefs.json` / `-status.json`).

Example:

````md
<!-- generated by progress-tool task-list mirror -->
# Task list — ses_abc

_Mirrored from progress-tool. UI view; newest first. Do not edit by hand._

- [x] **Build** — done · created 2026-01-01T10:00:00.000Z · updated 2026-01-01T10:05:00.000Z
- [ ] **Verify** — running · created 2026-01-01T10:05:00.000Z · updated 2026-01-01T10:09:00.000Z
  ```text
  running the smoke suite
  ```
````

Relay-created command entries are omitted by default so successful builds do
not fill the checklist. Set `PROGRESS_TASKLIST_RELAY_LEVEL=1` to mirror every
relay entry, or `2` to mirror relay entries only while their current status is
`error`. Agent-created tasks always mirror. The relay marker is applied only
when the relay creates an entry, so an agent task later driven by relay stays a
normal task. Entries written before this marker existed stay unmarked until
cleared.

## Links

- Repository & full docs: <https://github.com/jakedowns/progress-tool>
- Spec: `docs/out-of-band-relay-spec.md`
- License: MIT
