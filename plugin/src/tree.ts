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

/**
 * Normalize title/detail text from the state file for display.
 *
 * The MCP server stores plain newlines, but older entries and hand-written
 * state files may still contain an escaped `\\n`, an extra-escaped `\\\\n`,
 * an escaped unicode newline, or HTML `<br>` tags. Accept every form and
 * return plain `\n` so the TUI and GUI render identical line breaks.
 */
export function normalizeProgressText(value: string | null | undefined): string {
  if (value == null) return "";
  let text = String(value);
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/\\u000[ad]/gi, "\n");
  text = text.replace(/\\r\\n|\\n|\\r/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Collapse normalized text to one line for compact host rows and status lines. */
export function oneLineText(value: string | null | undefined): string {
  return normalizeProgressText(value)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

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
    byKey.set(key, {
      ...entry,
      title: normalizeProgressText(entry.title),
      detail:
        entry.detail == null ? entry.detail : normalizeProgressText(entry.detail),
    });
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

    return { ...entry, key, children, status, progress, updatedAt, reportedAt: entry.updatedAt };
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

/**
 * Rows for a collapsible tree view: every root is always shown; a root's
 * descendants are included unless that root is in `collapsed`. Collapsing is
 * top-level only (descendants have no independent toggle), which keeps the
 * menu readable on long trees without a nested state model.
 */
export function visibleRows(
  roots: readonly TreeNode[],
  collapsed: Record<string, boolean>
): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = [];
  for (const root of roots) {
    out.push({ node: root, depth: 0 });
    if (!collapsed[root.key]) {
      out.push(...flattenTreeWithDepth(root.children, 1));
    }
  }
  return out;
}

/** How many descendants (all depths) a node has. */
export function countDescendants(node: Pick<TreeNode, "children">): number {
  return (node.children ?? []).reduce(
    (total, child) => total + 1 + countDescendants(child),
    0
  );
}

/**
 * Collapse state for root rows: collapsed by default, expanded when the
 * user toggled it (overrides) or when `expandByDefault` is configured.
 * Roots without children are omitted (nothing to collapse).
 */
export function collapsedRootMap(
  roots: readonly TreeNode[],
  expandByDefault: boolean,
  overrides: Record<string, boolean>
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const root of roots) {
    if (!root.children || root.children.length === 0) continue;
    map[root.key] = !(overrides[root.key] ?? expandByDefault);
  }
  return map;
}

/**
 * Headline counts for the pill: active (running/waiting), done, and dismissed.
 * Computed over the session-scoped entry set, before view filtering, so the
 * numbers describe the store rather than the current visibility.
 */
export function summarizeEntries(entries: Record<string, ProgressEntry>): {
  active: number;
  done: number;
  dismissed: number;
} {
  let active = 0;
  let done = 0;
  let dismissed = 0;
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status === "running" || entry.status === "waiting") active++;
    if (entry.status === "done") done++;
    if (entry.dismissed) dismissed++;
  }
  return { active, done, dismissed };
}

export function countActive(nodes: readonly TreeNode[]): number {
  return flattenTree(nodes).filter((node) => node.status === "running" || node.status === "waiting").length;
}

/**
 * Per-root dismissal snapshot for views that let users hide a task tree.
 *
 * Revival semantics, scoped to the dismissed task itself:
 * - A direct re-report of the task's own id (fresh milestone or lifecycle
 *   restart) always revives it: `reportedAt` moves past the snapshot.
 * - A non-terminal dismissal (running/waiting) also revives when the
 *   rolled-up status changes (waiting/done/error, or a new child flips it).
 * - A terminal dismissal (done/error) stays hidden through child activity —
 *   appended children flipping the parent's rolled-up status do NOT revive
 *   it — with one carve-out: a child failing (rolled-up status becomes
 *   "error") still revives a done-dismissed tree, because a failure must
 *   not silently scroll away. An error-dismissed tree revives only on a
 *   direct re-report.
 * - Sibling roots and unrelated updates never revive anything.
 */
export type Dismissal = { status: string; at: number };

export function isDismissed(root: TreeNode, map: Record<string, Dismissal>): boolean {
  const d = map[root.key];
  if (!d) return false;
  // The task itself was re-reported (new milestone or fresh lifecycle).
  if ((root.reportedAt ?? 0) > d.at) return false;
  const wasTerminal = d.status === "done" || d.status === "error";
  // Non-terminal: any rolled-up status change revives. Terminal: only a
  // failure appearing in the subtree revives a done-dismissed tree.
  if (!wasTerminal || root.status === "error") {
    if ((root.status ?? "") !== d.status) return false;
  }
  return true;
}

/** Snapshot every given root for "Dismiss all". */
export function dismissalsFor(
  roots: readonly TreeNode[],
  prev: Record<string, Dismissal>
): Record<string, Dismissal> {
  const next = { ...prev };
  for (const root of roots) {
    next[root.key] = { status: root.status ?? "", at: root.reportedAt ?? 0 };
  }
  return next;
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
  /**
   * Auto-hide completed tasks after `successHoldMs` (the old behavior).
   * Defaults to FALSE: a done entry the user never dismissed stays visible
   * until it is dismissed or pruned, including across plugin reloads.
   */
  autoHideDone?: boolean;
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
    // Default OFF: never-dismissed done entries stay visible.
    autoHideDone: options.autoHideDone === true,
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
 * enough — ONLY when `autoHideDone` is enabled (default off). By default a
 * done entry the user never dismissed stays visible until dismissed or pruned
 * (including across plugin reloads); `showDone: false` hides all completed
 * entries regardless.
 */
export function visibleEntries(
  entries: Record<string, ProgressEntry>,
  now: number,
  options: VisibilityOptions = {}
): Record<string, ProgressEntry> {
  const hold = options.successHoldMs ?? 8000;
  const showDone = options.showDone !== false;
  const autoHideDone = options.autoHideDone === true;
  const visible: Record<string, ProgressEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status === "done") {
      if (!showDone) continue;
      if (autoHideDone && now - (entry.updatedAt ?? 0) >= hold) continue;
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
