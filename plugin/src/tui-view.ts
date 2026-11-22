/**
 * TUI tree layout: collapsed roots plus a hard row budget.
 *
 * The TUI renders inside the composer area, so an unbounded tree can push the
 * prompt off screen. Roots are always shown (one line each); descendants only
 * when that root is expanded, and the whole view is clipped to `maxRows` with
 * a "+N more" footer.
 */

import { countDescendants, flattenTreeWithDepth, progressLabel } from "./tree.js";
import type { TreeNode } from "./types.js";

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
  done: 1,
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
    rows: all.slice(0, maxRows),
    hidden: Math.max(0, all.length - maxRows),
    hiddenRoots,
  };
}
