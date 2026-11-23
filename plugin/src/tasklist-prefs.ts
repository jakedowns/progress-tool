/**
 * Runtime preferences and status for the optional Markdown task-list mirror.
 *
 * The MCP server owns rendering and writes a status file next to the shared
 * state file. The plugin reads that status to decide whether the palette
 * command should be available, and writes the view preference that the MCP
 * server reads on its next render. Keeping both files next to the state file
 * means a custom PROGRESS_STATE_PATH keeps its mirror metadata together.
 */

import fs from "node:fs";
import path from "node:path";
import { stateFilePath } from "./state.js";

export type TaskListViewMode = "ui" | "raw";
export type TaskListDetailMode = "code" | "escaped" | "raw";
export type TaskListLocation = 0 | 1 | 2;
export type TaskListOrder = "newest-first" | "oldest-first";

export interface TaskListStatus {
  enabled: boolean;
  mode: TaskListViewMode;
  detail: TaskListDetailMode;
  location: TaskListLocation;
  order: TaskListOrder;
  file?: string;
  sessionID?: string;
  updatedAt?: number;
}

export interface TaskListPrefs {
  mode?: TaskListViewMode;
}

export function taskListPrefsPath(stateFile = stateFilePath()): string {
  return path.join(path.dirname(stateFile), ".opencode-progress-tasklist-prefs.json");
}

export function taskListStatusPath(stateFile = stateFilePath()): string {
  return path.join(path.dirname(stateFile), ".opencode-progress-tasklist-status.json");
}

export function normalizeTaskListView(raw: unknown): TaskListViewMode {
  return raw === "raw" ? "raw" : "ui";
}

export function normalizeTaskListDetail(raw: unknown): TaskListDetailMode {
  return raw === "raw" || raw === "escaped" ? raw : "code";
}

export function normalizeTaskListLocation(raw: unknown): TaskListLocation {
  const numeric = Number(raw);
  return numeric === 0 || numeric === 2 ? numeric : 1;
}

export function normalizeTaskListOrder(raw: unknown): TaskListOrder {
  return raw === "oldest-first" ? "oldest-first" : "newest-first";
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function readTaskListPrefs(stateFile = stateFilePath()): TaskListPrefs {
  const parsed = readJson(taskListPrefsPath(stateFile));
  if (!parsed || typeof parsed !== "object") return {};
  const mode = (parsed as { mode?: unknown }).mode;
  return mode === "ui" || mode === "raw" ? { mode } : {};
}

export function writeTaskListPrefs(
  prefs: TaskListPrefs,
  stateFile = stateFilePath()
): boolean {
  const file = taskListPrefsPath(stateFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function readTaskListStatus(
  stateFile = stateFilePath()
): TaskListStatus | null {
  const parsed = readJson(taskListStatusPath(stateFile));
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    mode: normalizeTaskListView(raw.mode),
    detail: normalizeTaskListDetail(raw.detail),
    location: normalizeTaskListLocation(raw.location),
    order: normalizeTaskListOrder(raw.order),
    file: typeof raw.file === "string" ? raw.file : undefined,
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID : undefined,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
  };
}

/**
 * Flip the mirror between the UI view and the raw store view. The MCP server
 * applies it on the next render; no existing entries are rewritten.
 */
export function toggleTaskListMode(
  fallback: TaskListViewMode = "ui",
  stateFile = stateFilePath()
): TaskListViewMode {
  const prefs = readTaskListPrefs(stateFile);
  const status = readTaskListStatus(stateFile);
  const current = prefs.mode ?? status?.mode ?? fallback;
  const next: TaskListViewMode = current === "raw" ? "ui" : "raw";
  writeTaskListPrefs({ ...prefs, mode: next }, stateFile);
  return next;
}
