/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Command, MenuItem, Panel, Plugin, Style } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";
import { ErrorBoundary, For, Index, Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import pkg from "../package.json";
import { feedbackIssueUrl, releasesUrl } from "./feedback.js";
import { ProgressRpc } from "./rpc.js";
import {
  GUI_PROGRESS_PANEL_ID,
  buildNoteToast,
  buildNotesPill,
  nextGuiLayout,
  noteAuthorLabel,
  normalizeGuiDetailLines,
  normalizeGuiLayout,
  normalizeGuiSidebarWidth,
  type GuiLayout,
} from "./gui-view.js";
import {
  guiSaySurfaces,
  normalizeSayOptions,
  sayToastDurationMs,
  sayToastNotes,
  visibleSayNotes,
} from "./say.js";
import { buildNotesLine } from "./tui-view.js";
import {
  buildTree,
  buildVisibleTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  visibleRows,
  compactTreeSuffix,
  countDescendants,
  collapsedRootMap,
  summarizeEntries,
  isDismissed,
  normalizeBarOptions,
  normalizeProgressText,
  normalizeRefreshMs,
  normalizeTreeTheme,
  normalizeVisibilityOptions,
  oneLineText,
  progressLabel,
  scopeEntries,
  subagentPrefix,
  visibleEntries,
  THEME_PRESET_CHOICES,
  themePresetChoice,
  themePresetFrom,
  themePresetLabel,
  type BarOptions,
  type ThemePreset,
  type TreeTheme,
} from "./tree.js";
import type { ProgressEntry, SayNote, TreeNode } from "./types.js";

type GuiNote = SayNote & { rootSessionId?: string };

type GuiState = {
  entries: Record<string, ProgressEntry>;
  notes: GuiNote[];
  loaded: boolean;
  error?: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function toneFor(status: TreeNode["status"]): "success" | "warning" | "danger" | undefined {
  if (status === "error") return "danger";
  if (status === "done") return "success";
  if (status === "waiting") return "warning";
  return undefined;
}

function dotColor(status: TreeNode["status"]): string {
  if (status === "error") return "#ef4444";
  if (status === "done") return "#10b981";
  if (status === "waiting") return "#f59e0b";
  if (status === "pending") return "#94a3b8";
  return "#3b82f6";
}

/** "Nov 18, 2:03 PM" in the viewer's locale and timezone. */
function formatDateTime(ms: number | undefined): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Human-readable age: "just now", "42 seconds ago", "3 minutes ago", ... */
function formatRelative(ms: number | undefined): string {
  if (!ms) return "";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 10_000) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "9:12 AM" clock time for the ultra-compact prefix. */
function formatClock(ms: number | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** Compact duration: "<1m", "42m", "1h 04m", "2d 3h". */
function formatElapsedShort(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Emoji status light used by ultra-compact rows. */
function statusLight(status: string | undefined): string {
  if (status === "done") return "🟢";
  if (status === "error") return "🔴";
  if (status === "waiting") return "🟡";
  if (status === "pending") return "⚪";
  return "🔵";
}

/** Render normalized text with real <br> elements, never innerHTML. */
function Multiline(props: { text: string }) {
  return (
    <Index each={normalizeProgressText(props.text).split("\n")}>
      {(line, index) => (
        <>
          {index > 0 ? <br /> : null}
          {line()}
        </>
      )}
    </Index>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function MenuRow(props: {
  node: TreeNode;
  depth: number;
  options: BarOptions;
  onDismiss?: () => void;
  leaving?: boolean;
  leaveDelayMs?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Detail line cap: -1 full, 0 hidden, n>0 clamp with ellipsis. Default full. */
  detailLines?: number;
  /** `compact` drops the bar and started line and keeps one detail line. */
  theme?: TreeTheme;
}) {
  const pct = () => progressLabel(props.node.progress);
  const parts = () => barParts(props.node.progress, props.options);
  const compact = () => props.theme === "compact";
  /** Compact rows ignore `guiDetailLines` above 1 but still honor 0 = hidden. */
  const effectiveDetailLines = () =>
    ultra() ? 0 : compact() ? (props.detailLines === 0 ? 0 : 1) : props.detailLines;
  const ultra = () => props.theme === "ultra-compact";
  const compactMeta = () =>
    compactTreeSuffix(
      props.node.progress,
      props.collapsed && props.node.children.length > 0
        ? countDescendants(props.node)
        : 0
    );
  const titleText = () =>
    `${props.depth === 0 ? subagentPrefix(props.node) : ""}${props.node.title}`;
  const startedAt = () => props.node.startedAt ?? props.node.createdAt;
  const updatedAt = () => props.node.updatedAt ?? props.node.reportedAt;
  const elapsedMs = () => {
    const start = startedAt();
    if (!start) return undefined;
    const terminal = props.node.status === "done" || props.node.status === "error";
    return Math.max(0, (terminal ? updatedAt() ?? Date.now() : Date.now()) - start);
  };
  const timePrefix = () => {
    const start = startedAt();
    if (!start) return "";
    return `${formatClock(start)}→${formatClock(updatedAt())} · ${formatElapsedShort(elapsedMs())}`;
  };
  const timeTitle = () =>
    `Started ${formatDateTime(startedAt()) || "unknown"} · Updated ${
      formatDateTime(updatedAt()) || "unknown"
    } · Elapsed ${formatElapsedShort(elapsedMs())}`;

  return (
    <div
      onClick={(event: MouseEvent) => {
        if (!props.hasChildren || props.leaving) return;
        // Do not hijack text selection drags.
        const selected = window.getSelection?.()?.toString();
        if (selected) return;
        event.preventDefault();
        props.onToggle?.();
      }}
      style={{
        display: "flex",
        "align-items": ultra() ? "center" : "flex-start",
        gap: ultra() ? "6px" : "8px",
        "padding-left": `${props.depth * 14}px`,
        "padding-top": ultra() ? "1px" : compact() ? "2px" : "5px",
        "padding-bottom": ultra() ? "1px" : compact() ? "2px" : "5px",
        cursor: props.hasChildren && !props.leaving ? "pointer" : "default",
        transform: props.leaving ? "translateX(120%)" : "translateX(0)",
        opacity: props.leaving ? "0" : "1",
        transition: "transform 0.35s ease-in, opacity 0.3s ease-in",
        "transition-delay": `${props.leaveDelayMs ?? 0}ms`,
      }}
    >
      <Show when={props.hasChildren}>
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            opacity: "0.6",
            "font-size": "11px",
            width: "14px",
            "margin-top": ultra() ? "0" : "4px",
            "user-select": "none",
            "line-height": "1",
            display: "inline-block",
            transform: props.collapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 0.35s ease-in-out",
          }}
        >
          {props.collapsed ? "▸" : "▾"}
        </span>
      </Show>
      <Show when={props.depth > 0}>
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
            "font-size": "11px",
            "line-height": "1",
            "margin-top": ultra() ? "0" : "5px",
            opacity: "0.55",
            "user-select": "none",
            "white-space": "pre",
          }}
        >
          └─
        </span>
      </Show>
      <Show
        when={ultra()}
        fallback={
          <div
            style={{
              width: "8px",
              height: "8px",
              "border-radius": "50%",
              "margin-top": "6px",
              flex: "0 0 auto",
              background: dotColor(props.node.status),
            }}
          />
        }
      >
        <span
          aria-label={props.node.status}
          title={props.node.status}
          style={{ flex: "0 0 auto", "font-size": "11px", "line-height": "1", "user-select": "none" }}
        >
          {statusLight(props.node.status)}
        </span>
      </Show>
      <div style={{ flex: "1 1 auto", "min-width": "0" }}>
        <div
          style={{
            "font-weight": props.depth === 0 ? "650" : "500",
            "white-space": ultra() ? "nowrap" : "normal",
            "overflow-wrap": ultra() ? "normal" : "anywhere",
            "word-break": ultra() ? "normal" : "break-word",
            ...(ultra() ? { overflow: "hidden", "text-overflow": "ellipsis" } : {}),
          }}
          title={
            ultra()
              ? `${props.node.status}: ${timeTitle()} — ${oneLineText(titleText())}`
              : `${props.node.status}: ${oneLineText(titleText())}`
          }
        >
          <Show when={ultra() && timePrefix()}>
            <span
              style={{
                "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
                "font-size": "9px",
                "font-weight": "400",
                opacity: "0.5",
                "margin-right": "6px",
                "white-space": "nowrap",
              }}
            >
              {timePrefix()}
            </span>
          </Show>
          <Show when={ultra()} fallback={<Multiline text={titleText()} />}>
            {oneLineText(titleText())}
          </Show>
        </div>
        <Show when={props.node.detail && effectiveDetailLines() !== 0}>
          <div
            style={{
              "margin-top": "2px",
              "font-size": "12px",
              opacity: "0.72",
              "white-space": "normal",
              "overflow-wrap": "anywhere",
              "word-break": "break-word",
              ...((effectiveDetailLines() ?? 0) > 0
                ? {
                    display: "-webkit-box",
                    "-webkit-box-orient": "vertical",
                    "-webkit-line-clamp": String(effectiveDetailLines()),
                    "text-overflow": "ellipsis",
                    overflow: "hidden",
                  }
                : {}),
            }}
            title={props.node.detail ? `${props.node.status}: ${oneLineText(props.node.detail)}` : ""}
          >
            <Multiline text={props.node.detail ?? ""} />
          </div>
        </Show>
        <Show
          when={compact()}
          fallback={
            <>
              <div
                style={{
                  "margin-top": "4px",
                  display: "flex",
                  gap: "8px",
                  "align-items": "center",
                  "font-size": "11px",
                  opacity: "0.58",
                }}
              >
                <span style={{ "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {parts().bar}
                </span>
                <Show when={pct()}>
                  <span>{pct()}</span>
                </Show>
                <Show when={props.collapsed && props.node.children.length > 0}>
                  <span>&amp; {countDescendants(props.node)} more...</span>
                </Show>
              </div>
              <Show when={props.node.startedAt}>
                <div
                  title={`Last updated ${formatRelative(props.node.updatedAt)} (${formatDateTime(props.node.updatedAt)})`}
                  style={{
                    "margin-top": "2px",
                    "font-size": "11px",
                    opacity: "0.58",
                    "white-space": "nowrap",
                    cursor: "default",
                  }}
                >
                  started {formatDateTime(props.node.startedAt)}
                </div>
              </Show>
            </>
          }
        >
          <Show when={compactMeta()}>
            <div
              style={{
                "margin-top": "2px",
                display: "flex",
                gap: "8px",
                "align-items": "center",
                "font-size": "11px",
                opacity: "0.58",
              }}
            >
              <span>{compactMeta()}</span>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={props.onDismiss}>
        <button
          type="button"
          class="progress-pill-button"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            props.onDismiss?.();
          }}
          style={{
            flex: "0 0 auto",
            border: "1px solid rgba(127,127,127,0.35)",
            background: "transparent",
            color: "inherit",
            opacity: "0.65",
            "border-radius": "50%",
            width: "22px",
            height: "22px",
            cursor: "pointer",
            "line-height": "1",
          }}
        >
          ×
        </button>
      </Show>
    </div>
  );
}

function rowFor(
  node: TreeNode,
  depth: number,
  options: BarOptions,
  theme: TreeTheme = "default"
) {
  const parts = barParts(node.progress, options);
  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└─ " : "";
  const compactSuffix = compactTreeSuffix(node.progress, 0);
  const suffix =
    theme === "ultra-compact"
      ? ""
      : theme === "compact"
        ? compactSuffix
          ? ` · ${compactSuffix}`
          : ""
        : parts.style === "emoji"
          ? `: ${parts.bar}${parts.fraction}`
          : progressLabel(node.progress)
            ? ` · ${progressLabel(node.progress)}`
            : "";
  return {
    id: node.key,
    label: `${indent}${oneLineText(node.title)}${suffix}`,
    detail: theme === "ultra-compact" ? undefined : node.detail ? oneLineText(node.detail) : undefined,
    tone: toneFor(node.status),
  };
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<GuiState>({ entries: {}, notes: [], loaded: false });
    const [interacting, setInteracting] = createSignal(false);
    let suspendUntil = 0;
    // Dismissal is per root task and scoped to that task itself; the revival
    // semantics (re-report always revives, non-terminal status changes revive,
    // terminal dismissals only revive on failure or re-report) live in
    // tree.ts's isDismissed, shared and unit-tested.
    //
    // The dismissed state is PERSISTED in the shared state doc as
    // entry.dismissed = { status, at } (view-plane metadata written through
    // the plugin server's locked atomic writer), so it survives window
    // reloads and is shared by every view. This signal holds only optimistic
    // writes between the click and the next observed state.
    const [pendingDismissed, setPendingDismissed] = createSignal<Record<string, { status: string; at: number }>>({});
    const visibility = normalizeVisibilityOptions(ctx.options);
    const refreshMs = normalizeRefreshMs(ctx.options);
    // Placement is memory-backed like the TUI's `tuiLayout`; the configured
    // value seeds it and the palette command / pill action flips it at runtime.
    const [layoutStore, updateLayout] = ctx.storage.memory("guiLayout", {
      initial: { mode: normalizeGuiLayout(ctx.options?.guiLayout) },
    });
    const layoutMode = (): GuiLayout => layoutStore.mode;
    const setLayoutMode = (mode: GuiLayout) =>
      updateLayout((draft) => {
        draft.mode = mode;
      });
    const sidebarWidth = normalizeGuiSidebarWidth(ctx.options?.guiSidebarWidth);
    const detailLines = normalizeGuiDetailLines(ctx.options?.guiDetailLines);
    // Runtime theme preset; the configured tree theme + bar style seed it and
    // the palette command updates it, then persists both to the OpenCode config.
    const [themeStore, updateTheme] = ctx.storage.memory("guiTheme", {
      initial: {
        treeTheme: normalizeTreeTheme(ctx.options?.treeTheme),
        barStyle: normalizeBarOptions(ctx.options).style ?? "blocks",
      },
    });
    const treeTheme = (): TreeTheme => themeStore.treeTheme;
    const currentPreset = (): ThemePreset =>
      themePresetFrom(themeStore.treeTheme, themeStore.barStyle);
    const setThemePreset = (value: ThemePreset) => {
      const preset = themePresetChoice(value);
      updateTheme((draft) => {
        draft.treeTheme = preset.treeTheme;
        draft.barStyle = preset.barStyle;
      });
    };
    // Bar options follow the runtime preset so a style switch redraws rows
    // without a plugin reload.
    const options = createMemo(() =>
      normalizeBarOptions({ ...ctx.options, barStyle: themeStore.barStyle })
    );
    const sidebarPanelKey = `${ctx.id}:${GUI_PROGRESS_PANEL_ID}`;
    let alive = true;
    let inFlight = false;

    /** Flip between the composer pill and the pinned side-region panel. */
    const swapLayout = () => {
      const next = nextGuiLayout(layoutMode());
      setLayoutMode(next);
      if (next === "sidebar") {
        const session = ctx.sessions.current();
        if (session) {
          ctx.layout.open(sidebarPanelKey, session, { tab: "select", background: true });
        }
      }
      ctx.toast.show({
        title:
          next === "sidebar"
            ? "Progress moved to the sidebar"
            : "Progress moved above the prompt",
        variant: "default",
        duration: 2500,
      });
    };

    /** Pick a theme preset, apply it now, and save it to the OpenCode config. */
    const switchTreeTheme = async () => {
      const current = currentPreset();
      const choice = await ctx.dialogs.select<ThemePreset>({
        title: "Progress tree theme",
        current,
        options: THEME_PRESET_CHOICES.map((option) => ({
          title: option.title,
          value: option.value,
          description:
            option.value === current
              ? `${option.description} · current`
              : option.description,
        })),
      });
      if (!choice) return;
      const preset = themePresetChoice(choice);
      setThemePreset(choice);
      try {
        const result = await ctx.client.rpc(ProgressRpc).setTreeTheme({
          theme: preset.treeTheme,
          barStyle: preset.barStyle,
        });
        ctx.toast.show({
          title: `Progress theme: ${themePresetLabel(choice)}`,
          description: result.ok
            ? `Saved to ${result.file}`
            : `Applied for this run; config not updated: ${result.error ?? "unknown error"}`,
          variant: result.ok ? "success" : "default",
          duration: result.ok ? 2500 : 5000,
        });
      } catch (error) {
        ctx.toast.show({
          title: `Progress theme: ${themePresetLabel(choice)}`,
          description: `Applied for this run; config not updated: ${String(error)}`,
          variant: "default",
          duration: 5000,
        });
      }
    };

    // A configured sidebar must be visible on startup, not just add a pinned
    // tab to a closed region. Open it once per session; closing it later stays
    // closed until the user asks again.
    const sidebarOpenedFor = new Set<string>();
    createEffect(() => {
      if (layoutMode() !== "sidebar") return;
      const session = ctx.sessions.current();
      if (!session || sidebarOpenedFor.has(session.key)) return;
      sidebarOpenedFor.add(session.key);
      if (!ctx.layout.side.opened(session)) {
        ctx.layout.open(sidebarPanelKey, session, { tab: "select", background: true });
      }
    });
    let lastRevision = "";
    let lastRevisionSession = "";

    /**
     * The host's `rpc(contract)` is typed as an untyped client in this
     * environment; give the handful of methods we call their real shapes.
     */
    type ProgressClient = {
      list(input?: {
        sessionID?: string;
        scope?: "session" | "all";
      }): Promise<{
        entries?: Record<string, ProgressEntry>;
        notes?: GuiNote[];
        revision?: string;
      }>;
      dismiss(input: { key: string; status: string }): Promise<{ ok: boolean }>;
      dismissNote(input: { noteID: string }): Promise<{ ok: boolean }>;
      clearNotes(input: { sessionID: string }): Promise<{ ok: boolean; removed: number }>;
      clear(input: { sessionID: string }): Promise<{ ok: boolean; cleared: number }>;
      hardClearSession(input: {
        sessionID: string;
      }): Promise<{ ok: boolean; removed: number; freedBytes: number }>;
      hardClearAll(input?: Record<string, never>): Promise<{
        ok: boolean;
        removed: number;
        freedBytes: number;
      }>;
      stats(input?: { sessionID?: string }): Promise<{
        entries: number;
        active: number;
        done: number;
        error: number;
        dismissed: number;
        cleared: number;
        bytes: number;
      }>;
      nudgeList(input: { sessionID: string }): Promise<{
        rules: Array<{
          id: string;
          title?: string;
          scope: "global" | "project" | "session";
          enabled: boolean;
          text: string;
          severity: "info" | "warn" | "block";
          delivery: string;
          trigger: string;
          criteria: string;
          ttlMs: number;
          maxFires: number;
          fires: number;
          nextFireAt: number;
          effective: boolean;
        }>;
        errors: string[];
      }>;
      nudgeSet(input: {
        sessionID: string;
        preset?: "replace" | "alongside" | "block" | "custom";
        rule: Record<string, unknown>;
      }): Promise<{ ok: boolean; error?: string }>;
      nudgeSetEnabled(input: {
        sessionID: string;
        scope: "global" | "project" | "session";
        id: string;
        enabled: boolean;
      }): Promise<{ ok: boolean; error?: string }>;
      nudgeClear(input: {
        sessionID: string;
        scope: "global" | "project" | "session";
        id: string;
      }): Promise<{ ok: boolean; error?: string }>;
    };
    const rpcFor = (session: MountedSession) =>
      session.server.client.rpc(ProgressRpc) as unknown as ProgressClient;
    const globalRpc = () =>
      ctx.client.rpc(ProgressRpc) as unknown as ProgressClient;

    type TaskListViewStatus = {
      enabled: boolean;
      mode: "ui" | "raw";
      detail: "code" | "escaped" | "raw";
      location: 0 | 1 | 2;
      order: "newest-first" | "oldest-first";
    };
    const [taskListStatus, setTaskListStatus] = createSignal<TaskListViewStatus | null>(null);
    const refreshTaskListStatus = async () => {
      try {
        const status = await withTimeout(ctx.client.rpc(ProgressRpc).taskListStatus({}), 4000);
        if (!alive) return;
        setTaskListStatus(status as TaskListViewStatus);
      } catch {
        // Status is optional; the mirror may simply be disabled.
      }
    };
    void refreshTaskListStatus();
    const taskListTimer = setInterval(() => void refreshTaskListStatus(), 10_000);

    const sayNotesEnabled = ctx.options?.say === true;
    const sayOptions = normalizeSayOptions(ctx.options);
    const sayModes = sayOptions.modes;
    const autoHideTimeoutMs = sayOptions.autoHideTimeoutMs;
    const saySurfaces = () => guiSaySurfaces(sayModes, layoutMode());
    // Notes expire by wall clock, but the GUI only refreshes on state changes.
    // This clock re-renders the note surfaces only while notes exist.
    const [notesClock, setNotesClock] = createSignal(Date.now());
    let notesClockTimer: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
      const hasNotes = state().notes.length > 0;
      if (hasNotes && !notesClockTimer) {
        notesClockTimer = setInterval(() => setNotesClock(Date.now()), 1000);
      } else if (!hasNotes && notesClockTimer) {
        clearInterval(notesClockTimer);
        notesClockTimer = undefined;
      }
    });
    // Optimistic note removals between the click and the next server state.
    // Note ids are stable, so a removed id stays filtered until it disappears
    // from the shared ring buffer.
    const [pendingNoteDismissals, setPendingNoteDismissals] = createSignal<
      Record<string, number>
    >({});
    /** Per-session note ids already seen; the first load primes without toasts. */
    const seenNotesBySession = new Map<string, Set<string>>();

    /** Notes rolled up to this session's root, newest first. */
    const notesForSession = (sessionID: string, all: GuiNote[] = state().notes) => {
      const pending = pendingNoteDismissals();
      const scoped = all.filter(
        (note) =>
          !pending[note.id] &&
          (note.rootSessionId ?? note.sessionId) === sessionID
      );
      return visibleSayNotes(scoped, notesClock(), autoHideTimeoutMs).slice(0, 20);
    };

    /**
     * Toast notes that appeared after this session was first loaded. The
     * baseline is per session, so switching chats never replays old history.
     */
    const toastFreshNotes = (sessionID: string, all: GuiNote[]) => {
      if (!saySurfaces().toast) return;
      const notes = notesForSession(sessionID, all);
      const current = new Set(notes.map((note) => note.id));
      const seen = seenNotesBySession.get(sessionID);
      if (!seen) {
        seenNotesBySession.set(sessionID, current);
        return;
      }
      const pendingRemovals = pendingNoteDismissals();
      for (const id of [...seen]) {
        // Keep ids that are merely awaiting the server's dismiss write; only
        // forget notes that are truly gone (prevents a re-toast race).
        if (!current.has(id) && !pendingRemovals[id]) seen.delete(id);
      }
      const toastable = new Set(
        sayToastNotes(notes, sessionID, sayOptions.toastScope).map((note) => note.id)
      );
      const fresh = notes
        .filter((note) => !seen.has(note.id) && toastable.has(note.id))
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      for (const note of notes) seen.add(note.id);
      for (const note of fresh) {
        const toast = buildNoteToast(note, sessionID);
        // The desktop toast API has no `warning` variant; use its warning
        // icon with the neutral tone for blocked/question notes.
        ctx.toast.show({
          title: toast.title,
          description: toast.description,
          variant: "default",
          ...(toast.tone === "warning" ? { icon: "warning" as const } : {}),
          duration: sayToastDurationMs(note.kind),
        });
      }
    };

    const refresh = async () => {
      if (inFlight || interacting() || Date.now() < suspendUntil) return;
      inFlight = true;
      try {
        const session = ctx.sessions.current();
        if (!session) {
          setState((prev) => ({ ...prev, notes: [], loaded: true }));
          return;
        }
        const result = await withTimeout(
          rpcFor(session).list({ scope: "all", sessionID: session.id }),
          4000
        );
        if (!alive) return;
        if (session.id !== lastRevisionSession) {
          lastRevision = "";
          lastRevisionSession = session.id;
        }
        const revision = typeof result?.revision === "string" ? result.revision : "";
        if (revision && revision === lastRevision) return;
        if (revision) lastRevision = revision;
        const entries = (result?.entries ?? {}) as Record<string, ProgressEntry>;
        const notes = (result?.notes ?? []) as GuiNote[];
        // Drop optimistic dismissals once the persisted state reflects them.
        // Build the next map first so an unchanged poll does not notify every
        // dependent computation a second time.
        const prevPending = pendingDismissed();
        const nextPending = { ...prevPending };
        let pendingChanged = false;
        for (const [key, value] of Object.entries(prevPending)) {
          const d = entries[key]?.dismissed;
          if (d && typeof d === "object" && (d as { at: number }).at >= value.at - 500) {
            delete nextPending[key];
            pendingChanged = true;
          }
        }
        // Drop optimistic note removals once the shared ring buffer no longer
        // contains them (the server processed the dismiss/clear).
        const prevNotePending = pendingNoteDismissals();
        const nextNotePending = { ...prevNotePending };
        let notePendingChanged = false;
        const liveNoteIDs = new Set(notes.map((note) => note.id));
        for (const id of Object.keys(prevNotePending)) {
          if (!liveNoteIDs.has(id)) {
            delete nextNotePending[id];
            notePendingChanged = true;
          }
        }
        batch(() => {
          setState({ entries, notes, loaded: true });
          if (pendingChanged) setPendingDismissed(nextPending);
          if (notePendingChanged) setPendingNoteDismissals(nextNotePending);
        });
        toastFreshNotes(session.id, notes);

      } catch (error) {
        if (!alive) return;
        setState((prev) => ({ ...prev, loaded: true, error: String(error) }));
        console.error("[opencode-progress] rpc list failed", String(error));
      } finally {
        inFlight = false;
      }
    };

    console.log(`[opencode-progress] gui setup v${pkg.version} (opencode ${ctx.app.version}, ${ctx.app.platform})`);
    if (ctx.options?.notifyOnLoad === true) {
      ctx.toast.show({
        title: "Progress plugin loaded",
        description: `${ctx.app.platform} · opencode-progress v${pkg.version}`,
        variant: "success",
        duration: 2500,
      });
    }
    void refresh();
    let unsubscribeUpdated: (() => void) | undefined;
    try {
      // The server emits this whenever its state signature changes. Polling
      // stays as a slow fallback for a missed event or a server restart.
      unsubscribeUpdated = ctx.client
        .rpc(ProgressRpc)
        .events.on("updated", () => void refresh());
    } catch (error) {
      console.warn("[opencode-progress] updated subscription unavailable", String(error));
    }
    const timer = setInterval(
      () => void refresh(),
      unsubscribeUpdated ? Math.max(refreshMs, 5000) : refreshMs
    );

    /** Persisted dismissals, read straight from the state doc entries. */
    const dismissedFromEntries = (
      entries: Record<string, ProgressEntry> = state().entries
    ) => {
      const map: Record<string, { status: string; at: number }> = {};
      for (const [key, entry] of Object.entries(entries)) {
        const d = entry.dismissed;
        if (d && typeof d === "object" && typeof d.at === "number") {
          map[key] = { status: String(d.status ?? ""), at: d.at };
        }
      }
      return map;
    };

    /** Persisted + optimistic: pending wins while newer than persisted. */
    const dismissedMap = (entries: Record<string, ProgressEntry> = state().entries) => {
      const merged = dismissedFromEntries(entries);
      for (const [key, pending] of Object.entries(pendingDismissed())) {
        const persisted = merged[key];
        if (!persisted || pending.at > persisted.at) merged[key] = pending;
      }
      return merged;
    };

    /** Persist the dismissal via the plugin server, optimistically in-memory. */
    const dismissKey = (
      session: MountedSession,
      key: string,
      status: string
    ) => {
      setPendingDismissed((prev) => ({ ...prev, [key]: { status, at: Date.now() } }));
      void rpcFor(session)
        .dismiss({ key, status })
        .catch((error: unknown) =>
          console.error("[opencode-progress] dismiss rpc failed", String(error))
        );
    };

    const sessionEntries = (sessionID: string) =>
      Object.entries(state().entries).filter(
        ([key, entry]) =>
          entry &&
          typeof entry === "object" &&
          (entry.sessionId === sessionID || key.startsWith(`${sessionID}:`))
      );

    /** Palette-only: soft-clear finished/dismissed entries for this session. */
    const clearList = async () => {
      const session = ctx.sessions.current();
      if (!session) {
        ctx.toast.show({ title: "Open a session first", variant: "error" });
        return;
      }
      const candidates = sessionEntries(session.id).filter(
        ([, entry]) =>
          !entry.cleared &&
          (entry.status === "done" ||
            entry.status === "error" ||
            Boolean(entry.dismissed))
      );
      if (candidates.length === 0) {
        ctx.toast.show({ title: "Nothing to clear", description: "No finished or dismissed entries.", variant: "default" });
        return;
      }
      const confirmed = await ctx.dialogs.confirm({
        title: "Clear progress list?",
        description: `${candidates.length} finished or dismissed ${
          candidates.length === 1 ? "entry" : "entries"
        } will be hidden. Records stay on disk; running tasks keep showing.`,
        confirm: "Clear list",
        danger: true,
      });
      if (!confirmed) return;
      try {
        const result = await rpcFor(session).clear({ sessionID: session.id });
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Progress list cleared",
          description: `${result.cleared} ${
            result.cleared === 1 ? "entry" : "entries"
          } hidden; records kept.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Clear failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    /** Palette-only: permanently delete this session's progress entries. */
    const hardClearSession = async () => {
      const session = ctx.sessions.current();
      if (!session) {
        ctx.toast.show({ title: "Open a session first", variant: "error" });
        return;
      }
      try {
        const stats = await rpcFor(session).stats({ sessionID: session.id });
        if (stats.entries === 0) {
          ctx.toast.show({ title: "Nothing to delete", variant: "default" });
          return;
        }
        const confirmed = await ctx.dialogs.confirm({
          title: "Permanently delete session progress?",
          description: `${stats.entries} ${
            stats.entries === 1 ? "entry" : "entries"
          } (${formatBytes(stats.bytes)}) will be removed from the progress store. The mirrored tasklist file is kept. This cannot be undone.`,
          confirm: "Delete permanently",
          danger: true,
        });
        if (!confirmed) return;
        const result = await rpcFor(session).hardClearSession({
          sessionID: session.id,
        });
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Session progress deleted",
          description: `${result.removed} ${
            result.removed === 1 ? "entry" : "entries"
          } removed · ${formatBytes(result.freedBytes)} freed.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Delete failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    /** Palette-only: wipe every progress entry. Requires typing DELETE. */
    const hardClearStore = async () => {
      try {
        const stats = await globalRpc().stats({});
        if (stats.entries === 0) {
          ctx.toast.show({ title: "Progress store is already empty", variant: "default" });
          return;
        }
        const typed = await ctx.dialogs.prompt({
          title: "Hard clear the entire progress store",
          description: `This deletes all ${stats.entries} entries (${formatBytes(
            stats.bytes
          )}) from the plugin store. It cannot be undone without a backup and prevents future auditing or progress reporting. Type DELETE to confirm.`,
          placeholder: "DELETE",
          submit: "Delete everything",
        });
        if (typed?.trim() !== "DELETE") {
          if (typed !== undefined) {
            ctx.toast.show({ title: "Store not cleared", description: "Confirmation did not match.", variant: "default" });
          }
          return;
        }
        const result = await globalRpc().hardClearAll({});
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Progress store cleared",
          description: `${result.removed} ${
            result.removed === 1 ? "entry" : "entries"
          } removed · ${formatBytes(result.freedBytes)} freed. Mirrored tasklists kept.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Hard clear failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    ctx.add(Command, () => ({
      id: "progress.clear",
      title: "Progress: clear list (this session)",
      description: "Hide finished and dismissed entries; records stay on disk",
      keywords: "progress clear soft delete dismiss history",
      section: "session" as const,
      get enabled() {
        return Boolean(ctx.sessions.current());
      },
      run: () => void clearList(),
    }));

    ctx.add(Command, () => ({
      id: "progress.hard-clear-session",
      title: "Progress: hard clear this session",
      description: "Permanently delete this session's progress entries",
      keywords: "progress hard delete purge session store",
      section: "session" as const,
      get enabled() {
        return Boolean(ctx.sessions.current());
      },
      run: () => void hardClearSession(),
    }));

    ctx.add(Command, () => ({
      id: "progress.hard-clear-store",
      title: "Progress: hard clear entire progress store",
      description: "Delete all progress entries; requires typing DELETE",
      keywords: "progress hard delete purge all store wipe",
      section: "general" as const,
      run: () => void hardClearStore(),
    }));

    ctx.add(
      Style,
      `.progress-pill-button { cursor: pointer !important; }
       .progress-pill-button:hover { background: rgba(127,127,127,0.18) !important; }`
    );

    const footerButtonStyle = {
      flex: "1 1 auto",
      border: "none",
      background: "transparent",
      color: "inherit",
      opacity: "0.65",
      cursor: "pointer",
      "text-align": "left",
      padding: "3px 4px",
      "font-size": "12px",
    };

    /**
     * Read-only settings tab for the pill popover and sidebar. Values are the
     * effective runtime options; edits belong in the OpenCode config that
     * declares the plugin and apply on reload.
     */
    const SettingsPanel = (props: { onBack: () => void }) => {
      const sections = () => [
        {
          title: "View",
          rows: [
            ["Placement", layoutMode()],
            ["Tree theme", treeTheme()],
            ["Bar style", themeStore.barStyle],
            ["Detail lines", String(detailLines)],
            ["Refresh", `${refreshMs}ms`],
            ["Done entries", visibility.showDone ? (visibility.autoHideDone ? "auto-hide" : "shown") : "hidden"],
            ["Expand roots", expandRootsByDefault ? "yes" : "no"],
          ] as Array<[string, string]>,
        },
        {
          title: "Reminders",
          rows: [
            ["Strict mode", String(ctx.options?.strictMode ?? "nudge")],
            ["Wall clock", `${Math.round((typeof ctx.options?.wallClockMs === "number" ? ctx.options.wallClockMs : 120_000) / 1000)}s`],
            ["Idle reminder", ctx.options?.idleReminder === false ? "off" : "on"],
            ["Relay hints", ctx.options?.relayHints === false ? "off" : "on"],
            ["Custom nudges", ctx.options?.customNudges === true ? "on" : "off (opt-in)"],
            ["Say notes", ctx.options?.say === true ? "on" : "off"],
            ["Say surfaces", sayModes.length > 0 ? sayModes.join(", ") : "none"],
          ] as Array<[string, string]>,
        },
        {
          title: "Data",
          rows: [
            ["Scope", visibility.scope],
            ["Task-list mirror", taskListStatus()?.enabled ? taskListStatus()?.mode ?? "on" : "off"],
            ["Workspace", ctx.location?.directory ?? "unknown"],
          ] as Array<[string, string]>,
        },
      ];

      const linkStyle = {
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        padding: "0",
        "font-size": "10px",
        "text-decoration": "underline",
        opacity: "0.75",
      } as const;

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
            "min-height": "260px",
            "min-width": "260px",
            "max-height": "min(60vh, 520px)",
            "overflow-y": "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              "padding-bottom": "6px",
              "border-bottom": "1px solid rgba(127,127,127,0.2)",
              "flex": "0 0 auto",
            }}
          >
            <span style={{ flex: "1 1 auto", "font-size": "12px", opacity: "0.75" }}>
              Plugin settings
            </span>
            <button
              type="button"
              class="progress-pill-button"
              onClick={props.onBack}
              style={{ ...footerButtonStyle, flex: "0 0 auto", padding: "0", opacity: "1", "font-size": "10px", "text-decoration": "underline" }}
            >
              [Tree]
            </button>
          </div>
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "8px",
              "padding-right": "4px",
            }}
          >
            <For each={sections()}>
              {(section) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                  <div style={{ "font-size": "10px", "text-transform": "uppercase", "letter-spacing": "0.04em", opacity: "0.45" }}>
                    {section.title}
                  </div>
                  <For each={section.rows}>
                    {([label, value]) => (
                      <div
                        style={{
                          display: "flex",
                          "align-items": "baseline",
                          gap: "8px",
                          "font-size": "11px",
                          "line-height": "1.35",
                        }}
                      >
                        <span style={{ flex: "0 0 96px", opacity: "0.55" }}>{label}</span>
                        <span style={{ flex: "1 1 auto", "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={value}>
                          {value}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              "padding-top": "4px",
              "border-top": "1px solid rgba(127,127,127,0.2)",
              "font-size": "10px",
              opacity: "0.6",
              "flex": "0 0 auto",
            }}
          >
            <button type="button" class="progress-pill-button" style={linkStyle} onClick={() => ctx.system.openExternal(releasesUrl())}>
              v{pkg.version} release notes ↗
            </button>
            <button type="button" class="progress-pill-button" style={linkStyle} onClick={() => ctx.system.openExternal("https://github.com/jakedowns/progress-tool#readme")}>
              Docs ↗
            </button>
          </div>
          <div style={{ "font-size": "10px", opacity: "0.45", "flex": "0 0 auto" }}>
            Edit these in the OpenCode config that declares the plugin; reload to apply.
          </div>
        </div>
      );
    };

    const sidebarHeaderButtonStyle = {
      flex: "0 0 auto",
      border: "1px solid rgba(127,127,127,0.35)",
      background: "transparent",
      color: "inherit",
      opacity: "0.7",
      "border-radius": "999px",
      padding: "1px 8px",
      cursor: "pointer",
      "font-size": "11px",
      "white-space": "nowrap",
    };

    const ProgressMenu = (props: {
      session: MountedSession;
      sessionID: string;
      close?: () => void;
    }) => {
      // The popover removes this component without a pointerleave; make sure
      // closing it never leaves refresh paused forever.
      onCleanup(() => setInteracting(false));
      const [view, setView] = createSignal<"tree" | "settings">("tree");
      const scoped = createMemo(() =>
        scopeEntries(state().entries, props.sessionID, visibility)
      );
      // Persisted + optimistic dismissals, recomputed once per state change
      // rather than once per root. The old per-root call scanned every entry
      // in the store for every root, which dominated the 1 s tick.
      const dismissed = createMemo(() => {
        const merged = dismissedFromEntries(scoped());
        for (const [key, pending] of Object.entries(pendingDismissed())) {
          const persisted = merged[key];
          if (!persisted || pending.at > persisted.at) merged[key] = pending;
        }
        return merged;
      });
      const tree = createMemo(() =>
        buildVisibleTree(scoped(), Date.now(), visibility, dismissed())
      );
      const visibleRoots = createMemo(() => tree());
      const [expandedOverrides, setExpandedOverrides] = createSignal<Record<string, boolean>>({});
      const expandByDefault = ctx.options?.expandRootsByDefault === true;
      const collapsedMap = createMemo(() =>
        collapsedRootMap(visibleRoots(), expandByDefault, expandedOverrides())
      );
      const rows = createMemo(() => visibleRows(visibleRoots(), collapsedMap()));
      const doneRoots = createMemo(() =>
        visibleRoots().filter((root) => root.status === "done")
      );
      // Stable keys keep <For> from remounting every row on each poll. The
      // node lookup is reactive, so row content still updates in place.
      const rootKeys = createMemo(() => visibleRoots().map((root) => root.key));
      const rootByKey = createMemo(() => {
        const map = new Map<string, TreeNode>();
        for (const root of visibleRoots()) map.set(root.key, root);
        return map;
      });

      // Slide-away dismissal: mark the root as leaving (still rendered) and
      // slide it out sideways; once it has cleared the right edge, collapse
      // its container vertically, then actually dismiss so the filter removes
      // it. Dismiss-all staggers the rows slightly.
      const SLIDE_MS = 380;
      const COLLAPSE_MS = 300;
      const [leaving, setLeaving] = createSignal<Record<string, number>>({});
      const [leavingCollapsed, setLeavingCollapsed] = createSignal<Record<string, boolean>>({});
      const dismissAnimated = (root: TreeNode, delayMs = 0) => {
        if (leaving()[root.key] !== undefined) return;
        // Do not let a poll land mid-animation and rebuild the rows.
        suspendUntil = Math.max(
          suspendUntil,
          Date.now() + delayMs + SLIDE_MS + COLLAPSE_MS + 120
        );
        setLeaving((prev) => ({ ...prev, [root.key]: delayMs }));
        setTimeout(() => {
          setLeavingCollapsed((prev) => ({ ...prev, [root.key]: true }));
          setTimeout(() => {
            dismissKey(props.session, root.key, root.status ?? "");
            setLeaving((prev) => {
              const next = { ...prev };
              delete next[root.key];
              return next;
            });
            setLeavingCollapsed((prev) => {
              const next = { ...prev };
              delete next[root.key];
              return next;
            });
          }, COLLAPSE_MS + 20);
        }, delayMs + SLIDE_MS);
      };

      // Our own scroll container: <For> rebuilds row DOM when the tree
      // changes (e.g. after a dismiss), which resets scrollTop. Track the
      // user's position and restore it after each re-render.
      let listEl: HTMLDivElement | undefined;
      let scrollTop = 0;
      createEffect(() => {
        rows();
        const target = scrollTop;
        queueMicrotask(() => {
          if (listEl && listEl.scrollTop !== target) listEl.scrollTop = target;
        });
      });

      // Scroll the list so a root sits at the top of the viewport before its
      // exit animation starts.
      const scrollToRoot = (key: string) => {
        if (!listEl) return;
        const el = listEl.querySelector<HTMLElement>(
          `[data-root-key="${key.replace(/"/g, '\\"')}"]`
        );
        if (!el) return;
        const top =
          el.getBoundingClientRect().top -
          listEl.getBoundingClientRect().top +
          listEl.scrollTop;
        const next = Math.max(0, top - 2);
        listEl.scrollTop = next;
        scrollTop = next;
      };

      // Dismiss a batch (done / all): first bring the first row that will
      // animate into view, then stagger the rows.
      const dismissMany = (roots: TreeNode[]) => {
        const pending = roots.filter((root) => leaving()[root.key] === undefined);
        if (pending.length === 0) return;
        scrollToRoot(pending[0].key);
        pending.forEach((root, index) =>
          dismissAnimated(root, Math.min(index, 10) * 45)
        );
      };

      return (
        <div
          onPointerEnter={() => setInteracting(true)}
          onPointerLeave={() => setInteracting(false)}
          style={{
            display: "flex",
            "flex-direction": "column",
            "min-width": "320px",
            "max-width": "520px",
          }}
        >
          <Show
            when={view() === "tree"}
            fallback={
              <ErrorBoundary
                fallback={(error) => (
                  <div style={{ padding: "8px", "font-size": "12px", color: "#f87171" }}>
                    Settings failed to render: {String(error)}
                  </div>
                )}
              >
                <SettingsPanel onBack={() => setView("tree")} />
              </ErrorBoundary>
            }
          >
          <div
            ref={(el) => (listEl = el)}
            onScroll={(event) => {
              scrollTop = event.currentTarget.scrollTop;
            }}
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "2px",
              "flex": "0 1 auto",
              "min-height": "0",
              "max-height": "min(60vh, 520px)",
              "overflow-y": "auto",
              "overflow-x": "hidden",
              "padding-right": "4px",
            }}
          >
          <Show
            when={rows().length > 0}
            fallback={
              <div style={{ opacity: "0.6", "font-size": "13px", padding: "8px" }}>
                No active progress
              </div>
            }
          >
            <For each={rootKeys()}>
              {(key) => {
                const root = () => rootByKey().get(key);
                const isCollapsed = () => collapsedMap()[key] ?? false;
                return (
                  // Outer wrapper collapses vertically once the row has slid
                  // fully past the right edge.
                  <div
                    data-root-key={key}
                    style={{
                      display: "grid",
                      "grid-template-rows": leavingCollapsed()[key] ? "0fr" : "1fr",
                      transition: "grid-template-rows 0.3s ease-in",
                    }}
                  >
                    <Show when={root()}>
                      {(node) => (
                        <div style={{ overflow: "hidden", "min-height": "0" }}>
                          <MenuRow
                            node={node()}
                            depth={0}
                            options={options()}
                            detailLines={detailLines}
                            theme={treeTheme()}
                            hasChildren={node().children.length > 0}
                            collapsed={isCollapsed()}
                            onToggle={() =>
                              setExpandedOverrides((prev) => ({
                                ...prev,
                                [key]: !(prev[key] ?? expandByDefault),
                              }))
                            }
                            onDismiss={() => dismissAnimated(node())}
                            leaving={leaving()[key] !== undefined}
                            leaveDelayMs={leaving()[key] ?? 0}
                          />
                          <div
                            style={{
                              display: "grid",
                              "grid-template-rows": isCollapsed() ? "0fr" : "1fr",
                              transition: "grid-template-rows 0.5s ease-in-out, transform 0.35s ease-in, opacity 0.3s ease-in",
                              transform:
                                leaving()[key] !== undefined
                                  ? "translateX(120%)"
                                  : "translateX(0)",
                              opacity: leaving()[key] !== undefined ? "0" : "1",
                              "transition-delay": `${leaving()[key] ?? 0}ms`,
                            }}
                          >
                            <div style={{ overflow: "hidden", "min-height": "0" }}>
                              <For each={flattenTreeWithDepth(node().children, 1)}>
                                {({ node: child, depth }) => (
                                  <MenuRow
                                    node={child}
                                    depth={depth}
                                    options={options()}
                                    detailLines={detailLines}
                                    theme={treeTheme()}
                                    onDismiss={() =>
                                      dismissKey(props.session, child.key, child.status ?? "")
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
          </div>
          </Show>
          <Show when={view() === "tree" && rows().length > 0}>
            <div
              style={{
                display: "flex",
                gap: "2px",
                "margin-top": "2px",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
                "flex": "0 0 auto",
              }}
            >
              <Show when={doneRoots().length > 0 && doneRoots().length < visibleRoots().length}>
                <button
                  type="button"
                  class="progress-pill-button"
                  onClick={() => dismissMany(doneRoots())}
                  style={footerButtonStyle}
                >
                  ✓ Dismiss done ({doneRoots().length})
                </button>
              </Show>
              <button
                type="button"
                class="progress-pill-button"
                onClick={() => dismissMany(visibleRoots())}
                style={footerButtonStyle}
              >
                ✕ Dismiss all ({visibleRoots().length})
              </button>
            </div>
          </Show>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "padding": "1px 4px 2px",
              "font-size": "10px",
              opacity: "0.45",
              "user-select": "none",
            }}
          >
            <span>progress plugin desktop</span>
            <button
              type="button"
              class="progress-pill-button"
              title="Open release notes"
              onClick={() => ctx.system.openExternal(releasesUrl())}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [v{pkg.version}]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Show plugin settings"
              onClick={() => setView((current) => (current === "settings" ? "tree" : "settings"))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              {view() === "settings" ? "[Tree]" : "[Settings]"}
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Move progress into the sidebar"
              onClick={() => {
                swapLayout();
                props.close?.();
              }}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Sidebar]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              onClick={() => ctx.system.openExternal(feedbackIssueUrl(pkg.version))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Feedback]
            </button>
          </div>
        </div>
      );
    };

    /**
     * Full tree for the pinned side-region panel. Unlike the popover it has
     * no height cap of its own; the panel body scrolls, and the header keeps
     * the aggregate summary and a way back to the composer pill.
     */
    const ProgressSidebar = (props: {
      session: () => MountedSession;
      sessionID: () => string;
    }) => {
      const [view, setView] = createSignal<"tree" | "settings">("tree");
      const scoped = createMemo(() =>
        scopeEntries(state().entries, props.sessionID(), visibility)
      );
      const dismissed = createMemo(() => {
        const merged = dismissedFromEntries(scoped());
        for (const [key, pending] of Object.entries(pendingDismissed())) {
          const persisted = merged[key];
          if (!persisted || pending.at > persisted.at) merged[key] = pending;
        }
        return merged;
      });
      const tree = createMemo(() =>
        buildVisibleTree(scoped(), Date.now(), visibility, dismissed())
      );
      const visibleRoots = createMemo(() => tree());
      const [expandedOverrides, setExpandedOverrides] = createSignal<
        Record<string, boolean>
      >({});
      const expandByDefault = ctx.options?.expandRootsByDefault === true;
      const collapsedMap = createMemo(() =>
        collapsedRootMap(visibleRoots(), expandByDefault, expandedOverrides())
      );
      const doneRoots = createMemo(() =>
        visibleRoots().filter((root) => root.status === "done")
      );
      const rootKeys = createMemo(() => visibleRoots().map((root) => root.key));
      const rootByKey = createMemo(() => {
        const map = new Map<string, TreeNode>();
        for (const root of visibleRoots()) map.set(root.key, root);
        return map;
      });
      const summary = createMemo(() => {
        const totals = summarizeEntries(scoped());
        const parts: string[] = [];
        if (totals.active > 0) parts.push(`${totals.active} active`);
        if (totals.pending > 0) parts.push(`${totals.pending} pending`);
        if (totals.done > 0) parts.push(`${totals.done} done`);
        if (totals.dismissed > 0) parts.push(`${totals.dismissed} dismissed`);
        return parts.length > 0 ? parts.join(" · ") : "Agent progress";
      });
      const dismissAll = (roots: TreeNode[]) => {
        for (const root of roots) {
          dismissKey(props.session(), root.key, root.status ?? "");
        }
      };
      const notesLine = createMemo(() => {
        if (!guiSaySurfaces(sayModes, "sidebar").line) return "";
        return buildNotesLine(notesForSession(props.sessionID()), props.sessionID());
      });

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            height: "100%",
            "min-height": "0",
            gap: "4px",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "padding-bottom": "6px",
              "border-bottom": "1px solid rgba(127,127,127,0.2)",
              "flex": "0 0 auto",
            }}
          >
            <span
              title={summary()}
              style={{
                flex: "1 1 auto",
                "min-width": "0",
                "font-size": "12px",
                opacity: "0.65",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {summary()}
            </span>
            <button
              type="button"
              class="progress-pill-button"
              title="Move progress above the prompt"
              onClick={() => swapLayout()}
              style={sidebarHeaderButtonStyle}
            >
              → Composer
            </button>
          </div>
          <Show when={notesLine()}>
            <div
              title={notesLine()}
              style={{
                "font-size": "11px",
                opacity: "0.62",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "flex": "0 0 auto",
              }}
            >
              {notesLine()}
            </div>
          </Show>
          <Show
            when={view() === "tree"}
            fallback={
              <ErrorBoundary
                fallback={(error) => (
                  <div style={{ padding: "8px", "font-size": "12px", color: "#f87171" }}>
                    Settings failed to render: {String(error)}
                  </div>
                )}
              >
                <SettingsPanel onBack={() => setView("tree")} />
              </ErrorBoundary>
            }
          >
          <Show
            when={visibleRoots().length > 0}
            fallback={
              <div
                style={{
                  opacity: "0.6",
                  "font-size": "13px",
                  padding: "8px 2px",
                  "flex": "1 1 auto",
                }}
              >
                No active progress
              </div>
            }
          >
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "2px",
                flex: "1 1 auto",
                "min-height": "0",
                "overflow-y": "auto",
                "overflow-x": "hidden",
                "padding-right": "2px",
              }}
            >
              <For each={rootKeys()}>
                {(key) => {
                  const root = () => rootByKey().get(key);
                  const isCollapsed = () => collapsedMap()[key] ?? false;
                  return (
                    <Show when={root()}>
                      {(node) => (
                        <div>
                          <MenuRow
                            node={node()}
                            depth={0}
                            options={options()}
                            detailLines={detailLines}
                            theme={treeTheme()}
                            hasChildren={node().children.length > 0}
                            collapsed={isCollapsed()}
                            onToggle={() =>
                              setExpandedOverrides((prev) => ({
                                ...prev,
                                [key]: !(prev[key] ?? expandByDefault),
                              }))
                            }
                            onDismiss={() =>
                              dismissKey(props.session(), key, node().status ?? "")
                            }
                          />
                          <div
                            style={{
                              display: "grid",
                              "grid-template-rows": isCollapsed() ? "0fr" : "1fr",
                              transition: "grid-template-rows 0.35s ease-in-out",
                            }}
                          >
                            <div style={{ overflow: "hidden", "min-height": "0" }}>
                              <For each={flattenTreeWithDepth(node().children, 1)}>
                                {({ node: child, depth }) => (
                                  <MenuRow
                                    node={child}
                                    depth={depth}
                                    options={options()}
                                    detailLines={detailLines}
                                    theme={treeTheme()}
                                    onDismiss={() =>
                                      dismissKey(props.session(), child.key, child.status ?? "")
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          </Show>
          </Show>
          <Show when={view() === "tree" && visibleRoots().length > 0}>
            <div
              style={{
                display: "flex",
                gap: "2px",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
                "flex": "0 0 auto",
              }}
            >
              <Show when={doneRoots().length > 0 && doneRoots().length < visibleRoots().length}>
                <button
                  type="button"
                  class="progress-pill-button"
                  onClick={() => dismissAll(doneRoots())}
                  style={footerButtonStyle}
                >
                  ✓ Dismiss done ({doneRoots().length})
                </button>
              </Show>
              <button
                type="button"
                class="progress-pill-button"
                onClick={() => dismissAll(visibleRoots())}
                style={footerButtonStyle}
              >
                ✕ Dismiss all ({visibleRoots().length})
              </button>
            </div>
          </Show>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "padding": "1px 2px 2px",
              "font-size": "10px",
              opacity: "0.45",
              "user-select": "none",
              "flex": "0 0 auto",
            }}
          >
            <span>progress plugin desktop</span>
            <button
              type="button"
              class="progress-pill-button"
              title="Open release notes"
              onClick={() => ctx.system.openExternal(releasesUrl())}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [v{pkg.version}]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Show plugin settings"
              onClick={() => setView((current) => (current === "settings" ? "tree" : "settings"))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              {view() === "settings" ? "[Tree]" : "[Settings]"}
            </button>
            <button
              type="button"
              class="progress-pill-button"
              onClick={() => ctx.system.openExternal(feedbackIssueUrl(pkg.version))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Feedback]
            </button>
          </div>
        </div>
      );
    };

    const NOTE_RING_RADIUS = 5;
    const NOTE_RING_CIRCUMFERENCE = 2 * Math.PI * NOTE_RING_RADIUS;

    /** Countdown ring for the note's auto-hide expiry. */
    const NoteExpiryRing = (props: { note: GuiNote }) => {
      const remaining = () => {
        if (!(autoHideTimeoutMs > 0)) return 1;
        const at = typeof props.note.at === "number" ? props.note.at : 0;
        return Math.max(0, Math.min(1, 1 - (notesClock() - at) / autoHideTimeoutMs));
      };
      const seconds = () =>
        Math.max(0, Math.ceil((remaining() * autoHideTimeoutMs) / 1000));
      return (
        <Show when={autoHideTimeoutMs > 0}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            role="img"
            aria-label={`Note expires in ${seconds()}s`}
            style={{ flex: "0 0 auto", transform: "rotate(-90deg)" }}
          >
            <title>{remaining() > 0 ? `Expires in ${seconds()}s` : "Expiring now"}</title>
            <circle
              cx="8"
              cy="8"
              r={NOTE_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-opacity="0.2"
              stroke-width="2"
            />
            <circle
              cx="8"
              cy="8"
              r={NOTE_RING_RADIUS}
              fill="none"
              stroke={remaining() < 0.25 ? "#f59e0b" : "currentColor"}
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray={`${NOTE_RING_CIRCUMFERENCE}`}
              stroke-dashoffset={`${NOTE_RING_CIRCUMFERENCE * (1 - remaining())}`}
            />
          </svg>
        </Show>
      );
    };

    const NotesMenu = (props: { session: MountedSession; sessionID: string }) => {
      onCleanup(() => setInteracting(false));
      const notes = createMemo(() => notesForSession(props.sessionID));
      const showLine = () => guiSaySurfaces(sayModes, layoutMode()).line;
      const line = () =>
        showLine() ? buildNotesLine(notes(), props.sessionID) : "";

      const markPending = (ids: readonly string[]) =>
        setPendingNoteDismissals((prev) => {
          const next = { ...prev };
          const at = Date.now();
          for (const id of ids) next[id] = at;
          return next;
        });
      const unmarkPending = (ids: readonly string[]) =>
        setPendingNoteDismissals((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });

      const dismissNote = (note: GuiNote) => {
        markPending([note.id]);
        void rpcFor(props.session)
          .dismissNote({ noteID: note.id })
          .then((result) => {
            if (result.ok) return;
            unmarkPending([note.id]);
            ctx.toast.show({
              title: "Note already dismissed",
              description: "It was removed by another view.",
              variant: "default",
            });
          })
          .catch((error: unknown) => {
            unmarkPending([note.id]);
            ctx.toast.show({
              title: "Dismiss note failed",
              description: String(error),
              variant: "error",
            });
          });
      };

      const dismissAllNotes = () => {
        const ids = notes().map((note) => note.id);
        if (ids.length === 0) return;
        markPending(ids);
        void rpcFor(props.session)
          .clearNotes({ sessionID: props.sessionID })
          .then((result) => {
            if (result.removed === 0) unmarkPending(ids);
            void refresh();
          })
          .catch((error: unknown) => {
            unmarkPending(ids);
            ctx.toast.show({
              title: "Dismiss all notes failed",
              description: String(error),
              variant: "error",
            });
          });
      };

      return (
        <div
          onPointerEnter={() => setInteracting(true)}
          onPointerLeave={() => setInteracting(false)}
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
            "min-width": "320px",
            "max-width": "520px",
          }}
        >
          <Show when={line()}>
            <div
              title={line()}
              style={{
                "font-size": "11px",
                opacity: "0.62",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {line()}
            </div>
          </Show>
          <For each={notes()}>
            {(note) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                <div
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    gap: "12px",
                    "font-size": "11px",
                    color: "#94a3b8",
                  }}
                >
                  <span>
                    {noteAuthorLabel(note, props.sessionID)} · {note.kind}
                    {note.eta ? ` · ETA ${note.eta}` : ""}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      "flex": "0 0 auto",
                    }}
                  >
                    <NoteExpiryRing note={note} />
                    <span title={new Date(note.at).toLocaleString()}>
                      {formatRelative(note.at)}
                    </span>
                    <button
                      type="button"
                      class="progress-pill-button"
                      title="Dismiss this note"
                      aria-label="Dismiss note"
                      onClick={() => dismissNote(note)}
                      style={{
                        border: "1px solid rgba(127,127,127,0.35)",
                        background: "transparent",
                        color: "inherit",
                        opacity: "0.7",
                        "border-radius": "50%",
                        width: "20px",
                        height: "20px",
                        cursor: "pointer",
                        "line-height": "1",
                        padding: "0",
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div
                  style={{
                    "font-size": "13px",
                    "white-space": "pre-wrap",
                    "overflow-wrap": "anywhere",
                  }}
                >
                  {note.text}
                </div>
              </div>
            )}
          </For>
          <Show when={notes().length > 0}>
            <div
              style={{
                display: "flex",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
              }}
            >
              <button
                type="button"
                class="progress-pill-button"
                onClick={dismissAllNotes}
                style={footerButtonStyle}
              >
                ✕ Dismiss all notes ({notes().length})
              </button>
            </div>
          </Show>
        </div>
      );
    };

    ctx.add(ComposerPill, () => ({
      id: "progress",
      show: (input) => {
        if (layoutMode() === "sidebar") return undefined;
        const current = state();
        const scoped = scopeEntries(current.entries, input.session.id, visibility);
        const empty = Object.keys(scoped).length === 0;

        if (current.error && empty) {
          return {
            label: "progress: error",
            title: "Progress plugin error",
            rows: [
              {
                id: "error",
                label: current.error.slice(0, 160),
                tone: "danger" as const,
              },
            ],
          };
        }

        if (!current.loaded && empty) {
          return { label: "progress: loading", title: "Progress plugin" };
        }

        const visibleRoots = buildVisibleTree(
          scoped,
          Date.now(),
          visibility,
          dismissedMap(scoped)
        );
        if (visibleRoots.length === 0) return undefined;

        const active = countActive(visibleRoots);
        const top = visibleRoots[0];
        const topPct = progressLabel(top.progress);
        const parts = barParts(top.progress, options());
        const topTitle = oneLineText(top.title);

        // Collapsed pill prefix: the aggregate % shows even with a single
        // root; the root count is included only when there is more than one
        // ("(2 · 60%)", "(40%)"). Prefix placement survives truncation.
        const rootProgresses = visibleRoots
          .map((root) => root.progress)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const aggregatePct =
          rootProgresses.length > 0
            ? progressLabel(rootProgresses.reduce((a, b) => a + b, 0) / rootProgresses.length)
            : null;
        const pillPrefix = aggregatePct
          ? `(${visibleRoots.length > 1 ? `${visibleRoots.length} · ` : ""}${aggregatePct}) `
          : visibleRoots.length > 1
            ? `(${visibleRoots.length}) `
            : "";

        const label =
          parts.style === "emoji"
            ? `${pillPrefix}${topTitle}: ${parts.bar}${parts.fraction}`
            : active > 0
              ? `${pillPrefix}${topTitle}${topPct ? ` ${topPct}` : ""}`
              : `${pillPrefix}${topTitle}`;

        return {
          label,
          // Headline counts include descendants (the store, not just roots):
          // "4 active · 2 pending · 3 done · 2 dismissed".
          title: (() => {
            const summary = summarizeEntries(scoped);
            const parts: string[] = [];
            if (summary.active > 0) parts.push(`${summary.active} active`);
            if (summary.pending > 0) parts.push(`${summary.pending} pending`);
            if (summary.done > 0) parts.push(`${summary.done} done`);
            if (summary.dismissed > 0) parts.push(`${summary.dismissed} dismissed`);
            return parts.length > 0 ? parts.join(" · ") : "Agent progress";
          })(),
          rows: [
            ...flattenTreeWithDepth(visibleRoots)
              .slice(0, 7)
              .map(({ node, depth }) => {
                const row = rowFor(node, depth, options(), treeTheme());
                return {
                  ...row,
                  icon: "circle-x" as const,
                  detail: row.detail ?? "dismiss",
                  run: () => dismissKey(input.session, node.key, node.status ?? ""),
                };
              }),
            {
              id: "dismiss",
              label: "✕ Dismiss all",
              run: () => {
                for (const root of visibleRoots) {
                  dismissKey(input.session, root.key, root.status ?? "");
                }
              },
            },
          ],
        };
      },
      menu: (input) => (
        <ProgressMenu
          session={input.session}
          sessionID={input.session.id}
          close={input.close}
        />
      ),
    }));

    // Optional second pill for `say` notes. Opt in with { options: { say: true } }.
    // Pills float above the timeline, so this stays visible in both composer
    // and sidebar layouts; sidebar mode simply has no notes panel of its own.
    ctx.add(ComposerPill, {
      id: "say-notes",
      order: 1,
      show: (input) => {
        if (!sayNotesEnabled) return undefined;
        if (!saySurfaces().pill) return undefined;
        const view = buildNotesPill(notesForSession(input.session.id));
        if (!view) return undefined;
        return {
          label: view.label,
          title: view.title,
          icon: "speech-bubble" as const,
          ...(view.tone ? { tone: view.tone } : {}),
        };
      },
      menu: (input) => (
        <NotesMenu session={input.session} sessionID={input.session.id} />
      ),
    });

    const toggleTaskListView = async () => {
      try {
        const result = await ctx.client.rpc(ProgressRpc).toggleTaskListMode({});
        setTaskListStatus((prev) => (prev ? { ...prev, mode: result.mode } : prev));
        ctx.toast.show({
          title: "Task-list mirror",
          description: result.mode === "raw" ? "Raw store view" : "Matching the UI",
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Task-list toggle failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    ctx.add(Command, () => ({
      id: "progress.toggle-tasklist-view",
      title: "Progress: task-list mirror view (match UI/raw)",
      description: "Toggle the Markdown task list between the UI view and the raw store view",
      keywords: "progress tasklist markdown mirror raw ui",
      section: "general",
      get enabled() {
        return taskListStatus()?.enabled === true;
      },
      run: () => void toggleTaskListView(),
    }));

    type NudgePreset = "replace" | "alongside" | "block" | "custom";
    const NUDGE_PRESET_CHOICES: Array<{
      value: NudgePreset;
      title: string;
      description: string;
    }> = [
      {
        value: "replace",
        title: "Replace built-ins (recommended)",
        description: "One [warn] context reminder every 5m; pauses built-in nudges while active.",
      },
      {
        value: "alongside",
        title: "Alongside built-ins",
        description: "Same timing; built-in nudges keep running and identical text is deduped.",
      },
      {
        value: "block",
        title: "Synthetic block",
        description: "One-shot synthetic turn input. Use for hard stop conditions only.",
      },
      {
        value: "custom",
        title: "Custom",
        description: "Choose trigger, severity, delivery, TTL, and fire cap yourself.",
      },
    ];

    const openNudgeWizard = async () => {
      const session = ctx.sessions.current();
      if (!session) return;
      const rpc = rpcFor(session);
      const preset = await ctx.dialogs.select<NudgePreset>({
        title: "Progress custom nudge",
        options: NUDGE_PRESET_CHOICES.map((choice) => ({
          title: choice.title,
          value: choice.value,
          description: choice.description,
        })),
      });
      if (!preset) return;

      const scope = await ctx.dialogs.select<"session" | "project" | "global">({
        title: "Where should this rule live?",
        options: [
          { title: "Session", value: "session", description: "This session only" },
          { title: "Project", value: "project", description: "Every session in this project" },
          { title: "Global", value: "global", description: "Every session, in ~/.config/opencode" },
        ],
        current: "session",
      });
      if (!scope) return;

      const id = (
        await ctx.dialogs.prompt({
          title: "Rule id",
          description: "Slug used by on/off/clear, e.g. stale-build",
          placeholder: "stale-build",
        })
      )?.trim();
      if (!id) return;

      const text = (
        await ctx.dialogs.prompt({
          title: "Reminder text",
          description:
            "Model-facing. Placeholders: {id} {title} {status} {age} {count} {action}",
          placeholder: "{id} has been {status} for {age} — {action}",
        })
      )?.trim();
      if (!text) return;

      let every: string | undefined;
      if (preset === "custom") {
        every =
          (
            await ctx.dialogs.prompt({
              title: "Interval (blank for event-only)",
              description: "5m, 30s, 2h",
              placeholder: "5m",
            })
          )?.trim() || undefined;
      }

      const severity =
        preset === "block"
          ? "block"
          : ((await ctx.dialogs.select<"info" | "warn" | "block">({
              title: "Severity",
              options: [
                { title: "warn (context)", value: "warn" },
                { title: "info (context)", value: "info" },
                { title: "block", value: "block" },
              ],
              current: "warn",
            })) ?? "warn");

      const confirmed = await ctx.dialogs.confirm({
        title: "Save custom nudge?",
        description: `${scope}:${id} · ${severity} · ${preset}\n${
          every ? `every ${every}` : preset === "custom" ? "event-only" : "preset timing"
        }\n${text}`,
      });
      if (!confirmed) return;

      const result = await withTimeout(
        rpc.nudgeSet({
          sessionID: session.id,
          preset,
          rule: {
            id,
            text,
            scope,
            severity,
            source: "user",
            createdAt: Date.now(),
            ...(every
              ? { trigger: { type: "interval", everyMs: every } }
              : preset === "custom"
                ? { trigger: { type: "event" } }
                : {}),
          },
        }),
        4000
      );
      ctx.toast.show({
        title: result.ok ? "Custom nudge saved" : "Custom nudge not saved",
        description: result.ok
          ? `${scope}:${id}`
          : result.error ?? "unknown error",
        variant: result.ok ? "success" : "error",
        duration: result.ok ? 2500 : 6000,
      });
    };

    const openNudgeStatus = async () => {
      const session = ctx.sessions.current();
      if (!session) return;
      const rpc = rpcFor(session);
      let listed: Awaited<ReturnType<typeof rpc.nudgeList>>;
      try {
        listed = await withTimeout(rpc.nudgeList({ sessionID: session.id }), 4000);
      } catch (error) {
        ctx.toast.show({
          title: "Custom nudge status failed",
          description: String(error),
          variant: "error",
        });
        return;
      }
      if (listed.rules.length === 0) {
        await ctx.dialogs.alert({
          title: "Progress custom nudges",
          description: listed.errors.join("\n") || "No rules yet. Use the custom nudge wizard to add one.",
        });
        return;
      }
      const choice = await ctx.dialogs.select<string>({
        title: "Progress custom nudges",
        options: listed.rules.map((rule) => ({
          title: `${rule.enabled ? "on" : "off"} · ${rule.scope}:${rule.id}`,
          value: `${rule.scope}:${rule.id}`,
          description: `${rule.severity} · ${rule.delivery} · ${rule.trigger} · ${rule.criteria}`,
        })),
      });
      if (!choice) return;
      const [scope, id] = choice.split(":", 2) as [
        "global" | "project" | "session",
        string
      ];
      const action = await ctx.dialogs.select<"enable" | "disable" | "clear">({
        title: `Action for ${choice}`,
        options: [
          { title: "Enable", value: "enable" },
          { title: "Disable", value: "disable" },
          { title: "Clear", value: "clear" },
        ],
      });
      if (!action) return;
      const result =
        action === "clear"
          ? await withTimeout(rpc.nudgeClear({ sessionID: session.id, scope, id }), 4000)
          : await withTimeout(
              rpc.nudgeSetEnabled({
                sessionID: session.id,
                scope,
                id,
                enabled: action === "enable",
              }),
              4000
            );
      ctx.toast.show({
        title: result.ok ? `Custom nudge ${action}d` : "Custom nudge unchanged",
        description: result.ok ? choice : result.error ?? "unknown error",
        variant: result.ok ? "success" : "error",
      });
    };

    const progressTab = {
      id: GUI_PROGRESS_PANEL_ID,
      title: "Progress",
      pinned: true,
      fallback: true,
    };

    // A pinned side-region tab: it is listed without being opened, sits before
    // other tabs and cannot be closed or dragged, so sidebar mode behaves like
    // the TUI's sidebar slot. Composer mode lists nothing and leaves no tab.
    ctx.add(Panel, {
      id: GUI_PROGRESS_PANEL_ID,
      region: "side",
      width: sidebarWidth,
      mobile: {
        title: "Progress",
        order: 20,
        kind: "menu",
        icon: "checklist",
      },
      list: () => (layoutMode() === "sidebar" ? [progressTab] : []),
      render: (input) => (
        <ProgressSidebar
          session={() => input.session}
          sessionID={() => input.session.id}
        />
      ),
    });

    ctx.add(Command, () => ({
      id: "progress.swap-layout",
      title: "Progress: swap layout (composer/sidebar)",
      description: "Move the progress tree above the prompt or into the sidebar",
      group: "Progress",
      section: "session" as const,
      keywords: "progress sidebar composer layout move",
      run: () => swapLayout(),
    }));

    if (ctx.options?.customNudges === true) {
      ctx.add(Command, () => ({
        id: "progress.custom-nudge",
        title: "Progress: custom nudge…",
        description: "Create a configurable reminder rule for this or every session",
        group: "Progress",
        section: "session" as const,
        keywords: "progress nudge custom reminder rule interval",
        run: () => void openNudgeWizard(),
      }));

      ctx.add(Command, () => ({
        id: "progress.custom-nudge-status",
        title: "Progress: custom nudge status",
        description: "List custom nudge rules; enable, disable, or clear one",
        group: "Progress",
        section: "session" as const,
        keywords: "progress nudge custom list status disable clear",
        run: () => void openNudgeStatus(),
      }));
    }

    ctx.add(Command, () => ({
      id: "progress.switch-tree-theme",
      title: "Progress: switch tree theme",
      description: "Pick the tree row theme; saved to your OpenCode config",
      group: "Progress",
      section: "general" as const,
      keywords: "progress tree theme compact default rows appearance",
      run: () => void switchTreeTheme(),
    }));

    // Launcher for the desktop sidebar's New tab page and + menu, alongside
    // Review / Browser / Terminal / Open file. `opened` follows this tab's own
    // state so the launcher stays listed while some other side tab is open.
    ctx.add(MenuItem, () => {
      return {
        menu: "session.panel" as const,
        id: "progress",
        title: "Progress",
        icon: "checklist" as const,
        order: 20,
        description: "Task tree and notes",
        run: () => {
          const current = ctx.sessions.current();
          if (!current) return;
          if (layoutMode() !== "sidebar") {
            swapLayout();
            return;
          }
          ctx.layout.open(sidebarPanelKey, current, {
            tab: "select",
            background: true,
          });
        },
      };
    });

    return () => {
      alive = false;
      clearInterval(timer);
      if (notesClockTimer) clearInterval(notesClockTimer);
      unsubscribeUpdated?.();
      clearInterval(taskListTimer);
    };
  },
});
