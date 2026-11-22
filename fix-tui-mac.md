# Fix: TUI plugin fails with `Cannot find package 'react'`

**Component:** `@jakedowns/progress-tool-opencode-plugin` (v2.18.3)
**Runtime:** TUI (`role=cli`) on OpenCode v2.3.2, macOS arm64
**Symptom:** `Plugin status: failed` with `Cannot find package 'react' imported from .../src/tui.tsx`

---

## Verdict

This is **not a credential, environment-variable, or dependency-install problem**. It's the known
OpenCode TUI loader limitation for **npm-installed plugins that ship raw TSX**, and this plugin hits it
because its `./tui` entry is uncompiled Solid JSX (`src/tui.tsx`).

The rest of the plugin is healthy: the server half (`src/index.ts`) loads fine, the MCP server runs,
and `@opentui/solid`, `solid-js`, and `@opencode/plugin/tui` are all present in the install.

---

## Evidence

### 1. Only the TUI entry fails, and it fails on every reconciliation

From `~/.local/share/opencode/log/opencode.log` (opencode 2.3.2):

```
plugin operation failed component=plugin stage=load error="Cannot find package 'react' imported from
~/.cache/opencode/npm/@jakedowns/progress-tool-opencode-plugin@latest/.../src/tui.tsx" role=cli
```

The same package loads successfully as `role=server` via `src/index.ts`.

### 2. Nothing in the plugin imports React

`plugin/src/tui.tsx` imports only `solid-js`, `@opencode/plugin/tui`, and local modules.
`plugin/package.json` has no `react` dependency, and the install cache contains no `react` or
`react-dom` at all. The `react` import is *synthesized* by the JSX transpiler.

### 3. Reproduced directly with Bun

```sh
# Plain Bun import of the cached file:
bun -e "await import('.../src/tui.tsx')"
# error: Cannot find module "react/jsx-dev-runtime" ...

# With OpenTUI's Solid runtime support preloaded:
bun --preload @opentui/solid/runtime-plugin-support -e "..."
# IMPORT OK
```

Bun's default JSX runtime for `.tsx` is React. That is exactly the reported production error
(`react/jsx-runtime`; the dev loader uses `react/jsx-dev-runtime`).

### 4. Root cause is in OpenCode's bundled Solid transform

OpenCode 2.3.2 embeds OpenTUI's `bun-plugin-solid` with this file filter:

```
^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?(?:[?#].*)?$
```

The negative lookahead **excludes every path under `node_modules`**. npm-installed plugin code lives
at `~/.cache/opencode/npm/<spec>/<id>/node_modules/...`, so the Solid transform never runs on
`tui.tsx`; Bun compiles it with the React runtime and the import fails.

The `@opentui/solid` copy installed in the cache is newer (0.9.7) and its transform *would* handle
this file, but OpenCode uses its own bundled copy, not the peer package.

This is a documented upstream bug class:
[anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884). Local-directory
plugins work because they sit outside `node_modules`.

---

## Recommended fix (plugin side, ships to npm)

Precompile the TUI entry to plain JS and point `exports["./tui"]` at it. Plain JS has no JSX left, so
no JSX runtime is injected. The remaining bare imports (`solid-js`, `@opentui/solid`,
`@opencode/plugin/tui`) are then rewritten by OpenCode's runtime-module bridge to the **host's**
instances, which is required for reactivity to work.

### Build script

```js
// plugin/scripts/build-tui.mjs
import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  format: "esm",
  target: "bun",
  external: [
    "solid-js", "solid-js/store",
    "@opentui/solid", "@opentui/core",
    "@opencode/plugin/tui",
  ],
  plugins: [solidPlugin],
});
if (!result.success) { console.error(result.logs); process.exit(1); }
```

Verified against the exact published `src/tui.tsx`: the output contained zero `react` references,
only bare `@opentui/solid`, `solid-js`, and `@opencode/plugin/tui` imports, and imported cleanly with
plain Bun.

### Manifest change

```jsonc
// plugin/package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./dist/tui.js"   // was ./src/tui.tsx
  },
  "scripts": {
    "build": "../scripts/build-gui.sh && bun scripts/build-tui.mjs",
    "prepublishOnly": "npm test && npm run build"
  }
}
```

Notes:

- `dist/` is already in `files`; no other manifest changes are needed.
- Keep the compiled output's imports **external/bare**. Bundling `solid-js` or `@opentui/solid` into
  the file recreates the duplicate-runtime problem: the panel renders once and never updates.
- Bump to e.g. `2.18.4`, publish, then run `opencode plugin update`. The cache can be sticky on
  `@latest`; pin the version or clear
  `~/.cache/opencode/npm/@jakedowns/progress-tool-opencode-plugin@latest/` if the old build keeps
  resolving.

---

## Immediate workaround (no publish needed)

Load the plugin from the local checkout instead of the npm cache. Paths outside `node_modules` get
the Solid transform.

```jsonc
// ~/.config/opencode/cli.json (TUI plugins) or opencode.jsonc "plugins"
{
  "plugins": ["/Users/jakedowns/Desktop/scratch/progress-tool-mac-host/plugin"]
}
```

or in `~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": ["file:///Users/jakedowns/Desktop/scratch/progress-tool-mac-host/plugin"]
}
```

Config hot-reloads; no restart is needed.

---

## What not to do

- **Do not add `react` as a dependency.** The output would be React elements handed to a
  Solid/OpenTUI renderer — the error disappears and the UI silently renders nothing (or crashes
  later).
- **Do not rely on a `tsconfig.json` / `@jsxImportSource` pragma as the fix.** It makes the file
  resolve, but against the plugin-local `@opentui/solid` (a second Solid instance), not the host's
  bridged runtime. The known symptom there is a panel/status that renders once and never updates.
  A pragma is fine as belt-and-braces, but precompiling is the durable fix.

No credentials or environment variables are involved; nothing sensitive appears in the logs or needs
changing.
