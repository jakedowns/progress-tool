#!/usr/bin/env node
'use strict';

/**
 * Progress MCP Server for OpenCode (and any MCP-capable harness)
 *
 * Exposes a `progress` tool that agents can call to signal long-running work
 * without blocking. Implements the proposal from:
 * https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c
 *
 * Zero-token-burn design:
 *   The agent owns milestones and tree structure. High-frequency telemetry
 *   (stdout, percentages, elapsed time) is streamed out-of-band by the
 *   relay CLI, which writes to the same state file. The agent never polls.
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Each progress entry may carry a `parentId`, linking it to a parent task.
 *   Parent status/progress roll up from children so a GUI or TUI can render:
 *
 *     ├── build [██████░░░░] 6/10 · compiling SDL2
 *     │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
 *     └── npm-install [██████████] 10/10 · done ✓
 *
 * Dual-mode entrypoint (same binary, no extra daemon):
 *   node mcp-server/index.js                    # MCP stdio server (default)
 *   node mcp-server/index.js relay --id build-1 -- npm run build
 *   node mcp-server/index.js emit --id build-1 --status running
 *
 * Usage as an MCP server:
 *   opencode mcp add progress-server -- /path/to/mcp-server/index.js
 */

const fs = require('fs');
const path = require('path');

const {
  upsertProgress,
  upsertManyProgress,
  ensureStateFile,
  readState,
  resolveStatePath,
  resolveSessionId,
  resolveSessionScope,
} = require('./state-store');

// First-offense tracking for the anti-pattern error result. The MCP server
// is spawned per session, so an in-memory Map is enough: the first call
// that embeds an enumerated step list gets an isError result (the strongest
// self-correction lever a tool has), later ones fall back to the text tip.
const nudgeStrikes = new Map();

/**
 * Whether any entry in the shared tree already nests under `parentId` —
 * i.e. the agent partially restructured into the tree, in which case we
 * soften to a text tip instead of an error result.
 */
function treeHasChildren(parentId) {
  try {
    const entries = readState(resolveStatePath()).entries || {};
    return Object.values(entries).some((e) => e && e.parentId === parentId);
  } catch (e) {
    return false;
  }
}

const SERVER_VERSION = '2.12.0';
const VALID_STATUSES = ['pending', 'running', 'waiting', 'done', 'error'];

const SERVER_INSTRUCTIONS = [
  'The `progress` tool is DUAL PURPOSE: a drop-in replacement for',
  'todo/task-tracking tools (todowrite / TaskCreate) for any multi-step',
  'plan, and a wrapper (progress-relay) for long-running programmatic',
  'commands that report progress on stdout.',
  'The `progress` tool is fire-and-forget. Call it at task milestones:',
  'once when a phase starts (status "running"), once when a child task is',
  'created (status "pending" or "running", parentId), and once when a phase',
  'finishes ("done" or "error").',
  'During long-horizon NON-SHELL work (research, planning, exploration,',
  'refactors, documentation) there is no relay, so also spend one of your',
  'turns between tool calls — roughly every few calls, or whenever you',
  'start or finish a step — on a progress update (fresh detail or a 0..1',
  'progress fraction); that todowrite-style between-turn cadence keeps the',
  'summary rollup live. Report ANY long-horizon work this way, not just',
  'shell commands. For multi-step plans, expose the steps in the tree — one',
  'child entry per step (parentId = the parent task) — instead of embedding',
  'a numbered list inside one title/detail, so each step gets its own',
  'status/progress in the rollup. Never poll, sleep, or loop on terminal',
  'output or timers to refresh elapsed time or percentages — the relay',
  'streams telemetry at zero token cost. For long-running shell commands,',
  'use the out-of-band relay printed in the tool response (for example',
  '`progress-relay --id <id> -- <cmd>`). The relay parses OSC 9;4 terminal',
  'progress sequences natively before text heuristics like "45%". Pass',
  'parentId to build a tree;',
  'parent status and progress roll up from children. Concurrent sessions are',
  'isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID, so',
  'keep using clean task IDs like "build-1" instead of manually prefixing them.',
  'Formatting: title and detail may contain line breaks written as real newlines,',
  'as escaped "\\n" / "\\r\\n" (or extra-escaped "\\\\n"), or as "<br>" / "<br/>".',
  'Use line breaks to keep verbose status readable: a short title line plus a',
  'few detail lines. Viewers wrap long lines and scroll long details; do not use',
  'one huge single-line description.',
].join(' ');

