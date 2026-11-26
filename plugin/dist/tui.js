// src/tui.js
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";

// src/state.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function stateFilePath() {
  return process.env.PROGRESS_STATE_PATH || path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".opencode-progress-state.json");
}
var stateSafetyCache = /* @__PURE__ */ new Map();
function assertWritableStateFile(file) {
  if (path.extname(file).toLowerCase() !== ".json") {
    throw new Error(`Refusing to write progress state to ${file}: expected a .json file`);
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write progress state to ${file}: not a regular file`);
  }
  if (stat.size === 0) return;
  const hit = stateSafetyCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `Refusing to overwrite ${file}: not valid JSON (PROGRESS_STATE_PATH must point at a progress state file)`
    );
  }
  const entries = parsed && typeof parsed === "object" && "entries" in parsed ? parsed.entries : void 0;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`Refusing to overwrite ${file}: missing a progress "entries" object`);
  }
  stateSafetyCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
}
function readProgressState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
  }
  return { entries: {}, version: 2 };
}
var SESSION_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
function sessionMapFilePath() {
  return process.env.PROGRESS_SESSION_MAP_PATH || path.join(path.dirname(stateFilePath()), ".opencode-progress-sessions.json");
}
function readSessionMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMapFilePath(), "utf8"));
    const links = parsed && typeof parsed === "object" && "links" in parsed ? parsed.links : parsed;
    if (!links || typeof links !== "object") return {};
    const map = {};
    for (const [child, value] of Object.entries(links)) {
      if (typeof value === "string" && value) {
        map[child] = { parentId: value, at: 0 };
      } else if (value && typeof value === "object" && typeof value.parentId === "string") {
        const link = value;
        map[child] = {
          parentId: link.parentId,
          at: Number(link.at) || 0,
          agent: typeof link.agent === "string" && link.agent ? link.agent : void 0,
          name: typeof link.name === "string" && link.name ? link.name : void 0
        };
      }
    }
    return map;
  } catch {
    return {};
  }
}
function writeDismissal(key, status) {
  const file = stateFilePath();
  const lock = `${file}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15e3) fs.unlinkSync(lock);
      } catch {
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
      }
    }
  }
  if (!locked) return false;
  try {
    const state2 = readProgressState();
    const entry = state2.entries[key];
    if (!entry) return false;
    entry.dismissed = { status, at: Date.now() };
    state2.version = state2.version ?? 2;
    assertWritableStateFile(file);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state2, null, 2));
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
    }
  }
}
function mutateStateFile(mutator) {
  const file = stateFilePath();
  const lock = `${file}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15e3) fs.unlinkSync(lock);
      } catch {
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
      }
    }
  }
  if (!locked) return void 0;
  try {
    const state2 = readProgressState();
    const { value, write } = mutator(state2);
    if (!write) return value;
    state2.version = state2.version ?? 2;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state2, null, 2));
    fs.renameSync(tmp, file);
    return value;
  } catch (error) {
    console.error("[opencode-progress] state write failed", String(error));
    return void 0;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
    }
  }
}
var SAY_NOTES_PER_SESSION = 20;
function dismissSayNote(noteID) {
  const id = String(noteID ?? "");
  if (!id) return false;
  const result = mutateStateFile((state2) => {
    let removed = false;
    for (const [author, list] of Object.entries(state2.notes ?? {})) {
      if (!Array.isArray(list)) continue;
      const next = list.filter((note) => note?.id !== id);
      if (next.length === list.length) continue;
      removed = true;
      if (next.length === 0) delete state2.notes[author];
      else state2.notes[author] = next;
    }
    return { value: removed, write: removed };
  });
  if (result) console.log(`[opencode-progress] dismissed note ${id}`);
  return result === true;
}
function clearSayNotes(sessionID) {
  const id = String(sessionID ?? "");
  if (!id) return 0;
  const links = readSessionMap();
  const root = rootSessionFor(id, links);
  const result = mutateStateFile((state2) => {
    let removed = 0;
    for (const [author, list] of Object.entries(state2.notes ?? {})) {
      if (!Array.isArray(list)) continue;
      const keep = list.filter(
        (note) => rootSessionFor(note?.sessionId ?? author, links) !== root
      );
      const count = list.length - keep.length;
      if (count === 0) continue;
      removed += count;
      if (keep.length === 0) delete state2.notes[author];
      else state2.notes[author] = keep;
    }
    return { value: removed, write: removed > 0 };
  });
  if (result) console.log(`[opencode-progress] cleared ${result} note(s) root=${root}`);
  return result ?? 0;
}
function rootSessionFor(sessionID, links = readSessionMap()) {
  let current = sessionID;
  const seen = /* @__PURE__ */ new Set();
  while (current && !seen.has(current) && seen.size < 32) {
    seen.add(current);
    const parent = links[current]?.parentId;
    if (!parent) break;
    current = parent;
  }
  return current;
}
function sayNotesForSession(state2, sessionID, options = {}) {
  const limit = Math.max(
    1,
    Math.min(200, Math.floor(options.limit ?? SAY_NOTES_PER_SESSION))
  );
  const all = [];
  for (const list of Object.values(state2.notes ?? {})) {
    if (Array.isArray(list)) all.push(...list);
  }
  all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (options.scope === "all" || !sessionID) return all.slice(0, limit);
  const links = options.links ?? readSessionMap();
  const root = rootSessionFor(sessionID, links);
  return all.filter((note) => rootSessionFor(note.sessionId, links) === root).slice(0, limit);
}
function belongsToSession(key, entry, sessionID) {
  return entry.sessionId === sessionID || key.startsWith(`${sessionID}:`);
}
function stateBytes(state2) {
  return Buffer.byteLength(JSON.stringify(state2));
}
function softClearSession(sessionID) {
  if (!sessionID) return { cleared: 0 };
  const at = Date.now();
  let cleared = 0;
  const result = mutateStateFile((state2) => {
    for (const [key, entry] of Object.entries(state2.entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (!belongsToSession(key, entry, sessionID)) continue;
      if (entry.cleared) continue;
      const finished = entry.status === "done" || entry.status === "error";
      if (!finished && !entry.dismissed) continue;
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
function hardDeleteSession(sessionID) {
  if (!sessionID) return { removed: 0, freedBytes: 0 };
  let removed = 0;
  const result = mutateStateFile((state2) => {
    const before = stateBytes(state2);
    for (const [key, entry] of Object.entries(state2.entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (!belongsToSession(key, entry, sessionID)) continue;
      delete state2.entries[key];
      removed++;
    }
    let notesRemoved = 0;
    if (state2.notes && state2.notes[sessionID]) {
      notesRemoved = Array.isArray(state2.notes[sessionID]) ? state2.notes[sessionID].length : 1;
      delete state2.notes[sessionID];
    }
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state2)) },
      write: removed > 0 || notesRemoved > 0
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
function hardDeleteAll() {
  let removed = 0;
  const result = mutateStateFile((state2) => {
    const before = stateBytes(state2);
    removed = Object.keys(state2.entries).length;
    state2.entries = {};
    const notesRemoved = Object.values(state2.notes ?? {}).reduce(
      (total, list) => total + (Array.isArray(list) ? list.length : 0),
      0
    );
    state2.notes = {};
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state2)) },
      write: removed > 0 || notesRemoved > 0
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
function removeSessionLinks(sessionID) {
  const file = sessionMapFilePath();
  const lock = `${file}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      locked = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15e3) fs.unlinkSync(lock);
      } catch {
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
      }
    }
  }
  if (!locked) return 0;
  try {
    const map = readSessionMap();
    let removed = 0;
    for (const [child, link] of Object.entries(map)) {
      if (sessionID === void 0 || child === sessionID || link.parentId === sessionID) {
        delete map[child];
        removed++;
      }
    }
    if (removed === 0) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ links: map }, null, 2));
    fs.renameSync(tmp, file);
    console.log(
      `[opencode-progress] removed ${removed} session link${removed === 1 ? "" : "s"}${sessionID ? ` for ${sessionID}` : ""}`
    );
    return removed;
  } catch (error) {
    console.error("[opencode-progress] session link cleanup failed", String(error));
    return 0;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
    }
  }
}

