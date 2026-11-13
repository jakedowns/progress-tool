# Shim progress into the desktop "Working" / "Thinking" indicator

OpenCode desktop shows a small animated **"Working"** / **"Thinking"** line while an
agent is busy. This guide explains how that text is produced and how to append our
`progress` output right next to it.

## How the native indicator works

- It is rendered by the **session timeline / composer status** component.
- The label comes from i18n (`session.timeline.working`) and the activity type
  (streaming reasoning vs. running tools).
- It is **not** driven by tool data, and the plugin API does **not** expose a hook
  to replace it. The plugin GUI API (`@opencode/plugin/gui`) exposes `Panel`,
  `Slot`, `ComposerPill`, `TitlebarItem`, `SettingsPage`, etc., but not the timeline
  status string.

In the current web build the relevant DOM anchors are:

| Anchor | Where |
|--------|-------|
| `[data-component="text-shimmer"][data-active="true"]` | The animated "Working"/"Thinking" text |
| `[data-slot="sidebar-inbox-working"]` | The sidebar **Working** section |
| `[data-slot="tab-status"]` | Per-tab status label |

Because those are stable data attributes, a **DOM shim** can append our progress
summary right after the native text. That is what `plugin/status-shim.js` does.

## Quick test (recommended)

1. Start the GUI server (also serves the shim):

   ```bash
   cd progress-tool
   ./launch-gui.sh      # or: node progress-gui-server.js
   ```

2. In the OpenCode desktop app, open the developer tools
   (`Ctrl+Shift+I` / `Cmd+Opt+I`, or **View → Toggle Developer Tools**) and run:

   ```js
   const s = document.createElement('script');
   s.src = 'http://localhost:8765/status-shim.js';
   document.head.appendChild(s);
   ```

That one line auto-installs a shim that:

- polls `http://localhost:8765/api/progress` every 1.5 s,
- finds the active "Working"/"Thinking" shimmer (+ sidebar working row),
- appends a compact summary such as:

  ```
  Working · [█████░░░░░] 5/10 · building SDL2 → linking libSDL2.a
  ```

The shim is defensive: if it cannot find an anchor it silently no-ops, and it
cleans itself up when anchors disappear.

## Using it from the plugin GUI bundle

The plugin bundle can install the same shim if it has the code available. Because
the plugin bundle's `require()` only resolves shared host modules (not relative
files), inline the shim (or paste it) and call:

```js
const shim = OCProgressStatusShim.createStatusShim({
  getEntries: () => progressEntries, // your entries object
});
// later: shim.dispose()
```

## Native (blessed) alternative: a composer pill

Newer builds expose `@opencode/plugin/gui` with `ComposerPill` and `Slot`. A
`ComposerPill` renders directly in the composer area next to the status text, which
is the officially supported place for this kind of indicator. Two caveats:

- The plugin GUI framework changed between builds (older builds use Preact, current
  builds use Solid + `@opencode/plugin/gui`), so a bundle written for one may not
  render in the other.
- The exact `ComposerPill` contribution shape is not documented in this repo yet.

If you want the fully native route, target the `ComposerPill` registry and pass a
reactive getter that reads our progress entries. The DOM shim above is the
framework-agnostic fallback that works on any build.

## Caveats

- DOM shims depend on internal `data-*` attributes and may break on app updates.
- Loading `http://localhost:8765/status-shim.js` into the app requires the GUI
  server to be running. Mixed-content or custom-scheme builds may block the fetch;
  in that case use the floating overlay (`/`) or the `ComposerPill` route.
- The shim is read-only: it never posts anything back to the app or the session.