const TOOL_DESCRIPTION = [
  'Report non-blocking task progress and dependency trees to the user\'s GUI. Fire-and-forget: never pauses execution or waits for human input.',
  '',
  'DUAL PURPOSE:',
  '(1) Use this tool INSTEAD of todo/task-tracking tools (todowrite / TaskCreate): any multi-step plan belongs in this tree, where it also drives the live indicator.',
  '(2) Use the out-of-band relay (progress-relay) to WRAP long-running programmatic tool calls — build scripts, compilers, test suites, installs, anything that reports progress on stdout — so telemetry streams at zero token cost.',
  '',
  'BULK TREE CREATION:',
  '- Pass `entries: [{ id, status, title, parentId, ... }]` (max 50) to create or update a whole parent+children tree in ONE atomic call — one round trip, no half-built tree. Use EITHER entries[] alone OR the single-entry fields, not both. Each entry item requires id/status/title; the top-level id/status/title are only for the single form.',
  '',
  'READING STATE:',
  '- The companion `list` tool returns your progress trees as text (session-scoped, user-dismissed entries hidden by default). Use it before planning or when unsure what is already tracked; pass includeDismissed/includeTerminal to widen.',
  'OWNERSHIP & ZERO-POLLING CONTRACT:',
  '- You own TASK MILESTONES and TREE STRUCTURE: call this tool when starting a phase (status: "running"), when creating child sub-tasks (parentId), and when a phase finishes (status: "done" | "error"). For long-horizon NON-SHELL work (research, planning, exploration, refactors, documentation) there is no relay, so also spend one of your turns between tool calls every few steps on a progress update (fresh detail or a 0..1 progress fraction) — todowrite-style cadence keeps the rollup live. Cover ANY long-horizon work, not just shell commands; anything past a couple of minutes or a single reply deserves an entry.',
  '- NEVER poll, sleep, or loop on terminal output just to refresh progress percentages or elapsed time.',
  '- For long-running shell commands, delegate live stdout/progress streaming to the out-of-band CLI relay (the exact command is returned in this tool\'s response, e.g. `progress-relay --id <id> -- <cmd>`) so the OS process updates the GUI directly without burning tokens. The relay parses OSC 9;4 terminal progress sequences (ConEmu / Windows Terminal convention) before text heuristics; OSC status writes are provisional and the command\'s real exit code always decides done/error.',
  '',
  'TREE ROLLUP (BOOTVINE SEMANTICS):',
  '- Pass `parentId` to nest sub-tasks under a parent task.',
  '- Multi-step plans belong in the TREE, created in ONE bulk call: pass `entries: [{ id: "<plan>", status: "running", title: "<plan>" }, { id: "<plan>-step-1", status: "running", title: "<step 1>", parentId: "<plan>" }, …]` (max 50). One child entry per step so each gets its own status/progress. Do NOT embed numbered step lists in one title/detail — the rollup cannot see individual steps inside text.',
  '- Parent status and progress automatically roll up from children (any child "error" -> parent "error"; any child "running"/"waiting" -> parent "running"/"waiting"; pending children leave a non-running parent "pending"; parent progress = mean of child progress).',
  '',
  'SESSION ISOLATION:',
  '- Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID (or an explicit `sessionId` override). Subagents should report under the parent session: the plugin records child→parent automatically, and an explicit parent `sessionId` always wins.',
  '- Keep using clean task IDs like `build-1`; do NOT manually prefix them with a session ID.',
  '',
  'LINE BREAKS & LONG TEXT:',
  '- `title` and `detail` support multi-line text. Use real newlines, escaped `\\n` / `\\r\\n` (or an extra-escaped `\\\\n`), or `<br>` / `<br/>` tags.',
  '- Keep `title` to a short headline and put verbose context in `detail` across a few lines instead of one huge single-line string.',
  '- Viewers normalize these forms, wrap long lines, and scroll long details. Do not rely on the viewer to split a wall of text for you.',
].join('\n');

