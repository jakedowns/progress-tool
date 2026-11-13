'use strict';

/**
 * Shared progress state store.
 *
 * This module is the single source of truth for reading and mutating
 * `~/.opencode-progress-state.json`. Both the MCP server and the
 * out-of-band relay CLI use it so concurrent writers never corrupt the
 * file or lose sibling updates.
 *
 * Guarantees:
 *   1. Writes are atomic (temp file + rename), so readers never see a
 *      half-written JSON document.
 *   2. Read-modify-write cycles are serialized with a small lock file,
 *      so a relay streaming stdout cannot clobber an MCP milestone update.
 *   3. The state shape is stable and harness-agnostic. Any process that
 *      honors this shape can participate; the CLI is just a reference.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_VERSION = 2;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;

function resolveStatePath(explicit) {
  return (
    explicit ||
    process.env.PROGRESS_STATE_PATH ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
      '.opencode-progress-state.json'
    )
  );
}

const DEFAULT_STATE_FILE = resolveStatePath();

/**
 * Resolve the session scope for an update.
 *
 * Priority: explicit input/flag -> PROGRESS_SESSION_ID -> OPENCODE_SESSION_ID
 * -> null. Returning null preserves the original flat, single-session keying
 * so existing state files and callers remain fully backwards compatible.
 */
function resolveSessionId(explicit) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return String(explicit);
  }
  const fromEnv =
    process.env.PROGRESS_SESSION_ID || process.env.OPENCODE_SESSION_ID || null;
  return fromEnv && String(fromEnv).trim() !== '' ? String(fromEnv) : null;
}

/**
 * Internal storage key. Entries are keyed by `${sessionId}:${id}` when a
 * session is active, while the public `entry.id` stays clean (`build-1`).
 */
function storageKey(id, sessionId) {
  return sessionId ? `${sessionId}:${id}` : id;
}

function parentStorageKey(parentId, sessionId) {
  if (!parentId || !sessionId) return parentId;
  const prefix = `${sessionId}:`;
  return parentId.startsWith(prefix) ? parentId : prefix + parentId;
}

function emptyState() {
  return { entries: {}, version: STATE_VERSION };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const rawEntries =
    raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
      ? raw.entries
      : {};
  const entries = {};
  for (const [id, entry] of Object.entries(rawEntries)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
      const fallbackId =
        sessionId && id.startsWith(`${sessionId}:`)
          ? id.slice(sessionId.length + 1)
          : id;
      entries[id] = {
        ...entry,
        id: typeof entry.id === 'string' ? entry.id : fallbackId,
      };
    }
  }
  return {
    ...raw,
    entries,
    version: typeof raw.version === 'number' ? raw.version : STATE_VERSION,
  };
}

/**
 * Block synchronously for a few milliseconds. Used only while waiting on
 * the state lock; progress writes are tiny and infrequent.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback for runtimes without SharedArrayBuffer/Atomics.
    }
  }
}

function ensureStateFile(stateFile = DEFAULT_STATE_FILE) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  try {
    // "wx" is important: never overwrite another process's fresh state.
    fs.writeFileSync(stateFile, JSON.stringify(emptyState(), null, 2), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function readState(stateFile = DEFAULT_STATE_FILE) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

function atomicWrite(stateFile, state) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(stateFile)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      // fsync is a durability nicety, not part of correctness on all FSes.
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {}
    throw err;
  }
}

function lockPathFor(stateFile) {
  return stateFile + '.lock';
}

function acquireLock(stateFile) {
  const lockPath = lockPathFor(stateFile);
  const timeoutMs = Number(process.env.PROGRESS_LOCK_TIMEOUT_MS || LOCK_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {}
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (e) {}
          continue;
        }
      } catch (e) {
        continue;
      }

      if (Date.now() > deadline) {
        // Progress reporting must never wedge the caller. Break the lock
        // and continue best-effort rather than failing the command.
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {}
        return () => {};
      }

      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function prune(state, now) {
  const ttl = Number(process.env.PROGRESS_TTL_MS || DEFAULT_TTL_MS);
  for (const [id, entry] of Object.entries(state.entries)) {
    if (!entry || typeof entry !== 'object') {
      delete state.entries[id];
      continue;
    }
    if (
      (entry.status === 'done' || entry.status === 'error') &&
      now - (entry.updatedAt || 0) > ttl
    ) {
      delete state.entries[id];
    }
  }
}

/**
 * Serialized read-modify-write. The mutator receives the live state object
 * and may return any value, which is passed back to the caller.
 */
function mutateState(mutator, stateFile = DEFAULT_STATE_FILE) {
  ensureStateFile(stateFile);
  const release = acquireLock(stateFile);
  try {
    const state = readState(stateFile);
    const result = mutator(state);
    prune(state, Date.now());
    atomicWrite(stateFile, state);
    return result;
  } finally {
    release();
  }
}

/**
 * Create or update one progress entry.
 *
 * Fields that are `undefined` are preserved from the existing entry. This
 * lets the relay attach to an entry the agent already created without
 * clobbering its title, parent, or status.
 */
