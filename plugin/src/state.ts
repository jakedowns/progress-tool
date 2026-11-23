/**
 * Reads the progress state file written by the progress MCP server and relay.
 *
 * The path must match `mcp-server/state-store.js` so the TUI and server parts
 * see the same entries as the `progress` tool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProgressEntry, ProgressState, SayNote, SayNoteKind } from "./types.js";

export function stateFilePath(): string {
  return (
    process.env.PROGRESS_STATE_PATH ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".opencode-progress-state.json")
  );
}

const stateSafetyCache = new Map<string, { mtimeMs: number; size: number }>();

/**
 * Refuse to write over a file that is not a progress state document.
 *
 * The MCP server has the same guard. This one covers the plugin's direct
 * writes (dismissals and child adoption), which bypass the MCP server's
 * mutateState(). A project-level PROGRESS_STATE_PATH must not be able to
 * clobber ~/.bashrc or package.json.
 */
function assertWritableStateFile(file: string): void {
  if (path.extname(file).toLowerCase() !== ".json") {
    throw new Error(`Refusing to write progress state to ${file}: expected a .json file`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // Missing: the first write is allowed.
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write progress state to ${file}: not a regular file`);
  }
  if (stat.size === 0) return;
  const hit = stateSafetyCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `Refusing to overwrite ${file}: not valid JSON (PROGRESS_STATE_PATH must point at a progress state file)`
    );
  }
  const entries =
    parsed && typeof parsed === "object" && "entries" in parsed
      ? (parsed as { entries?: unknown }).entries
      : undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`Refusing to overwrite ${file}: missing a progress "entries" object`);
  }
  stateSafetyCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
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
    assertWritableStateFile(file);
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
    assertWritableStateFile(file);
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

/**
 * Locked read-modify-write for the shared progress state.
 *
 * Same contract as the MCP state-store: a sibling lock serializes writers and
 * the document lands with a temp-file + rename, so a relay tick never sees a
 * half-written store. Returns undefined when the lock cannot be acquired; the
 * caller reports "nothing changed".
 */
function mutateStateFile<T>(
  mutator: (state: ProgressState) => { value: T; write: boolean }
): T | undefined {
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
  if (!locked) return undefined;

  try {
    const state = readProgressState();
    const { value, write } = mutator(state);
    if (!write) return value;
    state.version = state.version ?? 2;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return value;
  } catch (error) {
    console.error("[opencode-progress] state write failed", String(error));
    return undefined;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}

export const SAY_NOTES_PER_SESSION = 20;
const SAY_NOTE_KINDS: readonly SayNoteKind[] = ["intent", "update", "blocked", "question"];

/** Append one note to its author session's ring buffer (newest first). */
export function recordSayNote(input: {
  sessionID: string;
  text: string;
  kind?: SayNoteKind;
  eta?: string | null;
  agent?: string | null;
  at?: number;
  limit?: number;
}): SayNote | undefined {
  const sessionID = String(input.sessionID ?? "");
  const text = String(input.text ?? "").trim();
  if (!sessionID || !text) return undefined;
  const at = typeof input.at === "number" ? input.at : Date.now();
  const limit = Math.max(
    1,
    Math.min(100, Math.floor(input.limit ?? SAY_NOTES_PER_SESSION))
  );
  const kind = SAY_NOTE_KINDS.includes(input.kind as SayNoteKind)
    ? (input.kind as SayNoteKind)
    : "intent";
  const note: SayNote = {
    id: `${sessionID}:${at.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    sessionId: sessionID,
    text,
    kind,
    eta: input.eta ?? null,
    agent: input.agent ?? null,
    at,
  };
  return mutateStateFile((state) => {
    const notes = (state.notes ??= {});
    notes[sessionID] = [note, ...(notes[sessionID] ?? [])].slice(0, limit);
    return { value: note, write: true };
  });
}

/** Follow child→parent links to the root session (cycle-safe). */
export function rootSessionFor(
  sessionID: string,
  links: Record<string, SessionLink> = readSessionMap()
): string {
  let current = sessionID;
  const seen = new Set<string>();
  while (current && !seen.has(current) && seen.size < 32) {
    seen.add(current);
    const parent = links[current]?.parentId;
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * Notes for one session, newest first. Child-session notes roll up to their
 * root; `scope: "all"` (without a session) returns every note in the store.
 */
export function sayNotesForSession(
  state: ProgressState,
  sessionID?: string,
  options: {
    scope?: "session" | "all";
    limit?: number;
    links?: Record<string, SessionLink>;
  } = {}
): SayNote[] {
  const limit = Math.max(
    1,
    Math.min(200, Math.floor(options.limit ?? SAY_NOTES_PER_SESSION))
  );
  const all: SayNote[] = [];
  for (const list of Object.values(state.notes ?? {})) {
    if (Array.isArray(list)) all.push(...list);
  }
  all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (options.scope === "all" || !sessionID) return all.slice(0, limit);
  const links = options.links ?? readSessionMap();
  const root = rootSessionFor(sessionID, links);
  return all
    .filter((note) => rootSessionFor(note.sessionId, links) === root)
    .slice(0, limit);
}

function belongsToSession(key: string, entry: ProgressEntry, sessionID: string): boolean {
  return entry.sessionId === sessionID || key.startsWith(`${sessionID}:`);
}

function stateBytes(state: ProgressState): number {
  return Buffer.byteLength(JSON.stringify(state));
}

/**
 * Soft-clear the current session's finished and dismissed entries.
 *
 * Sets `cleared` on done/error entries and on anything the user already
 * dismissed. Running/waiting entries that are still visible are left alone.
 * Records stay on disk; views and counts ignore them. Any agent update
 * revives a cleared entry (handled by the MCP store's applyUpsert).
 */
export function softClearSession(sessionID: string): { cleared: number } {
  if (!sessionID) return { cleared: 0 };
  const at = Date.now();
  let cleared = 0;
  const result = mutateStateFile((state) => {
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (!belongsToSession(key, entry, sessionID)) continue;
      if (entry.cleared) continue;
      const finished = entry.status === "done" || entry.status === "error";
      if (!finished && !entry.dismissed) continue;
      // Clear supersedes dismissal: after an agent update revives the entry,
      // the old dismissal must not hide it again.
      delete entry.dismissed;
      entry.cleared = { at, status: entry.status };
      cleared++;
    }
    return { value: { cleared }, write: cleared > 0 };
  });
  if (result?.cleared) {
    console.log(`[opencode-progress] soft-cleared ${cleared} entries session=${sessionID}`);
  }
  return result ?? { cleared: 0 };
}

/** Permanently delete every entry for one session. The tasklist mirror is untouched. */
export function hardDeleteSession(sessionID: string): { removed: number; freedBytes: number } {
  if (!sessionID) return { removed: 0, freedBytes: 0 };
  let removed = 0;
  const result = mutateStateFile((state) => {
    const before = stateBytes(state);
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (!belongsToSession(key, entry, sessionID)) continue;
      delete state.entries[key];
      removed++;
    }
    let notesRemoved = 0;
    if (state.notes && state.notes[sessionID]) {
      notesRemoved = Array.isArray(state.notes[sessionID])
        ? state.notes[sessionID].length
        : 1;
      delete state.notes[sessionID];
    }
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state)) },
      write: removed > 0 || notesRemoved > 0,
    };
  });
  if (result) {
    removeSessionLinks(sessionID);
    if (result.removed > 0) {
      console.log(
        `[opencode-progress] hard-deleted ${removed} entries session=${sessionID} freed=${result.freedBytes}B`
      );
    }
  }
  return result ?? { removed: 0, freedBytes: 0 };
}

