/**
 * Decide whether a build should display `<version>-dev`.
 *
 * Detection: a build is a release build only when HEAD carries the exact tag
 * `plugin@<package version>`. `PROGRESS_DEV=1` forces dev, `PROGRESS_DEV=0`
 * forces release. A tree without `.git` (npm install) falls back to release.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveDevFlag(repoRoot, pluginDir, env = process.env) {
  const forced = String(env.PROGRESS_DEV ?? "").trim();
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;

  let version;
  try {
    version = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")).version;
  } catch {
    return false;
  }
  try {
    const tags = execFileSync("git", ["-C", repoRoot, "tag", "--points-at", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !tags
      .split("\n")
      .map((tag) => tag.trim())
      .includes(`plugin@${version}`);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repoRoot, pluginDir] = process.argv.slice(2);
  if (!repoRoot || !pluginDir) {
    process.stderr.write("usage: dev-version-flag.mjs <repo-root> <plugin-dir>\n");
    process.exit(2);
  }
  process.stdout.write(resolveDevFlag(repoRoot, pluginDir) ? "1" : "0");
}
