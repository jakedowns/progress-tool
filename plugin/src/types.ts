/**
 * Shared types for the progress plugin parts.
 *
 * Kept dependency-free so the GUI bundle can import it without pulling in
 * Node built-ins.
 */

export type ProgressStatus = "running" | "done" | "error" | "waiting";

export interface ProgressEntry {
  id: string;
  sessionId?: string;
  status: ProgressStatus;
  /** Task label; may contain `\n` line breaks. */
  title: string;
  /** Optional detail; may contain `\n` line breaks. */
  detail?: string | null;
  /** 0..1 fraction, or null when unknown. */
  progress?: number | null;
  parentId?: string | null;
  startedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProgressState {
  entries: Record<string, ProgressEntry>;
  version?: number;
}

export interface TreeNode extends ProgressEntry {
  /** Stable key from the state file map (may be session-scoped). */
  key: string;
  children: TreeNode[];
}
