# Progress Tool — TUI / CLI Implementation Guide

Text-based twin of the [Agent Progress Tool proposal](https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c) for harnesses and agent tool callers that run without a GUI layer.

When there's no desktop GUI or web UI, the agent still needs a way to say *"I'm not stuck, I'm just waiting on this long-running async thing"*. This guide shows how to render that as ASCII progress bars in a terminal, using the same `id`/`status`/`title`/`detail`/`progress` API shape.

The same [zero-token-burn contract](./docs/out-of-band-relay-spec.md) applies: the agent reports milestones, and an out-of-band relay streams terminal output into the shared state file. The TUI polls the file; the **agent** does not poll the terminal.

---

## The zero-token-burn rule

A text harness has exactly the same failure mode as a GUI harness: if the model is the only thing refreshing the display, it will `sleep`, read `stdout`, and call `progress` in a loop, burning tokens for the entire duration of the task.

Split the work instead:

| Plane | Owner | What it does |
|-------|-------|--------------|
| Control | Agent | Calls `progress` once per milestone (`running`, `waiting`, `done`, `error`) |
| Data | `progress-relay` | Streams stdout/stderr into the state file at up to 4 writes/sec, at zero model token cost |
| View | TUI | Polls the state file and redraws the tree |

The agent **must not** call `progress` on a timer, after every output line, or solely to refresh elapsed time. If the relay is unavailable, the agent still reports start/end boundaries; the TUI derives elapsed time from `startedAt`.

---

## Common API Shape

```ts
progress({
  id: "sdl2-compile",           // stable id → update / clear later
  status: "running" | "done" | "error" | "waiting",
  title: "Compiling SDL2",
  detail?: "linking libSDL2.a", // optional detail text
  progress?: 0.60,              // optional 0–1 fraction
  parentId?: "build",           // optional: nest under a parent task (tree)
})
```

Rules:

- **Fire-and-forget** — does not pause the agent
- **Same `id` updates in place** — call again with the same id to refresh the bar
- **Never requires a human reply**
- **Text harness renders it** as an ASCII progress bar in the terminal
- **Tree-like dependencies** — pass `parentId` to nest a task under a parent; the TUI renders it indented (bootvine-inspired)

---

## Data plane: the relay for text harnesses

Any shell can use the relay. It writes to the same state file the TUI reads.

### Wrap a command (recommended: captures exit status)

```bash
progress-relay --id sdl2-compile --title "compiling SDL2" -- make -j8
```

The relay:

- tees stdout/stderr to the terminal (so the harness still sees the full output),
- keeps the latest non-empty line as `detail`,
- parses `45%` and `6/10` into `progress`,
- marks the task `done` on exit `0`, or `error` with the exit code otherwise.

### Pipe a command

```bash
make -j8 | progress-relay --id sdl2-compile
```

Pipe mode marks the task `done` when stdin closes. It cannot see the upstream exit code, so prefer wrap mode when failure detection matters.

### One-shot milestones

For scripts that already know when a milestone happens:

```bash
progress-emit --id db-migration --status running --title "waiting on database migration"
./migrate.sh
progress-emit --id db-migration --status done --progress 100%
```

### Fallback if the bin is not installed

```bash
node /path/to/mcp-server/index.js relay --id sdl2-compile -- make -j8
node /path/to/mcp-server/index.js emit --id db-migration --status running
```

### TUI loop

The TUI should read the state file on its own interval (for example, 1 second), apply tree roll-up, and redraw. It should not ask the agent for updates. A relay tick keeps `updatedAt` fresh; a completed task keeps its final state until the retention window expires.

---

## ASCII Progress Bar Rendering

A text harness (TUI, CLI tool runner, tmux status line, etc.) renders each active entry like this:

```
agent: FYI, I'm not stuck, I'm just waiting on this long-running async thing:
  [██████░░░░] 6/10 · compiling SDL2
  [██████████] 10/10 · installing npm deps ✓
  [░░░░░░░░░░] 0/10 · waiting on database migration
```

### Bar format spec

