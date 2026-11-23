/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Command, Panel, Plugin, Style } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";
import { For, Index, Show, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import pkg from "../package.json";
import { feedbackIssueUrl } from "./feedback.js";
import { ProgressRpc } from "./rpc.js";
import {
  GUI_PROGRESS_PANEL_ID,
  buildNotesPill,
  nextGuiLayout,
  noteAuthorLabel,
  normalizeGuiDetailLines,
  normalizeGuiLayout,
  normalizeGuiSidebarWidth,
  type GuiLayout,
} from "./gui-view.js";
import {
  buildTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  visibleRows,
  countDescendants,
  collapsedRootMap,
  summarizeEntries,
  isDismissed,
  normalizeBarOptions,
  normalizeProgressText,
  normalizeRefreshMs,
  normalizeVisibilityOptions,
  oneLineText,
  progressLabel,
  scopeEntries,
  subagentPrefix,
  visibleEntries,
  type BarOptions,
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
}) {
  const pct = () => progressLabel(props.node.progress);
  const parts = () => barParts(props.node.progress, props.options);

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
        "align-items": "flex-start",
        gap: "8px",
        "padding-left": `${props.depth * 14}px`,
        "padding-top": "5px",
        "padding-bottom": "5px",
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
            "margin-top": "4px",
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
      <div style={{ flex: "1 1 auto", "min-width": "0" }}>
        <div
          style={{
            "font-weight": props.depth === 0 ? "650" : "500",
            "white-space": "normal",
            "overflow-wrap": "anywhere",
            "word-break": "break-word",
          }}
          title={`${props.node.status}: ${oneLineText(
            `${props.depth === 0 ? subagentPrefix(props.node) : ""}${props.node.title}`
          )}`}
        >
          <Multiline
            text={`${props.depth === 0 ? subagentPrefix(props.node) : ""}${props.node.title}`}
          />
        </div>
        <Show when={props.node.detail && props.detailLines !== 0}>
          <div
            style={{
              "margin-top": "2px",
              "font-size": "12px",
              opacity: "0.72",
              "white-space": "normal",
              "overflow-wrap": "anywhere",
              "word-break": "break-word",
              ...(props.detailLines && props.detailLines > 0
                ? {
                    display: "-webkit-box",
                    "-webkit-box-orient": "vertical",
                    "-webkit-line-clamp": String(props.detailLines),
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

function rowFor(node: TreeNode, depth: number, options: BarOptions) {
  const parts = barParts(node.progress, options);
  const pct = progressLabel(node.progress);
  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└─ " : "";
  const suffix =
    parts.style === "emoji"
      ? `: ${parts.bar}${parts.fraction}`
      : pct
        ? ` · ${pct}`
        : "";
  return {
    id: node.key,
    label: `${indent}${oneLineText(node.title)}${suffix}`,
    detail: node.detail ? oneLineText(node.detail) : undefined,
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
    const options = normalizeBarOptions(ctx.options);
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

    /** Notes rolled up to this session's root, newest first. */
    const notesForSession = (sessionID: string) =>
      state()
        .notes.filter((note) => (note.rootSessionId ?? note.sessionId) === sessionID)
        .slice(0, 20);

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
        batch(() => {
          setState({ entries, notes, loaded: true });
          if (pendingChanged) setPendingDismissed(nextPending);
        });
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
        buildTree(visibleEntries(scoped(), Date.now(), visibility))
      );
      const visibleRoots = createMemo(() =>
        tree().filter((root) => !isDismissed(root, dismissed()))
      );
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
                            options={options}
                            detailLines={detailLines}
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
                                    options={options}
                                    detailLines={detailLines}
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
          <Show when={rows().length > 0}>
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
            <span>progress plugin desktop v{pkg.version}</span>
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
        buildTree(visibleEntries(scoped(), Date.now(), visibility))
      );
      const visibleRoots = createMemo(() =>
        tree().filter((root) => !isDismissed(root, dismissed()))
      );
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
                            options={options}
                            detailLines={detailLines}
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
                                    options={options}
                                    detailLines={detailLines}
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
          <Show when={visibleRoots().length > 0}>
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
            <span>progress plugin desktop v{pkg.version}</span>
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

    const NotesMenu = (props: { sessionID: string; close?: () => void }) => {
      onCleanup(() => setInteracting(false));
      const notes = createMemo(() => notesForSession(props.sessionID));
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
          <For each={notes()}>
            {(note) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                <div
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    gap: "12px",
                    "font-size": "11px",
                    color: "#94a3b8",
                  }}
                >
                  <span>
                    {noteAuthorLabel(note, props.sessionID)} · {note.kind}
                    {note.eta ? ` · ETA ${note.eta}` : ""}
                  </span>
                  <span title={new Date(note.at).toLocaleString()}>
                    {formatRelative(note.at)}
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

        const roots = buildTree(visibleEntries(scoped, Date.now(), visibility));
        const dismissed = dismissedMap(scoped);
        const visibleRoots = roots.filter((root) => !isDismissed(root, dismissed));
        if (visibleRoots.length === 0) return undefined;

        const active = countActive(visibleRoots);
        const top = visibleRoots[0];
        const topPct = progressLabel(top.progress);
        const parts = barParts(top.progress, options);
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
                const row = rowFor(node, depth, options);
                if (depth !== 0) return row;
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

    // Optional second pill for `say` notes. Opt in with { options: { say: true } };
    // composer mode only — sidebar mode is the task tree's surface.
    const sayNotesEnabled = ctx.options?.say === true;
    ctx.add(ComposerPill, {
      id: "say-notes",
      order: 1,
      show: (input) => {
        if (!sayNotesEnabled) return undefined;
        if (layoutMode() === "sidebar") return undefined;
        const view = buildNotesPill(notesForSession(input.session.id));
        if (!view) return undefined;
        return {
          label: view.label,
          title: view.title,
          icon: "speech-bubble" as const,
          ...(view.tone ? { tone: view.tone } : {}),
        };
      },
      menu: (input) => <NotesMenu sessionID={input.session.id} close={input.close} />,
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

    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribeUpdated?.();
      clearInterval(taskListTimer);
    };
  },
});
