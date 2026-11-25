# Changelog

Changes to the Progress Tool (OpenCode plugin, TUI/GUI views, and MCP
server/relay) from **`plugin@2.18.9`** (`e938598`) through the **`plugin@2.20.0`**
release commit, dated **2026-11-23** — 41 commits.

**Release policy for this range.** The last published/tagged plugin release was
**`plugin@2.19.0`** (`ceff22d`); `plugin@2.18.9` is its predecessor. Development
used local reload labels `2.20.0`–`2.25.0`, which were **never published as
separate releases**. This changelog publishes all of that accumulated work as
**`plugin@2.20.0`**, the next minor after npm `2.19.0`. The MCP package is
released separately as **`mcp-server@2.11.0`**; see its section below.

## 2.19.0 — TUI support (released, `ceff22d`)

Shipped in `plugin@2.18.9..plugin@2.19.0`:

- **TUI one-line summary.** The palette command **Progress: collapse or expand
  tree** collapses the view to
  `progress: waiting (n) | running (n) | error (n) | done (n) | dismissed (n)`;
  clicking the line expands it again, with undismissed status buckets separated
  from dismissed roots.
- **Authoritative stale nudges.** Strict-mode reminders are self-identifying
  imperative directives rather than mutable questions, and clear on compliance.
  After `staleEscalateAfter` entry reminders (default 3; `0` disables), the
  ladder escalates **once** to a synthetic message so it becomes real turn
  input. Any real progress write resets it; `cooldownMs` is wired and
  compliance/ignore telemetry is recorded.
- **TUI screenshots and release housekeeping.** Added `screenshots/tui.png` and
  `screenshots/tui2.png`, updated the docs and release workflow examples, and
  bumped the plugin to `2.19.0`.

## 2.20.0 — narration, notes, and compact trees (released, `plugin@2.20.0`)

Everything below ships in `plugin@2.20.0`. The earlier development labels
`2.20.0`–`2.25.0` were reload bumps, not separate releases.

### Added

**Plugin — narration (`say`)**

- **Opt-in `say` tool.** `{ "options": { "say": true } }` registers a mid-turn
  narration tool for short "what I am doing + rough ETA" notes. Notes go to the
  tool progress line and a durable synthetic note with `resume: false`, so a
  turn cannot end on a note. Per-turn budget, cooldown, duplicate skip, one
  final guard, and guidance that budget/cooldown skips should fall back to the
  `progress` tool.
- **Persistent notes lane.** Every accepted note is stored in the shared state
  document in a bounded ring buffer (20 newest per author session), rolled up to
  the session root, included in the revision/signature, and purged with the
  session or a hard clear. Notes survive clear-list and are recorded even when
  `sayChatNotes` is off.
- **Notes surfaces.** A dim latest-note line above the TUI tree with a
  newest-first history dialog; a GUI notes composer pill with a history popover;
  the latest-note line in the GUI sidebar panel and pill popover. `sayModes`
  accepts `"pill"`, `"toast"`, and `"tree"` as a string or array (`sayMode` is a
  scalar alias), dedupes values, and treats `[]` as "record without showing".
- **Toasts, dismissal, and attribution.** New notes can toast once per note id,
  with `blocked`/`question` warning styling and `[Subagent (X)]` attribution for
  child sessions. Per-note dismissal removes the note from the shared ring
  buffer; **Dismiss all notes** is root-scoped and updates every client.
- **Note auto-hide.** `sayAutoHideTimeoutMs` (default 60s, `0` disables, clamped
  to `0..86400000`) hides old notes from every surface without deleting them.
  Expired notes fall back to the next visible note, surfaces disappear when none
  remain, old notes never toast, and the GUI re-renders on a 5s clock only while
  notes exist. View-only: the store and purge rules are unchanged.
- **Toast scope and durations.** `sayToastScope` defaults to `"own"` (only notes
  authored by the viewed session toast); `"warnings"` also toasts child
  `blocked`/`question` notes, and `"all"` toasts every rolled-up note. Child
  notes still appear in the line/pill/history with attribution. Warning toasts
  last 12s instead of 5s in both clients.
- **Long-tool `say` nudge.** Opt-in `sayNudge` (`true` / `"long-tool"`) leaves a
  one-shot, context-only reminder after a tool runs longer than
  `sayNudgeAfterMs` (default 20s) with no accepted note that turn. Guards run in
  order: off, already said, budget, short call, cooldown, per-turn cap, or a
  standing progress nudge. It never sends a synthetic message, skips `say` and
  progress calls, keeps the cooldown across prompts, and logs a `say-nudge`
  telemetry event when verbose logging is on.