// src/tasklist-prefs.ts
import fs2 from "node:fs";
import path2 from "node:path";
function taskListPrefsPath(stateFile = stateFilePath()) {
  return path2.join(path2.dirname(stateFile), ".opencode-progress-tasklist-prefs.json");
}
function taskListStatusPath(stateFile = stateFilePath()) {
  return path2.join(path2.dirname(stateFile), ".opencode-progress-tasklist-status.json");
}
function normalizeTaskListView(raw) {
  return raw === "raw" ? "raw" : "ui";
}
function normalizeTaskListDetail(raw) {
  return raw === "raw" || raw === "escaped" ? raw : "code";
}
function normalizeTaskListLocation(raw) {
  const numeric = Number(raw);
  return numeric === 0 || numeric === 2 ? numeric : 1;
}
function normalizeTaskListOrder(raw) {
  return raw === "oldest-first" ? "oldest-first" : "newest-first";
}
function readJson(file) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function readTaskListPrefs(stateFile = stateFilePath()) {
  const parsed = readJson(taskListPrefsPath(stateFile));
  if (!parsed || typeof parsed !== "object") return {};
  const mode = parsed.mode;
  return mode === "ui" || mode === "raw" ? { mode } : {};
}
function writeTaskListPrefs(prefs, stateFile = stateFilePath()) {
  const file = taskListPrefsPath(stateFile);
  try {
    fs2.mkdirSync(path2.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs2.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    fs2.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
function readTaskListStatus(stateFile = stateFilePath()) {
  const parsed = readJson(taskListStatusPath(stateFile));
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed;
  return {
    enabled: raw.enabled === true,
    mode: normalizeTaskListView(raw.mode),
    detail: normalizeTaskListDetail(raw.detail),
    location: normalizeTaskListLocation(raw.location),
    order: normalizeTaskListOrder(raw.order),
    file: typeof raw.file === "string" ? raw.file : void 0,
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID : void 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : void 0
  };
}
function toggleTaskListMode(fallback = "ui", stateFile = stateFilePath()) {
  const prefs = readTaskListPrefs(stateFile);
  const status = readTaskListStatus(stateFile);
  const current = prefs.mode ?? status?.mode ?? fallback;
  const next = current === "raw" ? "ui" : "raw";
  writeTaskListPrefs({ ...prefs, mode: next }, stateFile);
  return next;
}

// src/tree-theme.ts
import fs3 from "node:fs";
import os2 from "node:os";
import path3 from "node:path";

// src/tree.ts
var STATUS_ORDER = {
  error: 4,
  running: 3,
  waiting: 2,
  pending: 1,
  done: 0
};
function normalizeProgressText(value) {
  if (value == null) return "";
  let text = String(value);
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/\\u000[ad]/gi, "\n");
  text = text.replace(/\\r\\n|\\n|\\r/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
function oneLineText(value) {
  return normalizeProgressText(value).replace(/\s*\n+\s*/g, " ").replace(/[ \t]+/g, " ").trim();
}
function buildTree(entries) {
  const byKey = /* @__PURE__ */ new Map();
  const keyById = /* @__PURE__ */ new Map();
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    byKey.set(key, {
      ...entry,
      title: normalizeProgressText(entry.title),
      detail: entry.detail == null ? entry.detail : normalizeProgressText(entry.detail)
    });
    if (entry.id && !keyById.has(entry.id)) keyById.set(entry.id, key);
  }
  const childrenByKey = /* @__PURE__ */ new Map();
  for (const key of byKey.keys()) childrenByKey.set(key, []);
  const roots = [];
  for (const [key, entry] of byKey) {
    const parentKey = entry.parentId ? byKey.has(entry.parentId) ? entry.parentId : keyById.get(entry.parentId) : void 0;
    if (parentKey && parentKey !== key) {
      childrenByKey.get(parentKey)?.push(key);
    } else {
      roots.push(key);
    }
  }
  const compare = (a, b) => {
    const ea = byKey.get(a);
    const eb = byKey.get(b);
    const severity = (STATUS_ORDER[eb?.status ?? ""] ?? 0) - (STATUS_ORDER[ea?.status ?? ""] ?? 0);
    if (severity !== 0) return severity;
    return (eb?.updatedAt ?? 0) - (ea?.updatedAt ?? 0);
  };
  for (const children of childrenByKey.values()) children.sort(compare);
  roots.sort(compare);
  const seen = /* @__PURE__ */ new Set();
  const node = (key) => {
    const entry = byKey.get(key);
    seen.add(key);
    const children = (childrenByKey.get(key) ?? []).filter((child) => !seen.has(child)).map(node);
    let status = entry.status;
    let progress = entry.progress;
    let updatedAt = entry.updatedAt;
    let errorFromChild = false;
    if (children.length > 0) {
      const statuses = children.map((child) => child.status);
      errorFromChild = statuses.includes("error");
      if (errorFromChild || entry.status === "error") status = "error";
      else if (statuses.includes("running")) status = "running";
      else if (statuses.includes("waiting")) status = "waiting";
      else if (statuses.includes("pending")) status = "pending";
      else if (statuses.every((child) => child === "done")) status = "done";
      const childProgresses = children.map((child) => child.progress).filter((value) => typeof value === "number" && Number.isFinite(value));
      const childMean = childProgresses.length > 0 ? childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length : null;
      if (childMean != null && (progress == null || status === "error" && errorFromChild)) {
        progress = childMean;
      }
      const latestChild = children.reduce((latest, child) => Math.max(latest, child.updatedAt ?? 0), 0);
      if (latestChild > (updatedAt ?? 0)) updatedAt = latestChild;
    }
    if (status === "done") progress = 1;
    return { ...entry, key, children, status, progress, updatedAt, reportedAt: entry.updatedAt };
  };
  return roots.map(node);
}
function flattenTree(nodes) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
function flattenTreeWithDepth(nodes, depth = 0) {
  const out = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flattenTreeWithDepth(node.children, depth + 1));
  }
  return out;
}
function countDescendants(node) {
  return (node.children ?? []).reduce(
    (total, child) => total + 1 + countDescendants(child),
    0
  );
}
function countActive(nodes) {
  return flattenTree(nodes).filter((node) => node.status === "running" || node.status === "waiting").length;
}
function isDismissed(root, map) {
  const d = map[root.key];
  if (!d) return false;
  if ((root.reportedAt ?? 0) > d.at) return false;
  const wasTerminal = d.status === "done" || d.status === "error";
  if (!wasTerminal || root.status === "error") {
    if ((root.status ?? "") !== d.status) return false;
  }
  return true;
}
function dismissedMap(entries) {
  const map = {};
  for (const [key, entry] of Object.entries(entries)) {
    const dismissed = entry?.dismissed;
    if (dismissed && typeof dismissed === "object" && typeof dismissed.at === "number") {
      map[key] = { status: String(dismissed.status ?? ""), at: dismissed.at };
    }
  }
  return map;
}
function normalizeTreeTheme(value) {
  if (value === "compact" || value === "ultra-compact") return value;
  return "default";
}
function normalizeIndicatorStyle(value, fallback = "dot") {
  if (value === "circles" || value === "checkbox" || value === "dot") return value;
  return fallback;
}
var INDICATOR_STYLE_CHOICES = [
  {
    value: "dot",
    title: "\u25CF \u25CF \u25CF  Flat dots",
    description: "Solid CSS status dots (default)"
  },
  {
    value: "circles",
    title: "\u{1F7E2} \u{1F7E1} \u{1F534}  Emoji circles",
    description: "Colored emoji status lights"
  },
  {
    value: "checkbox",
    title: "\u2705 \u23F3 \u274C  Checkbox emoji",
    description: "Checklist marks for each status"
  }
];
function indicatorStyleLabel(style) {
  if (style === "circles") return "Emoji circles";
  if (style === "checkbox") return "Checkbox emoji";
  return "Flat dots";
}
function indicatorGlyph(style, status) {
  if (style === "circles") {
    if (status === "done") return "\u{1F7E2}";
    if (status === "error") return "\u{1F534}";
    if (status === "waiting") return "\u{1F7E1}";
    if (status === "pending") return "\u26AA";
    return "\u{1F535}";
  }
  if (style === "checkbox") {
    if (status === "done") return "\u2705";
    if (status === "error") return "\u274C";
    if (status === "waiting") return "\u23F3";
    if (status === "pending") return "\u2B1C";
    return "\u{1F504}";
  }
  if (status === "done") return "\u2713";
  if (status === "error") return "\u2717";
  if (status === "waiting") return "\u25D0";
  if (status === "pending") return "\u25CB";
  return "\u25CF";
}
function compactTreeSuffix(progress, hiddenChildren = 0) {
  const parts = [];
  const pct = progressLabel(progress);
  if (pct) parts.push(pct);
  if (hiddenChildren > 0) parts.push(`& ${hiddenChildren} more`);
  return parts.join(" \xB7 ");
}
function normalizeBarStyle(value) {
  return value === "emoji" ? "emoji" : "blocks";
}
function clampProgress(progress) {
  return progress == null ? 0 : Math.max(0, Math.min(1, progress));
}
function normalizeBarOptions(raw) {
  const options = raw ?? {};
  return {
    style: normalizeBarStyle(options.barStyle),
    segments: typeof options.barSegments === "number" && options.barSegments > 0 ? options.barSegments : void 0,
    total: typeof options.barTotal === "number" && options.barTotal > 0 ? options.barTotal : void 0
  };
}
function normalizeRefreshMs(raw, fallback = 1e3) {
  const options = raw ?? {};
  const value = options.refreshMs ?? options.intervalMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 100) return value;
  return fallback;
}
function normalizeVisibilityOptions(raw) {
  const options = raw ?? {};
  return {
    successHoldMs: typeof options.successHoldMs === "number" && options.successHoldMs >= 0 ? options.successHoldMs : void 0,
    showDone: options.showDone !== false,
    // Default OFF: never-dismissed done entries stay visible.
    autoHideDone: options.autoHideDone === true,
    scope: options.scope === "all" ? "all" : "session"
  };
}
function truncatedSubagentName(name) {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 20 ? `${clean.slice(0, 19).trimEnd()}\u2026` : clean;
}
function subagentPrefix(entry) {
  if (!entry.subagent) return "";
  const name = truncatedSubagentName(entry.subagentName);
  return name ? `[subagent ${name}]: ` : "[subagent]: ";
}
function scopeEntries(entries, sessionID, options = {}) {
  if (options.scope === "all") return entries;
  if (!sessionID) return {};
  const prefix = `${sessionID}:`;
  const scoped2 = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.sessionId === sessionID || key.startsWith(prefix)) scoped2[key] = entry;
  }
  return scoped2;
}
function visibleEntries(entries, now, options = {}) {
  const hold = options.successHoldMs ?? 8e3;
  const showDone = options.showDone !== false;
  const autoHideDone = options.autoHideDone === true;
  const visible = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.cleared) continue;
    if (entry.status === "done") {
      if (!showDone) continue;
      if (autoHideDone && now - (entry.updatedAt ?? 0) >= hold) continue;
    }
    visible[key] = entry;
  }
  return visible;
}
function buildVisibleTree(entries, now, options = {}, dismissals) {
  const visible = visibleEntries(entries, now, options);
  const roots = buildTree(visible);
  const map = dismissals ?? dismissedMap(visible);
  const drop = /* @__PURE__ */ new Set();
  const collect = (node) => {
    drop.add(node.key);
    for (const child of node.children) collect(child);
  };
  const visit = (node) => {
    if (isDismissed(node, map)) {
      collect(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  if (drop.size === 0) return roots;
  const remaining = {};
  for (const [key, entry] of Object.entries(visible)) {
    if (!drop.has(key)) remaining[key] = entry;
  }
  return buildTree(remaining);
}
function barParts(progress, options = {}) {
  const style = options.style === "emoji" ? "emoji" : "blocks";
  const segments = options.segments ?? (style === "emoji" ? 6 : 10);
  const total = options.total ?? 100;
  const value = clampProgress(progress);
  const filled = Math.round(value * segments);
  const bar = style === "emoji" ? "\u{1F7E9}".repeat(filled) + "\u2B1B\uFE0F".repeat(Math.max(0, segments - filled)) : "\u2588".repeat(filled) + "\u2591".repeat(Math.max(0, segments - filled));
  const done = Math.round(value * total);
  return { bar, done, total, fraction: `(${done}/${total})`, style };
}
function progressLabel(progress) {
  return progress == null ? null : `${Math.round(progress * 100)}%`;
}
var ASCII_PREVIEW = barParts(0.6, { style: "blocks", segments: 10 }).bar;
var EMOJI_PREVIEW = barParts(0.6, { style: "emoji", segments: 6 });
var COMPACT_PREVIEW = compactTreeSuffix(0.6, 2);
var THEME_PRESET_CHOICES = [
  {
    value: "ascii",
    title: `ASCII  ${ASCII_PREVIEW} 60%`,
    description: "Block bars \xB7 default tree rows",
    treeTheme: "default",
    barStyle: "blocks"
  },
  {
    value: "emoji",
    title: `Emoji  ${EMOJI_PREVIEW.bar}${EMOJI_PREVIEW.fraction}`,
    description: "Emoji bars \xB7 default tree rows",
    treeTheme: "default",
    barStyle: "emoji"
  },
  {
    value: "compact",
    title: `Compact  Task ${COMPACT_PREVIEW}`,
    description: "No bars \xB7 one detail line",
    treeTheme: "compact",
    barStyle: "blocks"
  },
  {
    value: "ultra-compact",
    title: "Ultra  Task  [09:12\u219209:41 \xB7 29m]",
    description: "One title line \xB7 status light, times, dismiss",
    treeTheme: "ultra-compact",
    barStyle: "blocks"
  }
];
function themePresetFrom(theme, style) {
  if (theme === "ultra-compact") return "ultra-compact";
  if (theme === "compact") return "compact";
  return style === "emoji" ? "emoji" : "ascii";
}
function themePresetChoice(value) {
  return THEME_PRESET_CHOICES.find((choice) => choice.value === value);
}
function themePresetLabel(value) {
  if (value === "ultra-compact") return "Ultra-compact rows";
  if (value === "compact") return "Compact rows";
  return value === "emoji" ? "Emoji bars" : "ASCII bars";
}

// src/tree-theme.ts
var PROGRESS_PLUGIN_NAME = "@jakedowns/progress-tool-opencode-plugin";
function globalConfigDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os2.homedir();
  const xdg = env.XDG_CONFIG_HOME || path3.join(home, ".config");
  return path3.join(xdg, "opencode");
}
function treeThemeConfigCandidates(directory, env = process.env) {
  const candidates = [];
  if (directory) {
    candidates.push(path3.join(directory, "opencode.json"));
    candidates.push(path3.join(directory, "opencode.jsonc"));
  }
  const global = globalConfigDir(env);
  candidates.push(path3.join(global, "opencode.json"));
  candidates.push(path3.join(global, "opencode.jsonc"));
  return [...new Set(candidates)];
}
function isProgressPluginPackage(ref, baseDir = process.cwd()) {
  if (typeof ref !== "string" || !ref.trim()) return false;
  if (ref.includes("progress-tool-opencode-plugin")) return true;
  if (ref.startsWith(".") || path3.isAbsolute(ref)) {
    const dir = path3.isAbsolute(ref) ? ref : path3.resolve(baseDir, ref);
    try {
      const pkg = JSON.parse(fs3.readFileSync(path3.join(dir, "package.json"), "utf8"));
      return pkg?.name === PROGRESS_PLUGIN_NAME;
    } catch {
      return false;
    }
  }
  return false;
}
function isWhitespace(ch) {
  return ch === " " || ch === "	" || ch === "\n" || ch === "\r";
}
function isDelimiter(ch) {
  return isWhitespace(ch) || ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === "," || ch === '"';
}
function tokenize(input) {
  const tokens = [];
  const length = input.length;
  let i = 0;
  while (i < length) {
    const ch = input[i];
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i = Math.min(length, i + 2);
      continue;
    }
    if (ch === '"') {
      const start2 = i;
      i += 1;
      let value = "";
      while (i < length) {
        const c = input[i];
        if (c === "\\") {
          const esc = input[i + 1];
          if (esc === '"' || esc === "\\" || esc === "/") {
            value += esc;
            i += 2;
          } else if (esc === "b") {
            value += "\b";
            i += 2;
          } else if (esc === "f") {
            value += "\f";
            i += 2;
          } else if (esc === "n") {
            value += "\n";
            i += 2;
          } else if (esc === "r") {
            value += "\r";
            i += 2;
          } else if (esc === "t") {
            value += "	";
            i += 2;
          } else if (esc === "u") {
            value += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += esc ?? "";
            i += 2;
          }
        } else if (c === '"') {
          i += 1;
          break;
        } else {
          value += c;
          i += 1;
        }
      }
      tokens.push({ type: "string", value, start: start2, end: i });
      continue;
    }
    if ("{}[]:,".includes(ch)) {
      tokens.push({ type: "punct", value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const start = i;
    while (i < length) {
      if (isDelimiter(input[i])) break;
      if (input[i] === "/" && (input[i + 1] === "/" || input[i + 1] === "*")) break;
      i += 1;
    }
    if (i === start) {
      i += 1;
      continue;
    }
    tokens.push({ type: "literal", value: input.slice(start, i), start, end: i });
  }
  return tokens;
}
function parseValue(tokens, index) {
  const token = tokens[index];
  if (!token) throw new Error("unexpected end of config");
  if (token.type === "punct" && token.value === "{") {
    const members = [];
    let i = index + 1;
    while (i < tokens.length) {
      const next = tokens[i];
      if (next.type === "punct" && next.value === "}") {
        i += 1;
        return { node: { kind: "object", start: token.start, end: next.end, members }, next: i };
      }
      if (next.type !== "string") throw new Error("expected an object key");
      const key = next.value;
      i += 1;
      if (!(tokens[i]?.type === "punct" && tokens[i].value === ":")) {
        throw new Error("expected ':'");
      }
      i += 1;
      const parsed = parseValue(tokens, i);
      members.push({ key, value: parsed.node });
      i = parsed.next;
      if (tokens[i]?.type === "punct" && tokens[i].value === ",") i += 1;
    }
    throw new Error("unterminated object");
  }
  if (token.type === "punct" && token.value === "[") {
    const items = [];
    let i = index + 1;
    while (i < tokens.length) {
      const next = tokens[i];
      if (next.type === "punct" && next.value === "]") {
        i += 1;
        return { node: { kind: "array", start: token.start, end: next.end, items }, next: i };
      }
      const parsed = parseValue(tokens, i);
      items.push(parsed.node);
      i = parsed.next;
      if (tokens[i]?.type === "punct" && tokens[i].value === ",") i += 1;
    }
    throw new Error("unterminated array");
  }
  if (token.type === "string") {
    return {
      node: {
        kind: "string",
        start: token.start,
        end: token.end,
        value: token.value
      },
      next: index + 1
    };
  }
  if (token.type === "literal") {
    return {
      node: { kind: "literal", start: token.start, end: token.end, value: token.value },
      next: index + 1
    };
  }
  throw new Error("unexpected token");
}
function memberOf(node, key) {
  return node.members?.find((member) => member.key === key);
}
function pluginRefOf(node) {
  if (node.kind === "string") return node.value;
  if (node.kind !== "object") return void 0;
  const pkg = memberOf(node, "package");
  return pkg?.value.kind === "string" ? pkg.value.value : void 0;
}
function insertObjectProperty(text, node, property, value) {
  const object = node;
  const close = object.end - 1;
  let cursor = close;
  while (cursor > object.start && isWhitespace(text[cursor - 1])) cursor -= 1;
  const hasMembers = (object.members?.length ?? 0) > 0;
  const trailingComma = cursor > object.start && text[cursor - 1] === ",";
  const prefix = trailingComma ? " " : hasMembers ? ", " : "";
  const insert = `${prefix}${JSON.stringify(property)}: ${value}`;
  return text.slice(0, cursor) + insert + text.slice(cursor);
}
function replaceSpan(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}
function writePropertyIntoEntry(text, key, literal, entry) {
  const options = memberOf(entry, "options");
  if (options?.value.kind === "object") {
    const current = memberOf(options.value, key);
    if (current) {
      return replaceSpan(text, current.value.start, current.value.end, literal);
    }
    return insertObjectProperty(text, options.value, key, literal);
  }
  if (options) {
    return replaceSpan(
      text,
      options.value.start,
      options.value.end,
      `{ ${JSON.stringify(key)}: ${literal} }`
    );
  }
  return insertObjectProperty(text, entry, "options", `{ ${JSON.stringify(key)}: ${literal} }`);
}
function setThemePropertyInConfig(text, key, value, options) {
  let root;
  try {
    const parsed = parseValue(tokenize(text), 0);
    root = parsed.node;
  } catch {
    return void 0;
  }
  if (root.kind !== "object") return void 0;
  const plugins = memberOf(root, "plugins");
  if (!plugins || plugins.value.kind !== "array" || !plugins.value.items) return void 0;
  for (const item of plugins.value.items) {
    const ref = pluginRefOf(item);
    if (typeof ref !== "string" || !options.matches(ref)) continue;
    if (item.kind === "object") {
      return writePropertyIntoEntry(text, key, JSON.stringify(value), item);
    }
    if (item.kind === "string") {
      return replaceSpan(
        text,
        item.start,
        item.end,
        `{ "package": ${JSON.stringify(item.value ?? "")}, "options": { ${JSON.stringify(key)}: ${JSON.stringify(value)} } }`
      );
    }
  }
  return void 0;
}
function updateThemeInConfig(text, theme, options) {
  if (text.charCodeAt(0) === 65279) {
    const updated2 = updateThemeInConfig(text.slice(1), theme, options);
    return updated2 === void 0 ? void 0 : `\uFEFF${updated2}`;
  }
  const settings = [];
  if (theme.treeTheme !== void 0) {
    settings.push(["treeTheme", normalizeTreeTheme(theme.treeTheme)]);
  }
  if (theme.barStyle !== void 0) {
    settings.push(["barStyle", normalizeBarStyle(theme.barStyle)]);
  }
  if (settings.length === 0) return text;
  let updated = text;
  for (const [key, value] of settings) {
    const next = setThemePropertyInConfig(updated, key, value, options);
    if (next === void 0) return void 0;
    updated = next;
  }
  return updated;
}
function atomicWrite(file, body) {
  const stat = fs3.statSync(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs3.writeFileSync(tmp, body, { encoding: "utf8", mode: stat.mode });
  fs3.renameSync(tmp, file);
}
function writeThemeToConfig(values, options = {}) {
  const theme = {};
  if (values.treeTheme !== void 0) {
    theme.treeTheme = normalizeTreeTheme(values.treeTheme);
  }
  if (values.barStyle !== void 0) {
    theme.barStyle = normalizeBarStyle(values.barStyle);
  }
  if (theme.treeTheme === void 0 && theme.barStyle === void 0) {
    return { ok: false, error: "no theme values supplied" };
  }
  const env = options.env ?? process.env;
  const candidates = treeThemeConfigCandidates(options.directory, env);
  for (const file of candidates) {
    let text;
    try {
      text = fs3.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const updated = updateThemeInConfig(text, theme, {
      matches: (ref) => isProgressPluginPackage(ref, path3.dirname(file))
    });
    if (updated === void 0) continue;
    try {
      if (updated !== text) atomicWrite(file, updated);
      return { ok: true, ...theme, file };
    } catch (error) {
      return { ok: false, ...theme, file, error: String(error) };
    }
  }
  return {
    ok: false,
    ...theme,
    error: "no OpenCode config entry found for this plugin"
  };
}

// src/tui-view.ts
var STATUS_URGENCY = {
  error: 4,
  running: 3,
  waiting: 2,
  pending: 1,
  done: 0
};
function sortRootsByUrgency(roots) {
  return roots.map((node, index) => ({ node, index })).sort(
    (a, b) => (STATUS_URGENCY[b.node.status] ?? 0) - (STATUS_URGENCY[a.node.status] ?? 0) || a.index - b.index
  ).map(({ node }) => node);
}
function rootDetailLines(root) {
  const lines = [`status: ${root.status ?? "unknown"}`];
  const pct = progressLabel(root.progress);
  if (pct) lines.push(`progress: ${pct}`);
  const descendants = countDescendants(root);
  if (descendants > 0) lines.push(`descendants: ${descendants}`);
  lines.push("", root.detail?.trim() ? root.detail.trim() : "(no detail)");
  return lines;
}
var ROOT_SUMMARY_ORDER = ["waiting", "running", "error", "pending", "done", "dismissed"];
function summarizeRoots(roots, isDismissedRoot) {
  const counts = {
    waiting: 0,
    running: 0,
    error: 0,
    pending: 0,
    done: 0,
    dismissed: 0
  };
  for (const root of roots) {
    if (isDismissedRoot(root)) {
      counts.dismissed += 1;
    } else if (root.status && root.status in counts) {
      counts[root.status] += 1;
    }
  }
  return ROOT_SUMMARY_ORDER.filter((key) => counts[key] > 0).map((key) => `${key} (${counts[key]})`).join(" | ");
}
function buildTuiView(roots, options = {}) {
  const maxRows2 = Math.max(1, Math.min(50, Math.floor(options.maxRows ?? 8)));
  const maxRoots = Math.max(1, Math.floor(options.maxRoots ?? Infinity));
  const expanded = options.expanded;
  const all = [];
  const sorted = sortRootsByUrgency(roots);
  const visibleRoots = maxRoots === Infinity ? sorted : sorted.slice(0, maxRoots);
  const hiddenRoots = sorted.length - visibleRoots.length;
  for (const root of visibleRoots) {
    const hasChildren = (root.children?.length ?? 0) > 0;
    const isExpanded = hasChildren && (expanded ? expanded.has(root.key) : options.expandByDefault === true);
    all.push({
      node: root,
      depth: 0,
      collapsed: hasChildren && !isExpanded,
      hiddenChildren: hasChildren && !isExpanded ? countDescendants(root) : 0
    });
    if (isExpanded) {
      for (const { node, depth } of flattenTreeWithDepth(root.children, 1)) {
        all.push({ node, depth, collapsed: false, hiddenChildren: 0 });
      }
    }
  }
  return {
    rows: options.clipRows === false ? all : all.slice(0, maxRows2),
    hidden: options.clipRows === false ? 0 : Math.max(0, all.length - maxRows2),
    hiddenRoots
  };
}
function normalizeMaxRoots(value) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 3;
  return Math.max(1, Math.min(50, numeric));
}
function normalizeSidebarRows(value) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(100, numeric));
}
function normalizeTuiLayout(value) {
  return value === "sidebar" ? "sidebar" : "composer";
}
function nextTuiLayout(current) {
  return current === "sidebar" ? "composer" : "sidebar";
}
var NOTES_LINE_MAX_CHARS = 72;
function noteAuthorPrefix(note, viewerSessionID) {
  if (!viewerSessionID || note.sessionId === viewerSessionID) return "";
  return note.agent ? `[Subagent (${note.agent})] ` : "[Subagent] ";
}
function truncateNote(text, maxChars) {
  const oneLine = oneLineText(text);
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}\u2026`;
}
function latestSayNote(notes) {
  const list = (notes ?? []).filter((note) => note && oneLineText(note.text));
  if (list.length === 0) return void 0;
  return list.reduce(
    (newest, note) => (note.at ?? 0) > (newest.at ?? 0) ? note : newest
  );
}
function buildNotesLine(notes, viewerSessionID, options = {}) {
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
function sayNoteWarns(note) {
  return note.kind === "blocked" || note.kind === "question";
}
function buildNoteToast(note, viewerSessionID) {
  const eta = note.eta ? ` \xB7 ETA ${note.eta}` : "";
  return {
    message: `${noteAuthorPrefix(note, viewerSessionID)}${oneLineText(note.text)}${eta}`,
    warning: sayNoteWarns(note)
  };
}
function formatNotesDialog(notes, options = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const list = [...notes ?? []].filter((note) => note && oneLineText(note.text)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
  return list.map((note) => {
    const time = Number.isFinite(note.at) ? new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const eta = note.eta ? ` \xB7 ETA ${note.eta}` : "";
    const prefix = noteAuthorPrefix(note, options.viewerSessionID);
    return `${time ? `[${time}] ` : ""}${note.kind}${eta}: ${prefix}${oneLineText(note.text)}`;
  }).join("\n");
}

// src/say.ts
var DEFAULT_MIN_CHARS = 180;
var DEFAULT_MAX_CHARS = 260;
var DEFAULT_BUDGET = 3;
var DEFAULT_COOLDOWN_MS = 15e3;
var SAY_MODES = ["pill", "toast", "tree"];
var DEFAULT_SAY_MODES = ["tree"];
function sayModeValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string");
  }
  return [];
}
function normalizeSayModes(value) {
  if (value === void 0 || value === null) return [...DEFAULT_SAY_MODES];
  const modes = [];
  for (const raw of sayModeValues(value)) {
    const mode = raw.trim();
    if (SAY_MODES.includes(mode) && !modes.includes(mode)) modes.push(mode);
  }
  return modes;
}
function tuiSaySurfaces(modes = DEFAULT_SAY_MODES) {
  const enabled = new Set(modes);
  return {
    line: enabled.has("tree") || enabled.has("pill"),
    toast: enabled.has("toast")
  };
}
var DEFAULT_SAY_AUTO_HIDE_TIMEOUT_MS = 6e4;
var MAX_SAY_AUTO_HIDE_TIMEOUT_MS = 864e5;
function visibleSayNotes(notes, now, timeoutMs) {
  const list = notes ?? [];
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return [...list];
  return list.filter((note) => {
    const at = typeof note.at === "number" && Number.isFinite(note.at) ? note.at : 0;
    return now - at < timeoutMs;
  });
}
function integerInRange(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
function normalizeSayOptions(raw) {
  const options = raw ?? {};
  const minChars = integerInRange(options.sayMinChars, DEFAULT_MIN_CHARS, 20, 600);
  const maxChars = Math.max(
    minChars,
    integerInRange(options.sayMaxChars, DEFAULT_MAX_CHARS, 20, 600)
  );
  const modesSource = options.sayModes === void 0 || options.sayModes === null ? options.sayMode : options.sayModes;
  return {
    enabled: options.say === true,
    minChars,
    maxChars,
    budgetPerTurn: integerInRange(options.sayBudgetPerTurn, DEFAULT_BUDGET, 1, 10),
    cooldownMs: integerInRange(options.sayCooldownMs, DEFAULT_COOLDOWN_MS, 0, 12e4),
    chatNotes: options.sayChatNotes !== false,
    finalGuard: options.sayFinalGuard !== false,
    modes: normalizeSayModes(modesSource),
    toastScope: normalizeSayToastScope(options.sayToastScope),
    autoHideTimeoutMs: integerInRange(
      options.sayAutoHideTimeoutMs,
      DEFAULT_SAY_AUTO_HIDE_TIMEOUT_MS,
      0,
      MAX_SAY_AUTO_HIDE_TIMEOUT_MS
    )
  };
}
var SAY_TOAST_DURATION_MS = 5e3;
var SAY_WARNING_TOAST_DURATION_MS = 12e3;
function normalizeSayToastScope(value) {
  return value === "all" || value === "warnings" ? value : "own";
}
function sayToastNotes(notes, viewerSessionID, scope) {
  if (scope === "all") return [...notes];
  if (scope === "warnings") {
    return notes.filter(
      (note) => note.sessionId === viewerSessionID || note.kind === "blocked" || note.kind === "question"
    );
  }
  return notes.filter((note) => note.sessionId === viewerSessionID);
}
function sayToastDurationMs(kind) {
  return kind === "blocked" || kind === "question" ? SAY_WARNING_TOAST_DURATION_MS : SAY_TOAST_DURATION_MS;
}

// src/custom-nudges.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path4 from "node:path";
var NUDGE_RULE_LIMIT = 20;
var NUDGE_TEXT_LIMIT = 240;
var NUDGE_PLACEHOLDERS = ["id", "title", "status", "age", "count", "action"];
var KNOWN_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "error"
];
var SCOPES = ["global", "project", "session"];
var DELIVERIES = [
  "context-replace",
  "context-alongside",
  "synthetic"
];
var SEVERITIES = ["info", "warn", "block"];
var MIN_TRIGGER_MS = 5e3;
var MAX_TRIGGER_MS = 24 * 60 * 60 * 1e3;
var MIN_COOLDOWN_MS = 0;
var MAX_COOLDOWN_MS = 24 * 60 * 60 * 1e3;
var MIN_TTL_MS = 1e4;
var MAX_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var MIN_STALE_MS = 3e4;
var clampInt = (value, min, max, fallback) => {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
};
var asScope = (value, fallback = "session") => SCOPES.includes(value) ? value : fallback;
var asSeverity = (value, fallback = "warn") => SEVERITIES.includes(value) ? value : fallback;
var asDelivery = (value, fallback = "context-alongside") => DELIVERIES.includes(value) ? value : fallback;
var asId = (value) => String(value ?? "").trim().replace(/\s+/g, "-");
function parseNudgeDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string" || !value.trim()) return void 0;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) return void 0;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = unit === "d" ? 864e5 : unit === "h" ? 36e5 : unit === "m" ? 6e4 : unit === "s" ? 1e3 : 1;
  return Math.max(0, Math.round(amount * factor));
}
function formatNudgeDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "off";
  if (ms < 6e4) return `${Math.round(ms / 1e3)}s`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m`;
  if (ms < 864e5) return `${Math.round(ms / 36e5)}h`;
  return `${Math.round(ms / 864e5)}d`;
}
function invalidNudgePlaceholders(text) {
  const found = /* @__PURE__ */ new Set();
  for (const match of String(text ?? "").matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    if (!NUDGE_PLACEHOLDERS.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}
function normalizeTrigger(raw) {
  const errors = [];
  const value = raw ?? {};
  const type = String(value.type ?? "interval");
  const everyMsRaw = parseNudgeDuration(value.everyMs ?? value.every);
  const everyStepsRaw = typeof value.everySteps === "number" ? value.everySteps : Number(value.everySteps ?? Number.NaN);
  if (type === "event") return { trigger: { type: "event" }, errors };
  if (type === "steps") {
    if (!Number.isFinite(everyStepsRaw) || everyStepsRaw < 1) {
      errors.push("trigger.everySteps must be at least 1");
      return { trigger: { type: "steps", everySteps: 3 }, errors };
    }
    return {
      trigger: { type: "steps", everySteps: clampInt(everyStepsRaw, 1, 1e4, 3) },
      errors
    };
  }
  if (type === "either") {
    const everyMs = everyMsRaw == null ? void 0 : clampInt(everyMsRaw, MIN_TRIGGER_MS, MAX_TRIGGER_MS, 3e5);
    const everySteps = Number.isFinite(everyStepsRaw) && everyStepsRaw > 0 ? clampInt(everyStepsRaw, 1, 1e4, 3) : void 0;
    if (everyMs == null && everySteps == null) {
      errors.push("trigger.either needs everyMs and/or everySteps");
      return { trigger: { type: "either", everyMs: 3e5 }, errors };
    }
    return {
      trigger: {
        type: "either",
        ...everyMs != null ? { everyMs } : {},
        ...everySteps != null ? { everySteps } : {}
      },
      errors
    };
  }
  return {
    trigger: {
      type: "interval",
      everyMs: everyMsRaw == null ? 3e5 : clampInt(everyMsRaw, MIN_TRIGGER_MS, MAX_TRIGGER_MS, 3e5)
    },
    errors
  };
}
function normalizeCriteria(raw) {
  if (!raw || typeof raw !== "object") return {};
  const value = raw;
  const criteria = {};
  if (Array.isArray(value.statuses)) {
    const statuses = value.statuses.map((status) => String(status)).filter(
      (status) => KNOWN_STATUSES.includes(status)
    );
    if (statuses.length > 0) criteria.statuses = [...new Set(statuses)];
  }
  const stale = parseNudgeDuration(value.staleAfterMs ?? value.staleAfter);
  if (stale != null && stale >= MIN_STALE_MS) criteria.staleAfterMs = stale;
  const noProgressMs = parseNudgeDuration(value.noProgressAfterMs ?? value.noProgressAfter);
  if (noProgressMs != null && noProgressMs >= MIN_STALE_MS) {
    criteria.noProgressAfterMs = noProgressMs;
  }
  const noProgressSteps = typeof value.noProgressAfterSteps === "number" ? value.noProgressAfterSteps : Number(value.noProgressAfterSteps ?? Number.NaN);
  if (Number.isFinite(noProgressSteps) && noProgressSteps >= 1) {
    criteria.noProgressAfterSteps = clampInt(noProgressSteps, 1, 1e4, 3);
  }
  if (value.inFlight === "only" || value.inFlight === "never" || value.inFlight === "any") {
    criteria.inFlight = value.inFlight;
  }
  if (value.tree === "empty" || value.tree === "nonempty") criteria.tree = value.tree;
  if (value.idleOnly === true) criteria.idleOnly = true;
  if (Array.isArray(value.entryIds)) {
    const ids = value.entryIds.map((id) => String(id).trim()).filter(Boolean);
    if (ids.length > 0) criteria.entryIds = [...new Set(ids)].slice(0, 50);
  }
  if (value.sessions === "self" || value.sessions === "children" || value.sessions === "all") {
    criteria.sessions = value.sessions;
  }
  return criteria;
}
function normalizeNudgeRule(raw, fallbackScope = "session") {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["rule must be an object"], warnings };
  }
  const value = raw;
  const id = asId(value.id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    errors.push("id must be a 1-64 character slug (letters, numbers, . _ -)");
  }
  let text = String(value.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) errors.push("text is required");
  if (text.length > NUDGE_TEXT_LIMIT) {
    warnings.push(`text truncated to ${NUDGE_TEXT_LIMIT} characters`);
    text = `${text.slice(0, NUDGE_TEXT_LIMIT - 1).trimEnd()}\u2026`;
  }
  const unknown = invalidNudgePlaceholders(text);
  if (unknown.length > 0) {
    errors.push(`unknown placeholder(s): ${unknown.map((name) => `{${name}}`).join(", ")}`);
  }
  const severity = asSeverity(value.severity);
  const delivery = asDelivery(value.delivery);
  if (delivery === "synthetic" && severity !== "block") {
    errors.push('delivery "synthetic" requires severity "block"');
  }
  const { trigger, errors: triggerErrors } = normalizeTrigger(value.trigger);
  errors.push(...triggerErrors);
  const rule = {
    id,
    enabled: value.enabled !== false,
    scope: asScope(value.scope, fallbackScope),
    text,
    severity,
    trigger,
    cooldownMs: clampInt(
      parseNudgeDuration(value.cooldownMs ?? value.cooldown) ?? 12e4,
      MIN_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
      12e4
    ),
    criteria: normalizeCriteria(value.criteria ?? value),
    delivery,
    ttlMs: value.ttlMs === 0 || value.ttl === 0 ? 0 : clampInt(
      parseNudgeDuration(value.ttlMs ?? value.ttl) ?? 36e5,
      MIN_TTL_MS,
      MAX_TTL_MS,
      36e5
    ),
    maxFires: clampInt(value.maxFires ?? 0, 0, 1e3, 0)
  };
  if (value.title != null && String(value.title).trim()) {
    rule.title = String(value.title).trim().slice(0, 120);
  }
  if (typeof value.createdAt === "number" && Number.isFinite(value.createdAt)) {
    rule.createdAt = Math.floor(value.createdAt);
  }
  if (value.source === "user" || value.source === "agent" || value.source === "config") {
    rule.source = value.source;
  }
  return { ok: errors.length === 0, rule, errors, warnings };
}
var NUDGE_PRESETS = [
  {
    value: "replace",
    title: "Replace built-ins (recommended)",
    description: "One [warn] context reminder every 5m; pauses the built-in nudges while active."
  },
  {
    value: "alongside",
    title: "Alongside built-ins",
    description: "Same timing, but built-in nudges keep running; identical text is deduped."
  },
  {
    value: "block",
    title: "Synthetic block",
    description: "A real turn input when it fires. Use for hard stop conditions only."
  },
  {
    value: "custom",
    title: "Custom",
    description: "Choose trigger, criteria, delivery, TTL, and fire cap yourself."
  }
];
function presetDefaults(preset) {
  switch (preset) {
    case "replace":
      return {
        delivery: "context-replace",
        severity: "warn",
        trigger: { type: "interval", everyMs: 3e5 },
        cooldownMs: 12e4,
        ttlMs: 36e5,
        maxFires: 0
      };
    case "alongside":
      return {
        delivery: "context-alongside",
        severity: "warn",
        trigger: { type: "interval", everyMs: 3e5 },
        cooldownMs: 12e4,
        ttlMs: 36e5,
        maxFires: 0
      };
    case "block":
      return {
        delivery: "synthetic",
        severity: "block",
        trigger: { type: "interval", everyMs: 3e5 },
        cooldownMs: 12e4,
        ttlMs: 36e5,
        maxFires: 1
      };
    default:
      return {};
  }
}
function buildNudgeRule(input, preset = "custom", fallbackScope = "session") {
  return normalizeNudgeRule({ ...presetDefaults(preset), ...input }, fallbackScope);
}
function mergeNudgeRules(layers) {
  const disabled = (rules) => new Set((rules ?? []).filter((rule) => !rule.enabled).map((rule) => rule.id));
  const projectTombstones = disabled(layers.project);
  const sessionTombstones = disabled(layers.session);
  const effective = [];
  for (const rule of layers.session ?? []) {
    if (rule.enabled) effective.push(rule);
  }
  for (const rule of layers.project ?? []) {
    if (rule.enabled && !sessionTombstones.has(rule.id)) effective.push(rule);
  }
  for (const rule of layers.global ?? []) {
    if (rule.enabled && !sessionTombstones.has(rule.id) && !projectTombstones.has(rule.id)) {
      effective.push(rule);
    }
  }
  return effective;
}
function describeNudgeTrigger(rule) {
  const trigger = rule.trigger;
  if (trigger.type === "event") return "on event";
  if (trigger.type === "steps") return `every ${trigger.everySteps} steps`;
  if (trigger.type === "either") {
    const parts = [
      trigger.everyMs != null ? `every ${formatNudgeDuration(trigger.everyMs)}` : null,
      trigger.everySteps != null ? `${trigger.everySteps} steps` : null
    ].filter(Boolean);
    return parts.length > 0 ? `either ${parts.join(" or ")}` : "either";
  }
  return `every ${formatNudgeDuration(trigger.everyMs)}`;
}
function describeNudgeCriteria(rule) {
  const parts = [];
  const c = rule.criteria;
  if (c.statuses?.length) parts.push(`status ${c.statuses.join("/")}`);
  if (c.staleAfterMs != null) parts.push(`stale > ${formatNudgeDuration(c.staleAfterMs)}`);
  if (c.noProgressAfterMs != null) parts.push(`no progress > ${formatNudgeDuration(c.noProgressAfterMs)}`);
  if (c.noProgressAfterSteps != null) parts.push(`${c.noProgressAfterSteps}+ steps`);
  if (c.inFlight && c.inFlight !== "any") parts.push(c.inFlight === "only" ? "in flight" : "idle only");
  if (c.tree) parts.push(`tree ${c.tree}`);
  if (c.idleOnly) parts.push("turn end");
  if (c.entryIds?.length) parts.push(`ids ${c.entryIds.join(",")}`);
  if (c.sessions && c.sessions !== "self") parts.push(`sessions ${c.sessions}`);
  return parts.length > 0 ? parts.join("; ") : "any open tree";
}
function findProjectRoot(directory, exists = existsSync) {
  let current = path4.resolve(directory);
  while (true) {
    if (exists(path4.join(current, ".git")) || exists(path4.join(current, ".opencode"))) {
      return current;
    }
    const parent = path4.dirname(current);
    if (parent === current) return path4.resolve(directory);
    current = parent;
  }
}
function resolveNudgePaths(options) {
  const home = options.home ?? homedir();
  const config = path4.join(home, ".config", "opencode");
  const projectRoot = findProjectRoot(options.directory);
  return {
    globalFile: path4.join(config, "progress-nudge.json"),
    projectFile: path4.join(projectRoot, ".opencode", "progress-nudge.json"),
    sessionFile: path4.join(config, "progress-nudge-sessions.json"),
    projectRoot
  };
}
function readJson2(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function atomicWriteJson(file, value) {
  mkdirSync(path4.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync(tmp, file);
}
function readNudgeRuleFile(file, scope) {
  const raw = readJson2(file);
  if (!raw || typeof raw !== "object") return { rules: [], errors: [] };
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  const rules = [];
  const errors = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...item, scope }, scope);
    if (result.ok && result.rule) {
      rules.push(result.rule);
    } else {
      errors.push(
        `${scope}:${String(item?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}
function writeNudgeRuleFile(file, rules) {
  const payload = { version: 1, rules: rules.slice(0, NUDGE_RULE_LIMIT) };
  atomicWriteJson(file, payload);
}
function upsertNudgeRule(file, scope, rule) {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`${scope} scope is limited to ${NUDGE_RULE_LIMIT} rules`]
    };
  }
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}
function setNudgeRuleEnabled(file, scope, id, enabled) {
  const existing = readNudgeRuleFile(file, scope);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    if (!enabled) {
      const tombstone = {
        id,
        enabled: false,
        scope,
        text: "disabled",
        severity: "warn",
        trigger: { type: "event" },
        cooldownMs: 0,
        criteria: {},
        delivery: "context-alongside",
        ttlMs: 0,
        maxFires: 0,
        createdAt: Date.now()
      };
      const rules2 = [...existing.rules, tombstone];
      writeNudgeRuleFile(file, rules2);
      return { rules: rules2, errors: existing.errors };
    }
    return { rules: existing.rules, errors: [`${scope}:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => rule.id === id ? { ...rule, enabled } : rule);
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}
function clearNudgeRule(file, scope, id) {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}
function readSessionNudgeRules(file, sessionID) {
  const raw = readJson2(file);
  const list = raw?.sessions?.[sessionID];
  if (!Array.isArray(list)) return { rules: [], errors: [] };
  const rules = [];
  const errors = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...item, scope: "session" }, "session");
    if (result.ok && result.rule) rules.push(result.rule);
    else {
      errors.push(
        `session:${String(item?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}
function readSessionMapFile(file) {
  const raw = readJson2(file);
  if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions == null) {
    return { version: 1, sessions: {} };
  }
  return { version: 1, sessions: raw.sessions };
}
function upsertSessionNudgeRule(file, sessionID, rule) {
  const store = readSessionMapFile(file);
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope: "session" });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`session scope is limited to ${NUDGE_RULE_LIMIT} rules`]
    };
  }
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}
function setSessionNudgeRuleEnabled(file, sessionID, id, enabled) {
  const existing = readSessionNudgeRules(file, sessionID);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    return { rules: existing.rules, errors: [`session:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => rule.id === id ? { ...rule, enabled } : rule);
  const store = readSessionMapFile(file);
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}
function clearSessionNudgeRule(file, sessionID, id) {
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  const store = readSessionMapFile(file);
  if (rules.length > 0) store.sessions[sessionID] = rules;
  else delete store.sessions[sessionID];
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

// src/tui-nudges.ts
function parseFlags(args) {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const positional = [];
  const values = {};
  const booleans = /* @__PURE__ */ new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positional.push(token.replace(/^["']|["']$/g, ""));
      continue;
    }
    const key = token.slice(2);
    if (key === "idle" || key === "one-shot" || key === "event") {
      booleans.add(key);
      continue;
    }
    const next = tokens[i + 1];
    if (next != null && !next.startsWith("--")) {
      values[key] = next.replace(/^["']|["']$/g, "");
      i += 1;
    } else {
      booleans.add(key);
    }
  }
  return { positional, values, booleans };
}
function scoped(context) {
  return resolveNudgePaths({ directory: context.location?.directory ?? process.cwd() });
}
function allRules(context, sessionID) {
  const paths = scoped(context);
  const global = readNudgeRuleFile(paths.globalFile, "global");
  const project = readNudgeRuleFile(paths.projectFile, "project");
  const session = readSessionNudgeRules(paths.sessionFile, sessionID);
  const merged = mergeNudgeRules({
    global: global.rules,
    project: project.rules,
    session: session.rules
  });
  return {
    paths,
    global,
    project,
    session,
    merged,
    errors: [...global.errors, ...project.errors, ...session.errors]
  };
}
function row(rule, effective, detailed) {
  const state2 = rule.enabled ? effective ? "on" : "muted" : "off";
  const base = `${rule.scope}:${rule.id} [${state2}] ${rule.text}`;
  if (!detailed) return base;
  return [
    base,
    `  ${describeNudgeTrigger(rule)}; ${describeNudgeCriteria(rule)}`,
    `  severity ${rule.severity}, ${rule.delivery}, cooldown ${formatNudgeDuration(rule.cooldownMs)}, ttl ${formatNudgeDuration(rule.ttlMs)}, max fires ${rule.maxFires === 0 ? "unlimited" : rule.maxFires}`
  ].join("\n");
}
async function showList(context, sessionID, detailed) {
  const { global, project, session, merged, errors } = allRules(context, sessionID);
  const effective = new Set(merged.map((rule) => `${rule.scope}:${rule.id}`));
  const rows = [
    ...session.rules.map((rule) => row(rule, effective.has(`session:${rule.id}`), detailed)),
    ...project.rules.map((rule) => row(rule, effective.has(`project:${rule.id}`), detailed)),
    ...global.rules.map((rule) => row(rule, effective.has(`global:${rule.id}`), detailed))
  ];
  const notes = [];
  if (rows.length === 0) notes.push("No custom nudge rules yet.");
  if (errors.length > 0) notes.push(`Invalid rules: ${errors.join("; ")}`);
  await context.ui.dialog.alert({
    title: "Progress custom nudges",
    message: [...rows, ...notes].join("\n\n")
  });
}
function parseTarget(raw, sessionID) {
  if (!raw) return null;
  const [maybeScope, maybeId] = raw.includes(":") ? raw.split(":", 2) : ["session", raw];
  const scope = maybeScope === "global" || maybeScope === "project" || maybeScope === "session" ? maybeScope : "session";
  const id = (maybeId ?? "").trim();
  if (!id) return null;
  return { scope, id };
}
async function toggle(context, sessionID, args, enabled, clear) {
  const flags = parseFlags(args);
  const target = parseTarget(flags.positional[0] ?? flags.values.id, sessionID);
  if (!target) {
    context.ui.toast.show({ message: "Use <scope>:<id>, e.g. session:build", variant: "warning" });
    return;
  }
  const paths = scoped(context);
  if (target.scope === "session") {
    const result2 = clear ? clearSessionNudgeRule(paths.sessionFile, sessionID, target.id) : setSessionNudgeRuleEnabled(paths.sessionFile, sessionID, target.id, enabled);
    context.ui.toast.show({
      message: result2.errors.length > 0 ? result2.errors.join("; ") : `Nudge session:${target.id} ${clear ? "cleared" : enabled ? "enabled" : "disabled"}.`,
      variant: result2.errors.length > 0 ? "warning" : "success"
    });
    return;
  }
  const file = target.scope === "global" ? paths.globalFile : paths.projectFile;
  const result = clear ? clearNudgeRule(file, target.scope, target.id) : setNudgeRuleEnabled(file, target.scope, target.id, enabled);
  context.ui.toast.show({
    message: result.errors.length > 0 ? result.errors.join("; ") : `Nudge ${target.scope}:${target.id} ${clear ? "cleared" : enabled ? "enabled" : "disabled"}.`,
    variant: result.errors.length > 0 ? "warning" : "success"
  });
}
async function saveRule(context, sessionID, rule) {
  const paths = scoped(context);
  const result = rule.scope === "session" ? upsertSessionNudgeRule(paths.sessionFile, sessionID, rule) : upsertNudgeRule(rule.scope === "global" ? paths.globalFile : paths.projectFile, rule.scope, rule);
  if (result.errors.length > 0) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7e3 });
    return false;
  }
  context.ui.toast.show({
    message: `Saved nudge ${rule.scope}:${rule.id} \xB7 ${describeNudgeTrigger(rule)}`,
    variant: "success"
  });
  return true;
}
async function wizard(context, sessionID) {
  const preset = await context.ui.dialog.select({
    title: "Custom nudge preset",
    options: NUDGE_PRESETS.map((choice) => ({
      title: choice.title,
      value: choice.value,
      description: choice.description
    }))
  });
  if (!preset) return;
  const scope = await context.ui.dialog.select({
    title: "Where should this rule live?",
    options: [
      { title: "Session", value: "session", description: "This session only (stored separately)" },
      { title: "Project", value: "project", description: "Every session in this project" },
      { title: "Global", value: "global", description: "Every session, in ~/.config/opencode" }
    ],
    current: "session"
  });
  if (!scope) return;
  const id = (await context.ui.dialog.prompt({
    title: "Rule id",
    description: "Slug used by on/off/clear, e.g. stale-build",
    placeholder: "stale-build"
  }))?.trim();
  if (!id) return;
  const text = (await context.ui.dialog.prompt({
    title: "Reminder text",
    description: "Model-facing. Placeholders: {id} {title} {status} {age} {count} {action}",
    placeholder: "{id} has been {status} for {age} \u2014 {action}"
  }))?.trim();
  if (!text) return;
  let every;
  if (preset === "custom") {
    every = (await context.ui.dialog.prompt({
      title: "Interval (blank for event-only)",
      description: "5m, 30s, 2h",
      placeholder: "5m"
    }))?.trim() || void 0;
  }
  const severity = preset === "block" ? "block" : await context.ui.dialog.select({
    title: "Severity",
    options: [
      { title: "warn (context)", value: "warn" },
      { title: "info (context)", value: "info" },
      { title: "block (synthetic only if delivery is synthetic)", value: "block" }
    ],
    current: "warn"
  }) ?? "warn";
  const result = buildNudgeRule(
    {
      id,
      text,
      scope,
      severity,
      ...every ? { trigger: { type: "interval", everyMs: every } } : {},
      ...preset === "custom" && !every ? { trigger: { type: "event" } } : {},
      source: "user",
      createdAt: Date.now()
    },
    preset,
    scope
  );
  if (!result.ok || !result.rule) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7e3 });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Save custom nudge?",
    message: [
      `${result.rule.scope}:${result.rule.id} \xB7 ${result.rule.severity} \xB7 ${result.rule.delivery}`,
      `${describeNudgeTrigger(result.rule)}; ${describeNudgeCriteria(result.rule)}`,
      `Text: ${result.rule.text}`
    ].join("\n")
  });
  if (!confirmed) return;
  await saveRule(context, sessionID, result.rule);
}
async function runNudgeCommand(context, sessionID, rawArgs) {
  const args = rawArgs.trim();
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage custom nudges", variant: "warning" });
    return;
  }
  const sub = (args.split(/\s+/)[0] ?? "").toLowerCase();
  const rest = args.slice(sub.length).trim();
  if (!sub || sub === "wizard") {
    await wizard(context, sessionID);
    return;
  }
  if (sub === "list" || sub === "status") {
    await showList(context, sessionID, sub === "status" || rest.includes("--detailed"));
    return;
  }
  if (sub === "on") {
    await toggle(context, sessionID, rest, true, false);
    return;
  }
  if (sub === "off") {
    await toggle(context, sessionID, rest, false, false);
    return;
  }
  if (sub === "clear") {
    await toggle(context, sessionID, rest, false, true);
    return;
  }
  if (sub !== "set") {
    context.ui.toast.show({
      message: "Usage: /progress nudge [list|status|set|on|off|clear]",
      variant: "warning"
    });
    return;
  }
  const flags = parseFlags(rest);
  if (!flags.values.id || !flags.values.text) {
    await wizard(context, sessionID);
    return;
  }
  const scope = flags.values.scope === "global" || flags.values.scope === "project" ? flags.values.scope : "session";
  const criteria = {};
  if (flags.values.status) criteria.statuses = flags.values.status.split(",").map((s) => s.trim());
  if (flags.values.stale) criteria.staleAfter = flags.values.stale;
  if (flags.values["no-progress"]) criteria.noProgressAfter = flags.values["no-progress"];
  if (flags.values["no-progress-steps"]) criteria.noProgressAfterSteps = Number(flags.values["no-progress-steps"]);
  if (flags.values["in-flight"]) criteria.inFlight = flags.values["in-flight"];
  if (flags.values.tree) criteria.tree = flags.values.tree;
  if (flags.booleans.has("idle")) criteria.idleOnly = true;
  if (flags.values.ids) criteria.entryIds = flags.values.ids.split(",").map((s) => s.trim());
  if (flags.values.sessions) criteria.sessions = flags.values.sessions;
  const every = flags.values.every;
  const steps = flags.values.steps ? Number(flags.values.steps) : void 0;
  const trigger = flags.booleans.has("event") ? { type: "event" } : every && steps ? { type: "either", everyMs: parseNudgeDuration(every), everySteps: steps } : steps ? { type: "steps", everySteps: steps } : every ? { type: "interval", everyMs: parseNudgeDuration(every) } : void 0;
  const preset = flags.values.preset ?? "custom";
  const result = buildNudgeRule(
    {
      id: flags.values.id,
      title: flags.values.title,
      text: flags.values.text,
      scope,
      severity: flags.values.severity,
      delivery: flags.values.delivery,
      trigger,
      cooldownMs: flags.values.cooldown,
      ttlMs: flags.values.ttl,
      maxFires: flags.booleans.has("one-shot") ? 1 : flags.values["max-fires"] ? Number(flags.values["max-fires"]) : void 0,
      criteria,
      source: "user",
      createdAt: Date.now()
    },
    preset,
    scope
  );
  if (!result.ok || !result.rule) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7e3 });
    return;
  }
  await saveRule(context, sessionID, result.rule);
}