function upsertProgress(input, stateFile = DEFAULT_STATE_FILE) {
  if (!input || !input.id) throw new Error('upsertProgress requires an id');

  const sessionId = resolveSessionId(input.sessionId);
  const key = storageKey(input.id, sessionId);

  return mutateState((state) => {
    const now = Date.now();
    const prev = state.entries[key] || null;
    const status = input.status !== undefined ? input.status : prev?.status || 'running';

    const wasTerminal = prev?.status === 'done' || prev?.status === 'error';
    const isRestart = wasTerminal && (status === 'running' || status === 'waiting');

    const entry = {
      ...(prev || {}),
      id: input.id,
      ...(sessionId ? { sessionId } : {}),
      status,
      title: input.title !== undefined ? input.title : prev?.title || input.id,
      detail:
        input.detail !== undefined
          ? input.detail
          : isRestart
          ? null
          : prev?.detail ?? null,
      progress:
        input.progress !== undefined
          ? input.progress
          : isRestart
          ? null
          : prev?.progress ?? null,
      parentId: input.parentId !== undefined ? input.parentId : prev?.parentId ?? null,
      startedAt: isRestart ? now : prev?.startedAt || prev?.createdAt || now,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };

    state.entries[key] = entry;
    return entry;
  }, stateFile);
}

function clearProgress(id, stateFile = DEFAULT_STATE_FILE, sessionId) {
  const resolvedSessionId = resolveSessionId(sessionId);
  const key = storageKey(id, resolvedSessionId);
  return mutateState((state) => {
    delete state.entries[key];
    return null;
  }, stateFile);
}

function getAllProgress(stateFile = DEFAULT_STATE_FILE) {
  return readState(stateFile);
}

// --- Tree helpers (bootvine-inspired roll-up) ---

const STATUS_SEVERITY = {
  error: 4,
  running: 3,
  waiting: 2,
  done: 1,
};

function statusOrder(a, b) {
  return (STATUS_SEVERITY[b] || 0) - (STATUS_SEVERITY[a] || 0);
}

/**
 * Build a dependency tree from flat entries.
 * Returns roots (entries with no parentId or whose parent is missing)
 * and a map of id -> { children: [...] }.
 */
function buildTree(entries) {
  const byId = new Map(Object.entries(entries || {}));
  const childrenMap = new Map();

  for (const [id, entry] of [...byId]) {
    if (!entry || typeof entry !== 'object') byId.delete(id);
  }

  for (const [id] of byId) childrenMap.set(id, []);

  const roots = [];
  for (const [id, entry] of byId) {
    // `entry.parentId` stays clean for display, but sibling lookup happens in
    // the same session namespace so two sessions cannot cross-contaminate
    // parent roll-ups.
    const parentKey = parentStorageKey(entry.parentId, entry.sessionId);
    if (parentKey && byId.has(parentKey)) {
      childrenMap.get(parentKey).push(id);
    } else {
      roots.push(id);
    }
  }

  for (const [id, childIds] of childrenMap) {
    childIds.sort((a, b) => {
      const ea = byId.get(a);
      const eb = byId.get(b);
      const s = statusOrder(ea.status, eb.status);
      if (s !== 0) return s;
      return (eb.updatedAt || 0) - (ea.updatedAt || 0);
    });
  }

  roots.sort((a, b) => {
    const ea = byId.get(a);
    const eb = byId.get(b);
    const s = statusOrder(ea.status, eb.status);
    if (s !== 0) return s;
    return (eb.updatedAt || 0) - (ea.updatedAt || 0);
  });

  return { byId, childrenMap, roots };
}

/**
 * Recursively roll up a parent entry's status and progress from its children.
 * A parent with no explicit progress of its own derives it from children.
 */
function rollUp(id, entries, childrenMap, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  const entry = entries[id];
  if (!entry) return null;

  const childIds = childrenMap.get(id) || [];
  const result = { ...entry };

  if (childIds.length > 0) {
    const childResults = childIds.map((cid) => rollUp(cid, entries, childrenMap, cache));

    const childStatuses = childResults.map((r) => r.status);
    if (childStatuses.includes('error')) {
      result.status = 'error';
    } else if (childStatuses.includes('running')) {
      result.status = 'running';
    } else if (childStatuses.includes('waiting')) {
      result.status = 'waiting';
    } else if (childStatuses.every((s) => s === 'done')) {
      result.status = 'done';
    }

    const childProgresses = childResults.map((r) => r.progress).filter((p) => p != null);
    if (childProgresses.length > 0 && entry.progress == null) {
      result.progress =
        childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length;
    }

    const latestChild = childResults.reduce(
      (latest, r) => (r.updatedAt > latest.updatedAt ? r : latest),
      { updatedAt: 0 }
    );
    if (latestChild.updatedAt > (result.updatedAt || 0)) {
      result.updatedAt = latestChild.updatedAt;
    }

    result.children = childResults;
  }

  cache.set(id, result);
  return result;
}

function getTree(state) {
  const entries = state.entries || {};
  const { byId, childrenMap, roots } = buildTree(entries);
  const tree = roots.map((id) => rollUp(id, entries, childrenMap));
  return { tree, entries: byId, roots };
}

module.exports = {
  STATE_VERSION,
  DEFAULT_STATE_FILE,
  resolveStatePath,
  resolveSessionId,
  storageKey,
  ensureStateFile,
  readState,
  atomicWrite,
  mutateState,
  upsertProgress,
  clearProgress,
  getAllProgress,
  buildTree,
  rollUp,
  getTree,
};
