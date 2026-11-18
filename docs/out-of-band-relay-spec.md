# Out-of-Band Relay & Zero-Token-Burn Progress Specification

**Status:** Reference specification, v1
**Audience:** Agent and harness authors, MCP server implementers, model trainers
**Reference implementation:** `mcp-server/` in this repository

This document defines a model-, agent-, and harness-agnostic way to report long-running task progress without turning the model into a polling loop. It is intentionally small: three primitives, one shared state shape, and one behavioral rule.

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as in RFC 2119.

---

## 1. Problem

A blocking `question` tool pauses the agent turn until a human responds. A non-blocking `progress` tool returns immediately so the agent can keep working.

That creates a structural mismatch during long-running background work:

1. **The model has no background thread.** Between tool calls it cannot observe `stdout`, `stderr`, or wall-clock time.
2. **Agents default to becoming the relay.** To keep a UI updated with elapsed time, percentages, or log snippets, models fall back to `sleep` + `read_terminal_output` + `progress()` loops.
3. **Every tick burns tokens.** The cost scales with wall-clock duration instead of with the number of meaningful state transitions.
4. **Harness fragmentation.** OpenCode, Claude Code, Cursor, Cline, and custom loops all manage background shells differently. A single harness's plugin API does not travel.

The goal is not to make the model report more often. It is to move high-frequency reporting out of the model entirely.

### Token model

For a task of duration `T` with `M` meaningful milestones:

| Approach | Model calls | Token cost |
|----------|-------------|------------|
| Agent as relay (polling) | `O(T / poll_interval)` | Grows with task duration |
| Boundary contract + out-of-band relay | `O(M)` | Independent of task duration |

"Zero-token-burn" in this document means **zero model tokens for telemetry** (log lines, percentages, elapsed ticks). Milestone calls still cost tokens, but there are only a handful of them.

---

## 2. Design principles

1. **Split ownership.** The model owns semantics. An OS process owns telemetry.
2. **One shared state store.** Both planes write the same document. No proprietary side channel is required for interoperability.
3. **Fire-and-forget.** Progress reporting MUST NOT block, require a human reply, or fail the underlying command.
4. **No harness hooks required.** A POSIX pipe or process wrapper is enough. Harnesses MAY add native integrations, but those are optimizations, not requirements.
5. **Self-teaching at the decision point.** The tool response SHOULD include the exact relay command. Models read tool results more reliably than long system prompts.
6. **Graceful degradation.** If no relay is available, the agent still reports boundaries and the UI still works.
7. **Crash safety.** Concurrent writers MUST NOT corrupt the state document or lose sibling updates.

---

## 3. Planes and responsibilities

### 3.1 Control plane (agent)

The agent owns:

- Task identity (`id`)
- Lifecycle status (`running`, `waiting`, `done`, `error`)
- Human-readable title
- Tree topology (`parentId`)
- Occasional semantic detail

The agent MUST call the progress tool only at discrete state boundaries:

- when a phase starts;
- when a child task is created;
- when a phase changes to `waiting`, `done`, or `error`.

The agent MUST NOT call the progress tool:

- on a timer;
- in a `sleep` loop;
- after every line of terminal output;
- solely to refresh elapsed time or a percentage that a relay can supply.

**Long-horizon work without a relay is the exception that defines the cadence.**
Research, planning, codebase exploration, refactors, and documentation are not
shell commands: no relay exists, so the agent's own multi-turn rhythm is the
data plane. During such work the agent SHOULD spend one of its turns between
tool calls — roughly every few calls, or whenever it starts or finishes a
step — on a progress update (fresh `detail`, a `progress` fraction, or a
status change), the same way it maintains a todo list. This is not polling:
polling burns tokens on timers and terminal output; a between-turn update
burns one fire-and-forget tool call at a natural boundary and keeps the
summary rollup live.

### 3.2 Data plane (relay / OS process)

The relay owns:

- Latest non-empty output line (`detail`)
- Percentage parsing (`45%`, `6/10`)
- Structured progress parsing: `OSC 9;4` terminal progress sequences (§6.3.1), before text heuristics
- Write throttling
- Terminal exit status (`done` / `error`)
- Elapsed time indirectly, by keeping `startedAt` and `updatedAt` fresh

