/**
 * OpenCode Progress Plugin — TUI part.
 *
 * Reads the shared state file directly (the TUI runs locally) and renders:
 *   - a compact one-line summary in the composer footer,
 *   - a dependency tree above the composer.
 */

import { For, Show, createSignal } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { readProgressState } from "./state.js";
import {
  buildTree,
  barParts,
  countActive,
  normalizeBarOptions,
  normalizeVisibilityOptions,
  progressLabel,
  visibleEntries,
  type BarOptions,
  type VisibilityOptions,
} from "./tree.js";
import type { ProgressStatus, ProgressState, TreeNode } from "./types.js";

const [state, setState] = createSignal<ProgressState>(readProgressState());

let pollers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let barOptions: BarOptions = {};
let visibilityOptions: VisibilityOptions = {};

function startPolling(): () => void {
  pollers += 1;
  setState(readProgressState());
  if (!timer) {
    timer = setInterval(() => setState(readProgressState()), 1000);
  }
  return () => {
    pollers -= 1;
    if (pollers <= 0) {
      if (timer) clearInterval(timer);
      timer = undefined;
      pollers = 0;
    }
  };
}

function glyph(status: ProgressStatus): string {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  if (status === "waiting") return "◐";
  return "●";
}

function ProgressNode(props: { node: TreeNode; depth: number }) {
  const ctx = usePlugin();
  const indent = () => (props.depth === 0 ? "" : `${"  ".repeat(props.depth)}└─ `);

  const label = () => {
    const parts = barParts(props.node.progress, barOptions);
    if (parts.style === "emoji") {
      const suffix =
        props.node.status === "done" ? " ✓" : props.node.status === "error" ? " ✗" : "";
      return `${props.node.title}: ${parts.bar}${parts.fraction}${suffix}`;
    }
    const pct = progressLabel(props.node.progress);
    return `${glyph(props.node.status)} [${parts.bar}] ${props.node.title}${pct ? ` ${pct}` : ""}`;
  };

  return (
    <>
      <box flexDirection="row">
        <text fg={ctx.theme.text.muted}>{indent()}</text>
        <text fg={ctx.theme.text.base}>{label()}</text>
        <Show when={props.node.detail}>
          <text fg={ctx.theme.text.muted}>{` · ${props.node.detail}`}</text>
        </Show>
      </box>
      <For each={props.node.children}>
        {(child) => <ProgressNode node={child} depth={props.depth + 1} />}
      </For>
    </>
  );
}

function ProgressTree() {
  const ctx = usePlugin();
  const roots = () =>
    buildTree(visibleEntries(state().entries ?? {}, Date.now(), visibilityOptions)).slice(0, 4);

  return (
    <Show when={roots().length > 0}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text fg={ctx.theme.text.muted}>progress</text>
        <For each={roots()}>{(node) => <ProgressNode node={node} depth={0} />}</For>
      </box>
    </Show>
  );
}

function FooterStatus() {
  const ctx = usePlugin();
  const summary = () => {
    const roots = buildTree(visibleEntries(state().entries ?? {}, Date.now(), visibilityOptions));
    if (roots.length === 0) return "";
    const active = countActive(roots);
    const top = roots[0];
    const pct = progressLabel(top.progress);
    return `${active} active · ${top.title}${pct ? ` ${pct}` : ""}`;
  };

  return (
    <Show when={summary()}>
      <text fg={ctx.theme.text.muted}>{summary()}</text>
    </Show>
  );
}

export default Plugin.define({
  id: "opencode-progress.tui",
  setup(context) {
    barOptions = normalizeBarOptions(context.options);
    visibilityOptions = normalizeVisibilityOptions(context.options);
    const stopPolling = startPolling();
    if (context.options?.notifyOnLoad === true) {
      context.ui.toast.show({ message: "Progress plugin loaded", variant: "success" });
    }
    const unregisterTree = context.ui.slot({
      append: "session.composer.top",
      render: () => <ProgressTree />,
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => <FooterStatus />,
    });

    return () => {
      unregisterTree?.();
      unregisterFooter?.();
      stopPolling();
    };
  },
});