// --- Shell / CLI helpers ---------------------------------------------------

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:@%+,\/-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fileQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:@%+,\/-]+$/.test(text) ? text : JSON.stringify(text);
}

let cachedRelayBin = null;

/**
 * Prefer the installed `progress-relay` bin. If it is not on PATH (common
 * when the MCP server is run from a checkout), fall back to invoking this
 * same file with the `relay` subcommand. Either form works in any shell.
 */
function relayBin() {
  if (process.env.PROGRESS_RELAY_CMD) return process.env.PROGRESS_RELAY_CMD;
  if (cachedRelayBin !== null) return cachedRelayBin;

  const names =
    process.platform === 'win32'
      ? ['progress-relay.cmd', 'progress-relay.exe', 'progress-relay']
      : ['progress-relay'];

  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        cachedRelayBin = 'progress-relay';
        return cachedRelayBin;
      } catch (e) {
        // Keep looking.
      }
    }
  }

  cachedRelayBin = `${fileQuote(process.execPath)} ${fileQuote(__filename)} relay`;
  return cachedRelayBin;
}

function affirmation(id) {
  const lines = [
    'Thanks for using the progress tool — the user appreciates it!',
    'Progress logged — thanks for keeping the task list current. The user appreciates it!',
    'Thank you for remembering to use the progress tool; the user can see your progress.',
  ];
  return `\n${lines[String(id ?? 'ok').length % lines.length]}`;
}

function relayHint(id, parentId, sessionId) {
  const bin = relayBin();
  const parent = parentId ? ` --parent ${shellQuote(parentId)}` : '';
  const session = sessionId ? ` --session ${shellQuote(sessionId)}` : '';
  const taskId = shellQuote(id);

  return [
    '',
    'To stream live command output into this indicator without polling, use the out-of-band relay:',
    `  ${bin} --id ${taskId}${parent}${session} -- <cmd>`,
    `  # or: <cmd> | ${bin} --id ${taskId}${session}`,
    'Do NOT poll, sleep, or re-call progress in a loop for elapsed time or percentages.',
    'The relay parses OSC 9;4 terminal progress sequences (Gradle rich console, mise, PowerShell 7.4+, ...) before text heuristics like "45%".',
    'If a tool suppresses progress output when stdout is not a TTY, enable its rich/verbose progress flag so the relay can see it.',
    'Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID; keep task IDs clean (e.g. "build-1").',
  ].join('\n');
}

// --- MCP protocol ----------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function toolOk(id, text) {
  sendResponse(id, {
    content: [{ type: 'text', text }],
    isError: false,
  });
}

function toolError(id, text) {
  sendResponse(id, {
    content: [{ type: 'text', text }],
    isError: true,
  });
}

