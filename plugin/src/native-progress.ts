/**
 * Minimal native progress writer for the plugin tool.
 *
 * The MCP server owns the canonical writer, but a plugin-native `progress`
 * tool cannot rely on the companion package being resolvable from the host's
 * plugin cache. This mirrors the fields the UI needs (status/title/detail/
 * progress/parent/timestamps) and uses the same atomic temp+rename under the
 * shared lock, so relay and MCP writers never see a partial document.
 */

import fs from "node:fs";
import path from "node:path";
import { stateFilePath, readProgressState } from "./state.js";
import { normalizeProgressText } from "./tree.js";
import type { ProgressStatus } from "./types.js";

export interface NativeProgressInput {
  id: string;
  status: ProgressStatus;
  title: string;
  detail?: string | null;
  progress?: number | null;
  parentId?: string | null;
  sessionId?: string;
  subagent?: boolean;
  subagentAgent?: string | null;
  subagentName?: string | null;
}

const STATUSES: readonly ProgressStatus[] = [
  "pending",
  "running",
  "waiting",
  "done",
  "error",
];

function storageKey(id: string, sessionId?: string): string {
  return sessionId ? `${sessionId}:${id}` : id;
}

function acquireLock(lock: string): boolean {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.unlinkSync(lock);
      } catch {
        // Lock vanished; retry.
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        // Restricted context; retry immediately.
      }
    }
  }
  return false;
}

export function upsertNativeProgress(inputs: readonly NativeProgressInput[]): number {
  if (inputs.length === 0) return 0;
  const file = stateFilePath();
  const lock = `${file}.lock`;
  if (!acquireLock(lock)) throw new Error("progress store is locked");
  try {
    const state = readProgressState();
    const now = Date.now();
    for (const input of inputs) {
      if (!input?.id) throw new Error("progress id is required");
      if (!STATUSES.includes(input.status)) {
        throw new Error(`invalid progress status: ${String(input.status)}`);
      }
      const key = storageKey(input.id, input.sessionId);
      const prev = state.entries[key];
      const status = input.status;
      const terminalRestart =
        (prev?.status === "done" || prev?.status === "error") &&
        (status === "running" || status === "waiting" || status === "pending");
      const progress =
        input.progress !== undefined && input.progress !== null
          ? Math.max(0, Math.min(1, input.progress))
          : status === "done"
            ? 1
            : terminalRestart
              ? null
              : prev?.progress ?? null;
      const detail =
        input.detail !== undefined
          ? normalizeProgressText(input.detail)
          : terminalRestart
            ? null
            : normalizeProgressText(prev?.detail ?? null);
      const entry = {
        ...(prev ?? {}),
        id: input.id,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        status,
        title: normalizeProgressText(input.title ?? prev?.title ?? input.id),
        detail,
        progress,
        parentId:
          input.parentId !== undefined ? input.parentId : prev?.parentId ?? null,
        startedAt: terminalRestart ? now : prev?.startedAt ?? prev?.createdAt ?? now,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        statusUpdatedAt: now,
        ...(input.subagent || prev?.subagent ? { subagent: true } : {}),
        ...(input.subagentAgent
          ? { subagentAgent: input.subagentAgent }
          : prev?.subagentAgent
            ? { subagentAgent: prev.subagentAgent }
            : {}),
        ...(input.subagentName
          ? { subagentName: input.subagentName }
          : prev?.subagentName
            ? { subagentName: prev.subagentName }
            : {}),
      };
      // Agent writes revive soft-cleared/dismissed entries.
      delete (entry as { cleared?: unknown }).cleared;
      delete (entry as { dismissed?: unknown }).dismissed;
      state.entries[key] = entry;
    }
    state.version = state.version ?? 2;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return inputs.length;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}