/** Permanently wipe every progress entry. The tasklist mirrors are untouched. */
export function hardDeleteAll(): { removed: number; freedBytes: number } {
  let removed = 0;
  const result = mutateStateFile((state) => {
    const before = stateBytes(state);
    removed = Object.keys(state.entries).length;
    state.entries = {};
    const notesRemoved = Object.values(state.notes ?? {}).reduce(
      (total, list) => total + (Array.isArray(list) ? list.length : 0),
      0
    );
    state.notes = {};
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state)) },
      write: removed > 0 || notesRemoved > 0,
    };
  });
  if (result) {
    removeSessionLinks();
    if (result.removed > 0) {
      console.log(`[opencode-progress] hard-cleared store: ${removed} entries freed=${result.freedBytes}B`);
    }
  }
  return result ?? { removed: 0, freedBytes: 0 };
}

/**
 * Drop child→parent links for a deleted session, or every link when no id is
 * given. The map is small, but stale rows are still noise after a purge.
 */
export function removeSessionLinks(sessionID?: string): number {
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
  if (!locked) return 0;

  try {
    const map = readSessionMap();
    let removed = 0;
    for (const [child, link] of Object.entries(map)) {
      if (sessionID === undefined || child === sessionID || link.parentId === sessionID) {
        delete map[child];
        removed++;
      }
    }
    if (removed === 0) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ links: map }, null, 2));
    fs.renameSync(tmp, file);
    console.log(
      `[opencode-progress] removed ${removed} session link${removed === 1 ? "" : "s"}${
        sessionID ? ` for ${sessionID}` : ""
      }`
    );
    return removed;
  } catch (error) {
    console.error("[opencode-progress] session link cleanup failed", String(error));
    return 0;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}