| Element | Meaning |
|---------|---------|
| `██████░░░░` | 10-char block bar (`█` = complete, `░` = remaining) |
| `6/10` | progress fraction as `done/total` |
| `compiling SDL2` | `title` from the progress call |
| `✓` | shown when `status === "done"` |
| `!` | shown when `status === "error"` |
| `⟳` | shown when `status === "waiting"` |

### Example renderer (pseudocode)

```python
BAR_WIDTH = 10

def render_entry(entry):
    status = entry["status"]
    pct = entry.get("progress", 0)
    done = int(round(pct * BAR_WIDTH))
    remaining = BAR_WIDTH - done
    bar = "█" * done + "░" * remaining

    icon = {
        "running": "",
        "done": "✓",
        "error": "!",
        "waiting": "⟳",
    }.get(status, "")

    total = 10
    current = int(round(pct * total))
    return f"  [{bar}] {current}/{total} · {entry['title']} {icon}"
```

Example output:

```
  [██████░░░░] 6/10 · compiling SDL2
  [██████████] 10/10 · installing npm deps ✓
  [░░░░░░░░░░] 0/10 · waiting on database migration ⟳
```

### Tree rendering (bootvine-inspired)

When entries use `parentId`, the TUI renders them nested with tree-drawing characters:

```
agent: FYI, I'm not stuck, I'm just waiting on these long-running async things:
  ├── build [██████░░░░] 6/10 · building SDL2
  │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
  └── npm-install [██████████] 10/10 · installing npm deps ✓
```

**Tree format spec:**

| Element | Meaning |
|---------|---------|
| `├── ` / `└── ` | Tree connector (`├──` = has siblings below, `└──` = last child) |
| `│   ` / `    ` | Vertical continuation line or blank space for indentation |
| `[██████░░░░]` | 10-char block bar (`█` = complete, `░` = remaining) |
| `6/10` | progress fraction as `done/total` |
| `building SDL2` | `title` from the progress call |
| `✓` / `!` / `⟳` | status icon (done / error / waiting) |

**Roll-up rules:** a parent's status is the most severe child status (`error` > `running` > `waiting` > `done`). If any child errors, the parent shows `error`. Parent progress is the average of child progress values. This lets a text harness show at a glance whether a whole build is stuck or just one sub-task.

Example renderer (pseudocode):

```python
BAR_WIDTH = 10
STATUS_ORDER = {"error": 4, "running": 3, "waiting": 2, "done": 1}

def build_tree(entries):
    by_id = {e["id"]: e for e in entries}
    children = {e["id"]: [] for e in entries}
    roots = []
    for e in entries:
        pid = e.get("parentId")
        if pid and pid in by_id:
            children[pid].append(e["id"])
        else:
            roots.append(e["id"])
    for ids in children.values():
        ids.sort(key=lambda i: (-STATUS_ORDER[by_id[i]["status"]], -by_id[i]["updatedAt"]))
    roots.sort(key=lambda i: (-STATUS_ORDER[by_id[i]["status"]], -by_id[i]["updatedAt"]))
    def node(i):
        e = by_id[i]
        return {**e, "children": [node(c) for c in children[i]]}
    return [node(r) for r in roots]

def render_tree(nodes, prefix="", is_last=True):
    lines = []
    for i, n in enumerate(nodes):
        last = i == len(nodes) - 1
        connector = "└── " if last else "├── "
        child_prefix = prefix + ("    " if last else "│   ")
        bar = "█" * int(round(n.get("progress", 0) * BAR_WIDTH))
        bar += "░" * (BAR_WIDTH - len(bar))
        icon = {"done": "✓", "error": "!", "waiting": "⟳"}.get(n["status"], "")
        lines.append(f"{prefix}{connector}[{bar}] {int(round(n.get('progress',0)*10))}/10 · {n['title']} {icon}")
        lines.extend(render_tree(n.get("children", []), child_prefix, last))
    return lines
```

---

## Example Tool Call JSON Payload

For a batch of 6/10 tasks in flight, the agent emits `progress` tool calls like these. These are milestone snapshots, not a polling loop; live percentages and log lines come from the relay.

