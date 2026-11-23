/**
 * RPC contract shared by the server part, the TUI part, and the GUI bundle.
 *
 * `list` returns the current entries from the shared state file. `updated`
 * fires when the server observes a change, so GUI windows do not have to poll.
 */

import { Rpc } from "@opencode/plugin/rpc";

export const ProgressRpc = Rpc.define({
  id: "opencode-progress",
  methods: {
    list: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          scope: { type: "string", enum: ["session", "all"] },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: { type: "object", additionalProperties: true },
          updatedAt: { type: "number" },
          revision: { type: "string" },
        },
        required: ["entries", "updatedAt"],
        additionalProperties: false,
      },
    },
    dismiss: {
      input: {
        type: "object",
        properties: {
          // Storage key (may be session-scoped), not the bare task id.
          key: { type: "string" },
          // Rolled-up status at dismiss time; drives revival semantics
          // (terminal vs non-terminal, child-failure carve-out).
          status: { type: "string" },
        },
        required: ["key", "status"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    clear: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          cleared: { type: "number" },
        },
        required: ["ok", "cleared"],
        additionalProperties: false,
      },
    },
    hardClearSession: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          removed: { type: "number" },
          freedBytes: { type: "number" },
        },
        required: ["ok", "removed", "freedBytes"],
        additionalProperties: false,
      },
    },
    hardClearAll: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          removed: { type: "number" },
          freedBytes: { type: "number" },
        },
        required: ["ok", "removed", "freedBytes"],
        additionalProperties: false,
      },
    },
    stats: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: { type: "number" },
          active: { type: "number" },
          done: { type: "number" },
          error: { type: "number" },
          dismissed: { type: "number" },
          cleared: { type: "number" },
          bytes: { type: "number" },
        },
        required: ["entries", "active", "done", "error", "dismissed", "cleared", "bytes"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          updatedAt: { type: "number" },
        },
        required: ["updatedAt"],
        additionalProperties: false,
      },
    },
  },
});
