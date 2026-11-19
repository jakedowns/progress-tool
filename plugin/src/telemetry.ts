/**
 * Nudge telemetry: a JSONL audit trail of everything the plugin injects.
 *
 * Why a file: plugin `console.log` output does not reliably reach any
 * captureable harness log (verified — neither the service log nor the
 * desktop logs show plugin stdout). A plain append-only file is greppable,
 * works for both processes that can write it, and never depends on the
 * harness.
 *
 * Disabled by default: enable with `{ "options": { "verboseLogging": true } }`
 * or by setting `PROGRESS_NUDGE_LOG` to a path (or `1` for the default).
 *
 * Each line is one JSON object: { ts, event, sessionID, ...details }.
 * Events: wall-clock, strict, idle-reminder, child-list-error, unhinged.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function nudgeLogPath(): string {
  const env = process.env.PROGRESS_NUDGE_LOG;
  if (env && env !== "1") return env;
  return process.env.HOME || process.env.USERPROFILE
    ? join(process.env.HOME || process.env.USERPROFILE!, ".opencode-progress-nudges.log")
    : join(homedir(), ".opencode-progress-nudges.log");
}

/** Explicit option wins; the env var can also enable it. Default: off. */
export function nudgeLoggingEnabled(raw: unknown): boolean {
  const options = (raw ?? {}) as Record<string, unknown>;
  if (options.verboseLogging === true) return true;
  return Boolean(process.env.PROGRESS_NUDGE_LOG);
}

export function logNudge(event: Record<string, unknown>): void {
  try {
    appendFileSync(nudgeLogPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Telemetry must never break a session.
  }
}
