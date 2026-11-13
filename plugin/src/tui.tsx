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
import { buildTree, countActive, progressLabel, renderBar } from "./tree.js";
import type { ProgressStatus, ProgressState, TreeNode } from "./types.js";

const [state, setState] = createSignal<ProgressState>(readProgressState());

let pollers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

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
  const pct = () => progressLabel(props.node.progress);
  const indent = () => (props.depth === 0 ? "" : `${"  ".repeat(props.depth)}└─ `);

  return (
    <>
      <box flexDirection="row">
        <text fg={ctx.theme.text.muted}>{indent()}</text>
        <text fg={ctx.theme.text.base}>{`${glyph(props.node.status)} [${renderBar(props.node.progress)}]`}</text>
        <text fg={ctx.theme.text.base}>{` ${props.node.title}`}</text>
        <Show when={pct()}>
          <text fg={ctx.theme.text.muted}>{` ${pct()}`}</text>
        </Show>
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
  const roots = () => buildTree(state().entries ?? {}).slice(0, 4);

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
    const roots = buildTree(state().entries ?? {});
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
