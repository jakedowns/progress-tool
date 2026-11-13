# OpenCode Progress Tool

Implements the [Agent Progress Tool proposal](https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c) for OpenCode 2.

A non-blocking twin of `question` so coding agents can signal long-running work without looking dead or abusing the question tool.

## Progress tool schema

```ts
progress({
  id: "compile-1",           // stable id → update / clear later
  status: "running" | "done" | "error" | "waiting",
  title: "Waiting on tsc",
  detail?: "34s elapsed",    // optional detail text
  progress?: 0.65,           // optional 0–1 fraction
  parentId?: "build",        // optional: nest under a parent task (tree)
})
```

- **Fire-and-forget** — does not pause the agent
- **Same `id` updates in place** — call again with the same id to refresh
- **Never requires a human reply**
- **Tree-like dependencies** — pass `parentId` to nest a task under a parent; parent status/progress rolls up from children (bootvine-inspired)
- Renders as floating indicators in the top-right of the desktop GUI

## Tree-like dependencies (bootvine-inspired)

Both the MCP server and the plugin/standalone GUI support nested tasks via `parentId`. A parent's status and progress are derived from its children:

```
├── build [██████░░░░] 6/10 · compiling SDL2
│   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
└── npm-install [██████████] 10/10 · done ✓
```

If any child errors, the parent shows `error`. If any child is still running/waiting, the parent shows `running`/`waiting`. Parent progress is the average of child progress values.

See [`tui-progress-guide.md`](./tui-progress-guide.md) for a text/CLI implementation of the same protocol (ASCII progress bars for harnesses without a GUI layer).

## What's included

| Component | Path | Status |
|-----------|------|--------|
| MCP server (exposes `progress` to agents) | `mcp-server/index.js` | ✅ |
| OpenCode plugin (desktop GUI) | `plugin/` | ✅ |
| Standalone desktop GUI server | `progress-gui-server.js` | ✅ |
| Setup script | `setup.sh` | ✅ |
| Launch script | `launch-gui.sh` | ✅ |
| TUI / CLI guide | `tui-progress-guide.md` | ✅ |

## Installation

### Step 1: Add the MCP server (makes `progress` available to agents)

```bash
opencode mcp add progress-server -- ./mcp-server/index.js
```

Then restart OpenCode: `opencode service restart`

Verify: `opencode mcp list` should show `progress-server` as **connected**.

### Step 2: Choose a desktop GUI

#### Option A: OpenCode plugin (integrated into the desktop app)

The plugin code is complete at `plugin/`. However, `opencode plugin add` currently only accepts npm registry packages or Git specifiers, not local paths. To install:

1. Publish to npm: `npm publish` (from `plugin/` directory), then:
   ```bash
   opencode plugin add opencode-progress-plugin
   ```

2. Or use a Git URL:
   ```bash
   opencode plugin add github:your-username/opencode-progress-plugin
   ```

3. Or manually add to your OpenCode config (the `plugins` section in `opencode.json`):
   ```json
   {
     "plugins": {
       "opencode-progress-plugin": {
         "type": "local",
         "path": "./plugin"
       }
     }
   }
   ```

#### Option B: Standalone desktop GUI (works immediately)

Run the GUI server and open it in your browser or as a desktop web app:

```bash
./launch-gui.sh
```

Then open `http://localhost:8765` in your browser. You can also add it as a desktop app (e.g., Chrome "Install page as app" or your OS's web app feature).

## Usage (from an agent)

Once the MCP server is connected, agents can call `progress` in any session:

```js
progress({
  id: "build-1",
  status: "running",
  title: "Running npm build",
  detail: "23s elapsed",
  progress: 0.45
})
```

### Nesting a sub-task under a parent

```js
progress({
  id: "build-1",
  status: "running",
  title: "Building SDL2",
  progress: 0.5
})

progress({
  id: "link-lib",
  status: "running",
  title: "Linking libSDL2.a",
  detail: "ld -o libSDL2.a ...",
  progress: 0.4,
  parentId: "build-1"
})
```

Update the same job later:

```js
progress({
  id: "build-1",
  status: "done",
  title: "Running npm build",
  detail: "Completed in 42s",
  progress: 1.0
})
```

Or signal an error:

```js
progress({
  id: "deploy-1",
  status: "error",
  title: "Deploy to production",
  detail: "Connection timeout"
})
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     OpenCode Desktop                    │
│  ┌─────────────┐    ┌─────────────────────────────┐   │
│  │    Agent    │───▶│    MCP Client               │   │
│  │    calls    │───▶│    progress tool            │   │
│  └─────────────┘    └─────────────┬───────────────┘   │
│                                   │ stdio             │
│  ┌────────────────────────────────▼─────────────────┐  │
│  │   progress-mcp-server                            │  │
│  │   writes state to ~/.opencode-progress-state.json│  │
│  │   builds dependency tree from parentId           │  │
│  └───────────────────────┬──────────────────────────┘  │
│                          │ file / HTTP                 │
│  ┌───────────────────────▼──────────────────────────┐  │
│  │   Desktop GUI (plugin or standalone server)      │  │
│  │   reads state → renders nested tree              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Uninstalling

```bash
opencode mcp remove progress-server
# or edit your config to remove the server entry
```

## Files

- `mcp-server/index.js` — MCP server (stdio) exposing the `progress` tool with `parentId` tree support
- `mcp-server/package.json` — MCP server manifest
- `plugin/index.js` — OpenCode plugin server-side code
- `plugin/gui-experimental.js` — OpenCode plugin GUI bundle (renders nested tree)
- `plugin/package.json` — OpenCode plugin manifest
- `progress-gui-server.js` — Standalone desktop GUI HTTP server (renders nested tree)
- `launch-gui.sh` — Launch script for standalone GUI
- `setup.sh` — Setup script (installs MCP server)
- `tui-progress-guide.md` — Text/CLI implementation guide (ASCII progress bars)