The relay MUST NOT:

- require the agent to be running;
- block or alter the wrapped command's exit semantics;
- hide the command's output from the harness by default;
- write malformed JSON.

The relay does not make a blocking shell call asynchronous. It makes the display live and token-free while the command runs. A harness with background jobs can attach the same relay to the background process and let the agent continue.

### 3.3 View plane (GUI / TUI / status shim)

The view reads the state store and renders it. It MAY poll the file or subscribe to filesystem events. It MUST tolerate missing fields and unknown fields, and it MUST NOT require the relay to be present.

A view MAY write exactly one kind of data: the per-entry `dismissed` record of §4.9 (a user action), using the same §4.3/§4.4 atomic and locked protocol as every other writer. All task state (status, title, detail, progress, topology) remains owned by the agent and the relay.

---

## 4. State store contract

### 4.1 Location

The default path is:

```
~/.opencode-progress-state.json
```

Implementations MUST support an override:

- Environment: `PROGRESS_STATE_PATH=/path/to/state.json`
- CLI: `--state-path /path/to/state.json`

### 4.2 Shape

```json
{
  "entries": {
    "<storage-key>": {
      "id": "string",
      "sessionId": "string (optional; present when scoped)",
      "status": "running | waiting | done | error",
      "title": "string",
      "detail": "string | null",
      "progress": "number 0..1 | null",
      "parentId": "string | null",
      "startedAt": "epoch milliseconds",
      "createdAt": "epoch milliseconds",
      "updatedAt": "epoch milliseconds"
    }
  },
  "version": 2
}
```

`<storage-key>` is `<id>` for legacy unscoped entries, or `<sessionId>:<id>` when a session is active. `entry.id` and `entry.parentId` remain clean task IDs even when the storage key is composite.

Required per entry: `id`, `status`, `title`, `updatedAt`.
Optional per entry: `sessionId`, `detail`, `progress`, `parentId`, `startedAt`, `createdAt`, `dismissed` (§4.9).

Readers MUST ignore unknown fields and MUST tolerate missing optional fields.

### 4.3 Atomic writes

A writer MUST use an atomic replace:

1. Write the complete document to a temporary file in the same directory.
2. Flush the file (`fsync`) when the platform supports it.
3. Rename the temporary file over the target path.

Readers MUST never observe a partially written document. A failed parse SHOULD be treated as an empty state rather than a crash.

### 4.4 Cross-process serialization

Because a relay and an MCP server may write concurrently, read-modify-write cycles MUST be serialized. The reference implementation uses a sibling lock file:

- Acquire with `open(lock, "wx")`.
- Retry briefly on contention.
- Break a lock older than 15 seconds.
- Release in a `finally` block.
- On timeout, proceed best-effort rather than failing the underlying command.

Implementations MAY use a different lock (advisory `flock`, a Unix socket broker, SQLite) as long as the observable guarantee holds: no lost sibling updates and no corrupt JSON.

### 4.5 Merge semantics

An update MUST preserve fields that were not supplied. This is what lets a relay attach to an entry the agent created without clobbering its `title`, `parentId`, or status.

Specifically:

- `undefined` means "leave unchanged".
- `null` means "explicitly clear" for nullable fields.
- `progress: 0` MUST be distinguishable from "no progress supplied".
- Reusing an `id` that is currently `done` or `error` with a new `running`/`waiting` status SHOULD reset `startedAt`, `detail`, and `progress` unless the caller explicitly supplies them. This prevents a new run from inheriting a stale 100% bar. A lifecycle restart MUST also clear the entry's view-plane `dismissed` metadata (§4.9): a stale user dismissal must not mute a fresh run.

### 4.9 View-plane metadata: user dismissal

An entry MAY carry a dismissal record written by view clients:

```json
"dismissed": { "status": "running", "at": 1795017842669 }
```

