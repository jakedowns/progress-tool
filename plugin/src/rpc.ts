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
        // Empty schema: accept `list()` from older bundles and `list({})`.
      },
      output: {
        type: "object",
        properties: {
          entries: { type: "object", additionalProperties: true },
          updatedAt: { type: "number" },
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