**Plugin — tree theme and views**

- **`treeTheme`.** `"default"` or `"compact"` for the GUI pill popover, GUI
  sidebar panel, and TUI tree. `"compact"` removes progress-bar glyphs (blocks,
  emoji bars, fractions), hides the GUI `started …` line, keeps one detail line
  regardless of `guiDetailLines` (`0` still hides it), tightens GUI row padding,
  and shows a `40% · & N more` suffix from the new `compactTreeSuffix` helper.
  View-only: the GUI composer pill capsule and its `barStyle` rendering are
  unchanged.
- **Compact rows in both views.** The GUI pill popover/sidebar and TUI render
  barless compact rows when the theme is enabled, including the
  collapsed-descendant count.
- **GUI composer/sidebar layouts.** `guiLayout: "composer"` keeps the floating
  pill; `"sidebar"` registers a pinned Progress tab in the session side region,
  opens once per session, and offers a way back from the panel header. Adds
  `guiSidebarWidth` (360px default, clamped 240–800), the `[Sidebar]` pill
  action, and the palette command **Progress: swap layout**.
- **GUI detail caps and pill performance.** `guiDetailLines` caps detail text
  (`1` line default with an ellipsis, `0` hides details, `-1` shows full text;
  tooltips retain full detail). Pill derivations and rows are memoized, with
  event-driven refresh and polling fallbacks.

**MCP server & relay**

- **`pending` (queued) status.** Accepted by the `progress` tool schema, bulk
  entries, and relay `--status`/emit paths. Roll-up precedence is
  `error > running > waiting > pending > done` in the MCP server, task-list
  mirror, and plugin tree helpers. The TUI adds a pending glyph/bucket, the GUI
  a muted dot and pending count, idle reminders count pending as open work, and
  the stale sweep still skips it.
- **Optional Markdown task-list mirror.** Env-gated (`PROGRESS_TASKLIST=1`, or
  `taskListFile`) mirror of the current session's task tree, written on progress
  writes with checkboxes, status, timestamps, nested children, and a
  session-derived path. Newest-first by default with oldest-first support;
  content-compared so relay telemetry ticks do not churn the file.
- **Mirror hardening.** Enum-only locations (project root, `project/.progress`,
  or `~/.opencode-progress`), a fixed `tasklist-<session>.md` filename with no
  free-form path, a sentinel guard that refuses to overwrite non-mirror files,
  `ui`/`raw` views with safe `code`/`escaped`/`raw` detail modes, composite
  session keys to avoid duplicate ids in shared mode, and prefs/status sidecars
  next to the state file. The palette command **Progress: task-list mirror
  view** toggles UI/raw.
- **`relayMirrorLevel`.** `0` omits relay-created entries, `1` mirrors every
  relay entry, and `2` mirrors only relay entries currently in `error`.
  Agent-created tasks always mirror; the relay marker is creation-only, so an
  agent task later driven by the relay stays normal.
- **Store maintenance.** Palette-only clear list, hard clear this session, and
  hard clear entire store (typing `DELETE`); deleting a session purges its
  store entries unless `retainDeletedSessionProgress` is set, while mirrored
  tasklists are kept. Store helpers and tests cover deleted-session cleanup.

### Changed

- **Dismissal semantics.** Dismissal is view-plane, not a status change: a
  dismissed tree stays hidden through relay telemetry and sibling activity. An
  agent update clears the dismissal on that entry and its ancestors, except a
  terminal dismissal (while done/error), which later done/error re-reports do
  not revive; a restart or a child failure does. Clear list soft-deletes
  finished/dismissed entries while keeping records on disk.
- **Narration length is a preference.** `sayMinChars`/`sayMaxChars` are advisory
  targets; the tool schema no longer sets `maxLength`, and notes are never
  trimmed or rejected. Out-of-range notes are accepted in full with a reminder
  to aim for the preferred range next time; budget, cooldown, and duplicate
  skips are unchanged.

### Fixed

- **Notes pill in sidebar layout.** The notes pill is shown in both composer
  and sidebar layouts; pills float above the timeline, and sidebar mode adds no
  duplicate notes panel of its own.
- **Mirror correctness.** Composite session keys fix duplicate ids in shared
  mode, and clear/delete operations target the correct session file.
