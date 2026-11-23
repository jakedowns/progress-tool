#!/usr/bin/env node
/**
 * Pure-function benchmark for the tree derivation.
 *
 * The pill's 1 s tick used to rebuild this model many times per render. Run
 * this after changing tree.ts or the GUI accessors to catch regressions in the
 * hot path without opening the app:
 *
 *   cd plugin && npm run bench:tree
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "progress-bench-"));
const require = createRequire(import.meta.url);

execFileSync(
  path.join(root, "node_modules", ".bin", "esbuild"),
  [
    path.join(root, "src", "tree.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${path.join(out, "tree.cjs")}`,
  ],
  { stdio: "pipe" }
);
const { buildTree, visibleEntries, dismissedMap, isDismissed } = require(
  path.join(out, "tree.cjs")
);

const ROOTS = 50;
const CHILDREN = 9;
const entries = {};
for (let r = 0; r < ROOTS; r++) {
  const rootID = `root-${r}`;
  const status = r % 7 === 0 ? "running" : r % 5 === 0 ? "error" : "done";
  entries[rootID] = {
    id: rootID,
    status,
    title: `Root ${r}`,
    progress: status === "done" ? 1 : 0.4,
    updatedAt: Date.now() - r * 1000,
    dismissed: r % 3 === 0 ? { status, at: Date.now() } : undefined,
  };
  for (let c = 0; c < CHILDREN; c++) {
    const id = `${rootID}-${c}`;
    entries[id] = {
      id,
      parentId: rootID,
      status: c % 8 === 0 ? "error" : "done",
      title: `Child ${r}.${c}`,
      progress: 1,
      updatedAt: Date.now() - r * 1000 - c,
    };
  }
}

function measure(label, fn, iterations = 200) {
  for (let i = 0; i < 10; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  console.log(`${label.padEnd(42)} ${ms.toFixed(2)} ms`);
}

const dismissed = dismissedMap(entries);
console.log(`synthetic store: ${Object.keys(entries).length} entries (${ROOTS} roots)\n`);

measure("buildTree + visibleEntries", () =>
  buildTree(visibleEntries(entries, Date.now(), {}))
);

const tree = buildTree(visibleEntries(entries, Date.now(), {}));
measure("filter dismissed (map hoisted)", () =>
  tree.filter((root) => !isDismissed(root, dismissed))
);

measure("old pattern: dismissedMap per root", () =>
  tree.filter((root) => !isDismissed(root, dismissedMap(entries)))
);

console.log(
  "\nThe old pattern rescanned every entry for every root. Keep both numbers\n" +
    "apart when tuning: the first is the unavoidable model build; the second\n" +
    "shows whether a lookup is being rebuilt inside a loop."
);
