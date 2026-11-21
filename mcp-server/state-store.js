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

const STATE_VERSION = 3;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Running entries untouched for this long are orphans (§4.6). Opt-in only. */
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;

/**
 * Normalize optional title/detail text for every writer and reader.
 *
 * Agents express line breaks in several ways depending on how a harness
 * serializes tool arguments. Accept all of the common ones:
 *
 *   - real newlines (`\n`, `\r\n`, `\r`)
 *   - escaped newlines (`\\n`, `\\r\\n`) that survived an extra JSON encode
 *   - HTML-style breaks (`<br>`, `<br/>`, `<br />`)
 *   - escaped unicode line separators (`\\u000a`, `\\u000d`)
 *
 * The stored value always uses plain `\n`, so every view can render it
 * consistently without guessing which escape the caller used.
 */
function normalizeProgressText(value) {
  if (value == null) return value;
  let text = String(value);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/\\u000[ad]/gi, '\n');
  text = text.replace(/\\r\\n|\\n|\\r/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

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
 * Path of the child→parent session attribution map.
 *
 * The desktop plugin writes it when it sees a subagent start (the V2 idle
 * hook's `background[].childSessionID`); the MCP server and relay read it so a
 * subagent's progress lands under the session the user is actually watching
 * instead of in an orphaned child scope. Lives next to the state file so both
 * halves of the tool share one directory.
 */
function resolveSessionMapPath(explicit) {
  return (
    explicit ||
    process.env.PROGRESS_SESSION_MAP_PATH ||
    path.join(
      path.dirname(resolveStatePath()),
      '.opencode-progress-sessions.json'
    )
  );
}

const SESSION_MAP_MAX_HOPS = 8;

/**
 * Read the session attribution map.
 *
 * Accepted shapes: `{ "<child>": "<parent>" }`, `{ "<child>": { parentId } }`,
 * or `{ links: { ... } }`. Unknown entries are ignored, so a corrupt map can
 * never redirect traffic.
 */
function readSessionMap(explicit) {
  const map = {};
  try {
    const raw = JSON.parse(fs.readFileSync(resolveSessionMapPath(explicit), 'utf8'));
    const links =
      raw && typeof raw === 'object' && raw.links && typeof raw.links === 'object'
        ? raw.links
        : raw;
    if (!links || typeof links !== 'object') return map;
    for (const [child, value] of Object.entries(links)) {
      if (typeof value === 'string' && value) {
        map[child] = { parentId: value, at: 0 };
      } else if (value && typeof value === 'object' && typeof value.parentId === 'string' && value.parentId) {
        map[child] = { parentId: value.parentId, at: Number(value.at) || 0 };
      }
    }
  } catch {
    // Missing or mid-write map: no attribution until the next call.
  }
  return map;
}

/**
 * Follow the attribution map from a session to its top-most ancestor.
 * Bounded and cycle-safe; unknown sessions resolve to themselves.
 */
function resolveParentSession(sessionId, map) {
  if (!sessionId) return sessionId;
  const links = map || readSessionMap();
  let current = sessionId;
  const seen = new Set([current]);
  for (let hop = 0; hop < SESSION_MAP_MAX_HOPS; hop++) {
    const link = links[current];
    if (!link || !link.parentId || seen.has(link.parentId)) break;
    current = link.parentId;
    seen.add(current);
  }
  return current;
}

/** Resolve the effective session scope: explicit/env first, then the map. */
function resolveSessionScope(explicit) {
  return resolveParentSession(resolveSessionId(explicit));
}

/**
 * Re-key a child session's existing entries onto its parent. Runs inside the
 * same locked mutation as the upsert that first discovers the mapping, so the
 * catch-up migration cannot race a concurrent writer. Collisions keep the
 * newer entry and preserve a dismissal the newer copy does not carry.
 */
function adoptChildEntries(state, childId, parentId, now) {
  if (!childId || !parentId || childId === parentId) return 0;
  let moved = 0;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!entry || typeof entry !== 'object' || entry.sessionId !== childId) continue;
    entry.sessionId = parentId;
    if (entry.updatedAt === undefined) entry.updatedAt = now;
    const targetKey = storageKey(entry.id, parentId);
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
  return moved;
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
        ...(typeof entry.title === 'string'
          ? { title: normalizeProgressText(entry.title) }
          : {}),
        ...(typeof entry.detail === 'string'
          ? { detail: normalizeProgressText(entry.detail) }
          : {}),
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
  // Retention is OPT-IN. By default nothing is pruned: entries ride so the
  // store stays useful for reporting/history. Enable with
  //   PROGRESS_AUTO_PRUNE_S=<seconds>   (0 = drop completed entries on next write)
  // PROGRESS_TTL_MS still works as a legacy millisecond override.
  // The orphan sweep for `running` entries is also opt-in via
  // PROGRESS_STALE_MS (milliseconds). `waiting` is never swept.
  const legacyTtl =
    process.env.PROGRESS_TTL_MS !== undefined ? Number(process.env.PROGRESS_TTL_MS) : undefined;
  const configuredS =
    process.env.PROGRESS_AUTO_PRUNE_S !== undefined
      ? Number(process.env.PROGRESS_AUTO_PRUNE_S)
      : undefined;
  const ttlMs =
    legacyTtl !== undefined
      ? legacyTtl
      : typeof configuredS === 'number' && Number.isFinite(configuredS) && configuredS >= 0
      ? configuredS * 1000
      : -1;
  const staleMs =
    process.env.PROGRESS_STALE_MS !== undefined ? Number(process.env.PROGRESS_STALE_MS) : -1;

  for (const [id, entry] of Object.entries(state.entries)) {
    if (!entry || typeof entry !== 'object') {
      delete state.entries[id];
      continue;
    }
    if (
      ttlMs >= 0 &&
      (entry.status === 'done' || entry.status === 'error') &&
      now - (entry.updatedAt || 0) > ttlMs
    ) {
      delete state.entries[id];
      continue;
    }
    if (staleMs > 0 && entry.status === 'running' && now - (entry.updatedAt || 0) > staleMs) {
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
function applyUpsert(state, input, now) {
  if (!input || !input.id) throw new Error('upsertProgress requires an id');

  const rawSessionId = resolveSessionId(input.sessionId);
  const sessionId = resolveParentSession(rawSessionId);
  if (sessionId && rawSessionId && sessionId !== rawSessionId) {
    // A subagent reported before the plugin's child→parent map caught up:
    // adopt whatever it already wrote, then continue under the parent.
    adoptChildEntries(state, rawSessionId, sessionId, now);
  }
  const key = storageKey(input.id, sessionId);
  // Transport marker, never persisted: relay telemetry ticks must not clear
  // a user's dismissal (that would resurrect dismissed running tasks at
  // 4Hz); agent-plane writes (MCP tool, emit CLI) do clear it.
  const fromRelay = input.source === 'relay';

  const prev = state.entries[key] || null;
  const status = input.status !== undefined ? input.status : prev?.status || 'running';

  const wasTerminal = prev?.status === 'done' || prev?.status === 'error';
  const isRestart = wasTerminal && (status === 'running' || status === 'waiting');

  const entry = {
    ...(prev || {}),
    id: input.id,
    ...(sessionId ? { sessionId } : {}),
    status,
    title: normalizeProgressText(
      input.title !== undefined ? input.title : prev?.title || input.id
    ),
    detail:
      input.detail !== undefined
        ? normalizeProgressText(input.detail)
        : isRestart
        ? null
        : normalizeProgressText(prev?.detail ?? null),
    progress:
      input.progress !== undefined
        ? input.progress
        : status === 'done'
        // Done is a terminal declaration: keep the store (and the root
        // aggregate) consistent with the relay's finish() mapping, which
        // also forces a completed entry to 100%. Without this, an agent
        // marking a parent done without an explicit progress leaves a stale
        // partial value (or null) that the tree rollup would happily display.
        ? 1
        : isRestart
        ? null
        : prev?.progress ?? null,
    parentId: input.parentId !== undefined ? input.parentId : prev?.parentId ?? null,
    startedAt: isRestart ? now : prev?.startedAt || prev?.createdAt || now,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
  delete entry.source;

  // An agent update is fresh activity: the user's dismissal of THIS entry no
  // longer applies, and neither does any dismissal on its ancestors — a
  // dismissed parent must not hide an actively updated descendant. Relay
  // telemetry only clears the flag on a lifecycle restart.
  //
  // EXCEPTION — terminal dismissal (§4.9): if the entry was dismissed while
  // already terminal (done/error) and this write is terminal too, preserve
  // the dismissal. The user has seen the outcome; a repeated done/error is
  // not news. A lifecycle restart (next status running/waiting) still clears
  // it, and a dismissal taken while running/waiting clears on ANY agent
  // update so completion revives it visually.
  if (!fromRelay) {
    const wasDismissedTerminal =
      prev?.dismissed &&
      (prev.dismissed.status === 'done' || prev.dismissed.status === 'error');
    const nextTerminal = status === 'done' || status === 'error';
    if (!(wasDismissedTerminal && nextTerminal)) {
      entry.dismissed = undefined;
    }
    clearAncestorDismissals(state, entry.parentId, sessionId);
  } else if (isRestart) {
    entry.dismissed = undefined;
  }

  state.entries[key] = entry;
  if (entry.status === 'done') {
    cascadeCloseDescendants(state, input.id, sessionId, now);
  }
  return entry;
}

/**
 * Clear the persisted dismissal on every ancestor of an actively updated
 * entry (§4.9): dismissing a tree must not hide later real updates inside it.
 * Walks parentId links within the same session scope, bounded for safety.
 */
function clearAncestorDismissals(state, parentId, sessionId) {
  let current = parentId;
  for (let depth = 0; depth < 10 && current; depth++) {
    const key = storageKey(current, sessionId);
    const ancestor = state.entries[key];
    if (!ancestor) return;
    let changed = false;
    if (ancestor.dismissed !== undefined) {
      ancestor.dismissed = undefined;
      changed = true;
    }
    current = ancestor.parentId || null;
    if (!changed && !current) return;
  }
}

/**
 * When a parent closes (done), all of its descendants close with it.
 *
 * Rationale: an explicit parent-done is the agent declaring the whole phase
 * finished; children left running/waiting after that are orphans the user
 * has to dismiss by hand (and which outlive the pruned parent, floating
 * parentless in the rollup). Auto-closed children are marked done at 100%
 * with a note, not deleted, so the success-hold aging and 10-minute retention
 * apply to them like any other finished entry — and so a fully done tree
 * rolls up to a full bar instead of a "done" root at 40%.
 *
 * Errors are deliberately excluded (§5.6.1): a failure is not "everything
 * underneath is finished". Errored descendants keep their status and their
 * real progress, and their subtrees are left for the agent to resolve, so
 * the failure surfaces as a red root in the rollup instead of being silently
 * rewritten into a green 100%. Scoped to the same session: parentId is a
 * clean id and MUST NOT cross session boundaries (§4.8).
 */
function cascadeCloseDescendants(state, parentId, sessionId, now) {
  const sameScope = (entry) =>
    (entry.sessionId || null) === (sessionId || null);
  let frontier = [parentId];
  for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
    const next = [];
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry || !frontier.includes(entry.parentId) || !sameScope(entry)) continue;
      // Already-done entries are left alone (their own history stands); an
      // error stops the cascade for its whole subtree.
      if (entry.status === 'done' || entry.status === 'error') continue;
      entry.status = 'done';
      entry.progress = 1;
      entry.detail = entry.detail
        ? `${normalizeProgressText(entry.detail)} (auto-closed: parent ${parentId} completed)`
        : `auto-closed: parent ${parentId} completed`;
      entry.updatedAt = now;
      next.push(entry.id);
    }
    frontier = next;
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
  return mutateState((state) => applyUpsert(state, input, Date.now()), stateFile);
}

/**
 * Create or update many entries in ONE atomic, locked write (§4.3/§4.4):
 * a parent + children tree lands whole, so the rollup never shows an
 * intermediate half-built tree. All-or-nothing: every input is validated
 * before the write, and a failure inside the mutator leaves the document
 * untouched. Cap: 50 entries per call.
 */
function upsertManyProgress(inputs, stateFile = DEFAULT_STATE_FILE) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('entries[] requires a non-empty array');
  }
  if (inputs.length > 50) {
    throw new Error(`entries[] too large: ${inputs.length} (max 50)`);
  }
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || !input.id || typeof input.id !== 'string') {
      throw new Error('each entry[] item requires an id (string)');
    }
    if (!input.status || !['running', 'waiting', 'done', 'error'].includes(input.status)) {
      throw new Error(`entries[${input.id}] requires a valid status (running|waiting|done|error)`);
    }
    if (!input.title || typeof input.title !== 'string') {
      throw new Error(`entries[${input.id}] requires a title (string)`);
    }
  }
  return mutateState((state) => {
    const now = Date.now();
    return inputs.map((input) => applyUpsert(state, input, now));
  }, stateFile);
}

