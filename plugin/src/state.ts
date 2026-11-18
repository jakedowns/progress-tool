/**
 * Reads the progress state file written by the progress MCP server and relay.
 *
 * The path must match `mcp-server/state-store.js` so the TUI and server parts
 * see the same entries as the `progress` tool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProgressState } from "./types.js";

export function stateFilePath(): string {
  return (
    process.env.PROGRESS_STATE_PATH ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".opencode-progress-state.json")
  );
}

export function readProgressState(): ProgressState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      return parsed as ProgressState;
    }
  } catch {
    // Missing or mid-write state file: treat as empty until the next tick.
  }
  return { entries: {}, version: 2 };
}

/**
 * Persist a user dismissal into the shared state doc as view-plane metadata:
 *
 *   entry.dismissed = { status, at }
 *
 * The status snapshot drives the shared revival semantics (see tree.ts
 * `isDismissed`): terminal dismissals (done/error) only revive on a direct
 * re-report or a child failure; non-terminal ones also revive on any
 * rolled-up status change. Agent/relay upserts preserve the field (mcp-server
 * state-store §4.5 merge semantics) and lifecycle restarts clear it.
 *
 * Writes follow the same contract as the relay: atomic temp-file + rename
 * under a sibling lock file (spec §4.3/§4.4). A failed write is logged and
 * left to the next attempt — dismissal is never worth breaking the view over.
 */
export function writeDismissal(key: string, status: string): boolean {
  const file = stateFilePath();
  const lock = `${file}.lock`;

  // Acquire the sibling lock (open "wx", break a lock older than 15s).
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.unlinkSync(lock);
      } catch {
        // Lock vanished or stat failed; retry briefly.
      }
      try {
        // Brief synchronous pause; Node allows blocking Atomics.wait.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        // Restricted context: fall through to the next attempt immediately.
      }
    }
  }
  if (!locked) return false;

  try {
    const state = readProgressState();
    const entry = state.entries[key];
    if (!entry) return false;
    entry.dismissed = { status, at: Date.now() };
    state.version = state.version ?? 2;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error("[opencode-progress] dismissal write failed", String(error));
    return false;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}