function handleToolsList(id) {
  sendResponse(id, {
    tools: [
      {
        name: 'progress',
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Stable task ID; re-using an ID updates the indicator in place.',
            },
            status: {
              type: 'string',
              enum: VALID_STATUSES,
              description: 'Lifecycle status: pending (queued, not started), running, waiting (blocked), done, or error.',
            },
            title: {
              type: 'string',
              description:
                'Short human-readable task label. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags.',
            },
            detail: {
              type: 'string',
              description:
                'Optional status detail, latest step, or multi-line context. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags; viewers wrap and scroll long text.',
            },
            progress: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Optional completion fraction (0.0 to 1.0).',
            },
            parentId: {
              type: 'string',
              description:
                'Optional parent task ID to nest this task in a dependency tree.',
            },
            entries: {
              type: 'array',
              maxItems: 50,
              description:
                'BULK: create/update a whole parent+children tree in ONE atomic write (max 50). Each item takes the same fields as the single form. Use either entries[] or the single-entry fields, not both.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: {
                    type: 'string',
                    enum: VALID_STATUSES,
                  },
                  title: { type: 'string' },
                  detail: { type: 'string' },
                  progress: { type: 'number', minimum: 0, maximum: 1 },
                  parentId: { type: 'string' },
                },
                required: ['id', 'status', 'title'],
                additionalProperties: false,
              },
            },
            sessionId: {
              type: 'string',
              description:
                'Optional session ID override; automatically resolved from PROGRESS_SESSION_ID or OPENCODE_SESSION_ID when set by the harness.',
            },
          },
          // No top-level `required`: this tool accepts EITHER the single-entry
          // form (id + status + title) OR `entries[]` (bulk). Declaring the
          // single fields as required made schema-validating clients reject
          // bulk-only calls before they ever reached the handler. The handler
          // validates whichever form is used and returns a clear error.
          additionalProperties: false,
        },
        annotations: {
          title: 'Progress',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'list',
        description:
          'Read the progress store. Lists progress trees this session owns, hiding user-dismissed entries by default. Read-only: use it before planning, or when unsure what is already tracked.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['session', 'all'],
              description: 'session (default) = this session only; all = every session sharing the state file.',
            },
            includeDismissed: {
              type: 'boolean',
              description: 'Include entries the user dismissed (default false).',
            },
            includeTerminal: {
              type: 'boolean',
              description: 'Include done/error entries (default true).',
            },
            parentId: {
              type: 'string',
              description: 'Restrict to one tree (that parent id and its entries).',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              description: 'Maximum entries to render (default 200).',
            },
            sessionId: {
              type: 'string',
              description: 'Optional session override.',
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: 'Progress List',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  });
}

