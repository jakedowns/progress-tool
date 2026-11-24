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
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                sessionId: { type: "string" },
                rootSessionId: { type: "string" },
                text: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["intent", "update", "blocked", "question"],
                },
                eta: { type: "string" },
                agent: { type: "string" },
                at: { type: "number" },
              },
              required: ["id", "sessionId", "rootSessionId", "text", "kind", "at"],
              additionalProperties: false,
            },
          },
          updatedAt: { type: "number" },
          revision: { type: "string" },
        },
        required: ["entries", "notes", "updatedAt"],
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
    dismissNote: {
      input: {
        type: "object",
        properties: {
          // Stable note id from the `list` notes array (not a session id).
          noteID: { type: "string" },
        },
        required: ["noteID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    clearNotes: {
      input: {
        type: "object",
        properties: {
          // Viewer session; child and grandchild notes roll up to its root.
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
        },
        required: ["ok", "removed"],
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
    taskListStatus: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          mode: { type: "string", enum: ["ui", "raw"] },
          detail: { type: "string", enum: ["code", "escaped", "raw"] },
          location: { type: "number", enum: [0, 1, 2] },
          order: { type: "string", enum: ["newest-first", "oldest-first"] },
          file: { type: "string" },
          sessionID: { type: "string" },
          updatedAt: { type: "number" },
        },
        required: ["enabled", "mode", "detail", "location", "order"],
        additionalProperties: false,
      },
    },
    toggleTaskListMode: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          mode: { type: "string", enum: ["ui", "raw"] },
        },
        required: ["ok", "mode"],
        additionalProperties: false,
      },
    },
    setTreeTheme: {
      input: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["default", "compact"] },
          barStyle: { type: "string", enum: ["blocks", "emoji"] },
        },
        required: ["theme"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          theme: { type: "string", enum: ["default", "compact"] },
          barStyle: { type: "string", enum: ["blocks", "emoji"] },
          file: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok", "theme"],
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