- **Legacy fallback.** Removing the V1 entrypoints prevents OpenCode from
  falling back to a root `index.js` when `package.json` is transiently missing.

### Removed

- **Plugin V1 entrypoints.** Deleted `plugin/index.js` and
  `plugin/gui-experimental.js`. V2 resolves the server part from `src/index.ts`
  through package exports and never loaded either file.

### Docs & Tests

- Documented the `say` tool, notes lifecycle, dismissal, `sayAutoHideTimeoutMs`,
  the `sayModes` mode matrix (TUI, GUI composer, GUI sidebar), the `sayNudge`
  guards, and the **20–80 character** recommendation for terse intent/status
  pings (`sayMinChars: 20`, `sayMaxChars: 80`; shipped defaults remain
  `180`/`260`).
- Documented `treeTheme`, the compact-row meta suffix, and the unchanged
  composer pill capsule.
- Fixed stale V1→V2 setup guidance: removed the obsolete `cli.json` TUI step,
  replaced the plugin-list verification claim, corrected uninstall steps,
  updated the advanced file map for the removed entrypoints, and added npm
  version/download badges. TUI screenshots shipped with 2.19.0.
- Expanded suites across the range: notes, say/sayModes, clear/delete,
  dismissal, GUI/TUI view normalizers, task-list prefs, roll-up, MCP smoke, the
  task-list mirror, the 17-test `say-monitor` suite, and the 28-test `say` suite.
  Final state: **174 plugin tests**, **57 MCP tests**.

## Unreleased — `say` forgot-to-narrate nudge

- **Silent-run `say` nudge.** `sayNudge` now accepts `"silent-run"`: after
  `sayNudgeMinCalls` non-`say`/progress tool calls in a row with no accepted
  note this turn, leave one context-only reminder for the next step. This is
  the `say` analogue of the progress monitor's silent-run nudge, aimed at
  agents that forget to narrate across many quick calls. `"both"` fires on
  either the call count or the existing long-tool duration.
- **`sayNudgeMinCalls`.** Default `3`, clamped to `1..50`. Configurable only in
  `"silent-run"` / `"both"` modes; `"long-tool"` ignores it.
- **Gating and reset.** Every say nudge still requires `say: true` and an
  explicit non-`off` `sayNudge`; a disabled `say` is never nudged about. An
  accepted note resets the call counter and removes the standing `say-nudge`
  entry, and a new user prompt resets the counter while preserving the cooldown
  timestamp. Existing guards (budget, cooldown, per-turn cap, standing
  `progress-nudge`) are unchanged.

## 2.21.0 — tree theme picker (released, `plugin@2.21.0`)

Follow-up to `plugin@2.20.0`, dated **2026-11-24**. Final state: **187 plugin
tests**.

- **Tree theme picker.** The palette command **Progress: switch tree theme**
  (GUI and TUI) picks `Default` or `Compact`, applies it immediately, and saves
  `plugins[].options.treeTheme` in the OpenCode config that declares the
  plugin. Project `opencode.json`/`.jsonc` wins over the global config; edits
  preserve comments, formatting, and unrelated options. If no matching config
  entry is found, the runtime choice still applies and the toast reports why
  nothing was saved.
- **Config editor.** Token-based JSONC editing updates only the matching plugin
  entry's `options` object (or upgrades a string shorthand entry), handling
  trailing commas and a UTF-8 BOM without disturbing the rest of the file.

## mcp-server 2.11.0 — pending, mirror, relay levels (released, `mcp-server@2.11.0`)

Shipped since `mcp-server@2.10.2`:

- **`pending` status.** Queued/not-started entries accepted by the schema and bulk
  writes, carried through roll-up (`error > running > waiting > pending > done`),
  relay `--status`/`emit`, and the Markdown mirror.
- **Optional Markdown task-list mirror.** `tasklist-<session>.md` with a location
  enum (project root, `.progress/`, or home), UI vs raw views, safe detail modes,
  ordering, relay-entry filtering (`relayMirrorLevel`), session-key hardening,
  sentinel/state-path guards, and mirror prefs/status files.
- **Store and mirror support** for cleared/dismissed entries plus expanded MCP
  smoke and task-list suites (**57 tests**).

## 2.24.0 — settings tab and release links (unreleased)

