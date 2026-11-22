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
 * Child→parent session attribution.
 *
 * OpenCode runs subagents in their own child sessions, and a subagent's
 * progress calls carry the child session ID — so without help its entries
 * would land in a scope nobody watches. The idle hook knows each spawning
 * parent (`background[].childSessionID`); we record the link here and the MCP
 * server / relay resolve it before writing. The map lives next to the state
 * file so both halves of the tool agree on its location.
 */
export interface SessionLink {
  parentId: string;
  at: number;
  /** Subagent type from session.created (`explore`, `general`, …). */
  agent?: string;
}

/** Drop links older than this; session IDs are never reused, so stale rows are just noise. */
const SESSION_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionMapFilePath(): string {
  return (
    process.env.PROGRESS_SESSION_MAP_PATH ||
    path.join(path.dirname(stateFilePath()), ".opencode-progress-sessions.json")
  );
}

export function readSessionMap(): Record<string, SessionLink> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMapFilePath(), "utf8")) as unknown;
    const links =
      parsed && typeof parsed === "object" && "links" in parsed
        ? (parsed as { links?: unknown }).links
        : parsed;
    if (!links || typeof links !== "object") return {};
    const map: Record<string, SessionLink> = {};
    for (const [child, value] of Object.entries(links as Record<string, unknown>)) {
      if (typeof value === "string" && value) {
        map[child] = { parentId: value, at: 0 };
      } else if (
        value &&
        typeof value === "object" &&
        typeof (value as { parentId?: unknown }).parentId === "string"
      ) {
        const link = value as { parentId: string; at?: unknown; agent?: unknown };
        map[child] = {
          parentId: link.parentId,
          at: Number(link.at) || 0,
          agent: typeof link.agent === "string" && link.agent ? link.agent : undefined,
        };
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Record that `childID` is a subagent of `parentID`. Merge-write under a lock
 * so two parents finishing at once cannot drop each other's links.
 */
export function recordChildSession(
  childID: string,
  parentID: string,
  agent?: string
): boolean {
  if (!childID || !parentID || childID === parentID) return false;
  const file = sessionMapFilePath();
  const lock = `${file}.lock`;

  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
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
  if (!locked) return false;

  try {
    const map = readSessionMap();
    if (map[childID]?.parentId === parentID && (!agent || map[childID]?.agent === agent)) {
      return true;
    }
    map[childID] = {
      parentId: parentID,
      at: Date.now(),
      agent: agent || map[childID]?.agent,
    };
    const cutoff = Date.now() - SESSION_LINK_TTL_MS;
    for (const [child, link] of Object.entries(map)) {
      if (link.at && link.at < cutoff) delete map[child];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ links: map }, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error("[opencode-progress] session map write failed", String(error));
    return false;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}

/**
 * Re-key any entries a child session already wrote onto its parent.
 *
 * Called right after a child→parent link is recorded, so a subagent that
 * reported once before the plugin saw it (and may never report again) still
 * surfaces in the parent's pill. Mirrors the MCP server's adoption rules:
 * newer entry wins a collision, and a dismissal the newer copy lacks survives.
 */
export function adoptChildEntries(
  childID: string,
  parentID: string,
  agent?: string
): number {
  if (!childID || !parentID || childID === parentID) return 0;
  const file = stateFilePath();
  const lock = `${file}.lock`;

  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
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
  if (!locked) return 0;

  try {
    const state = readProgressState();
    const now = Date.now();
    let moved = 0;
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || typeof entry !== "object" || entry.sessionId !== childID) continue;
      entry.sessionId = parentID;
      if (entry.updatedAt === undefined) entry.updatedAt = now;
      if (entry.subagent === undefined) entry.subagent = true;
      if (agent && !entry.subagentAgent) entry.subagentAgent = agent;
      const targetKey = `${parentID}:${entry.id}`;
      const existing = state.entries[targetKey];
      if (existing && existing !== entry) {
        if ((entry.updatedAt || 0) >= (existing.updatedAt || 0)) {
          entry.dismissed = entry.dismissed ?? existing.dismissed;
          state.entries[targetKey] = entry;
        } else {
          existing.dismissed = existing.dismissed ?? entry.dismissed;
        }
      } else {
        state.entries[targetKey] = entry;
      }
      if (key !== targetKey) delete state.entries[key];
      moved++;
    }
    if (moved === 0) return 0;
    state.version = state.version ?? 2;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    console.log(
      `[opencode-progress] adopted ${moved} child entr${moved === 1 ? "y" : "ies"} ${childID} -> ${parentID}`
    );
    return moved;
  } catch (error) {
    console.error("[opencode-progress] child adoption failed", String(error));
    return 0;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
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
    console.log(`[opencode-progress] dismissal persisted key=${key} status=${status} at=${entry.dismissed.at}`);
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
