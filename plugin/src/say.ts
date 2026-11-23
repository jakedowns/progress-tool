/**
 * Experimental `say` narration tool (Phase 1: OpenCode-native).
 *
 * `say` is the liveness layer beside the progress tree: the agent posts a short
 * note about what it is about to do and how long it expects to take, without
 * ending the turn. It is a tool call, so the turn structurally cannot end there.
 *
 * A note fans out to two channels:
 *   1. `context.progress({ status })` — the instant, tool-scoped line.
 *   2. `ctx.session.synthetic({ resume: false })` — a durable prose note that
 *      does not schedule a new execution.
 *
 * Length is never a reason to skip a note. Over-max is clamped at a word
 * boundary; under-min is accepted and returns a warning. Budget and cooldown
 * can skip, and their result points the agent at the progress tool for further
 * backchannel updates in that turn.
 *
 * Pure helpers live here so they can be unit-tested without an OpenCode server.
 */

export interface SayOptions {
  enabled: boolean;
  minChars: number;
  maxChars: number;
  budgetPerTurn: number;
  cooldownMs: number;
  chatNotes: boolean;
  finalGuard: boolean;
}

export interface SayTurnState {
  count: number;
  lastAt: number;
  lastText: string;
}

export interface SaySessionState extends SayTurnState {
  /** At least one note was accepted in the current turn. */
  accepted: boolean;
  /** The final guard already fired for this turn. */
  guarded: boolean;
}

export type SaySkipReason = "empty" | "budget" | "cooldown" | "duplicate";

export interface SayDecision {
  accept: boolean;
  reason?: SaySkipReason;
  text: string;
  warning?: string;
}

export type SayKind = "intent" | "update" | "blocked" | "question";

export interface SayInput {
  text: string;
  kind?: SayKind;
  eta?: string;
}

export interface SayToolContext {
  sessionID: string;
  progress?: (update: { status: string }) => Promise<void> | void;
}

export interface SayDeps {
  recordNote?: (input: {
    sessionID: string;
    text: string;
    kind: SayKind;
    eta?: string | null;
    at: number;
  }) => void;
  synthetic?: (input: {
    sessionID: string;
    text: string;
    resume?: boolean;
    metadata?: Record<string, string | number | boolean | null>;
  }) => Promise<unknown> | unknown;
  log?: (message: string, error?: unknown) => void;
}

export interface SayToolDefinition {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  options: { codemode: boolean };
  execute: (input: SayInput, context: SayToolContext) => Promise<{ content: string }>;
}

export interface SayController {
  tool: SayToolDefinition;
  reset(sessionID: string): void;
  get(sessionID: string): SaySessionState | undefined;
  markGuarded(sessionID: string): void;
}

const DEFAULT_MIN_CHARS = 180;
const DEFAULT_MAX_CHARS = 260;
const DEFAULT_BUDGET = 3;
const DEFAULT_COOLDOWN_MS = 15_000;
const KINDS: readonly SayKind[] = ["intent", "update", "blocked", "question"];

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Defaults are opt-in: `say` only exists when `options.say === true`. */
export function normalizeSayOptions(raw: unknown): SayOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  const minChars = integerInRange(options.sayMinChars, DEFAULT_MIN_CHARS, 80, 600);
  const maxChars = Math.max(
    minChars,
    integerInRange(options.sayMaxChars, DEFAULT_MAX_CHARS, 80, 600)
  );
  return {
    enabled: options.say === true,
    minChars,
    maxChars,
    budgetPerTurn: integerInRange(options.sayBudgetPerTurn, DEFAULT_BUDGET, 1, 10),
    cooldownMs: integerInRange(options.sayCooldownMs, DEFAULT_COOLDOWN_MS, 0, 120_000),
    chatNotes: options.sayChatNotes !== false,
    finalGuard: options.sayFinalGuard !== false,
  };
}

export function sayEnabled(raw: unknown): boolean {
  return normalizeSayOptions(raw).enabled;
}