- **Settings tab in the tree view.** The desktop pill popover and pinned
  sidebar footer now has a **[Settings]** tab beside **[Feedback]**. It shows
  the effective view, reminder, and data options (layout, theme, refresh,
  strict/wall/idle, say, custom nudges, mirror, workspace) and links to the
  release notes and docs. Values are read-only; edits belong in the OpenCode
  config that declares the plugin and apply on reload.
- **Version link.** The footer version is now `[v2.24.0]`, opening
  `https://github.com/jakedowns/progress-tool/releases` for changelog viewing.

## 2.23.0 — custom nudges (released, `plugin@2.23.0`)

User- and agent-configurable reminders, built on the 2.22.0 reminder engine.
**Opt-in:** the whole feature is gated behind `{ customNudges: true }`
(default `false`) — no rule files are read, and no tool or TUI/palette command
is registered until it is enabled.

### Added

- **Rule schema + stores.** `id`, `text` (with `{id}` `{title}` `{status}`
  `{age}` `{count}` `{action}`), `severity`, `trigger`, `cooldownMs`,
  `criteria`, `delivery`, `ttlMs`, `maxFires`. Dedicated, atomic files:
  `~/.config/opencode/progress-nudge.json` (global),
  `<projectRoot>/.opencode/progress-nudge.json` (project), and
  `~/.config/opencode/progress-nudge-sessions.json` (session). Session rules
  are stored per session id rather than in server memory so the TUI, GUI, and
  server all see the same rule without an IPC bridge.
- **Triggers.** Interval, model steps, either, and event-only. Step rules use
  the logical model-step counter from 2.22.0; every progress write resets it.
- **Criteria.** Status, stale age, no-progress time/steps, in-flight only/never,
  tree empty/non-empty, idle-only, entry ids, and `self`/`children`/`all`
  session scope. AND across categories, OR inside lists. Fresh-detail
  `waiting` stays healthy unless `waiting` is listed explicitly.
- **Delivery.** `context-replace` (pauses built-in progress/wall/idle/relay/say
  reminders while live), `context-alongside` (deduped), and `synthetic`
  (block-only). Shared one standing key and `block > warn > info` priority.
- **Lifetime.** Per-rule TTL and fire cap (one-shot included), runtime counters
  scoped per session; expired/exhausted rules remain listed until cleared.
- **Merge/tombstones.** Global → project → session union; narrower scopes win
  identical rendered output; `enabled: false` in a narrower scope mutes that
  id in broader scopes.
- **Surfaces.**
  - TUI: `/progress nudge` wizard plus `list|status|set|on|off|clear`, with
    flags for trigger, criteria, cooldown, TTL, and fire cap.
  - GUI palette: **Progress: custom nudge…** wizard and **Progress: custom
    nudge status** (enable/disable/clear), backed by new `nudge*` RPC methods.
  - Agent tool `progress_nudge` (`set|list|status|on|off|clear`),
    session-scoped only; broader scopes are refused with a pointer to the
    user surfaces because the host exposes no tool permission prompt.
  - Direct JSON editing, documented with the full schema.
- **Telemetry.** `custom-nudge` events for fired rules and expired skips;
  built-in suppression is recorded as `reminder` with `suppressed:
  custom-replace`.

### Tests

- Plugin: **224** tests (16 new custom-nudge core tests: normalization,
  presets, merge/tombstones, criteria, rendering, triggers, cooldown/TTL/fire
  caps, replace suppression, stores, project-root discovery, session scoping).
  GUI/TUI bundles rebuilt.

## mcp-server 2.12.0 — `progress_touch` (released, `mcp-server@2.12.0`)

- **`progress_touch` MCP tool + `progress-touch` CLI.** Refreshes one entry or
  `ids[]` without changing status, title, progress, or parent; bumps
  `updatedAt` and optionally replaces `detail`. Missing ids are reported, not
  fabricated.
- Plugin `2.22.0` consumes the released MCP `2.12.0` through the existing
  `^2.10.1` dependency range.

## 2.22.0 — quieter reminders and `progress_touch` (shipped in `plugin@2.23.0`)

Closes the 13-point nudge feedback from a 2026-11-24 session. Reminder engine
shared by strict, wall-clock, idle, relay, and `say` nudges.

### Added

- **`progress_touch` MCP tool + `progress-touch` CLI.** Refreshes one entry or
  `ids[]` without changing status, title, progress, or parent; bumps
  `updatedAt` and optionally replaces `detail`. Use it for long single-step
  work instead of inventing a progress fraction. Missing ids are reported, not
  fabricated, and `progress_touch` still counts as progress for step resets.
