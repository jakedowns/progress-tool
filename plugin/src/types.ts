/**
 * Shared types for the progress plugin parts.
 *
 * Kept dependency-free so the GUI bundle can import it without pulling in
 * Node built-ins.
 */

export type ProgressStatus = "pending" | "running" | "done" | "error" | "waiting";

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
  /**
   * View-plane metadata: a user dismissed this task, with the rolled-up
   * status at dismiss time. Written by the plugin (atomic + locked, spec
   * §4.3/§4.4), preserved by agent/relay upserts, cleared on lifecycle
   * restart. Revival semantics live in tree.ts `isDismissed`.
   */
  dismissed?: { status: string; at: number } | null;
  /**
   * View-plane tombstone: the user cleared the list while this entry was
   * finished or dismissed. The record stays on disk (and in reports), but
   * views hide it and counts ignore it. Any agent upsert removes the marker,
   * reviving the entry.
   */
  cleared?: { at: number; status?: string } | null;
  /**
   * Origin marker: this entry was created by the out-of-band relay rather
   * than by an agent progress call. The optional task-list mirror uses it to
   * hide successful command runs while keeping agent tasks and relay errors.
   */
  relay?: boolean;
  /** View-plane marker: created by a subagent session. */
  subagent?: boolean;
  /** Subagent type when known (`explore`, `general`, …). */
  subagentAgent?: string | null;
}

export interface ProgressState {
  entries: Record<string, ProgressEntry>;
  version?: number;
}

export interface TreeNode extends ProgressEntry {
  /** Stable key from the state file map (may be session-scoped). */
  key: string;
  children: TreeNode[];
  /**
   * The entry's own stored `updatedAt`, before buildTree projects the latest
   * child update onto `updatedAt`. Dismissal logic uses this to tell "the
   * agent re-reported this task" apart from "a child ticked / a sibling moved".
   */
  reportedAt?: number;
}
