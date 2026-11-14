/**
 * Tree helpers shared by the TUI and GUI parts.
 *
 * Entries may carry a `parentId`, forming a dependency tree. Rendering rolls
 * children up under their parent and sorts the most severe status first.
 */

import type { ProgressEntry, ProgressState, TreeNode } from "./types.js";

const STATUS_ORDER: Record<string, number> = {
  error: 4,
  running: 3,
  waiting: 2,
  done: 1,
};

export function entriesOf(state: ProgressState | undefined | null): Record<string, ProgressEntry> {
  const entries = state?.entries;
  return entries && typeof entries === "object" ? entries : {};
}

/**
 * Build a dependency tree from the flat entry map.
 *
 * Parent links may use either the state map key (for example
 * `session-123:build`) or the entry's bare `id`. Both resolve.
 */
export function buildTree(entries: Record<string, ProgressEntry>): TreeNode[] {
  const byKey = new Map<string, ProgressEntry>();
  const keyById = new Map<string, string>();

  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    byKey.set(key, entry);
    if (entry.id && !keyById.has(entry.id)) keyById.set(entry.id, key);
  }

  const childrenByKey = new Map<string, string[]>();
  for (const key of byKey.keys()) childrenByKey.set(key, []);

  const roots: string[] = [];
  for (const [key, entry] of byKey) {
    const parentKey = entry.parentId
      ? byKey.has(entry.parentId)
        ? entry.parentId
        : keyById.get(entry.parentId)
      : undefined;

    if (parentKey && parentKey !== key) {
      childrenByKey.get(parentKey)?.push(key);
    } else {
      roots.push(key);
    }
  }

  const compare = (a: string, b: string) => {
    const ea = byKey.get(a);
    const eb = byKey.get(b);
    const severity = (STATUS_ORDER[eb?.status ?? ""] ?? 0) - (STATUS_ORDER[ea?.status ?? ""] ?? 0);
    if (severity !== 0) return severity;
    return (eb?.updatedAt ?? 0) - (ea?.updatedAt ?? 0);
  };

  for (const children of childrenByKey.values()) children.sort(compare);
  roots.sort(compare);

  const seen = new Set<string>();
  const node = (key: string): TreeNode => {
    const entry = byKey.get(key)!;
    // Guard against cycles in hand-written state files.
    seen.add(key);
    const children = (childrenByKey.get(key) ?? [])
      .filter((child) => !seen.has(child))
      .map(node);

    // Roll up parent status/progress from children (bootvine-inspired).
    let status = entry.status;
    let progress = entry.progress;
    let updatedAt = entry.updatedAt;

    if (children.length > 0) {
      const statuses = children.map((child) => child.status);
      if (statuses.includes("error")) status = "error";
      else if (statuses.includes("running")) status = "running";
      else if (statuses.includes("waiting")) status = "waiting";
      else if (statuses.every((child) => child === "done")) status = "done";

      const childProgresses = children
        .map((child) => child.progress)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (progress == null && childProgresses.length > 0) {
        progress = childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length;
      }

      const latestChild = children.reduce((latest, child) => Math.max(latest, child.updatedAt ?? 0), 0);
      if (latestChild > (updatedAt ?? 0)) updatedAt = latestChild;
    }

    return { ...entry, key, children, status, progress, updatedAt };
  };

  return roots.map(node);
}

/** Depth-first flatten, parents before children. */
export function flattenTree(nodes: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** Depth-first flatten with each node's depth, for indented menus. */
export function flattenTreeWithDepth(
  nodes: readonly TreeNode[],
  depth = 0
): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flattenTreeWithDepth(node.children, depth + 1));
  }
  return out;
}

export function countActive(nodes: readonly TreeNode[]): number {
  return flattenTree(nodes).filter((node) => node.status === "running" || node.status === "waiting").length;
}

export type BarStyle = "blocks" | "emoji";

export interface BarOptions {
  /** `blocks` (default) or `emoji` for the meme-style bar. */
  style?: BarStyle;
  /** Segments in the bar. Defaults to 10 for blocks and 6 for emoji. */
  segments?: number;
  /** Denominator shown in the fraction, e.g. 420. Defaults to 100. */
  total?: number;
}