/** Say notes are one line; collapse whitespace so the transcript stays tidy. */
export function normalizeSayText(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Hard cap at a word boundary. Length is never a rejection: an over-long note
 * is trimmed rather than dropped.
 */
export function clampSayText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(1, maxChars - 1);
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > Math.floor(budget * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export function emptySayState(): SaySessionState {
  return { count: 0, lastAt: 0, lastText: "", accepted: false, guarded: false };
}

/**
 * Decide whether a note is accepted. Pure: returns the next state plus the
 * decision, so the caller owns the per-session map.
 *
 * Order: empty -> budget -> cooldown -> duplicate -> accept.
 * Length is handled after acceptance (clamp + warning).
 */
export function decideSay(
  state: SaySessionState,
  input: { text: string; now: number; options: SayOptions }
): { state: SaySessionState; decision: SayDecision } {
  const text = normalizeSayText(input.text);
  if (!text) {
    return { state, decision: { accept: false, reason: "empty", text: "" } };
  }
  const clamped = clampSayText(text, input.options.maxChars);
  if (state.count >= input.options.budgetPerTurn) {
    return { state, decision: { accept: false, reason: "budget", text } };
  }
  if (state.lastAt > 0 && input.now - state.lastAt < input.options.cooldownMs) {
    return { state, decision: { accept: false, reason: "cooldown", text } };
  }
  if (clamped === state.lastText) {
    return { state, decision: { accept: false, reason: "duplicate", text } };
  }

  const warnings: string[] = [];
  if (clamped !== text) warnings.push(`trimmed to ${input.options.maxChars} chars`);
  if (text.length < input.options.minChars) {
    warnings.push(`shorter than the preferred ${input.options.minChars} chars`);
  }

  return {
    state: {
      count: state.count + 1,
      lastAt: input.now,
      lastText: clamped,
      accepted: true,
      guarded: state.guarded,
    },
    decision: {
      accept: true,
      text: clamped,
      warning: warnings.length
        ? `Heads-up: that note was ${warnings.join(" and ")}; keep the next one in range.`
        : undefined,
    },
  };
}

/** Minimal tool result: never repeat the note, and always tell the model to continue. */
export function sayResultMessage(decision: SayDecision): string {
  if (decision.accept) {
    const warning = decision.warning ? ` ${decision.warning}` : "";
    return `Noted.${warning} Continue working; this is not the final answer.`;
  }
  switch (decision.reason) {
    case "budget":
    case "cooldown":
      return "Skipped (budget/cooldown). Continue working; use the progress tool for any further backchannel updates this turn.";
    case "duplicate":
      return "Skipped (duplicate note). Continue working.";
    default:
      return "Skipped (empty note). Continue working.";
  }
}

export function sayToolDescription(options: SayOptions): string {
  const seconds = Math.round(options.cooldownMs / 1000);
  return (
    `Post a short user-visible note without ending the turn. Use before a multi-step task ` +
    `or a tool likely to run longer than ~30s: give a ${options.minChars}–${options.maxChars} ` +
    `character summary of what you're about to do and a rough ETA, so the user isn't left ` +
    `wondering or forced to open your thought trace. Not the final answer. ` +
    `Budget: ${options.budgetPerTurn} notes per turn, ${seconds}s apart.`
  );
}

/**
 * Build the tool definition plus the per-session budget map. The plugin server
 * part supplies the synthetic/progress bindings; tests supply mocks.
 */
export function createSayController(
  options: SayOptions,
  deps: SayDeps = {},
  name = "say"
): SayController {
  const states = new Map<string, SaySessionState>();

  const tool: SayToolDefinition = {
    name,
    description: sayToolDescription(options),
    input: {
      type: "object",
      properties: {
        text: {
          type: "string",
          maxLength: options.maxChars,
          description: `${options.minChars}–${options.maxChars} character summary of what you're about to do and a rough ETA.`,
        },
        kind: {
          type: "string",
          enum: KINDS,
          description: "intent (starting work), update (phase change), blocked, or question.",
        },
        eta: {
          type: "string",
          description: "Optional rough ETA, e.g. '~2 min'.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    options: { codemode: true },
    execute: async (input, context) => {
      const now = Date.now();
      const previous = states.get(context.sessionID) ?? emptySayState();
      const { state, decision } = decideSay(previous, {
        text: (input ?? ({} as SayInput)).text,
        now,
        options,
      });
      states.set(context.sessionID, {
        ...state,
        accepted: previous.accepted || state.accepted,
        guarded: previous.guarded,
      });

      if (decision.accept) {
        try {
          await context.progress?.({ status: decision.text });
        } catch (error) {
          deps.log?.("say progress update failed", error);
        }

        try {
          deps.recordNote?.({
            sessionID: context.sessionID,
            text: decision.text,
            kind: input?.kind ?? "intent",
            eta: input?.eta ?? null,
            at: now,
          });
        } catch (error) {
          // The note lanes are additive; never fail the tool on persistence.
          deps.log?.("say note persistence failed", error);
        }

        if (options.chatNotes && deps.synthetic) {
          try {
            await deps.synthetic({
              sessionID: context.sessionID,
              text: decision.text,
              resume: false,
              metadata: {
                kind: "agent.note",
                tone: input?.kind ?? "intent",
                eta: input?.eta ?? null,
                source: "progress-tool",
                at: now,
              },
            });
          } catch (error) {
            // The instant progress line already landed; a synthetic failure
            // must not turn an accepted note into a failed tool call.
            deps.log?.("say synthetic note failed", error);
          }
        }
      }

      return { content: sayResultMessage(decision) };
    },
  };

  return {
    tool,
    reset(sessionID) {
      states.delete(sessionID);
    },
    get(sessionID) {
      return states.get(sessionID);
    },
    markGuarded(sessionID) {
      const state = states.get(sessionID);
      if (state) state.guarded = true;
    },
  };
}
