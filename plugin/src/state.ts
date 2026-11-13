/**
 * Reads the progress state file written by the progress MCP server and relay.
 *
 * The path must match `mcp-server/state-store.js` so the TUI and server parts
 * see the same entries as the `progress` tool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProgressState } from "./types.js";

export function stateFilePath(): string {
  return (
    process.env.PROGRESS_STATE_PATH ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".opencode-progress-state.json")
  );
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