- `status` is the entry's rolled-up status at dismiss time; `at` is the epoch
  millisecond of the dismissal. A bare boolean or timestamp alone is
  insufficient: revival semantics depend on what the tree looked like when
  the user dismissed it (terminal vs non-terminal, the child-failure
  carve-out).
- Writers: view clients only (a user action), via the §4.3/§4.4 atomic and
  locked protocol. Agent and relay writes MUST preserve the field.
- A lifecycle restart MUST clear it (§4.5).
- Revival semantics are view-level and shared by convention: terminal
  (`done`/`error`) dismissals revive only on a direct re-report of the task
  or a child failing; non-terminal dismissals also revive on any rolled-up
  status change. Views MUST NOT require agent cooperation for dismissal.

### 4.6 Lifecycle cleanup

Completed entries (`done` or `error`) SHOULD be pruned after a retention period (default: 10 minutes). Implementations MUST allow the retention period to be configured (reference: `PROGRESS_TTL_MS`).

### 4.7 Concurrency guarantee

Two relays updating sibling children of the same parent MUST both survive. A parent's rolled-up status/progress is derived at read time from the children, so the store MUST NOT persist a stale parent roll-up that overwrites a sibling update.

### 4.8 Session scoping

Implementations MAY support multiple concurrent sessions sharing one state file. When a session scope is active:

- Resolve the session ID in this priority order: explicit `sessionId` / `--session` -> `PROGRESS_SESSION_ID` -> `OPENCODE_SESSION_ID` -> `null`.
- Store entries under the composite key `<sessionId>:<id>` and record `sessionId` on the entry.
- Keep `entry.id` clean (`build-1`). The relay SHOULD also keep `entry.parentId` clean and apply the session namespace only when resolving parent/child relationships for roll-up.
- Parent roll-up MUST only match a parent within the same session. Identical task IDs in two sessions MUST NOT collide or cross-contaminate status/progress.
- When no session resolves, implementations MUST preserve flat `<id>` keys for backwards compatibility.

A shared global view can group entries by `sessionId`; harnesses that need complete isolation MAY use a separate `PROGRESS_STATE_PATH` per session instead.

---

## 5. Control-plane contract (progress tool)

### 5.1 Input

```ts
progress({
  id: string,                 // required, stable
  status: "running" | "waiting" | "done" | "error", // required
  title: string,              // required
  detail?: string,
  progress?: number,          // 0..1
  parentId?: string,
  sessionId?: string          // optional override; auto from env when omitted
})
```

Validation requirements:

- `id` MUST be a non-empty string.
- `status` MUST be one of the four values.
- `title` MUST be a non-empty string.
- `progress`, when present, MUST be a finite number in `[0, 1]`.
- `detail`, `parentId`, and `sessionId`, when present, MUST be strings.
- Empty `parentId` SHOULD be treated as `null`.
- `sessionId` resolution MUST follow §4.8: explicit value, then `PROGRESS_SESSION_ID`, then `OPENCODE_SESSION_ID`, then unscoped.

### 5.1.1 Multi-line text

`title` and `detail` MAY contain line breaks. Implementations SHOULD normalize all
of these forms to plain `\n` on write and on read:

- real newlines (`\n`, `\r\n`, `\r`),
- escaped newlines that survived an extra JSON encode (`\\n`, `\\r\\n`),
- escaped unicode line separators (`\\u000a`, `\\u000d`), and
- HTML-style breaks (`<br>`, `<br/>`, `<br />`, case-insensitive).

Rendering requirements:

- Viewers MUST NOT render escaped newline sequences as literal `\n` text.
- Long text MUST wrap or scroll rather than force a single unbounded line.
- The TUI view SHOULD word-wrap title and detail to the terminal width.
- GUI views SHOULD wrap titles and constrain long details to a scrollable region.
- Hover/tooltip text, when available, SHOULD expose the full unmodified title and detail.

### 5.2 Behavior

- The call MUST return immediately. It MUST NOT wait for human input.
- The same `id` MUST update in place.
- The tool MUST NOT be a source of truth for background output. It records state.
- A tool implementation failure SHOULD be reported as an error result, but the agent SHOULD still be able to continue.

