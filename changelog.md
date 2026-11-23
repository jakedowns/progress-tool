# Changelog

All notable changes to the Progress Tool (OpenCode plugin, TUI/GUI views, and
MCP server/relay) between the **`plugin@2.18.9`** tag and the current working
tree, dated **2026-11-23**.

The range starts at `plugin@2.18.9` (commit `e938598`, tagged 2026-11-22) and
covers **35 commits** through `e3620ef` on `master`; the tree is clean apart from
this changelog. It includes the interim **`plugin@2.19.0`** tag (`ceff22d`).
After that tag, plugin package versions move through `2.20.0`, `2.21.0`,
`2.22.0`, `2.23.0`, `2.24.0`, and `2.25.0`, while the MCP server moves from
`2.10.2` to `2.12.0`; these later bumps are committed but **untagged**.

## 2.25.0 (untagged, commit `e3620ef`)

Committed after `2.24.0`; not yet tagged.

### Added

- **Plugin — `treeTheme` option.** Normalizes to `"default"` or `"compact"` and
  applies to the GUI pill popover, GUI sidebar panel, and TUI tree. `"compact"`
  removes progress-bar glyphs (blocks, emoji bars, and fractions), hides the GUI
  `started …` line, keeps one detail line regardless of `guiDetailLines`
  (`guiDetailLines: 0` still hides it), tightens GUI row padding, and replaces
  the bar with a `40% · & N more` suffix from the new `compactTreeSuffix`
  helper. View-only: the GUI composer pill capsule and its `barStyle` rendering
  are unchanged.
- **Plugin — compact rows in both views.** The GUI pill popover/sidebar and the
  TUI render barless compact rows when the theme is enabled, including the
  collapsed-descendant count.

### Fixed

- **`say` length is advisory, never destructive.** Removed the tool schema's
  `maxLength` so the host cannot reject an over-long argument, stopped trimming
  or rewriting notes, and accept every non-empty note in full. Notes outside
  `sayMinChars`/`sayMaxChars` still succeed and carry a reminder to aim for the
  preferred range next time; budget, cooldown, and duplicate skips are
  unchanged. The `say` suite now has 28 tests.

### Changed

- **Docs wording and version.** Documentation now states that note length is a
  preference and that notes are never trimmed or rejected; plugin
  `package.json` moves to `2.25.0`, both dist bundles are rebuilt, and the
  plugin suite grows to 171 tests (MCP stays at 57).

## 2.24.0 (untagged, commit `c6b24d4`)

Committed after `2.23.0`; not yet tagged.

### Added

- **Plugin — `say` long-tool nudge.** `plugin/src/say-monitor.ts` is a pure
  decision module for an opt-in, retrospective reminder on the `say` narration
  lane: after a tool call finishes, it can leave a one-shot **context-only**
  hint asking the agent to narrate before the next long step. It never sends a
  synthetic message, skips `say` and progress calls, and is suppressed while a
  `progress-nudge` entry stands. Guards run in order: mode off, a note already
  posted this turn, say budget exhausted, call shorter than `sayNudgeAfterMs`
  (default 20s), cooldown (default 120s), per-turn cap (default 1, max 3), or a
  standing progress nudge.
- **Plugin — nudge wiring.** `execute.before`/`execute.after` timing keyed by
  tool call id leaves the hint as a one-shot context entry for the next step;
  the next prompt resets per-turn counts while keeping the cooldown timestamp,
  and an accepted note clears the entry. Config keys: `sayNudge` (`true` /
  `"long-tool"`), `sayNudgeAfterMs`, `sayNudgeCooldownMs`, and
  `sayNudgeMaxPerTurn`; `verboseLogging` records a `say-nudge` telemetry event.
- **Plugin — nudge tests and docs.** `plugin/test/say-monitor.test.cjs` adds 17
  unit tests for option normalization, each guard, message truncation, and
  per-turn state; it is listed in the package `test` script (165 plugin tests).
  README, README-advanced, and plugin README document the option, its guard
  order, and the recommended note length.

### Changed

- **Narration length guidance.** README now recommends **20–80 characters** for
  terse intent/status pings (`sayMinChars: 20`, `sayMaxChars: 80`); the shipped
  defaults remain `180`/`260` for longer intent-plus-ETA notes.
- **Version.** `plugin/package.json` moves from `2.23.0` to `2.24.0` and both
  dist bundles are rebuilt; the MCP server stays at `2.12.0`. The commit is
  untagged, so this feature is in git but not in a release tag.

## Added

