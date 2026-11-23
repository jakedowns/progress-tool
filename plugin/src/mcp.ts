/**
 * Companion MCP launch resolution.
 *
 * The plugin auto-registers `@jakedowns/progress-tool-mcp`, but it cannot use
 * `process.execPath` as the interpreter. In OpenCode Desktop (and in
 * bun-compiled CLI builds) `process.execPath` is the `opencode` executable,
 * not a JavaScript runtime. OpenCode then receives the MCP entrypoint as a
 * positional project path, tries to `chdir` into the `.js` file, and the
 * server dies with `ENOTDIR` — so `progress`/`list` never register.
 * See https://github.com/jakedowns/progress-tool/issues/1.
 *
 * Resolution order:
 *   1. an explicit `mcpRuntime` plugin option
 *   2. `process.execPath`, only when it really is node/bun/deno
 *   3. node, then bun — on PATH, then in well-known install locations
 *   4. `npx -y @jakedowns/progress-tool-mcp` as a last resort
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeTaskListDetail,
  normalizeTaskListLocation,
  normalizeTaskListView,
} from "./tasklist-prefs.js";

/** Published companion package, used by the `npx` fallback. */
export const MCP_PACKAGE = "@jakedowns/progress-tool-mcp";

/** Basenames that really are JavaScript runtimes. */
const RUNTIME_NAMES = new Set(["node", "nodejs", "bun", "deno"]);

/**
 * Everything the resolver touches from the outside world is injectable so the
 * launch order can be tested without the host's real PATH or install layout.
 */
export interface RuntimeProbe {
  /** Explicit runtime from `options.mcpRuntime`. */
  runtime?: string;
  /** Override for `process.execPath` (the OpenCode binary, usually). */
  execPath?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  home?: string;
  exists?: (candidate: string) => boolean;
  readdir?: (directory: string) => string[];
}

export interface McpLaunch {
  command: string[];
  /** Human-readable explanation for the startup log. */
  source: string;
}

/** True when `execPath` names a JS runtime rather than an application binary. */
export function isJsRuntime(execPath: string | undefined | null): boolean {
  if (typeof execPath !== "string" || execPath.length === 0) return false;
  // Split on both separators so the check also recognizes Windows paths when
  // inspected from another platform in tests.
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") ?? "";
  return RUNTIME_NAMES.has(base);
}

function executableNames(name: string, platform: string): string[] {
  if (platform !== "win32") return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

function lookup(
  name: string,
  directories: readonly string[],
  platform: string,
  exists: (candidate: string) => boolean
): string | undefined {
  for (const directory of directories) {
    if (!directory) continue;
    for (const file of executableNames(name, platform)) {
      const candidate = path.join(directory, file);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Search the process PATH for an executable. */
export function findExecutable(name: string, probe: RuntimeProbe = {}): string | undefined {
  const env = probe.env ?? process.env;
  const platform = probe.platform ?? process.platform;
  const exists = probe.exists ?? existsSync;
  const separator = platform === "win32" ? ";" : ":";
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  const directories = String(rawPath)
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return lookup(name, directories, platform, exists);
}

/**
 * Install locations worth checking when PATH is minimal — as it is for GUI
 * apps on macOS, where Desktop's server may inherit only
 * `/usr/bin:/bin:/usr/sbin:/sbin`.
 */
export function knownInstallDirs(probe: RuntimeProbe = {}): string[] {
  const home = probe.home ?? os.homedir();
  const platform = probe.platform ?? process.platform;
  const readdir =
    probe.readdir ??
    ((directory: string): string[] => {
      try {
        return readdirSync(directory);
      } catch {
        return [];
      }
    });

  const dirs = [
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "bin"),
  ];

  if (platform === "win32") {
    dirs.push(path.join(home, "AppData", "Roaming", "npm"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  }

  // nvm keeps one directory per installed Node version.
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  for (const version of readdir(nvmRoot)) {
    dirs.push(path.join(nvmRoot, version, "bin"));
  }

  return dirs;
}

/** Find an executable on PATH, then in the well-known install locations. */
export function findRuntime(name: string, probe: RuntimeProbe = {}): string | undefined {
  const onPath = findExecutable(name, probe);
  if (onPath) return onPath;
  const platform = probe.platform ?? process.platform;
  const exists = probe.exists ?? existsSync;
  return lookup(name, knownInstallDirs(probe), platform, exists);
}

/**
 * Build the command OpenCode should spawn for the companion MCP server.
 * Returns `null` when no runtime and no `npx` can be found — the caller should
 * then skip auto-registration and tell the user how to configure it manually.
 */
export function resolveMcpLaunch(entry: string, probe: RuntimeProbe = {}): McpLaunch | null {
  const configured = typeof probe.runtime === "string" ? probe.runtime.trim() : "";
  if (configured) return { command: [configured, entry], source: "options.mcpRuntime" };

  // Prefer the host runtime when the plugin really runs on a JS runtime
  // (plain `node`/`bun` dev runs). Under Desktop this is the `opencode`
  // binary and is deliberately rejected.
  const execPath = probe.execPath ?? process.execPath;
  if (isJsRuntime(execPath)) {
    return { command: [execPath as string, entry], source: "process.execPath" };
  }

  for (const name of ["node", "bun"]) {
    const found = findRuntime(name, probe);
    if (found) return { command: [found, entry], source: `${name} (PATH or known install dir)` };
  }

  const npx = findRuntime("npx", probe);
  if (npx) return { command: [npx, "-y", MCP_PACKAGE], source: "npx fallback" };

  return null;
}

/**
 * Map the optional local task-list plugin options to MCP server environment
 * variables. Returns undefined when the mirror is disabled (the default).
 *
 * There is deliberately no path option: the location enum picks one of three
 * fixed directories, and the filename is always `tasklist-<session>.md`.
 */
function normalizeRelayMirrorLevel(value: unknown): 0 | 1 | 2 {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "log" || text === "all") return 1;
  if (text === "err" || text === "error" || text === "errors") return 2;
  const numeric = Number(text);
  return numeric === 1 || numeric === 2 ? numeric : 0;
}

export function taskListEnvironment(
  options: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  const raw = options ?? {};
  if (raw.taskListFile !== true) return undefined;
  return {
    PROGRESS_TASKLIST: "1",
    PROGRESS_TASKLIST_LOCATION: String(normalizeTaskListLocation(raw.taskListLocation)),
    PROGRESS_TASKLIST_MODE: normalizeTaskListView(raw.taskListView),
    PROGRESS_TASKLIST_DETAIL: normalizeTaskListDetail(raw.taskListDetail),
    PROGRESS_TASKLIST_ORDER:
      raw.taskListOrder === "oldest-first" ? "oldest-first" : "newest-first",
    PROGRESS_TASKLIST_RELAY_LEVEL: String(
      normalizeRelayMirrorLevel(raw.relayMirrorLevel)
    ),
  };
}