### 5.3 Response hint (required for `running`)

When `status === "running"`, the response MUST include an actionable relay hint. The hint MUST contain:

1. The task `id`.
2. A wrap form: `<relay> --id <id> [--parent <parentId>] [--session <sessionId>] -- <cmd>`.
3. A pipe form: `<cmd> | <relay> --id <id> [--session <sessionId>]`.
4. An explicit instruction not to poll, sleep, or re-call progress for elapsed time or percentages.
5. When a session scope is active, a reminder that sessions are isolated automatically so the agent keeps task IDs clean.

Example:

```text
Recorded progress [build-1] (running) - Running npm build - 10%
To stream live command output into this indicator without polling, use the out-of-band relay:
  progress-relay --id build-1 -- <cmd>
  # or: <cmd> | progress-relay --id build-1
Do NOT poll, sleep, or re-call progress in a loop for elapsed time or percentages.
```

If the relay is not on `$PATH`, the hint SHOULD use a guaranteed invocation (for example `node /path/to/index.js relay ...`) rather than a command that will fail.

### 5.4 Server instructions

MCP servers SHOULD place the same rule in the `initialize` response's `instructions` field. This reaches clients that surface server instructions separately from tool descriptions.

### 5.5 Tool description

The tool description MUST explain:

- That the tool is fire-and-forget.
- That the agent owns milestones and tree structure.
- That polling is forbidden.
- That long-running commands should use the relay.
- How tree roll-up works.
- That concurrent sessions are isolated automatically via `OPENCODE_SESSION_ID` / `PROGRESS_SESSION_ID` (or `sessionId`), so task IDs stay clean.

See the drop-in definition in `README.md`.

### 5.6 Tree roll-up

Roll-up is a read-time projection. Given flat entries with `parentId`:

- A parent with children derives status as:
  - `error` if any descendant is `error`;
  - otherwise `running` if any descendant is `running`;
  - otherwise `waiting` if any descendant is `waiting`;
  - otherwise `done` if all children are `done`.
- Parent progress is the mean of child `progress` values that are not `null`, unless the parent has its own explicit `progress`.
- The parent's `updatedAt` may be projected as the latest descendant `updatedAt`.

Cycles MUST NOT crash the renderer. A cycle SHOULD be broken by treating a node whose parent chain revisits it as a root, or by ignoring the cyclic edge.

---

## 6. Data-plane contract (relay)

### 6.1 Invocation forms

Implementations MUST support, directly or through a thin alias:

```bash
# Wrap: capture exit status
progress-relay --id build-1 --title "Build" -- npm run build

# Pipe: mark done on EOF
npm run build | progress-relay --id build-1

# One-shot milestone
progress-emit --id build-1 --status running --title "Build"
```

The reference implementation exposes all three through one binary:

```bash
node mcp-server/index.js relay --id build-1 -- npm run build
node mcp-server/index.js emit --id build-1 --status running
```

### 6.2 Arguments

| Option | Required | Meaning |
|--------|----------|---------|
| `--id` | yes | Stable task ID; `PROGRESS_ID` may be used instead |
| `--title` | no | Label for a new task; existing title is preserved if omitted |
| `--parent` / `--parent-id` | no | Parent task ID |
| `--detail` | no | Initial detail line |
| `--progress` | no | `0..1`, `45%`, or `6/10` |
| `--status` | no | Initial status, default `running` |
| `--session` | no | Session scope; falls back to `PROGRESS_SESSION_ID`, then `OPENCODE_SESSION_ID` |
| `--max-hz` | no | Max writes/sec, default `4`; `0` means unlimited |
| `--quiet` / `--no-tee` | no | Do not echo wrapped output |
| `--state-path` | no | State file override |
| `--once` | no | Emit one update and exit |
| `--` | no | End of options; following args are the command |

Unknown options MUST fail with a non-zero exit code and usage text. A relay startup failure MUST NOT be mistaken for the wrapped command's failure; the relay SHOULD use a distinct exit code (reference: `2` for usage, `127` for spawn failure).

### 6.3 Input handling

