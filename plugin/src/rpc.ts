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