The sections below cover the 2.19.0–2.23.0 lines; 2.24.0 and 2.25.0 are above.

### Plugin — narration (`say`)

- **Opt-in `say` tool (2.20.0).** `{ "options": { "say": true } }` registers a
  mid-turn narration tool for short "what I am doing + rough ETA" notes. Notes
  fan out to the tool progress line and a synthetic session note with
  `resume: false`, so a turn cannot end on a note. Per-turn budget, cooldown,
  preferred length targets, a once-per-turn final guard, and guidance that
  budget/cooldown skips should fall back to the `progress` tool.
- **Persistent notes lane (2.22.0).** Accepted notes are stored in the shared
  state document in a bounded per-author ring buffer (20 newest per session),
  rolled up to the session root, included in the revision/signature, and
  purged with the session or a hard clear. Notes survive clear-list and are
  recorded even when `sayChatNotes` is off.
- **TUI notes UI.** A dim latest-note line above the tree with a history count,
  click-through to a newest-first history dialog, `Notes (N)` in `/progress`,
  and per-note plus **Dismiss all notes** actions.
- **GUI notes UI.** A second composer pill showing the latest note snippet
  (warning-tinted for `blocked`/`question`) with a newest-first history
  popover, plus the latest-note line in the sidebar panel and pill popover.
- **`sayModes` surfaces (2.23.0).** Normalize a string or array of `"pill"`,
  `"toast"`, and `"tree"` (`sayMode` as scalar alias), with unknown values
  dropped, duplicates collapsed, and `[]` recording notes without a surface.
  The TUI folds `pill` into its line; the GUI composer layout falls back from
  `tree` to the notes pill.
- **Toasts and dismissal.** New notes can toast once per note id with
  `blocked`/`question` warning styling and `[Subagent (X)]` attribution for
  child sessions. Per-note dismissal removes that note from the shared ring
  buffer; **Dismiss all notes** is root-scoped and clears the same rolled-up
  tree the viewer is reading. Every client updates on its next poll/event, and
  the GUI also applies optimistic removal.
- **Note auto-hide (committed in `11a7c8a`).** `sayAutoHideTimeoutMs` (default
  60s, `0` disables, clamped to `0..86400000`) hides old notes from every
  surface without deleting them. Expired notes fall back to the next visible
  note, surfaces disappear when none remain, old notes never toast, and the
  GUI re-renders on a 5s clock only while notes exist. View-only: the tool,
  store, and purge rules are unchanged.

### Plugin — GUI

- **Composer/sidebar layouts (2.20.0).** `guiLayout: "composer"` keeps the
  floating pill; `"sidebar"` registers a pinned Progress tab in the session
  side region, opens once per session, and offers a way back from the panel
  header. Adds `guiSidebarWidth` (360px default, clamped 240–800), the
  `[Sidebar]` pill action, and the palette command **Progress: swap layout
  (composer/sidebar)**.
- **Detail line caps (2.20.0).** `guiDetailLines` caps detail text in the pill
  menu and sidebar rows: `1` line by default with an ellipsis, `0` hides
  details, and `-1` shows full text; the tooltip still carries full detail.
- **Pill performance.** Pill derivations and rows are memoized and refresh is
  event-driven with polling fallbacks.

### Plugin — TUI

- **One-line summary (2.19.0).** The palette command **Progress: collapse or
  expand tree** collapses the view to
  `progress: waiting (n) | running (n) | error (n) | done (n) | dismissed (n)`;
  clicking the line expands it again.

### MCP server & relay

- **`pending` (queued) status (2.21.0 / MCP 2.12.0).** `pending` is accepted by
  the `progress` tool schema, bulk entries, and relay `--status`/emit paths.
  Roll-up precedence is `error > running > waiting > pending > done` in the
  MCP server, task-list mirror, and plugin tree helpers. The TUI adds a pending
  glyph/bucket, the GUI a muted dot and pending count, idle reminders count
  pending as open work, and the stale sweep still skips it.
- **Optional Markdown task-list mirror (2.20.0 / MCP 2.11.0).** Env-gated
  (`PROGRESS_TASKLIST=1`, or `taskListFile`) mirror of the current session's
  task tree, written on progress writes with checkboxes, status, timestamps,
  nested children, and a session-derived path. Newest-first by default with
  oldest-first support; content-compared so relay telemetry ticks do not churn
  the file.
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

## Changed

### Plugin