### Task 1 — compiling SDL2 (60%)

```json
{
  "name": "progress",
  "arguments": {
    "id": "sdl2-compile",
    "status": "running",
    "title": "compiling SDL2",
    "detail": "linking libSDL2.a",
    "progress": 0.60
  }
}
```

### Task 2 — installing npm deps (100%, done)

```json
{
  "name": "progress",
  "arguments": {
    "id": "npm-install",
    "status": "done",
    "title": "installing npm deps",
    "detail": "142 packages added",
    "progress": 1.0
  }
}
```

### Task 3 — database migration (0%, waiting)

```json
{
  "name": "progress",
  "arguments": {
    "id": "db-migration",
    "status": "waiting",
    "title": "waiting on database migration",
    "detail": "blocked by sdl2-compile",
    "progress": 0.0
  }
}
```

---

## Full Example Session Transcript

```
agent: FYI, I'm not stuck, I'm just waiting on these long-running async things:
  [██████░░░░] 6/10 · compiling SDL2
  [██████████] 10/10 · installing npm deps ✓
  [░░░░░░░░░░] 0/10 · waiting on database migration ⟳

(agent calls progress with id="sdl2-compile", status="running", progress=0.80)

agent:
  [████████░░] 8/10 · compiling SDL2
  [██████████] 10/10 · installing npm deps ✓
  [░░░░░░░░░░] 0/10 · waiting on database migration ⟳

(agent calls progress with id="sdl2-compile", status="done", progress=1.0)

agent:
  [██████████] 10/10 · compiling SDL2 ✓
  [██████████] 10/10 · installing npm deps ✓
  [██░░░░░░░░] 2/10 · waiting on database migration ⟳

(agent calls progress with id="db-migration", status="error")

agent:
  [██████████] 10/10 · compiling SDL2 ✓
  [██████████] 10/10 · installing npm deps ✓
  [██░░░░░░░░] 2/10 · waiting on database migration !
```

---

## Persistence (optional)

If your text harness wants to survive across turns without re-sending all entries, write state to a shared file (e.g. `~/.opencode-progress-state.json`) matching the GUI plugin's format. Include `startedAt` so the TUI can show true elapsed time even when no relay tick is writing `updatedAt` every second:

```json
{
  "entries": {
    "build": {
      "id": "build",
      "status": "running",
      "title": "building SDL2",
      "detail": "compiling source",
      "progress": 0.60,
      "parentId": null,
      "startedAt": 1794559267388,
      "createdAt": 1794559267388,
      "updatedAt": 1794559267388
    },
    "link-lib": {
      "id": "link-lib",
      "status": "running",
      "title": "linking libSDL2.a",
      "detail": "ld -o libSDL2.a ...",
      "progress": 0.40,
      "parentId": "build",
      "startedAt": 1794559267388,
      "createdAt": 1794559267388,
      "updatedAt": 1794559267388
    }
  },
  "version": 2
}
```

Writers should use an atomic temp-file + rename (and a lock for read-modify-write) so a relay tick and an agent milestone cannot corrupt the document. A TUI renderer can poll that file on its own interval and redraw the tree; the agent never polls the terminal. See [`docs/out-of-band-relay-spec.md`](./docs/out-of-band-relay-spec.md) for the full contract and conformance checklist.

---

## Mapping to the Original Proposal

| Field | Same as proposal? | Notes |
|-------|-------------------|-------|
| `id` | ✅ yes | Stable id for in-place updates |
| `status` | ✅ yes | `running\|done\|error\|waiting` |
| `title` | ✅ yes | Short title shown in the bar |
| `detail` | ✅ yes | Optional detail (second line or inline) |
| `progress` | ✅ yes | 0–1 fraction → `X/10` in ASCII bar |
| `parentId` | extension | Nest under a parent; forms a tree (bootvine-inspired) |

This is not a new protocol — it's the same shape rendered in text instead of a GUI toast/status bar, with an optional `parentId` for tree-like dependencies.
