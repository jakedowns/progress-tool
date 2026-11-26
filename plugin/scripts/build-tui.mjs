/**
 * Compile the TUI entry to plain JS for npm installs.
 *
 * Why: npm-installed plugins live under node_modules, which OpenCode's bundled
 * Solid transform skips. A raw `src/tui.tsx` then gets Bun's default (React)
 * JSX runtime and dies with `Cannot find package 'react'`.
 *
 * Pipeline: Babel/Solid transform (via @opentui/solid's pure transform) for the
 * JSX, then esbuild to inline the plugin's own local .ts modules while keeping
 * solid-js / @opentui / @opencode/plugin/tui external. The host bridges those
 * bare imports to its own instances, which is what keeps reactivity working.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolveDevFlag } from "../../scripts/dev-version-flag.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);

function solidTransformPath() {
  let pkgPath;
  try {
    pkgPath = require.resolve("@opentui/solid/package.json");
  } catch {
    pkgPath = path.join(path.dirname(require.resolve("@opentui/solid")), "package.json");
  }
  return path.join(path.dirname(pkgPath), "scripts", "solid-transform.js");
}

const { transformSolidSource } = await import(pathToFileURL(solidTransformPath()).href);

const source = fs.readFileSync(path.join(root, "src", "tui.tsx"), "utf8");
const transformed = await transformSolidSource(source, { filename: "src/tui.tsx" });

const devFlag = resolveDevFlag(path.resolve(root, ".."), root);

await build({
  define: {
    __PROGRESS_DEV__: JSON.stringify(devFlag),
  },
  stdin: {
    contents: transformed,
    resolveDir: path.join(root, "src"),
    sourcefile: "tui.js",
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile: path.join(root, "dist", "tui.js"),
  external: [
    "solid-js",
    "solid-js/*",
    "@opentui/*",
    "@opencode/plugin/tui",
    "node:*",
  ],
  legalComments: "none",
  logLevel: "info",
});

console.log("built dist/tui.js");
