// src/tui.js
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
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

// src/tree.ts
var STATUS_ORDER = {
  error: 4,
  running: 3,
  waiting: 2,
  done: 1
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
function countActive(nodes) {
  return flattenTree(nodes).filter((node) => node.status === "running" || node.status === "waiting").length;
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

// src/tui.js
var [state, setState] = createSignal(readProgressState());
var pollers = 0;
var timer;
var barOptions = {};
var visibilityOptions = {};
function startPolling(refreshMs) {
  pollers += 1;
  setState(readProgressState());
  if (!timer) {
    timer = setInterval(() => setState(readProgressState()), refreshMs);
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
  return "\u25CF";
}
function ProgressNode(props) {
  const ctx = usePlugin();
  const indent = () => props.depth === 0 ? "" : "\u2514\u2500 ";
  const detailIndent = () => "  \xB7 ";
  const title = () => `${props.depth === 0 ? subagentPrefix(props.node) : ""}${props.node.title}`;
  const label = () => {
    const parts = barParts(props.node.progress, barOptions);
    if (parts.style === "emoji") {
      const suffix = props.node.status === "done" ? " \u2713" : props.node.status === "error" ? " \u2717" : "";
      return `${title()}: ${parts.bar}${parts.fraction}${suffix}`;
    }
    const pct = progressLabel(props.node.progress);
    return `${glyph(props.node.status)} [${parts.bar}] ${title()}${pct ? ` ${pct}` : ""}`;
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("span");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "wrapMode", "word");
    _$insert(_el$3, indent);
    _$insert(_el$2, label, null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return props.node.detail;
      },
      get children() {
        var _el$4 = _$createElement("text");
        _$setProp(_el$4, "wrapMode", "word");
        _$insert(_el$4, () => `${detailIndent()}${props.node.detail}`);
        _$effect((_$p) => _$setProp(_el$4, "fg", ctx.theme.text.muted, _$p));
        return _el$4;
      }
    }), null);
    _$insert(_el$, _$createComponent(For, {
      get each() {
        return props.node.children;
      },
      children: (child) => _$createComponent(ProgressNode, {
        node: child,
        get depth() {
          return props.depth + 1;
        }
      })
    }), null);
    _$effect((_p$) => {
      var _v$ = props.depth === 0 ? 0 : 2, _v$2 = ctx.theme.text.base, _v$3 = ctx.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "paddingLeft", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$3, "fg", _v$3, _p$.a));
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
  const roots = () => buildTree(visibleEntries(scopeEntries(state().entries ?? {}, props.sessionID, visibilityOptions), Date.now(), visibilityOptions)).slice(0, 4);
  return _$createComponent(Show, {
    get when() {
      return roots().length > 0;
    },
    get children() {
      var _el$5 = _$createElement("box"), _el$6 = _$createElement("text");
      _$insertNode(_el$5, _el$6);
      _$setProp(_el$5, "flexDirection", "column");
      _$setProp(_el$5, "paddingLeft", 1);
      _$setProp(_el$5, "paddingRight", 1);
      _$setProp(_el$5, "paddingTop", 1);
      _$insertNode(_el$6, _$createTextNode(`progress`));
      _$insert(_el$5, _$createComponent(For, {
        get each() {
          return roots();
        },
        children: (node) => _$createComponent(ProgressNode, {
          node,
          depth: 0
        })
      }), null);
      _$effect((_$p) => _$setProp(_el$6, "fg", ctx.theme.text.muted, _$p));
      return _el$5;
    }
  });
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
      var _el$8 = _$createElement("text");
      _$insert(_el$8, summary);
      _$effect((_$p) => _$setProp(_el$8, "fg", ctx.theme.text.muted, _$p));
      return _el$8;
    }
  });
}
var tui_default = Plugin.define({
  id: "opencode-progress.tui",
  setup(context) {
    barOptions = normalizeBarOptions(context.options);
    visibilityOptions = normalizeVisibilityOptions(context.options);
    const stopPolling = startPolling(normalizeRefreshMs(context.options));
    if (context.options?.notifyOnLoad === true) {
      context.ui.toast.show({
        message: "Progress plugin loaded",
        variant: "success"
      });
    }
    const unregisterTree = context.ui.slot({
      append: "session.composer.top",
      render: ({
        sessionID
      }) => _$createComponent(ProgressTree, {
        sessionID
      })
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => _$createComponent(FooterStatus, {})
    });
    return () => {
      unregisterTree?.();
      unregisterFooter?.();
      stopPolling();
    };
  }
});
export {
  tui_default as default
};
