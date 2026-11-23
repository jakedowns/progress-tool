/**
 * TUI tree layout: collapsed roots plus a hard row budget.
 *
 * The TUI renders inside the composer area, so an unbounded tree can push the
 * prompt off screen. Roots are always shown (one line each); descendants only
 * when that root is expanded, and the whole view is clipped to `maxRows` with
 * a "+N more" footer.
 */

import { countDescendants, flattenTreeWithDepth, oneLineText, progressLabel } from "./tree.js";
import type { SayNote, TreeNode } from "./types.js";

export interface TuiRow {
  node: TreeNode;
  depth: number;
  /** Root with hidden descendants. */
  collapsed: boolean;
  /** Descendants hidden behind the collapsed root (0 when expanded). */
  hiddenChildren: number;
}

export interface TuiViewOptions {
  /** Rows to render, including roots, details are counted by the view. */
  maxRows?: number;
  /** Root rows to render; extra roots are omitted and counted in hiddenRoots. Defaults to no cap. */
  maxRoots?: number;
  /** Clip rows to maxRows (default). Set false when the caller provides its own scroll viewport. */
  clipRows?: boolean;
  /** Root keys the user expanded. */
  expanded?: ReadonlySet<string>;
  /** Expand every root by default (matches the desktop option). */
  expandByDefault?: boolean;
}

export interface TuiView {
  rows: TuiRow[];
  /** Rows that did not fit the budget. */
  hidden: number;
  /** Roots omitted by the root cap. */
  hiddenRoots: number;
}

const STATUS_URGENCY: Record<string, number> = {
  error: 4,
  running: 3,
  waiting: 2,
  pending: 1,
  done: 0,
};

/** Error-first ordering for the click-to-expand summary line. */
export function sortRootsByUrgency(roots: readonly TreeNode[]): TreeNode[] {
  return roots
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        (STATUS_URGENCY[b.node.status] ?? 0) - (STATUS_URGENCY[a.node.status] ?? 0) ||
        a.index - b.index
    )
    .map(({ node }) => node);
}

/**
 * Full, untruncated detail for a root row (click target).
 * Blank line separates metadata from the description.
 */
export function rootDetailLines(root: TreeNode): string[] {
  const lines = [`status: ${root.status ?? "unknown"}`];
  const pct = progressLabel(root.progress);
  if (pct) lines.push(`progress: ${pct}`);
  const descendants = countDescendants(root);
  if (descendants > 0) lines.push(`descendants: ${descendants}`);
  lines.push("", root.detail?.trim() ? root.detail.trim() : "(no detail)");
  return lines;
}

const ROOT_SUMMARY_ORDER = ["waiting", "running", "error", "pending", "done", "dismissed"] as const;

/**
 * One-line status summary for the collapsed TUI view, e.g.
 * `waiting (1) | running (3) | error (2) | pending (2) | done (5) | dismissed (34)`.
 * Dismissed roots are counted separately and excluded from status buckets.
 * Zero buckets are omitted; returns "" when there is nothing to show.
 */
export function summarizeRoots(
  roots: readonly TreeNode[],
  isDismissedRoot: (root: TreeNode) => boolean
): string {
  const counts: Record<(typeof ROOT_SUMMARY_ORDER)[number], number> = {
    waiting: 0,
    running: 0,
    error: 0,
    pending: 0,
    done: 0,
    dismissed: 0,
  };
  for (const root of roots) {
    if (isDismissedRoot(root)) {
      counts.dismissed += 1;
    } else if (root.status && root.status in counts) {
      counts[root.status as keyof typeof counts] += 1;
    }
  }
  return ROOT_SUMMARY_ORDER.filter((key) => counts[key] > 0)
    .map((key) => `${key} (${counts[key]})`)
    .join(" | ");
}

export function buildTuiView(
  roots: readonly TreeNode[],
  options: TuiViewOptions = {}
): TuiView {
  const maxRows = Math.max(1, Math.min(50, Math.floor(options.maxRows ?? 8)));
  const maxRoots = Math.max(1, Math.floor(options.maxRoots ?? Infinity));
  const expanded = options.expanded;
  const all: TuiRow[] = [];
  const sorted = sortRootsByUrgency(roots);
  const visibleRoots = maxRoots === Infinity ? sorted : sorted.slice(0, maxRoots);
  const hiddenRoots = sorted.length - visibleRoots.length;

  for (const root of visibleRoots) {
    const hasChildren = (root.children?.length ?? 0) > 0;
    const isExpanded =
      hasChildren && (expanded ? expanded.has(root.key) : options.expandByDefault === true);
    all.push({
      node: root,
      depth: 0,
      collapsed: hasChildren && !isExpanded,
      hiddenChildren: hasChildren && !isExpanded ? countDescendants(root) : 0,
    });
    if (isExpanded) {
      for (const { node, depth } of flattenTreeWithDepth(root.children, 1)) {
        all.push({ node, depth, collapsed: false, hiddenChildren: 0 });
      }
    }
  }

  return {
    rows: options.clipRows === false ? all : all.slice(0, maxRows),
    hidden: options.clipRows === false ? 0 : Math.max(0, all.length - maxRows),
    hiddenRoots,
  };
}

