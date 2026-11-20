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
  one atomic write; `status` is `running | waiting | done | error`.
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
| `PROGRESS_TTL_MS` | — | legacy completed-entry retention |
| `PROGRESS_AUTO_PRUNE_S` | off | completed-entry retention in seconds |
| `PROGRESS_STALE_MS` | off | sweep `running` entries untouched this long |
| `PROGRESS_RELAY_MAX_HZ` | `4` | relay write throttle |

## Links

- Repository & full docs: <https://github.com/jakedowns/progress-tool>
- Spec: `docs/out-of-band-relay-spec.md`
- License: MIT
