// src/tui.js
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
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
          agent: typeof link.agent === "string" && link.agent ? link.agent : void 0
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
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state2)) },
      write: removed > 0
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
    return {
      value: { removed, freedBytes: Math.max(0, before - stateBytes(state2)) },
      write: removed > 0
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
function clampProgress(progress) {
  return progress == null ? 0 : Math.max(0, Math.min(1, progress));
}
function normalizeBarOptions(raw) {
  const options = raw ?? {};
  return {
    style: options.barStyle === "emoji" ? "emoji" : "blocks",
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
function subagentPrefix(entry) {
  if (!entry.subagent) return "";
  const raw = typeof entry.subagentAgent === "string" ? entry.subagentAgent.trim() : "";
  if (!raw) return "[Subagent]: ";
  const label = raw.charAt(0).toUpperCase() + raw.slice(1);
  return `[Subagent (${label})]: `;
}
function scopeEntries(entries, sessionID, options = {}) {
  if (options.scope === "all") return entries;
  if (!sessionID) return {};
  const prefix = `${sessionID}:`;
  const scoped = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.sessionId === sessionID || key.startsWith(prefix)) scoped[key] = entry;
  }
  return scoped;
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

// src/tui.js
var [state, setState] = createSignal(readProgressState());
var [taskListStatus, setTaskListStatus] = createSignal(readTaskListStatus());
var [expandedBySession, setExpandedBySession] = createSignal({});
var pollers = 0;
var timer;
var barOptions = {};
var visibilityOptions = {};
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
function startPolling(refreshMs) {
  pollers += 1;
  setState(readProgressState());
  setTaskListStatus(readTaskListStatus());
  if (!timer) {
    timer = setInterval(() => {
      setState(readProgressState());
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
  if (status === "done") return "\u2713";
  if (status === "error") return "\u2717";
  if (status === "waiting") return "\u25D0";
  if (status === "pending") return "\u25CB";
  return "\u25CF";
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
  return buildTree(visibleEntries(scopeEntries(entries, sessionID, visibilityOptions), Date.now(), visibilityOptions));
}
function rootsForSession(sessionID) {
  const entries = state().entries ?? {};
  return allRootsForSession(sessionID).filter((root) => !isDismissed(root, dismissedMap(entries)));
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
  const marker = () => props.row.collapsed ? "\u25B8 " : "\u25BE ";
  const suffix = () => props.row.hiddenChildren > 0 ? `  +${props.row.hiddenChildren}` : "";
  const detailPreview = () => {
    const full = oneLineText(props.row.node.detail ?? "");
    return full.length > 120 ? `${full.slice(0, 120)}\u2026` : full;
  };
  const label = () => {
    const parts = barParts(props.row.node.progress, barOptions);
    if (parts.style === "emoji") {
      const done = props.row.node.status === "done" ? " \u2713" : props.row.node.status === "error" ? " \u2717" : "";
      return `${title()}: ${parts.bar}${parts.fraction}${done}${suffix()}`;
    }
    const pct = progressLabel(props.row.node.progress);
    return `${glyph(props.row.node.status)} [${parts.bar}] ${title()}${pct ? ` ${pct}` : ""}${suffix()}`;
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$4);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "alignItems", "flex-start");
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return hasMarker();
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
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return isRoot();
      },
      get children() {
        var _el$6 = _$createElement("text");
        _$insertNode(_el$6, _$createTextNode(`  \u2715`));
        _$setProp(_el$6, "selectable", false);
        _$setProp(_el$6, "onMouseUp", onDismiss);
        _$effect((_$p) => _$setProp(_el$6, "fg", ctx.theme.text.muted, _$p));
        return _el$6;
      }
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return props.row.node.detail;
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
      var _v$ = props.row.depth === 0 ? 0 : 2, _v$2 = ctx.theme.text.base, _v$3 = ctx.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "paddingLeft", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
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
  const view = () => buildTuiView(roots(), {
    maxRows,
    maxRoots: rootCapState.value,
    clipRows: false,
    expanded: expandedFor(props.sessionID),
    expandByDefault: expandRootsByDefault
  });
  const lineCount = (rows) => rows.reduce((total, row) => total + 1 + (row.node.detail ? 1 : 0), 0);
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
    var _el$9 = _$createElement("text");
    _$insertNode(_el$9, _$createTextNode(`progress`));
    _$setProp(_el$9, "selectable", false);
    _$setProp(_el$9, "onMouseUp", () => openProgressDialog(ctx));
    _$effect((_$p) => _$setProp(_el$9, "fg", ctx.theme.text.muted, _$p));
    return _el$9;
  })();
  const actions = () => (() => {
    var _el$1 = _$createElement("box"), _el$13 = _$createElement("text");
    _$insertNode(_el$1, _el$13);
    _$setProp(_el$1, "flexDirection", "row");
    _$insert(_el$1, _$createComponent(Show, {
      get when() {
        return doneRoots().length > 0;
      },
      get children() {
        return [(() => {
          var _el$10 = _$createElement("text");
          _$setProp(_el$10, "selectable", false);
          _$setProp(_el$10, "onMouseUp", onDismissDone);
          _$insert(_el$10, () => `dismiss done (${doneRoots().length})`);
          _$effect((_$p) => _$setProp(_el$10, "fg", ctx.theme.text.base, _$p));
          return _el$10;
        })(), (() => {
          var _el$11 = _$createElement("text");
          _$insertNode(_el$11, _$createTextNode(`  \xB7  `));
          _$effect((_$p) => _$setProp(_el$11, "fg", ctx.theme.text.muted, _$p));
          return _el$11;
        })()];
      }
    }), _el$13);
    _$setProp(_el$13, "selectable", false);
    _$setProp(_el$13, "onMouseUp", onDismissAll);
    _$insert(_el$13, () => `dismiss all (${roots().length})`);
    _$effect((_$p) => _$setProp(_el$13, "fg", ctx.theme.text.base, _$p));
    return _el$1;
  })();
  const collapsed = () => collapsedState.value === true;
  const summary = () => {
    const entries = state().entries ?? {};
    return summarizeRoots(allRootsForSession(props.sessionID), (root) => isDismissed(root, dismissedMap(entries)));
  };
  const hasContent = () => collapsed() ? summary().length > 0 : view().rows.length > 0;
  return _$createComponent(Show, {
    get when() {
      return hasContent();
    },
    get children() {
      var _el$14 = _$createElement("box");
      _$setProp(_el$14, "flexDirection", "column");
      _$setProp(_el$14, "paddingLeft", 1);
      _$setProp(_el$14, "paddingRight", 1);
      _$setProp(_el$14, "paddingTop", 1);
      _$insert(_el$14, _$createComponent(Show, {
        get when() {
          return collapsed();
        },
        get children() {
          var _el$15 = _$createElement("text"), _el$16 = _$createElement("span");
          _$insertNode(_el$15, _el$16);
          _$setProp(_el$15, "selectable", false);
          _$setProp(_el$15, "onMouseUp", () => setCollapsed?.((draft) => {
            draft.value = false;
          }));
          _$insertNode(_el$16, _$createTextNode(`progress: `));
          _$insert(_el$15, summary, null);
          _$effect((_p$) => {
            var _v$4 = ctx.theme.text.base, _v$5 = ctx.theme.text.muted;
            _v$4 !== _p$.e && (_p$.e = _$setProp(_el$15, "fg", _v$4, _p$.e));
            _v$5 !== _p$.t && (_p$.t = _$setProp(_el$16, "fg", _v$5, _p$.t));
            return _p$;
          }, {
            e: void 0,
            t: void 0
          });
          return _el$15;
        }
      }), null);
      _$insert(_el$14, _$createComponent(Show, {
        get when() {
          return !collapsed();
        },
        get children() {
          return [_$createComponent(Show, {
            when: stackedHeader,
            get fallback() {
              return (() => {
                var _el$21 = _$createElement("box");
                _$setProp(_el$21, "flexDirection", "row");
                _$setProp(_el$21, "justifyContent", "space-between");
                _$insert(_el$21, title, null);
                _$insert(_el$21, actions, null);
                return _el$21;
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
                children: (row) => _$createComponent(ProgressRow, {
                  row,
                  get sessionID() {
                    return props.sessionID;
                  }
                })
              });
            },
            get children() {
              var _el$18 = _$createElement("scrollbox");
              _$setProp(_el$18, "scrollY", true);
              _$setProp(_el$18, "stickyStart", "top");
              _$setProp(_el$18, "focusable", false);
              _$insert(_el$18, _$createComponent(For, {
                get each() {
                  return view().rows;
                },
                children: (row) => _$createComponent(ProgressRow, {
                  row,
                  get sessionID() {
                    return props.sessionID;
                  }
                })
              }));
              _$effect((_$p) => _$setProp(_el$18, "height", viewportHeight(), _$p));
              return _el$18;
            }
          }), _$createComponent(Show, {
            get when() {
              return capacity > 0 && overflowLines() > 0;
            },
            get children() {
              var _el$19 = _$createElement("text");
              _$setProp(_el$19, "selectable", false);
              _$insert(_el$19, () => `--- scroll to see ${overflowLines()} more ---`);
              _$effect((_$p) => _$setProp(_el$19, "fg", ctx.theme.text.muted, _$p));
              return _el$19;
            }
          }), _$createComponent(Show, {
            get when() {
              return view().hiddenRoots > 0;
            },
            get children() {
              var _el$20 = _$createElement("text");
              _$setProp(_el$20, "selectable", false);
              _$setProp(_el$20, "onMouseUp", () => openProgressDialog(ctx));
              _$insert(_el$20, () => `view full progress tree (${statusSummary(roots())})`);
              _$effect((_$p) => _$setProp(_el$20, "fg", ctx.theme.text.base, _$p));
              return _el$20;
            }
          })];
        }
      }), null);
      return _el$14;
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
  if (roots.length === 0) {
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
    options: [...done.length > 0 ? [{
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
      var _el$22 = _$createElement("text");
      _$insert(_el$22, summary);
      _$effect((_$p) => _$setProp(_el$22, "fg", ctx.theme.text.muted, _$p));
      return _el$22;
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
          if ((input ?? "").trim().toLowerCase() === "swap-layout") {
            swapLayout(context);
            return;
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