- **Dismissal semantics.** Dismissal is view-plane, not a status change: a
  dismissed tree stays hidden through relay telemetry and sibling activity. An
  agent update clears the dismissal on that entry and its ancestors, except a
  terminal dismissal (while done/error), which later done/error re-reports do
  not revive; a restart or a child failure does. Clear list soft-deletes
  finished/dismissed entries while keeping records on disk.
- **Stale nudges (2.19.0).** Reminders are self-contained directives instead of
  mutable context values; the ladder escalates once after N entry reminders
  (default 3, `staleEscalateAfter: 0` disables), any real progress write
  resets it, and compliance/ignore telemetry is recorded.

### Release

- **Version bumps.** Plugin package versions `2.18.9 → 2.19.0 → 2.20.0 → 2.21.0
  → 2.22.0 → 2.23.0 → 2.24.0 → 2.25.0`; MCP server `2.10.2 → 2.11.0 → 2.12.0`.
  Only `2.19.0` is tagged in this range; the later bumps ride on `master`.
  README and release workflow examples were refreshed, and the TUI gained
  screenshots.

## Fixed

### Plugin

- **Notes pill in sidebar layout.** The notes pill is shown in both composer
  and sidebar layouts; pills float above the timeline, and sidebar mode still
  adds no duplicate notes panel of its own.
- **Legacy fallback.** Removing the V1 entrypoints prevents OpenCode from
  falling back to a root `index.js` when `package.json` is transiently missing.

### MCP server & relay

- **Mirror correctness.** Composite session keys fix duplicate ids in shared
  mode, and clear/delete operations target the correct session file.

## Removed

- **Plugin V1 entrypoints.** Deleted `plugin/index.js` and
  `plugin/gui-experimental.js` on the post-2.19.0 line. V2 resolves the server
  part from `src/index.ts` through package exports and never loaded either file.

## Docs & Tests

- Documented the `say` narration lane, notes lifecycle, dismissal, and the
  full `sayModes` mode matrix (TUI, GUI composer, GUI sidebar), plus the
  `sayAutoHideTimeoutMs` option on every surface.
- Documented the `sayNudge` long-tool option, its guard order, and the 20–80
  character guidance in README, README-advanced, and plugin README.
- Clarified that narration length is a preference: notes are accepted in full,
  never trimmed or rejected, and out-of-range lengths get a reminder for the
  next call.
- Fixed stale V1→V2 setup guidance: removed the obsolete `cli.json` TUI step,
  replaced the plugin-list verification claim, corrected uninstall steps,
  updated the advanced file map for the removed entrypoints, and added npm
  version/download badges. Added TUI screenshots.
- Expanded suites across the range: notes, say/sayModes, clear/delete,
  dismissal, GUI/TUI view normalizers, task-list prefs, roll-up, MCP smoke, the
  task-list mirror, the 17-test `say-monitor` suite, and the 28-test `say` suite.
  The final state cites MCP 57 tests and plugin 171 tests (up from 148).

## Local config note

The local OpenCode config used while validating this range sets
`treeTheme: "compact"` alongside `sayModes` and the 20/80 note range
(`sayMinChars: 20`, `sayMaxChars: 80`). Only these non-secret view options are
repeated here; no credentials or unrelated local settings are included.

## Commits

- Tag used: **`plugin@2.18.9`** → `e938598` (range start). Interim release tag:
  **`plugin@2.19.0`** → `ceff22d`. End of range: **`e3620ef`** (35 commits).
- 2.19.0 line: `d2ac471` TUI one-line summary, `d8af77b` authoritative stale
  nudges, `ceff22d` release.
- 2.20.0 line: `73053a7` task-list mirror, `d4a2101` clear/delete + relay
  levels, `ee1c363` `say` phase 1, `d282f01` GUI layouts, `720f92c` detail caps,
  `14c5503` mirror hardening (merges `58b1c95`, `3cd2681`).
- 2.21.0: `6c51c85` pending status. 2.22.0: `3a52b05`, `b978a23`, `15ea22b`,
  `c6f7b67` notes lane.
- 2.23.0: `41c1d10`, `51d77e9`, `adab9d8`, `93f3dbc`, `4efe127`, `11a7c8a`.
- 2.24.0 (untagged): `c6b24d4` long-tool nudge, wiring, docs, version, bundles.
- 2.25.0 (untagged): `a4964ef` say length fix, `434bf46` tree theme helpers,
  `ac5d2f3` GUI compact rows, `4b039f0` TUI compact rows, `5fde838` docs/2.25.0,
  `e3620ef` final say-length wording.
- Working tree: only the new `changelog.md` is uncommitted.