- The relay MUST split input on `\n`, `\r\n`, and bare `\r`. Bare `\r` matters because many progress bars redraw with carriage returns.
- The relay MUST strip ANSI CSI/OSC escape sequences before storing detail.
- The relay MUST keep the latest non-empty line as `detail`.
- The relay SHOULD truncate `detail` to a bounded length (reference: 240 characters) to keep the state file small.
- The relay MUST NOT grow an unbounded line buffer. The reference flushes a line after 64 KiB.
- The relay SHOULD parse `NN%` and `N/M` into `progress`. Percentages take precedence; the last valid match wins. `N/M` is only accepted when `M > 0` and `N <= M`.

### 6.3.1 Structured progress sources: OSC 9;4

Many build tools (Gradle's rich console, `mise`, PowerShell 7.4+, `winget`, ...)
emit the ConEmu / Windows Terminal "progress report" sequence natively:

```
ESC ] 9 ; 4 ; <state> [ ; <progress 0-100> ] ( BEL | ESC \ )
```

States: `0` clear, `1` normal, `2` error, `3` indeterminate/busy, `4` paused/warning.

The relay SHOULD parse these sequences as a structured, zero-heuristic progress
source, with the following requirements:

1. **Chunk-level interception.** Parsing MUST happen on raw read chunks BEFORE
   line splitting and ANSI stripping. OSC 9;4 sequences typically arrive
   without a trailing newline, often several per redraw, and can be split
   across chunk boundaries.
2. **Partial-sequence carry.** A chunk ending inside an incomplete OSC 9;4
   sequence MUST be buffered until the terminator arrives. Only tails that
   plausibly begin an OSC 9;4 sequence MAY be held; everything else passes
   through unchanged. Held buffers MUST be bounded.
3. **Escape stripping.** Parsed sequences MUST NOT reach `detail` as raw escape
   bytes. Complete OSC sequences of any type are already stripped per line; the
   chunk-level filter guarantees the same for OSC 9;4 even when sequences are
   split across lines or chunks.
4. **Precedence.** OSC 9;4 values take precedence over text-guessed `NN%` /
   `N/M`. Once an OSC 9;4 sequence has been observed on a stream, text
   heuristics are suppressed for that stream: a tool that reports structured
   progress once will keep doing so, and mixing both sources makes the bar
   jump backwards. Text heuristics still apply to streams that never emit
   OSC 9;4. (Sticky-per-stream, not per-chunk, because lines can be held in
   the splitter's carry buffer across chunk boundaries.)
5. **Multiple sequences.** When one chunk contains several OSC 9;4 sequences,
   apply them in order; the last one wins.
6. **State mapping (provisional).**

   | State | Effect |
   |-------|--------|
   | `0` | Clear `progress` (explicit `null`); status unchanged |
   | `1` | `progress = clamp(p, 0, 100) / 100` when supplied; status unchanged |
   | `2` | Status `error` (provisional); update `progress` when supplied |
   | `3` | Clear `progress` (indeterminate); status unchanged |
   | `4` | Status `waiting`; update `progress` when supplied, else preserve |

   These writes are **provisional**: they MUST NOT produce `done`, MUST NOT
   resurrect a `done`/`error` entry, and MUST be overwritten by the exit
   mapping (§6.6) when the command terminates. OSC writes also follow the
   merge semantics of §4.5 (`null` is an explicit clear) and the write
   throttle of §6.5.

### 6.4 Output behavior (tee)

By default the relay MUST tee:

- wrapped `stdout` -> relay `stdout`;
- wrapped `stderr` -> relay `stderr`;
- piped stdin -> relay `stdout`.

This preserves the harness's normal command output. `--quiet` disables tee.

Rationale: a relay that silently consumes output breaks agents that rely on reading command output after the command finishes. The relay's job is to observe, not to hide.

### 6.5 Throttling

The relay MUST throttle state writes. The default is 4 writes per second (overridable with `--max-hz <n>` or the `PROGRESS_RELAY_MAX_HZ` environment variable). The throttle applies to telemetry updates; the final status transition MUST be written immediately.

Throttling exists because a fast build can emit thousands of lines per second, and rewriting the state file that often is wasteful and increases lock contention.

### 6.6 Exit mapping

| Condition | `status` | `progress` | `detail` |
|-----------|----------|------------|----------|
| Wrapped command exits `0` | `done` | `1.0` | last line, or `exit 0` |
| Wrapped command exits non-zero | `error` | preserved | `exit <code>: <last line>` or `exit <code>` |
| Wrapped command dies from signal | `error` | preserved | `terminated by <signal>` |
| Pipe stdin reaches EOF | `done` | `1.0` | last line, or `stdin closed` |
| Relay/state write fails | unchanged | unchanged | warning on stderr, command continues |
| Spawn fails | `error` | preserved | error message |

The exit mapping is **authoritative**: any provisional status or progress
written from OSC 9;4 data (§6.3.1) is overwritten by this table when the
wrapped command or pipe terminates. In particular, an OSC state `2` seen
mid-run does not make a later `exit 0` report `error`.

**Pipe-mode limitation:** piping (`cmd | relay`) does not expose the upstream exit code. Implementations MUST document this. Use wrap mode when accuracy matters, or have the harness pass the exit status separately (for example, write it to a side channel and call `progress-emit --status error`).

### 6.7 Signals

The relay SHOULD forward `SIGINT`, `SIGTERM`, and `SIGHUP` to the wrapped child. When the child exits due to a signal, the relay MUST record `status: "error"` with the signal name.

### 6.8 Field preservation

When starting, the relay MUST look up the existing entry in the resolved session namespace and preserve `title`, `parentId`, `detail`, and `progress` unless the caller explicitly overrides them. This allows this sequence:

```text
Agent:  progress({ id: "build-1", status: "running", title: "Build", parentId: "root" })
Agent:  progress-relay --id build-1 -- npm run build
```

without the relay replacing the agent's semantic title with the raw command line.

### 6.9 Failure isolation

Progress reporting MUST NOT break the command being reported on. State write failures SHOULD produce at most one warning on stderr and MUST NOT abort or alter the wrapped process.

---

## 7. Harness integration

### 7.1 Minimum integration (any harness, no plugin)

A harness needs only:

1. A way to expose an MCP tool named `progress` (or an equivalent native tool with the same schema).
2. A shell that can run `progress-relay --id <id> -- <cmd>` or `cmd | progress-relay --id <id>`.
3. A view that reads the state file.

No plugin API, no lifecycle hook, and no daemon are required.

### 7.2 Shell examples

POSIX shell:

```sh
progress-relay --id test-1 --title "Test suite" -- pytest -q
```

With a parent task:

```sh
progress-relay --id test-unit --parent test-1 -- pytest tests/unit -q
```

Fallback when the bin is not installed:

```sh
node /path/to/mcp-server/index.js relay --id test-1 -- pytest -q
```

One-shot from a script:

```sh
progress-emit --id migrate --status running --title "Migration"
./migrate.sh
progress-emit --id migrate --status done --progress 100%
```

### 7.3 Native implementation

A harness MAY implement the data plane natively. It needs to:

1. Spawn or observe the command.
2. Read stdout/stderr incrementally.
3. Strip ANSI, keep the latest non-empty line.
4. Parse `NN%` or `N/M`.
5. Write the state document atomically under a lock, throttled.
6. On exit, write `done` or `error` with the real exit code.
7. Tee output to the normal capture path.

This is exactly what `mcp-server/relay.js` does; it can be ported to any language in a few hundred lines.

### 7.4 Model-facing prompt snippet

For harnesses that cannot return per-tool hints, include this in the system prompt:

```text
Treat progress as DUAL PURPOSE: a drop-in replacement for todo/
task-tracking tools (todowrite, TaskCreate) — any multi-step plan
belongs in this tree — and a relay wrapper for long-running commands.

For ANY long-horizon task — research, planning, codebase exploration,
multi-file refactors, documentation, long-running shell commands — call
progress once with status "running" before you start, and keep it current
while you work: for non-shell work, spend one of your turns between tool
calls every few steps on a progress update (fresh detail or a 0..1
progress fraction); use parentId to expose the phase structure
(plan / implement / verify). For multi-step plans, create one child
entry per step (parentId = the parent task) instead of embedding a
numbered list in one title/detail.

For long-running shell commands, attach the out-of-band relay instead of
waiting on the command:

  progress-relay --id <id> -- <cmd>

Do not poll, sleep, or call progress in a loop to refresh shell telemetry
(elapsed time, percentages). Close the task with done/error when the work
finishes or fails.
```

The prompt is a fallback. The tool response hint is more reliable because it arrives immediately before the shell call.

### 7.5 Training signal

For RLHF or tool-use fine-tuning, the desirable trajectory is:

1. Model calls `progress` once at the start.
2. Model reads the hint and invokes the shell wrapper/pipe.
3. Model does not call `progress` again until a real boundary.
4. Model reports `done` or `error` once, ideally from the relay's exit mapping rather than a redundant call.

Negative trajectories:

- repeated `sleep` + `progress` calls;
- re-calling `progress` with the same status solely to update a percentage;
- reading terminal output in a loop just to copy it into `detail`;
- calling `progress` after every line of output.

The tool response and server instructions are designed to make the positive trajectory the path of least resistance.

---

## 8. Conformance checklist

An implementation is conformant if it satisfies all of the following.

### State store

- [ ] Writes are atomic (temp file + rename).
- [ ] Concurrent writers do not lose sibling updates.
- [ ] Malformed JSON reads as empty state, not a crash.
- [ ] `progress: 0` survives a round trip.
- [ ] Unknown fields are preserved or ignored without error.
- [ ] Completed entries are eventually pruned.
- [ ] Session-scoped entries use `<sessionId>:<id>` keys without collisions.
- [ ] Parent roll-up does not cross session boundaries.
- [ ] Unscoped writes keep flat `<id>` keys.

### Control plane

- [ ] `progress` returns immediately.
- [ ] Same `id` updates in place.
- [ ] `running` response includes wrap and pipe relay forms and a no-polling instruction.
- [ ] Tool description states the zero-polling contract.
- [ ] Parent roll-up follows the severity rules.
- [ ] Invalid `progress` values are rejected without crashing the session.

### Data plane

- [ ] Wrap mode captures exit code and maps `0 -> done`, non-zero -> `error`.
- [ ] Pipe mode marks `done` on EOF and documents that it cannot see the upstream exit code.
- [ ] Bare `\r` progress bars are handled.
- [ ] ANSI escapes are stripped.
- [ ] OSC 9;4 sequences are parsed at the chunk level, including sequences split across chunks, and never leak escape bytes into `detail` (§6.3.1).
- [ ] OSC 9;4 values take precedence over text heuristics (sticky per stream once structured data is seen); multiple sequences in one chunk apply last-wins.
- [ ] OSC 9;4 status writes are provisional: they never produce `done` and the exit mapping overrides them at termination.
- [ ] Writes are throttled and the final transition is immediate.
- [ ] Output is teed by default.
- [ ] Existing title/parent are preserved when attaching to an agent-created entry.
- [ ] State write failures do not fail the wrapped command.
- [ ] Signals are forwarded and recorded.

### Interop

- [ ] The default state path is `~/.opencode-progress-state.json`.
- [ ] `PROGRESS_STATE_PATH` is honored.
- [ ] `PROGRESS_SESSION_ID` / `OPENCODE_SESSION_ID` scope entries automatically, with an explicit `--session` / `sessionId` taking precedence.
- [ ] A second harness can read and render the same file without importing the server.
- [ ] The contract is documented without requiring a specific harness.
- [ ] Agent/relay upserts preserve a view-written `dismissed` record (§4.9), and lifecycle restarts clear it.
- [ ] Dismissal writes are atomic and locked like every other writer (§4.3/§4.4).

---

## 9. Reference implementation map

| Contract area | File |
|---------------|------|
| State shape, atomic writes, locking, tree roll-up | `mcp-server/state-store.js` |
| MCP tool, instructions, response hint | `mcp-server/index.js` |
| Relay (pipe, wrap, emit), parsing, throttling | `mcp-server/relay.js` |
| `progress-relay` / `progress-emit` aliases | `mcp-server/progress-relay.js`, `mcp-server/progress-emit.js` |
| Conformance smoke tests | `mcp-server/test/smoke.test.js` |
| Desktop view | `progress-gui-server.js`, `plugin/` |
| Text view and rendering guide | `tui-progress-guide.md` |

Implementation versions:

- MCP server / relay: `2.2.0`
- OpenCode plugin: `1.1.0`

---

## 10. Non-goals

- Replacing a harness's background job system. The relay can wrap one, but it is not a job scheduler.
- Streaming full logs into the state file. Only the latest useful line belongs in `detail`.
- Requiring a GUI. The same state file drives a TUI or a status shim.
- Requiring an MCP client. Any process that writes the state shape is a valid participant.
- Guaranteeing accurate pipe-mode exit status. Use wrap mode or a side channel.

---

## 11. Safety and privacy

- `detail` can contain output from arbitrary commands. Implementations SHOULD bound its length and SHOULD strip ANSI control sequences.
- Implementations SHOULD NOT put secrets, tokens, or full environment dumps into `detail`.
- The state file is normally user-readable only. Implementations SHOULD create it with the user's default umask and SHOULD NOT widen permissions.
- A relay MUST NOT execute commands on its own. It only observes or wraps a command supplied by the caller.
- A GUI MUST treat state fields as untrusted text, not HTML. The reference views use `textContent`/text nodes rather than raw HTML injection.

---

## 12. Versioning

- `version: 2` is the current state document version.
- Adding an optional field (for example `sessionId`) is backward compatible.
- Changing field meaning, removing fields, or changing roll-up semantics requires a version bump.
- Readers MUST tolerate a newer `version` field and unknown fields.

---

## Appendix A: Minimal pseudocode

```python
# Control plane (tool handler)
def progress(id, status, title, detail=None, progress=None, parent_id=None):
    state = read_state_locked()
    entry = state["entries"].get(id, {})
    entry.update({
        "id": id,
        "status": status,
        "title": title,
        "detail": detail if detail is not None else entry.get("detail"),
        "progress": progress if progress is not None else entry.get("progress"),
        "parentId": parent_id if parent_id is not None else entry.get("parentId"),
        "updatedAt": now_ms(),
        "startedAt": entry.get("startedAt") or now_ms(),
    })
    state["entries"][id] = entry
    write_state_atomic_locked(state)

    text = f"Recorded progress [{id}] ({status}) - {title}"
    if status == "running":
        text += (
            "\nTo stream live command output without polling:\n"
            f"  progress-relay --id {id} -- <cmd>\n"
            f"  # or: <cmd> | progress-relay --id {id}\n"
            "Do NOT poll, sleep, or re-call progress in a loop."
        )
    return text
```

```python
# Data plane (relay)
def relay(id, argv):
    prev = read_state_locked()["entries"].get(id, {})
    last_line = prev.get("detail")
    last_write = 0

    def on_line(line):
        nonlocal last_line, last_write
        line = strip_ansi(line).strip()
        if not line:
            return
        last_line = line[:240]
        pct = parse_percent(line) or parse_ratio(line)
        if now_ms() - last_write >= 250:
            write_update(id, detail=last_line, progress=pct)
            last_write = now_ms()

    code = run_and_stream(argv, on_line, tee=True)
    write_update(
        id,
        status="done" if code == 0 else "error",
        progress=1.0 if code == 0 else None,
        detail=last_line if code == 0 else f"exit {code}: {last_line}",
    )
    return code
```

---

## Appendix B: Example state

```json
{
  "entries": {
    "build": {
      "id": "build",
      "status": "running",
      "title": "building SDL2",
      "detail": "compiling source",
      "progress": 0.6,
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
      "progress": 0.4,
      "parentId": "build",
      "startedAt": 1794559267388,
      "createdAt": 1794559267388,
      "updatedAt": 1794559267388
    }
  },
  "version": 2
}
```