function handleProgressCall(id, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    toolError(id, 'Invalid arguments: expected an object.');
    return;
  }

  // Bulk form: entries[] creates/updates a whole parent+children tree in one
  // atomic write. Single-entry fields and entries[] are mutually exclusive.
  if (Array.isArray(args.entries)) {
    if (args.id || args.status || args.title) {
      toolError(id, 'Pass either entries[] or single-entry fields (id/status/title), not both.');
      return;
    }
    return handleBulkProgress(id, args);
  }

  const {
    id: progressId,
    status,
    title,
    detail,
    progress,
    parentId,
    sessionId,
    callerSessionId,
  } = args;

  if (!progressId || typeof progressId !== 'string') {
    toolError(id, 'Missing required argument: id (string).');
    return;
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    toolError(id, `Missing or invalid argument: status (${VALID_STATUSES.join('|')}).`);
    return;
  }
  if (!title || typeof title !== 'string') {
    toolError(id, 'Missing required argument: title (string).');
    return;
  }
  if (detail !== undefined && detail !== null && typeof detail !== 'string') {
    toolError(id, 'Invalid argument: detail must be a string.');
    return;
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    toolError(id, 'Invalid argument: parentId must be a string.');
    return;
  }
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    toolError(id, 'Invalid argument: sessionId must be a string.');
    return;
  }
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== 'number' ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1)
  ) {
    toolError(id, 'Invalid argument: progress must be a number between 0 and 1.');
    return;
  }

  const entry = upsertProgress({
    id: progressId,
    sessionId,
    callerSessionId,
    status,
    title,
    detail: detail === undefined ? undefined : detail,
    progress: progress === undefined ? undefined : progress,
    parentId: parentId === '' ? null : parentId,
  });

  const parts = [`Recorded progress [${entry.id}] (${entry.status})`, entry.title];
  if (entry.detail) parts.push(entry.detail);
  if (entry.progress != null) parts.push(`${Math.round(entry.progress * 100)}%`);
  if (entry.parentId) parts.push(`parent=${entry.parentId}`);

  let text = parts.join(' - ');
  if (entry.status === 'running') {
    text += relayHint(entry.id, entry.parentId, entry.sessionId);

    // Anti-pattern nudge (self-teaching at the decision point, spec §2.5):
    // a numbered step list embedded in one title/detail cannot express
    // per-step status or progress. Suggest the tree instead. Heuristic:
    // three or more lines starting with a small ordinal number.
    const enumerated = `${entry.title ?? ''}\n${entry.detail ?? ''}`.match(
      /(?:^|\n)\s*\d{1,2}[.)?:]?\s+\S/g
    );
    const antiPattern = (enumerated?.length ?? 0) >= 3;
    if (antiPattern) {
      const strikes = nudgeStrikes.get(entry.id) ?? 0;
      nudgeStrikes.set(entry.id, strikes + 1);

      // First offense, no children yet: return the response as an ERROR
      // result. The update was already recorded (nothing is lost), but
      // error results are what reliably stop an agent mid-plan and make it
      // restructure. Once children exist, soften to the text tip.
      if (strikes === 0 && !treeHasChildren(entry.id)) {
        toolError(
          id,
          [
            `INVALID USAGE — this entry embeds a numbered step list (${enumerated.length} items), which cannot show per-step status or progress in the rollup. The update WAS recorded; nothing is lost.`,
            `Resubmit the WHOLE plan in one bulk call so each step gets its own status:`,
            `  progress({ entries: [`,
            `    { id: "${entry.id}", status: "running", title: "<plan>" },`,
            `    { id: "${entry.id}-step-1", status: "running", title: "<step 1>", parentId: "${entry.id}" },`,
            `    { id: "${entry.id}-step-2", status: "waiting", title: "<step 2>", parentId: "${entry.id}" }`,
            `  ] })`,
            `Then keep children current as you work (mark a child done, start the next) and strip the numbered list from this entry's title/detail. The parent rolls up automatically.`,
            `Load the progress-tool skill for the full pattern.`,
          ].join('\n')
        );
        return;
      }

      text += [
        '',
        'Tip: a numbered step list inside one entry cannot show per-step status or progress.',
        `  Prefer the tree, in ONE bulk call — progress({ entries: [{ id: "${entry.id}", status: "running", title: "<plan>" }, { id: "${entry.id}-step-1", status: "running", title: "<step>", parentId: "${entry.id}" }, …] })`,
        '  — and update each child as you go; the parent rolls up automatically.',
      ].join('\n');
    }
  }

  toolOk(id, text + affirmation(entry.id));
}

/**
 * Bulk form: entries[] lands a whole tree (parent + children) in one atomic
 * write, so the rollup never shows an intermediate half-built tree and the
 * agent pays one round trip instead of N.
 */