- **Severity tiers.** Reminders render `[info]`, `[warn]`, or `[block]`.
  `info`/`warn` ride the standing context entry; only `block` may admit a
  synthetic message (idle-with-open-tasks and explicit escalation).
- **Healthy waiting.** A `waiting` entry with a non-empty detail touched within
  `staleAfterMs` is blocked on something external, so strict/idle/wall nudges
  skip it. Stale or detail-less waiting still counts.
- **Model-step counting.** `strictThreshold` and stale detection count logical
  model steps (context hook), so parallel tool calls in one step count once.
  Any progress write or touch resets the counter; a new prompt resets all
  per-turn monitors and timers.
- **One standing reminder key.** `progress-reminder` replaces the per-nudge
  keys. Priority is `block > warn > info`; identical rendered text is deduped,
  and only compliance, a new prompt, or a higher tier overwrites it.
- **In-flight suppression.** Wall-clock reminders pause while a tool is
  executing or a background job is active; `warn`/`info` do not nag a working
  agent.
- **Compact copy.** Reminders are one line naming a target id and one action
  (`wr03 (running, 12m) — update detail/progress or close it`), with ages
  measured from `max(lastProgressAt, promptAt)` and clamped (`> 2h`) after a
  resumed session.
- **Docs.** One-progress-call-per-execute plus `entries[]` batching guidance is
  in the injected progress rules and both READMEs.

### Tests

- Plugin: **208** tests (new reminder-engine suite covers severity, dedupe,
  healthy waiting, target selection, model steps, and compaction).
- MCP: **60** tests (touch preserves lifecycle fields, updates detail, reports
  missing ids, and enforces `id`/`ids` exclusivity).

## Unreleased — theme previews and GUI tree branches

- **Theme preset switcher.** **Progress: switch tree theme** now presents
  **ASCII** (`barStyle: "blocks"`), **Emoji** (`barStyle: "emoji"`), and
  **Compact** (`treeTheme: "compact"`) with inline previews rendered from the
  real bar helpers. Picking a preset applies it immediately and persists both
  `treeTheme` and `barStyle` to the OpenCode config that declares the plugin.
- **GUI tree branches.** Expanded child rows in the composer pill popover and
  sidebar are prefixed with the TUI's `└─` branch glyph, placed ahead of the
  status dot.

## Local config note

The local OpenCode config used while validating this range sets `sayModes`,
the 20/80 note range (`sayMinChars: 20`, `sayMaxChars: 80`),
`treeTheme: "compact"`, and `successHoldMs: 6000`. Only these non-secret view
options are repeated here; no credentials or unrelated local settings are
included.

## Commits

- Range: **`plugin@2.18.9`** (`e938598`) → **`plugin@2.20.0`** release commit — **41 commits**.
- Published release in range: **`plugin@2.19.0`** → `ceff22d`.
- MCP package version: **`2.11.0`** (released, `mcp-server@2.11.0`).
- 2.19.0: `39d289c` screenshots, `d2ac471` TUI one-line summary, `332490b`
  screenshot bump, `d8af77b` authoritative stale nudges, `ceff22d` release.
- Unreleased: `d032d7f` badges, `73053a7` task-list mirror, `a4aa3c6` local
  mirror config, `2c7ff83` ignores, `d4a2101` clear/delete + relay levels,
  `ee1c363` `say` phase 1, `d282f01` GUI layouts, `720f92c` detail caps,
  `14c5503` mirror hardening (merges `58b1c95`, `3cd2681`), `0e726d0` V1
  entrypoints removed, `6c51c85` pending status, `3a52b05` notes ring buffer,
  `b978a23` TUI notes, `15ea22b` notes pill, `c6f7b67` notes docs, `41c1d10`
  sidebar pill fix, `51d77e9` sayModes/dismissal, `adab9d8` TUI surfaces,
  `93f3dbc` GUI surfaces, `4efe127` sayModes docs, `11a7c8a` auto-hide,
  `c6b24d4` long-tool nudge, `a4964ef` length fix, `434bf46` tree helpers,
  `ac5d2f3` GUI compact rows, `4b039f0` TUI compact rows, `5fde838` treeTheme
  docs, `e3620ef` length wording, `07eaea0` changelog, `face549` version reset,
  `9c85c88` changelog consolidation, `02ba836` toast scope + warning durations.
- Historical local reload labels `2.20.0`–`2.25.0` were never published.