// src/tui.js
var [state, setState] = createSignal(readProgressState());
var [taskListStatus, setTaskListStatus] = createSignal(readTaskListStatus());
var [expandedBySession, setExpandedBySession] = createSignal({});
var pollers = 0;
var timer;
var barOptions = {};
var visibilityOptions = {};
var themeState = {
  value: "ascii"
};
var setTreeThemeState;
var indicatorState = {
  value: "dot"
};
var setIndicatorState;
function presetBarOptions() {
  return {
    ...barOptions,
    style: themeState.value === "emoji" ? "emoji" : "blocks"
  };
}
var maxRows = 8;
var sidebarRows = 0;
var expandRootsByDefault = false;
var rootCapState = {
  value: 3
};
var setRootCap;
var layoutState = {
  mode: "composer"
};
var setLayout;
var collapsedState = {
  value: false
};
var setCollapsed;
var sayLineEnabled = true;
var autoHideTimeoutMs = 6e4;
var sayToastHook;
function refreshState() {
  const next = readProgressState();
  setState(next);
  sayToastHook?.(next);
  return next;
}
function startPolling(refreshMs) {
  pollers += 1;
  refreshState();
  setTaskListStatus(readTaskListStatus());
  if (!timer) {
    timer = setInterval(() => {
      refreshState();
      setTaskListStatus(readTaskListStatus());
    }, refreshMs);
  }
  return () => {
    pollers -= 1;
    if (pollers <= 0) {
      if (timer) clearInterval(timer);
      timer = void 0;
      pollers = 0;
    }
  };
}
function glyph(status) {
  return indicatorGlyph(indicatorState.value, status);
}
function expandedFor(sessionID) {
  return expandedBySession()[sessionID] ?? /* @__PURE__ */ new Set();
}
function toggleExpanded(sessionID, key) {
  setExpandedBySession((prev) => {
    const next = {
      ...prev
    };
    const set = new Set(prev[sessionID] ?? []);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    next[sessionID] = set;
    return next;
  });
}
function allRootsForSession(sessionID) {
  const entries = state().entries ?? {};
  return buildVisibleTree(scopeEntries(entries, sessionID, visibilityOptions), Date.now(), visibilityOptions);
}
function rootsForSession(sessionID) {
  return allRootsForSession(sessionID);
}
var STATUS_SUMMARY_ORDER = ["error", "running", "waiting", "pending", "done"];
function statusSummary(roots) {
  const counts = {
    pending: 0,
    error: 0,
    running: 0,
    waiting: 0,
    done: 0
  };
  for (const root of roots) {
    if (root.status && root.status in counts) counts[root.status] += 1;
  }
  return STATUS_SUMMARY_ORDER.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`).join(" / ");
}
function leftClick(event) {
  return event.button === void 0 || event.button === 0;
}
function ProgressRow(props) {
  const ctx = usePlugin();
  const indent = () => props.row.depth === 0 ? "" : "\u2514\u2500 ";
  const detailIndent = () => props.row.depth === 0 ? "  \xB7 " : "    \xB7 ";
  const isRoot = () => props.row.depth === 0;
  const hasChildren = () => (props.row.node.children?.length ?? 0) > 0;
  const hasMarker = () => isRoot() && hasChildren();
  const onToggle = (event) => {
    if (!leftClick(event) || !hasMarker()) return;
    toggleExpanded(props.sessionID, props.row.node.key);
  };
  const onDetail = (event) => {
    if (!leftClick(event)) return;
    showRootDetail(ctx, props.row.node);
  };
  const onDismiss = (event) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    dismissRoots(ctx, [props.row.node]);
  };
  const title = () => `${props.row.depth === 0 ? subagentPrefix(props.row.node) : ""}${props.row.node.title}`;
  const marker = () => props.row.collapsed ? "[+] " : "[-] ";
  const suffix = () => props.row.hiddenChildren > 0 ? `  +${props.row.hiddenChildren}` : "";
  const detailPreview = () => {
    const full = oneLineText(props.row.node.detail ?? "");
    return full.length > 120 ? `${full.slice(0, 120)}\u2026` : full;
  };
  const label = () => {
    if (themeState.value === "ultra-compact") {
      return `${glyph(props.row.node.status)} ${title()}`;
    }
    if (themeState.value === "compact") {
      const meta = compactTreeSuffix(props.row.node.progress, props.row.hiddenChildren);
      return `${glyph(props.row.node.status)} ${title()}${meta ? ` ${meta}` : ""}`;
    }
    const parts = barParts(props.row.node.progress, presetBarOptions());
    if (parts.style === "emoji") {
      const done = props.row.node.status === "done" ? " \u2713" : props.row.node.status === "error" ? " \u2717" : "";
      return `${title()}: ${parts.bar}${parts.fraction}${done}${suffix()}`;
    }
    const pct = progressLabel(props.row.node.progress);
    return `${glyph(props.row.node.status)} [${parts.bar}] ${title()}${pct ? ` ${pct}` : ""}${suffix()}`;
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$6 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$4);
    _$insertNode(_el$2, _el$6);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "alignItems", "flex-start");
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return hasMarker();
      },
      get fallback() {
        return _$memo(() => !!isRoot())() ? (() => {
          var _el$9 = _$createElement("text");
          _$insertNode(_el$9, _$createTextNode(`    `));
          _$setProp(_el$9, "selectable", false);
          return _el$9;
        })() : null;
      },
      get children() {
        var _el$3 = _$createElement("text");
        _$setProp(_el$3, "selectable", false);
        _$setProp(_el$3, "onMouseUp", onToggle);
        _$insert(_el$3, marker);
        _$effect((_$p) => _$setProp(_el$3, "fg", ctx.theme.text.muted, _$p));
        return _el$3;
      }
    }), _el$4);
    _$insertNode(_el$4, _el$5);
    _$setProp(_el$4, "selectable", false);
    _$setProp(_el$4, "wrapMode", "word");
    _$setProp(_el$4, "flexGrow", 1);
    _$setProp(_el$4, "flexShrink", 1);
    _$setProp(_el$4, "onMouseUp", onDetail);
    _$insert(_el$5, indent);
    _$insert(_el$4, label, null);
    _$insertNode(_el$6, _$createTextNode(`  \u2715`));
    _$setProp(_el$6, "selectable", false);
    _$setProp(_el$6, "onMouseUp", onDismiss);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.row.node.detail)() && themeState.value !== "ultra-compact";
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "selectable", false);
        _$setProp(_el$8, "wrapMode", "word");
        _$setProp(_el$8, "onMouseUp", onDetail);
        _$insert(_el$8, () => `${detailIndent()}${detailPreview()}`);
        _$effect((_$p) => _$setProp(_el$8, "fg", ctx.theme.text.muted, _$p));
        return _el$8;
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = props.row.depth === 0 ? 0 : 2, _v$2 = ctx.theme.text.base, _v$3 = ctx.theme.text.muted, _v$4 = ctx.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "paddingLeft", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0
    });
    return _el$;
  })();
}
function ProgressTree(props) {
  const ctx = usePlugin();
  const capacity = props.capacity ?? maxRows;
  const stackedHeader = props.variant === "sidebar";
  const roots = () => rootsForSession(props.sessionID);
  const doneRoots = () => roots().filter((root) => root.status === "done");
  const notes = () => visibleSayNotes(sayNotesForSession(state(), props.sessionID), Date.now(), autoHideTimeoutMs);
  const notesLine = () => buildNotesLine(notes(), props.sessionID);
  const latestNote = () => latestSayNote(notes());
  const showNotesLine = () => sayLineEnabled && notesLine().length > 0;
  const onDismissNote = (event) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    const note = latestNote();
    if (!note) return;
    if (dismissSayNote(note.id)) {
      setState(readProgressState());
      ctx.ui.toast.show({
        message: "Note dismissed",
        variant: "success"
      });
    } else {
      ctx.ui.toast.show({
        message: "Note already dismissed",
        variant: "info"
      });
    }
  };
  const view = () => buildTuiView(roots(), {
    maxRows,
    maxRoots: rootCapState.value,
    clipRows: false,
    expanded: expandedFor(props.sessionID),
    expandByDefault: expandRootsByDefault
  });
  const lineCount = (rows) => rows.reduce((total, row2) => total + 1 + (row2.node.detail ? 1 : 0), 0);
  const viewportHeight = () => Math.max(1, Math.min(capacity, lineCount(view().rows)));
  const overflowLines = () => Math.max(0, lineCount(view().rows) - capacity);
  const onDismissDone = (event) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    dismissRoots(ctx, doneRoots());
  };
  const onDismissAll = (event) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    void confirmDismissAll(ctx, roots());
  };
  const title = () => (() => {
    var _el$1 = _$createElement("text");
    _$insertNode(_el$1, _$createTextNode(`progress`));
    _$setProp(_el$1, "selectable", false);
    _$setProp(_el$1, "onMouseUp", () => openProgressDialog(ctx));
    _$effect((_$p) => _$setProp(_el$1, "fg", ctx.theme.text.muted, _$p));
    return _el$1;
  })();
  const actions = () => (() => {
    var _el$11 = _$createElement("box"), _el$15 = _$createElement("text");
    _$insertNode(_el$11, _el$15);
    _$setProp(_el$11, "flexDirection", "row");
    _$insert(_el$11, _$createComponent(Show, {
      get when() {
        return doneRoots().length > 0;
      },
      get children() {
        return [(() => {
          var _el$12 = _$createElement("text");
          _$setProp(_el$12, "selectable", false);
          _$setProp(_el$12, "onMouseUp", onDismissDone);
          _$insert(_el$12, () => `dismiss done (${doneRoots().length})`);
          _$effect((_$p) => _$setProp(_el$12, "fg", ctx.theme.text.base, _$p));
          return _el$12;
        })(), (() => {
          var _el$13 = _$createElement("text");
          _$insertNode(_el$13, _$createTextNode(`  \xB7  `));
          _$effect((_$p) => _$setProp(_el$13, "fg", ctx.theme.text.muted, _$p));
          return _el$13;
        })()];
      }
    }), _el$15);
    _$setProp(_el$15, "selectable", false);
    _$setProp(_el$15, "onMouseUp", onDismissAll);
    _$insert(_el$15, () => `dismiss all (${roots().length})`);
    _$effect((_$p) => _$setProp(_el$15, "fg", ctx.theme.text.base, _$p));
    return _el$11;
  })();
  const collapsed = () => collapsedState.value === true;
  const summary = () => {
    const entries = state().entries ?? {};
    return summarizeRoots(allRootsForSession(props.sessionID), (root) => isDismissed(root, dismissedMap(entries)));
  };
  const hasContent = () => showNotesLine() || (collapsed() ? summary().length > 0 : view().rows.length > 0);
  return _$createComponent(Show, {
    get when() {
      return hasContent();
    },
    get children() {
      var _el$16 = _$createElement("box");
      _$setProp(_el$16, "flexDirection", "column");
      _$setProp(_el$16, "paddingLeft", 1);
      _$setProp(_el$16, "paddingRight", 1);
      _$setProp(_el$16, "paddingTop", 1);
      _$insert(_el$16, _$createComponent(Show, {
        get when() {
          return showNotesLine();
        },
        get children() {
          var _el$17 = _$createElement("box"), _el$18 = _$createElement("text"), _el$19 = _$createElement("text");
          _$insertNode(_el$17, _el$18);
          _$insertNode(_el$17, _el$19);
          _$setProp(_el$17, "flexDirection", "row");
          _$setProp(_el$17, "alignItems", "flex-start");
          _$setProp(_el$18, "selectable", false);
          _$setProp(_el$18, "wrapMode", "word");
          _$setProp(_el$18, "flexGrow", 1);
          _$setProp(_el$18, "flexShrink", 1);
          _$setProp(_el$18, "onMouseUp", () => openNotesDialog(ctx, props.sessionID));
          _$insert(_el$18, notesLine);
          _$insertNode(_el$19, _$createTextNode(`  \u2715`));
          _$setProp(_el$19, "selectable", false);
          _$setProp(_el$19, "onMouseUp", onDismissNote);
          _$effect((_p$) => {
            var _v$5 = ctx.theme.text.muted, _v$6 = ctx.theme.text.muted;
            _v$5 !== _p$.e && (_p$.e = _$setProp(_el$18, "fg", _v$5, _p$.e));
            _v$6 !== _p$.t && (_p$.t = _$setProp(_el$19, "fg", _v$6, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$17;
        }
      }), null);
      _$insert(_el$16, _$createComponent(Show, {
        get when() {
          return collapsed();
        },
        get children() {
          var _el$21 = _$createElement("text"), _el$22 = _$createElement("span");
          _$insertNode(_el$21, _el$22);
          _$setProp(_el$21, "selectable", false);
          _$setProp(_el$21, "onMouseUp", () => setCollapsed?.((draft) => {
            draft.value = false;
          }));
          _$insertNode(_el$22, _$createTextNode(`progress: `));
          _$insert(_el$21, summary, null);
          _$effect((_p$) => {
            var _v$7 = ctx.theme.text.base, _v$8 = ctx.theme.text.muted;
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$21, "fg", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$22, "fg", _v$8, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$21;
        }
      }), null);
      _$insert(_el$16, _$createComponent(Show, {
        get when() {
          return !collapsed();
        },
        get children() {
          return [_$createComponent(Show, {
            when: stackedHeader,
            get fallback() {
              return (() => {
                var _el$27 = _$createElement("box");
                _$setProp(_el$27, "flexDirection", "row");
                _$setProp(_el$27, "justifyContent", "space-between");
                _$insert(_el$27, title, null);
                _$insert(_el$27, actions, null);
                return _el$27;
              })();
            },
            get children() {
              return [_$memo(() => title()), _$memo(() => actions())];
            }
          }), _$createComponent(Show, {
            when: capacity > 0,
            get fallback() {
              return _$createComponent(For, {
                get each() {
                  return view().rows;
                },
                children: (row2) => _$createComponent(ProgressRow, {
                  row: row2,
                  get sessionID() {
                    return props.sessionID;
                  }
                })
              });
            },
            get children() {
              var _el$24 = _$createElement("scrollbox");
              _$setProp(_el$24, "scrollY", true);
              _$setProp(_el$24, "stickyStart", "top");
              _$setProp(_el$24, "focusable", false);
              _$insert(_el$24, _$createComponent(For, {
                get each() {
                  return view().rows;
                },
                children: (row2) => _$createComponent(ProgressRow, {
                  row: row2,
                  get sessionID() {
                    return props.sessionID;
                  }
                })
              }));
              _$effect((_$p) => _$setProp(_el$24, "height", viewportHeight(), _$p));
              return _el$24;
            }
          }), _$createComponent(Show, {
            get when() {
              return capacity > 0 && overflowLines() > 0;
            },
            get children() {
              var _el$25 = _$createElement("text");
              _$setProp(_el$25, "selectable", false);
              _$insert(_el$25, () => `--- scroll to see ${overflowLines()} more ---`);
              _$effect((_$p) => _$setProp(_el$25, "fg", ctx.theme.text.muted, _$p));
              return _el$25;
            }
          }), _$createComponent(Show, {
            get when() {
              return view().hiddenRoots > 0;
            },
            get children() {
              var _el$26 = _$createElement("text");
              _$setProp(_el$26, "selectable", false);
              _$setProp(_el$26, "onMouseUp", () => openProgressDialog(ctx));
              _$insert(_el$26, () => `view full progress tree (${statusSummary(roots())})`);
              _$effect((_$p) => _$setProp(_el$26, "fg", ctx.theme.text.base, _$p));
              return _el$26;
            }
          })];
        }
      }), null);
      return _el$16;
    }
  });
}
function currentSessionID(context) {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : void 0;
}
function dismissRoots(context, roots) {
  let count = 0;
  for (const root of roots) {
    if (writeDismissal(root.key, root.status ?? "")) count += 1;
  }
  context.ui.toast.show({
    message: count === 0 ? "Nothing to dismiss" : `Dismissed ${count} progress task${count === 1 ? "" : "s"}`,
    variant: count === 0 ? "info" : "success"
  });
}
function showRootDetail(context, root) {
  void context.ui.dialog.alert({
    title: `${subagentPrefix(root)}${root.title}`,
    message: rootDetailLines(root).join("\n")
  });
}
function swapLayout(context) {
  if (!setLayout) return;
  const next = nextTuiLayout(layoutState.mode);
  setLayout((draft) => {
    draft.mode = next;
  });
  context.ui.toast.show({
    message: next === "sidebar" ? "Progress moved to the sidebar" : "Progress moved above the prompt",
    variant: "info"
  });
}
async function switchTreeTheme(context) {
  const current = themeState.value;
  const choice = await context.ui.dialog.select({
    title: "Progress tree theme",
    current,
    options: THEME_PRESET_CHOICES.map((option) => ({
      title: option.title,
      value: option.value,
      description: option.value === current ? `${option.description} \xB7 current` : option.description
    }))
  });
  if (choice == null) return;
  const preset = themePresetChoice(choice);
  setTreeThemeState?.((draft) => {
    draft.value = choice;
  });
  const result = writeThemeToConfig({
    treeTheme: preset.treeTheme,
    barStyle: preset.barStyle
  }, {
    directory: context.location?.directory
  });
  context.ui.toast.show({
    message: result.ok ? `Theme: ${themePresetLabel(choice)} \xB7 saved to config` : `Theme: ${themePresetLabel(choice)} \xB7 config not updated`,
    variant: result.ok ? "success" : "warning"
  });
}
function toggleCollapsed(context) {
  if (!setCollapsed) return;
  const next = !collapsedState.value;
  setCollapsed((draft) => {
    draft.value = next;
  });
  context.ui.toast.show({
    message: next ? "Progress collapsed to summary" : "Progress tree expanded",
    variant: "info"
  });
}
async function promptRootCap(context) {
  const current = rootCapState.value;
  const choice = await context.ui.dialog.select({
    title: "Progress root cap",
    current,
    options: [1, 2, 3, 5, 10, 25].map((value) => ({
      title: `${value} root${value === 1 ? "" : "s"}`,
      value,
      description: value === current ? "current" : void 0
    }))
  });
  if (choice == null) return;
  setRootCap?.((draft) => {
    draft.value = choice;
  });
  context.ui.toast.show({
    message: `Showing up to ${choice} root${choice === 1 ? "" : "s"}`,
    variant: "info"
  });
}
function sessionEntriesOf(sessionID) {
  return Object.entries(state().entries ?? {}).filter(([key, entry]) => entry && typeof entry === "object" && (entry.sessionId === sessionID || key.startsWith(`${sessionID}:`)));
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
async function clearList(context) {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({
      message: "Open a session to manage progress",
      variant: "warning"
    });
    return;
  }
  const candidates = sessionEntriesOf(sessionID).filter(([, entry]) => !entry.cleared && (entry.status === "done" || entry.status === "error" || Boolean(entry.dismissed)));
  if (candidates.length === 0) {
    context.ui.toast.show({
      message: "Nothing to clear",
      variant: "info"
    });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Clear progress list?",
    message: `${candidates.length} finished or dismissed ${candidates.length === 1 ? "entry" : "entries"} will be hidden. Records stay on disk; running tasks keep showing.`,
    label: {
      confirm: "Clear list"
    }
  });
  if (!confirmed) return;
  const result = softClearSession(sessionID);
  setState(readProgressState());
  context.ui.toast.show({
    message: `Cleared ${result.cleared} ${result.cleared === 1 ? "entry" : "entries"} (records kept)`,
    variant: "success"
  });
}
async function hardClearSessionCommand(context) {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({
      message: "Open a session to manage progress",
      variant: "warning"
    });
    return;
  }
  const entries = sessionEntriesOf(sessionID);
  if (entries.length === 0) {
    context.ui.toast.show({
      message: "Nothing to delete",
      variant: "info"
    });
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)));
  const confirmed = await context.ui.dialog.confirm({
    title: "Permanently delete session progress?",
    message: `${entries.length} ${entries.length === 1 ? "entry" : "entries"} (${formatBytes(bytes)}) will be removed from the progress store. The mirrored tasklist file is kept. This cannot be undone.`,
    label: {
      confirm: "Delete permanently"
    }
  });
  if (!confirmed) return;
  const result = hardDeleteSession(sessionID);
  setState(readProgressState());
  context.ui.toast.show({
    message: `Deleted ${result.removed} ${result.removed === 1 ? "entry" : "entries"} \xB7 ${formatBytes(result.freedBytes)} freed`,
    variant: "success"
  });
}
async function hardClearStoreCommand(context) {
  const entries = Object.values(state().entries ?? {});
  if (entries.length === 0) {
    context.ui.toast.show({
      message: "Progress store is already empty",
      variant: "info"
    });
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(state().entries ?? {}));
  const typed = await context.ui.dialog.prompt({
    title: "Hard clear the entire progress store",
    description: `This deletes all ${entries.length} entries (${formatBytes(bytes)}) from the plugin store. It cannot be undone without a backup and prevents future auditing or progress reporting. Type DELETE to confirm.`,
    placeholder: "DELETE"
  });
  if (typed?.trim() !== "DELETE") {
    if (typed !== void 0) {
      context.ui.toast.show({
        message: "Store not cleared: confirmation did not match",
        variant: "warning"
      });
    }
    return;
  }
  const result = hardDeleteAll();
  setState(readProgressState());
  context.ui.toast.show({
    message: `Store cleared: ${result.removed} ${result.removed === 1 ? "entry" : "entries"} \xB7 ${formatBytes(result.freedBytes)} freed`,
    variant: "success"
  });
}
async function confirmDismissAll(context, roots) {
  if (roots.length === 0) return;
  const confirmed = await context.ui.dialog.confirm({
    title: "Dismiss all progress?",
    message: `${roots.length} task${roots.length === 1 ? "" : "s"} will be hidden. Agent updates bring them back.`,
    label: {
      confirm: "Dismiss all"
    }
  });
  if (confirmed) dismissRoots(context, roots);
}
async function openNotesDialog(context, sessionIDOverride) {
  const sessionID = sessionIDOverride ?? currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({
      message: "Open a session to read agent notes",
      variant: "warning"
    });
    return;
  }
  const notes = visibleSayNotes(sayNotesForSession(readProgressState(), sessionID), Date.now(), autoHideTimeoutMs);
  if (notes.length === 0) {
    context.ui.toast.show({
      message: "No agent notes yet",
      variant: "info"
    });
    return;
  }
  const choice = await context.ui.dialog.select({
    title: `Agent notes (${notes.length})`,
    placeholder: "Filter notes\u2026",
    options: [{
      title: `Dismiss all notes (${notes.length})`,
      value: {
        kind: "all"
      },
      description: "Remove every note in this session tree"
    }, ...notes.map((note) => {
      const time = Number.isFinite(note.at) ? new Date(note.at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      }) : "";
      const eta = note.eta ? ` \xB7 ETA ${note.eta}` : "";
      const prefix = noteAuthorPrefix(note, sessionID);
      return {
        title: `\u2715 ${time ? `[${time}] ` : ""}${note.kind}: ${prefix}${oneLineText(note.text)}`,
        value: {
          kind: "note",
          note
        },
        description: `${note.kind}${eta}${prefix ? ` \xB7 ${prefix.trim()}` : ""} \xB7 select to dismiss`
      };
    })],
    search: (query, options) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return options;
      return options.filter((option) => option.title.toLowerCase().includes(needle) || (option.description ?? "").toLowerCase().includes(needle));
    }
  });
  if (!choice) return;
  if (choice.kind === "all") {
    const confirmed2 = await context.ui.dialog.confirm({
      title: "Dismiss all notes?",
      message: `${notes.length} note${notes.length === 1 ? "" : "s"} will be removed for every client.`,
      label: {
        confirm: "Dismiss all notes"
      }
    });
    if (!confirmed2) return;
    const removed = clearSayNotes(sessionID);
    setState(readProgressState());
    context.ui.toast.show({
      message: removed > 0 ? `Dismissed ${removed} note${removed === 1 ? "" : "s"}` : "No notes to dismiss",
      variant: removed > 0 ? "success" : "info"
    });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Dismiss this note?",
    message: formatNotesDialog([choice.note], {
      viewerSessionID: sessionID
    }),
    label: {
      confirm: "Dismiss note"
    }
  });
  if (!confirmed) return;
  const ok = dismissSayNote(choice.note.id);
  setState(readProgressState());
  context.ui.toast.show({
    message: ok ? "Note dismissed" : "Note already dismissed",
    variant: ok ? "success" : "info"
  });
}
async function openProgressDialog(context) {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({
      message: "Open a session to manage progress",
      variant: "warning"
    });
    return;
  }
  const roots = rootsForSession(sessionID);
  const notes = visibleSayNotes(sayNotesForSession(readProgressState(), sessionID), Date.now(), autoHideTimeoutMs);
  if (roots.length === 0 && notes.length === 0) {
    context.ui.toast.show({
      message: "No progress to show",
      variant: "info"
    });
    return;
  }
  const done = roots.filter((root) => root.status === "done");
  const expanded = expandedFor(sessionID);
  const choice = await context.ui.dialog.select({
    title: "Progress",
    placeholder: "Filter tasks\u2026",
    options: [...notes.length > 0 ? [{
      title: `Notes (${notes.length})`,
      value: {
        kind: "notes"
      }
    }] : [], ...done.length > 0 ? [{
      title: `Dismiss done (${done.length})`,
      value: {
        kind: "done"
      }
    }] : [], {
      title: `Dismiss all (${roots.length})`,
      value: {
        kind: "all"
      }
    }, {
      title: "Dismiss a task\u2026",
      value: {
        kind: "pick-dismiss"
      }
    }, ...roots.map((root) => ({
      title: `${expanded.has(root.key) ? "\u25BE" : "\u25B8"} ${glyph(root.status)} ${root.title}`,
      value: {
        kind: "toggle",
        key: root.key
      },
      description: `${root.status}${countDescendants(root) > 0 ? ` \xB7 ${countDescendants(root)} descendant(s)` : ""}`
    }))],
    search: (query, options) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return options;
      return options.filter((option) => option.title.toLowerCase().includes(needle) || (option.description ?? "").toLowerCase().includes(needle));
    }
  });
  if (!choice) return;
  if (choice.kind === "notes") {
    await openNotesDialog(context, sessionID);
    return;
  }
  if (choice.kind === "done") {
    dismissRoots(context, done);
    return;
  }
  if (choice.kind === "all") {
    await confirmDismissAll(context, roots);
    return;
  }
  if (choice.kind === "pick-dismiss") {
    const picked = await context.ui.dialog.select({
      title: "Dismiss a task",
      placeholder: "Filter tasks\u2026",
      options: roots.map((root) => ({
        title: `${glyph(root.status)} ${root.title}`,
        value: root,
        description: root.status
      }))
    });
    if (picked) dismissRoots(context, [picked]);
    return;
  }
  if (choice.kind === "toggle") {
    toggleExpanded(sessionID, choice.key);
    return;
  }
  if (choice.kind === "dismiss") {
    const root = roots.find((candidate) => candidate.key === choice.key);
    if (root) dismissRoots(context, [root]);
  }
}
function FooterStatus() {
  const ctx = usePlugin();
  const summary = () => {
    const roots = buildTree(state().entries ?? {});
    const active = countActive(roots);
    return active > 0 ? `${active} active task${active === 1 ? "" : "s"}` : "";
  };
  return _$createComponent(Show, {
    get when() {
      return summary();
    },
    get children() {
      var _el$28 = _$createElement("text");
      _$insert(_el$28, summary);
      _$effect((_$p) => _$setProp(_el$28, "fg", ctx.theme.text.muted, _$p));
      return _el$28;
    }
  });
}
var tui_default = Plugin.define({
  id: "opencode-progress.tui",
  setup(context) {
    barOptions = normalizeBarOptions(context.options);
    visibilityOptions = normalizeVisibilityOptions(context.options);
    expandRootsByDefault = context.options?.expandRootsByDefault === true;
    const configuredRows = context.options?.tuiMaxRows;
    maxRows = typeof configuredRows === "number" && configuredRows >= 1 ? Math.min(50, Math.floor(configuredRows)) : 8;
    sidebarRows = normalizeSidebarRows(context.options?.tuiSidebarRows);
    const sayOptions = normalizeSayOptions(context.options);
    const saySurfaces = tuiSaySurfaces(sayOptions.modes);
    sayLineEnabled = saySurfaces.line;
    autoHideTimeoutMs = sayOptions.autoHideTimeoutMs;
    const seenNotes = /* @__PURE__ */ new Map();
    sayToastHook = (next) => {
      if (!saySurfaces.toast) return;
      const sessionID = currentSessionID(context);
      if (!sessionID) return;
      const notes = visibleSayNotes(sayNotesForSession(next, sessionID), Date.now(), autoHideTimeoutMs);
      const current = new Set(notes.map((note) => note.id));
      const seen = seenNotes.get(sessionID);
      if (!seen) {
        seenNotes.set(sessionID, current);
        return;
      }
      for (const id of [...seen]) {
        if (!current.has(id)) seen.delete(id);
      }
      const toastable = new Set(sayToastNotes(notes, sessionID, sayOptions.toastScope).map((note) => note.id));
      const fresh = notes.filter((note) => !seen.has(note.id) && toastable.has(note.id)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      for (const note of notes) seen.add(note.id);
      for (const note of fresh) {
        const toast = buildNoteToast(note, sessionID);
        context.ui.toast.show({
          message: toast.message,
          variant: toast.warning ? "warning" : "info",
          duration: sayToastDurationMs(note.kind)
        });
      }
    };
    const [capStore, updateCap] = context.storage.memory("tuiMaxRoots", {
      initial: {
        value: normalizeMaxRoots(context.options?.tuiMaxRoots)
      }
    });
    rootCapState = capStore;
    setRootCap = updateCap;
    const [layoutStore, updateStoredLayout] = context.storage.memory("tuiLayout", {
      initial: {
        mode: normalizeTuiLayout(context.options?.tuiLayout)
      }
    });
    layoutState = layoutStore;
    setLayout = updateStoredLayout;
    const [collapsedStore, updateCollapsed] = context.storage.memory("tuiCollapsed", {
      initial: {
        value: false
      }
    });
    collapsedState = collapsedStore;
    setCollapsed = updateCollapsed;
    const [themeStore, updateTheme] = context.storage.memory("tuiThemePreset", {
      initial: {
        value: themePresetFrom(normalizeTreeTheme(context.options?.treeTheme), normalizeBarOptions(context.options).style ?? "blocks")
      }
    });
    themeState = themeStore;
    setTreeThemeState = updateTheme;
    const [indicatorStore, updateIndicator] = context.storage.memory("tuiIndicatorStyle", {
      initial: {
        value: normalizeIndicatorStyle(context.options?.indicatorStyle, normalizeTreeTheme(context.options?.treeTheme) === "ultra-compact" ? "circles" : "dot")
      }
    });
    indicatorState = indicatorStore;
    setIndicatorState = updateIndicator;
    const stopPolling = startPolling(normalizeRefreshMs(context.options));
    if (context.options?.notifyOnLoad === true) {
      context.ui.toast.show({
        message: "Progress plugin loaded",
        variant: "success"
      });
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "progress.open",
        title: "Progress: expand or dismiss",
        description: "Browse progress roots; expand a tree or dismiss tasks",
        group: "progress",
        bind: "alt+p",
        palette: true,
        slash: {
          name: "progress",
          arguments: true
        },
        run: (input) => {
          const args = (input ?? "").trim();
          const lower = args.toLowerCase();
          if (lower === "swap-layout") {
            swapLayout(context);
            return;
          }
          if (lower === "nudge" || lower.startsWith("nudge ")) {
            if (context.options?.customNudges !== true) {
              context.ui.toast.show({
                message: "Custom nudges are opt-in. Add { customNudges: true } to this plugin's options.",
                variant: "warning"
              });
              return;
            }
            return runNudgeCommand(context, currentSessionID(context), args.slice("nudge".length).trim());
          }
          return openProgressDialog(context);
        }
      }, {
        id: "progress.swap-layout",
        title: "Progress: swap layout (composer/sidebar)",
        description: "Move the progress tree above the prompt or into the sidebar",
        group: "progress",
        palette: true,
        run: () => swapLayout(context)
      }, {
        id: "progress.switch-tree-theme",
        title: "Progress: switch tree theme",
        description: "Pick the tree row theme; saved to your OpenCode config",
        group: "progress",
        palette: true,
        run: () => switchTreeTheme(context)
      }, {
        id: "progress.indicator-style",
        title: "Progress: indicator style",
        description: "Swap status indicators: flat dots, emoji circles, or checkbox emoji",
        group: "progress",
        palette: true,
        run: async () => {
          const choice = await context.ui.dialog.select({
            title: "Progress indicator style",
            current: indicatorState.value,
            options: INDICATOR_STYLE_CHOICES.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.value === indicatorState.value ? `${option.description} \xB7 current` : option.description
            }))
          });
          if (!choice) return;
          setIndicatorState?.((draft) => {
            draft.value = choice;
          });
          context.ui.toast.show({
            message: `Indicator style: ${indicatorStyleLabel(choice)}`,
            variant: "success"
          });
        }
      }, {
        id: "progress.set-root-cap",
        title: "Progress: set root cap",
        description: "Choose how many root tasks the TUI shows",
        group: "progress",
        palette: true,
        run: () => promptRootCap(context)
      }, {
        id: "progress.toggle-collapsed",
        title: "Progress: collapse or expand tree",
        description: "Toggle between the progress tree and a one-line status summary",
        group: "progress",
        palette: true,
        run: () => toggleCollapsed(context)
      }, {
        id: "progress.clear",
        title: "Progress: clear list (this session)",
        description: "Hide finished and dismissed entries; records stay on disk",
        group: "progress",
        palette: true,
        enabled: () => Boolean(currentSessionID(context)),
        run: () => clearList(context)
      }, {
        id: "progress.hard-clear-session",
        title: "Progress: hard clear this session",
        description: "Permanently delete this session's progress entries",
        group: "progress",
        palette: true,
        enabled: () => Boolean(currentSessionID(context)),
        run: () => hardClearSessionCommand(context)
      }, {
        id: "progress.hard-clear-store",
        title: "Progress: hard clear entire progress store",
        description: "Delete all progress entries; requires typing DELETE",
        group: "progress",
        palette: true,
        run: () => hardClearStoreCommand(context)
      }, {
        id: "progress.toggle-tasklist-view",
        title: "Progress: task-list mirror view (match UI/raw)",
        description: "Toggle the Markdown task list between the UI view and the raw store view",
        group: "progress",
        palette: true,
        enabled: () => taskListStatus()?.enabled === true,
        run: () => {
          const current = taskListStatus();
          const mode = toggleTaskListMode(current?.mode ?? "ui");
          if (current) setTaskListStatus({
            ...current,
            mode
          });
          context.ui.toast.show({
            message: mode === "raw" ? "Task-list mirror: raw store view" : "Task-list mirror: matching the UI",
            variant: "success"
          });
        }
      }]
    }));
    const unregisterComposer = context.ui.slot({
      append: "session.composer.top",
      render: ({
        sessionID
      }) => _$createComponent(Show, {
        get when() {
          return layoutState.mode === "composer";
        },
        get children() {
          return _$createComponent(ProgressTree, {
            sessionID,
            capacity: maxRows,
            variant: "composer"
          });
        }
      })
    });
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({
        sessionID
      }) => _$createComponent(Show, {
        get when() {
          return layoutState.mode === "sidebar";
        },
        get children() {
          return _$createComponent(ProgressTree, {
            sessionID,
            capacity: sidebarRows,
            variant: "sidebar"
          });
        }
      })
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => _$createComponent(FooterStatus, {})
    });
    return () => {
      sayToastHook = void 0;
      sayLineEnabled = true;
      autoHideTimeoutMs = 6e4;
      unregisterComposer?.();
      unregisterSidebar?.();
      unregisterFooter?.();
      stopPolling();
    };
  }
});
export {
  tui_default as default
};