function handleBulkProgress(id, args) {
  const { entries, sessionId, callerSessionId } = args;

  if (entries.length === 0) {
    toolError(id, 'entries[] must be a non-empty array.');
    return;
  }
  if (entries.length > 50) {
    toolError(id, `entries[] too large: ${entries.length} (max 50).`);
    return;
  }

  const problems = [];
  entries.forEach((entry, index) => {
    const label = `entries[${index}]${entry && entry.id ? ` (${entry.id})` : ''}`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${label} must be an object`);
      return;
    }
    if (!entry.id || typeof entry.id !== 'string') problems.push(`${label}.id (string) is required`);
    if (!entry.status || !VALID_STATUSES.includes(entry.status)) {
      problems.push(`${label}.status must be one of ${VALID_STATUSES.join('|')}`);
    }
    if (!entry.title || typeof entry.title !== 'string') problems.push(`${label}.title (string) is required`);
    if (entry.detail !== undefined && entry.detail !== null && typeof entry.detail !== 'string') {
      problems.push(`${label}.detail must be a string`);
    }
    if (entry.parentId !== undefined && entry.parentId !== null && typeof entry.parentId !== 'string') {
      problems.push(`${label}.parentId must be a string`);
    }
    if (
      entry.progress !== undefined &&
      entry.progress !== null &&
      (typeof entry.progress !== 'number' || !Number.isFinite(entry.progress) || entry.progress < 0 || entry.progress > 1)
    ) {
      problems.push(`${label}.progress must be a number between 0 and 1`);
    }
  });
  if (problems.length > 0) {
    toolError(id, `Invalid entries[] (nothing was written):\n${problems.join('\n')}`);
    return;
  }

  let created;
  try {
    created = upsertManyProgress(
      entries.map((entry) => ({
        id: entry.id,
        status: entry.status,
        title: entry.title,
        detail: entry.detail,
        progress: entry.progress,
        parentId: entry.parentId === '' ? null : entry.parentId,
        sessionId,
        callerSessionId,
      })),
      resolveStatePath()
    );
  } catch (err) {
    toolError(id, err.message);
    return;
  }

  const lines = created.map((entry) => {
    const bits = [`[${entry.id}] (${entry.status}) ${entry.title}`];
    if (entry.parentId) bits.push(`parent=${entry.parentId}`);
    return `- ${bits.join(' - ')}`;
  });
  const runningRoot = created.find((entry) => entry.status === 'running' && !entry.parentId);
  let text = `Recorded ${created.length} progress entries in one atomic write:\n${lines.join('\n')}`;
  if (runningRoot) {
    text += relayHint(runningRoot.id, null, runningRoot.sessionId);
  }
  toolOk(id, text + affirmation(created[0]?.id));
}

function handleListCall(id, args) {
  if (args && (typeof args !== 'object' || Array.isArray(args))) {
    toolError(id, 'Invalid arguments: expected an object.');
    return;
  }
  const options = args || {};
  const scope = options.scope === 'all' ? 'all' : 'session';
  const includeDismissed = options.includeDismissed === true;
  const includeTerminal = options.includeTerminal !== false;
  const parentFilter =
    typeof options.parentId === 'string' && options.parentId ? options.parentId : null;
  const limit = Number.isInteger(options.limit)
    ? Math.min(500, Math.max(1, options.limit))
    : 200;
  const sessionId = resolveSessionScope(options.sessionId);

  let selected = Object.entries(readState(resolveStatePath()).entries || {}).map(
    ([key, entry]) => ({ key, entry })
  );
  if (scope === 'session') {
    selected = selected.filter(({ entry }) =>
      sessionId ? entry.sessionId === sessionId : !entry.sessionId
    );
  }
  if (!includeDismissed) selected = selected.filter(({ entry }) => !entry.dismissed);
  if (!includeTerminal) {
    selected = selected.filter(
      ({ entry }) => entry.status !== 'done' && entry.status !== 'error'
    );
  }
  if (parentFilter) {
    selected = selected.filter(
      ({ entry }) => entry.id === parentFilter || entry.parentId === parentFilter
    );
  }

  if (selected.length === 0) {
    toolOk(
      id,
      `No ${includeTerminal ? '' : 'open '}progress entries${
        parentFilter ? ` under "${parentFilter}"` : ''
      } (scope=${scope}${includeDismissed ? ', dismissed included' : ', dismissed hidden'}).`
    );
    return;
  }

  const truncated = selected.length > limit;
  if (truncated) selected = selected.slice(0, limit);

  const map = new Map(selected.map(({ entry }) => [entry.id, entry]));
  const children = new Map();
  const roots = [];
  for (const { entry } of selected) {
    const parent = entry.parentId && map.has(entry.parentId) ? entry.parentId : null;
    if (parent && parent !== entry.id) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(entry);
    } else {
      roots.push(entry);
    }
  }

  const lines = [];
  const visit = (entry, depth) => {
    const pct = entry.progress == null ? '' : ` ${Math.round(entry.progress * 100)}%`;
    const flags = [];
    if (entry.dismissed) flags.push('dismissed');
    if (entry.parentId && !map.has(entry.parentId)) flags.push(`parent=${entry.parentId}`);
    lines.push(
      `${'  '.repeat(depth)}- [${entry.id}] (${entry.status})${pct} ${entry.title}${
        flags.length ? ` · ${flags.join(' · ')}` : ''
      }`
    );
    for (const child of children.get(entry.id) || []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);

  const counts = selected.reduce((acc, { entry }) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([status, count]) => `${status} ${count}`)
    .join(', ');
  let text = `Progress store (scope=${scope}${includeDismissed ? ', dismissed included' : ', dismissed hidden'}): ${selected.length} entr${
    selected.length === 1 ? 'y' : 'ies'
  }${summary ? ` — ${summary}` : ''}\n${lines.join('\n')}`;
  if (truncated) text += `\n(truncated at ${limit} entries; raise limit for more)`;
  toolOk(id, text);
}

function handleRequest(req) {
  const { jsonrpc, id, method, params } = req;

  if (jsonrpc !== '2.0') return;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'progress-mcp-server',
            version: SERVER_VERSION,
          },
          instructions: SERVER_INSTRUCTIONS,
        });
        break;
      }

      case 'initialized':
      case 'notifications/initialized': {
        // Notification, no response needed.
        break;
      }

      case 'ping': {
        sendResponse(id, {});
        break;
      }

      case 'tools/list': {
        handleToolsList(id);
        break;
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (name !== 'progress' && name !== 'list') {
          sendError(id, -32601, `Unknown tool: ${name}`);
          break;
        }
        const callArgs = { ...(args && typeof args === 'object' ? args : {}) };
        const metaSession = params?._meta?.['ai.opencode/sessionID'];
        if (typeof metaSession === 'string' && metaSession) {
          // The caller is always the session that invoked the tool, even when
          // the agent passes another session explicitly (subagent stamping).
          callArgs.callerSessionId = metaSession;
          if (callArgs.sessionId === undefined) callArgs.sessionId = metaSession;
        }
        if (name === 'list') {
          handleListCall(id, callArgs);
          break;
        }
        handleProgressCall(id, callArgs);
        break;
      }

      case 'shutdown': {
        sendResponse(id, null);
        break;
      }

      case 'exit': {
        process.exit(0);
        break;
      }

      default: {
        // Notifications have no id; never reply to them.
        if (id !== undefined && id !== null) {
          sendError(id, -32601, `Unknown method: ${method}`);
        }
        break;
      }
    }
  } catch (err) {
    if (id !== undefined && id !== null) {
      sendError(id, -32603, 'Internal error', String(err && err.message ? err.message : err));
    }
  }
}

function startMcpServer() {
  ensureStateFile();

  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handleRequest(JSON.parse(line));
      } catch (e) {
        // Ignore malformed JSON-RPC lines.
      }
    }
  });

  process.stdin.on('end', () => {
    // Let pending stdout writes drain naturally instead of truncating the
    // final tool response during a client restart.
    process.exitCode = 0;
  });

  // A closed stdout (client restart) should not crash the server.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

// --- Entrypoint ------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      'progress-mcp-server ' + SERVER_VERSION,
      '',
      'MCP server and out-of-band relay for the `progress` tool.',
      '',
      'Usage:',
      '  node index.js                         Start the MCP stdio server',
      '  node index.js relay --id <id> [--] <cmd...>',
      '                                        Stream command output to state',
      '  node index.js emit --id <id> [--status ...]',
      '                                        Emit one milestone',
      '  node index.js --version               Print version',
      '',
      'Relay options: relay --help',
      '',
    ].join('\n')
  );
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const invokedAs = path.basename(process.argv[1] || '').replace(/\.(js|cjs)$/i, '');

  if (command === 'relay' || command === 'emit') {
    require('./relay').main(argv.slice(1), command);
    return;
  }

  if (command === 'report') {
    process.exitCode = require('./report').runReport(argv.slice(1));
    return;
  }

  if (!command && /relay/i.test(invokedAs)) {
    require('./relay').main(argv, 'relay');
    return;
  }

  if (!command && /emit/i.test(invokedAs)) {
    require('./relay').main(argv, 'emit');
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }

  startMcpServer();
}

main();