function clearProgress(id, stateFile = DEFAULT_STATE_FILE, sessionId) {
  const resolvedSessionId = resolveSessionScope(sessionId);
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
 * Mirrors the plugin's tree.ts projection: done always reads 100%, and when a
 * descendant failed the children's progress wins over a (likely stale) value
 * stored on the parent so a red root keeps an honest partial bar.
 */
function rollUp(id, entries, childrenMap, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  const entry = entries[id];
  if (!entry) return null;

  const childIds = childrenMap.get(id) || [];
  const result = { ...entry };
  let errorFromChild = false;

  if (childIds.length > 0) {
    const childResults = childIds.map((cid) => rollUp(cid, entries, childrenMap, cache));

    const childStatuses = childResults.map((r) => r.status);
    errorFromChild = childStatuses.includes('error');
    // A failure on this entry is as severe as one below it: an errored parent
    // with a still-running child must not display as merely "running".
    if (errorFromChild || entry.status === 'error') {
      result.status = 'error';
    } else if (childStatuses.includes('running')) {
      result.status = 'running';
    } else if (childStatuses.includes('waiting')) {
      result.status = 'waiting';
    } else if (childStatuses.every((s) => s === 'done')) {
      result.status = 'done';
    }

    const childProgresses = childResults.map((r) => r.progress).filter((p) => p != null);
    const childMean =
      childProgresses.length > 0
        ? childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length
        : null;
    if (childMean != null && (entry.progress == null || (result.status === 'error' && errorFromChild))) {
      result.progress = childMean;
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

  if (result.status === 'done') result.progress = 1;

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
  resolveSessionMapPath,
  resolveSessionScope,
  resolveParentSession,
  readSessionMap,
  adoptChildEntries,
  storageKey,
  normalizeProgressText,
  ensureStateFile,
  readState,
  atomicWrite,
  mutateState,
  upsertProgress,
  upsertManyProgress,
  clearProgress,
  getAllProgress,
  buildTree,
  rollUp,
  getTree,
};