export interface VisibilityOptions {
  /** How long a completed task stays visible before the view hides it. Defaults to 8000ms. */
  successHoldMs?: number;
  /** Show completed tasks at all. Defaults to true. */
  showDone?: boolean;
  /** Show only the current session's tasks (default) or every session. */
  scope?: "session" | "all";
}

export interface BarParts {
  bar: string;
  done: number;
  total: number;
  fraction: string;
  style: BarStyle;
}

function clampProgress(progress: number | null | undefined): number {
  return progress == null ? 0 : Math.max(0, Math.min(1, progress));
}

/** Copy host plugin options into a plain object; the host's proxy may not outlive setup. */
export function normalizeBarOptions(raw: unknown): BarOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  return {
    style: options.barStyle === "emoji" ? "emoji" : "blocks",
    segments:
      typeof options.barSegments === "number" && options.barSegments > 0
        ? options.barSegments
        : undefined,
    total:
      typeof options.barTotal === "number" && options.barTotal > 0
        ? options.barTotal
        : undefined,
  };
}

/**
 * Resolve the view refresh interval (ms) from plugin options.
 * Defaults to 1000ms; floored at 100ms so a typo cannot hot-loop the poller.
 */
export function normalizeRefreshMs(raw: unknown, fallback = 1000): number {
  const options = (raw ?? {}) as Record<string, unknown>;
  const value = options.refreshMs ?? options.intervalMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 100) return value;
  return fallback;
}

/** Copy visibility options into a plain object. */
export function normalizeVisibilityOptions(raw: unknown): VisibilityOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  return {
    successHoldMs:
      typeof options.successHoldMs === "number" && options.successHoldMs >= 0
        ? options.successHoldMs
        : undefined,
    showDone: options.showDone !== false,
    scope: options.scope === "all" ? "all" : "session",
  };
}

/**
 * Keep entries belonging to one session. Entries without a session are hidden
 * by default, so a global/legacy report cannot leak into every chat.
 */
export function scopeEntries(
  entries: Record<string, ProgressEntry>,
  sessionID: string | undefined,
  options: VisibilityOptions = {}
): Record<string, ProgressEntry> {
  if (options.scope === "all") return entries;
  if (!sessionID) return {};
  const prefix = `${sessionID}:`;
  const scoped: Record<string, ProgressEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.sessionId === sessionID || key.startsWith(prefix)) scoped[key] = entry;
  }
  return scoped;
}

/**
 * Drop completed entries once their success confirmation has been visible long
 * enough. Running, waiting, and error entries always stay until dismissed or
 * updated.
 */
export function visibleEntries(
  entries: Record<string, ProgressEntry>,
  now: number,
  options: VisibilityOptions = {}
): Record<string, ProgressEntry> {
  const hold = options.successHoldMs ?? 8000;
  const showDone = options.showDone !== false;
  const visible: Record<string, ProgressEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status === "done") {
      if (!showDone) continue;
      if (now - (entry.updatedAt ?? 0) >= hold) continue;
    }
    visible[key] = entry;
  }
  return visible;
}

/**
 * Build a progress bar in either the ASCII block style or the emoji style:
 *
 *   blocks: [██████░░░░] 60%
 *   emoji:  🟩⬛️⬛️⬛️⬛️⬛️(69/420)
 */
export function barParts(progress: number | null | undefined, options: BarOptions = {}): BarParts {
  const style: BarStyle = options.style === "emoji" ? "emoji" : "blocks";
  const segments = options.segments ?? (style === "emoji" ? 6 : 10);
  const total = options.total ?? 100;
  const value = clampProgress(progress);
  const filled = Math.round(value * segments);
  const bar =
    style === "emoji"
      ? "🟩".repeat(filled) + "⬛️".repeat(Math.max(0, segments - filled))
      : "█".repeat(filled) + "░".repeat(Math.max(0, segments - filled));
  const done = Math.round(value * total);
  return { bar, done, total, fraction: `(${done}/${total})`, style };
}

export function renderBar(progress: number | null | undefined, width = 10): string {
  return barParts(progress, { segments: width }).bar;
}

export function progressLabel(progress: number | null | undefined): string | null {
  return progress == null ? null : `${Math.round(progress * 100)}%`;
}