/** Clamp the configurable root cap to a sane range; invalid values fall back to 3. */
export function normalizeMaxRoots(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 3;
  return Math.max(1, Math.min(50, numeric));
}

/** Sidebar viewport height in terminal rows; 0 (default) renders everything and lets the sidebar scroll. */
export function normalizeSidebarRows(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(100, numeric));
}

export type TuiLayout = "composer" | "sidebar";

/** Normalize the configured placement; anything but `sidebar` means the composer. */
export function normalizeTuiLayout(value: unknown): TuiLayout {
  return value === "sidebar" ? "sidebar" : "composer";
}

/** Flip between the two placements. */
export function nextTuiLayout(current: TuiLayout): TuiLayout {
  return current === "sidebar" ? "composer" : "sidebar";
}


/** "…" cap for the one-line notes summary above the tree. */
export const NOTES_LINE_MAX_CHARS = 72;

/** Who wrote a note, when the viewer is looking at the root tree. */
export function noteAuthorPrefix(
  note: Pick<SayNote, "sessionId" | "agent">,
  viewerSessionID?: string
): string {
  if (!viewerSessionID || note.sessionId === viewerSessionID) return "";
  return note.agent ? `[Subagent (${note.agent})] ` : "[Subagent] ";
}

function truncateNote(text: string, maxChars: number): string {
  const oneLine = oneLineText(text);
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Newest non-empty note, or undefined when the roll-up is empty. */
export function latestSayNote(
  notes: readonly SayNote[] | undefined
): SayNote | undefined {
  const list = (notes ?? []).filter((note) => note && oneLineText(note.text));
  if (list.length === 0) return undefined;
  return list.reduce((newest, note) =>
    (note.at ?? 0) > (newest.at ?? 0) ? note : newest
  );
}

/**
 * The dim line above the TUI tree: newest note, its author when it came from
 * a child session, and a count when there is more history in `/progress`.
 */
export function buildNotesLine(
  notes: readonly SayNote[] | undefined,
  viewerSessionID?: string,
  options: { maxChars?: number } = {}
): string {
  const list = (notes ?? []).filter((note) => note && oneLineText(note.text));
  const latest = latestSayNote(list);
  if (!latest) return "";
  const maxChars = Math.max(
    20,
    Math.min(200, Math.floor(options.maxChars ?? NOTES_LINE_MAX_CHARS))
  );
  const count = list.length > 1 ? ` (${list.length} notes)` : "";
  return `notes: ${noteAuthorPrefix(latest, viewerSessionID)}${truncateNote(
    latest.text,
    maxChars
  )}${count}`;
}

/** Warning tone for notes that need the user's attention. */
export function sayNoteWarns(note: Pick<SayNote, "kind">): boolean {
  return note.kind === "blocked" || note.kind === "question";
}

/**
 * TUI toast copy for one note. Child notes keep their `[Subagent (X)]`
 * attribution so the roll-up never looks like the root agent spoke.
 */
export function buildNoteToast(
  note: SayNote,
  viewerSessionID?: string
): { message: string; warning: boolean } {
  const eta = note.eta ? ` · ETA ${note.eta}` : "";
  return {
    message: `${noteAuthorPrefix(note, viewerSessionID)}${oneLineText(note.text)}${eta}`,
    warning: sayNoteWarns(note),
  };
}

/** `/progress` → Notes: newest-first history with time, kind, and author. */
export function formatNotesDialog(
  notes: readonly SayNote[] | undefined,
  options: { viewerSessionID?: string; limit?: number } = {}
): string {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const list = [...(notes ?? [])]
    .filter((note) => note && oneLineText(note.text))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, limit);
  return list
    .map((note) => {
      const time = Number.isFinite(note.at)
        ? new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      const eta = note.eta ? ` · ETA ${note.eta}` : "";
      const prefix = noteAuthorPrefix(note, options.viewerSessionID);
      return `${time ? `[${time}] ` : ""}${note.kind}${eta}: ${prefix}${oneLineText(note.text)}`;
    })
    .join("\n");
}
