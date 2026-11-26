#!/usr/bin/env node
// nudge-report — summarize the plugin's JSONL nudge log. Streams lines (safe
// for huge logs), skips malformed lines, no dependencies.
// Usage: node plugin/scripts/nudge-report.mjs [--log <path>] [--session <id>]
//        [--since <30m|12h|7d|ISO date>] [--json] [--help]
// fires = applied legacy `reminder` events + applied shared `nudge` events;
// suppressed includes explicit reasons and dedupes; channels = raw telemetry.

import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SHARED = new Set(["nudge", "nudge-shadow", "nudge-touch", "nudge-clear", "nudge-mute", "nudge-unmute", "nudge-reset"]);
const SHARED_FIELD = { "nudge-shadow": "shadow", "nudge-touch": "touch", "nudge-clear": "clear", "nudge-mute": "mute", "nudge-unmute": "unmute", "nudge-reset": "reset" };
const CHANNEL = { "say-nudge": "say", strict: "strict", "wall-clock": "wall", "idle-reminder": "idle", compliance: "compliance" };
const MAX_SINCE = 10 * 365 * 24 * 60 * 60 * 1000;

const HELP = `Usage: node plugin/scripts/nudge-report.mjs [options]

Summarize the plugin JSONL nudge log (default: $PROGRESS_NUDGE_LOG or
~/.opencode-progress-nudges.log). Lines are streamed, malformed lines skipped.

Options:
  --log <path>     Log file to read (default: env var or ~/.opencode-progress-nudges.log)
  --session <id>   Only count events for this session id
  --since <when>   Only count events at/after a duration ago (30m, 12h, 7d, 1w)
                   or an ISO timestamp/date (2026-11-26T18:00:00Z)
  --json           Print one stable JSON object instead of text
  -h, --help       Show this help and exit 0

Counts applied nudge fires by source/severity, suppressed reasons, channel
telemetry (say/strict/wall/idle/compliance), and shared-engine events.
`;

function defaultLogPath() {
  const env = process.env.PROGRESS_NUDGE_LOG;
  return env && env !== "1" ? env : join(process.env.HOME || homedir(), ".opencode-progress-nudges.log");
}

function fail(message) {
  process.stderr.write(`nudge-report: ${message}\nTry --help for usage.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { log: defaultLogPath(), session: null, since: null, json: false, help: false };
  const value = (arg, name) => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return arg.slice(eq + 1);
    const next = argv.shift();
    if (next === undefined || next.startsWith("--")) fail(`${name} needs a value`);
    return next;
  };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--log" || arg.startsWith("--log=")) out.log = value(arg, "--log");
    else if (arg === "--session" || arg.startsWith("--session=")) out.session = value(arg, "--session");
    else if (arg === "--since" || arg.startsWith("--since=")) out.since = value(arg, "--since");
    else fail(`unknown option: ${arg}`);
  }
  if (!out.log.trim()) fail("--log needs a non-empty path");
  return out;
}

function parseSince(raw) {
  const text = raw.trim();
  if (!text) return { error: "--since needs a duration or date" };
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(text);
  if (match) {
    let ms = Number(match[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[match[2].toLowerCase()];
    if (!Number.isFinite(ms)) return { error: `invalid --since: ${raw}` };
    const clamped = ms > MAX_SINCE;
    if (clamped) ms = MAX_SINCE;
    return { at: Date.now() - ms, label: `${match[1]}${match[2].toLowerCase()}`, clamped };
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { error: `invalid --since: ${raw} (use 30m, 12h, 7d, or an ISO date)` };
  const clamped = parsed > Date.now();
  const at = clamped ? Date.now() : parsed;
  return { at, label: new Date(at).toISOString(), clamped };
}

function emptyReport(log, session, since) {
  return {
    log,
    filters: { session: session || null, since: since ? since.label : null },
    lines: { total: 0, events: 0, malformed: 0, matched: 0, undated: 0 },
    range: { first: null, last: null },
    events: {},
    nudgeFires: { total: 0, bySource: {}, bySeverity: {} },
    suppressed: { total: 0, byReason: {} },
    channels: { say: 0, strict: 0, wall: 0, idle: 0, compliance: 0 },
    shared: { events: {}, fires: 0, shadow: 0, touch: 0, clear: 0, mute: 0, unmute: 0, reset: 0, byProducer: {}, bySeverity: {}, byReason: {} },
    _allSessions: new Set(), _matchedSessions: new Set(), _sinceAt: since ? since.at : undefined,
  };
}

const bump = (bag, key) => { bag[key] = (bag[key] ?? 0) + 1; };
const sorted = (bag) => Object.fromEntries(Object.keys(bag).sort().map((key) => [key, bag[key]]));

function add(report, event, ts) {
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : null;
  const matched = report.filters.session === null || sessionID === report.filters.session;
  if (sessionID) {
    report._allSessions.add(sessionID);
    if (matched) report._matchedSessions.add(sessionID);
  }
  if (!matched) return;

  const when = typeof ts === "string" ? Date.parse(ts) : NaN;
  if (report._sinceAt !== undefined) {
    if (Number.isNaN(when)) { report.lines.undated += 1; return; }
    if (when < report._sinceAt) return;
  }
  report.lines.matched += 1;
  if (!Number.isNaN(when)) {
    const iso = new Date(when).toISOString();
    if (!report.range.first || iso < report.range.first) report.range.first = iso;
    if (!report.range.last || iso > report.range.last) report.range.last = iso;
  }

  const name = typeof event.event === "string" ? event.event : "(none)";
  bump(report.events, name);
  if (CHANNEL[name]) report.channels[CHANNEL[name]] += 1;

  const fire = (source, severity) => {
    report.nudgeFires.total += 1;
    bump(report.nudgeFires.bySource, source ?? "unknown");
    bump(report.nudgeFires.bySeverity, severity ?? "none");
  };
  const suppress = (reason) => {
    report.suppressed.total += 1;
    bump(report.suppressed.byReason, reason);
  };

  if (name === "reminder") {
    if (typeof event.suppressed === "string") suppress(event.suppressed);
    else if (event.deduped === true) suppress("deduped");
    else fire(event.source, event.severity);
  }
  if (event.engine !== "shared") return;
  if (SHARED.has(name)) bump(report.shared.events, name);
  if (SHARED_FIELD[name]) report.shared[SHARED_FIELD[name]] += 1;
  else if (name === "nudge") {
    if (typeof event.reason === "string") {
      suppress(event.reason);
      bump(report.shared.byReason, event.reason);
    } else {
      const producer = typeof event.producer === "string" ? event.producer : "unknown";
      const severity = typeof event.severity === "string" ? event.severity : "none";
      fire(producer, severity);
      report.shared.fires += 1;
      bump(report.shared.byProducer, producer);
      bump(report.shared.bySeverity, severity);
    }
  }
}

async function scan(report, logPath) {
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      report.lines.total += 1;
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        report.lines.malformed += 1;
        continue;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        report.lines.malformed += 1;
        continue;
      }
      report.lines.events += 1;
      add(report, event, event.ts);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function finalize(report, error) {
  const out = {
    log: report.log,
    filters: report.filters,
    lines: report.lines,
    sessions: { total: report._allSessions.size, matched: report._matchedSessions.size },
    range: report.range,
    events: sorted(report.events),
    nudgeFires: { total: report.nudgeFires.total, bySource: sorted(report.nudgeFires.bySource), bySeverity: sorted(report.nudgeFires.bySeverity) },
    suppressed: { total: report.suppressed.total, byReason: sorted(report.suppressed.byReason) },
    channels: report.channels,
    shared: {
      events: sorted(report.shared.events), fires: report.shared.fires,
      shadow: report.shared.shadow, touch: report.shared.touch, clear: report.shared.clear,
      mute: report.shared.mute, unmute: report.shared.unmute, reset: report.shared.reset,
      byProducer: sorted(report.shared.byProducer), bySeverity: sorted(report.shared.bySeverity),
      byReason: sorted(report.shared.byReason),
    },
  };
  if (error) out.error = error;
  return out;
}

function printText(data) {
  const n = (value) => Number(value).toLocaleString("en-US");
  const rows = (bag, indent = "  ") => Object.entries(bag).map(([k, v]) => `${indent}${k.padEnd(18)} ${n(v)}`);
  const out = [
    `Nudge log: ${data.log}`,
    ...(data.error ? [`  (${data.error}; showing zeros)`] : []),
    `Filter: session=${data.filters.session ?? "all"} since=${data.filters.since ?? "all"}`,
    `Lines: ${n(data.lines.total)} · events ${n(data.lines.events)} · malformed ${n(data.lines.malformed)} · matched ${n(data.lines.matched)}`,
    `Sessions: ${n(data.sessions.matched)} matched of ${n(data.sessions.total)}`,
    `Range: ${data.range.first ?? "-"} → ${data.range.last ?? "-"}`,
    "",
    "Events:",
    ...rows(data.events),
    "",
    `Nudge fires: ${n(data.nudgeFires.total)}`,
    "  by source:",
    ...rows(data.nudgeFires.bySource, "    "),
    "  by severity:",
    ...rows(data.nudgeFires.bySeverity, "    "),
    "",
    `Suppressed: ${n(data.suppressed.total)}`,
    ...rows(data.suppressed.byReason),
    "",
    `Channels: say ${n(data.channels.say)} · strict ${n(data.channels.strict)} · wall ${n(data.channels.wall)} · idle ${n(data.channels.idle)} · compliance ${n(data.channels.compliance)}`,
  ];
  const s = data.shared;
  if (Object.keys(s.events).length || s.fires) {
    out.push("", `Shared engine: fires ${n(s.fires)} · shadow ${n(s.shadow)} · touch ${n(s.touch)} · clear ${n(s.clear)} · mute ${n(s.mute)} · unmute ${n(s.unmute)} · reset ${n(s.reset)}`, "  events:", ...rows(s.events, "    "));
    if (Object.keys(s.byProducer).length) out.push("  by producer:", ...rows(s.byProducer, "    "));
    if (Object.keys(s.byReason).length) out.push("  suppressed reasons:", ...rows(s.byReason, "    "));
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return void process.stdout.write(HELP);
  const args = parseArgs(rawArgs);
  if (args.help) return void process.stdout.write(HELP);
  if (args.session !== null) {
    args.session = args.session.trim();
    if (!args.session) fail("--session needs a non-empty value");
    if (args.session.length > 200) fail("--session is too long to be a session id");
    if (!/^ses_[\w-]+$/.test(args.session)) process.stderr.write("nudge-report: warning: --session does not look like an opencode session id\n");
  }
  let since = null;
  if (args.since !== null) {
    since = parseSince(args.since);
    if (since.error) fail(since.error);
    if (since.clamped) process.stderr.write(`nudge-report: --since clamped to ${since.label}\n`);
  }

  const report = emptyReport(args.log, args.session, since);
  let error;
  try {
    await scan(report, args.log);
  } catch (caught) {
    error = caught && caught.code === "ENOENT" ? `log not found: ${args.log}` : `could not read log: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  const data = finalize(report, error);
  if (args.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else if (error) {
    process.stderr.write(`nudge-report: ${error}\n`);
    process.stdout.write("No nudge log to summarize. Enable it with PROGRESS_NUDGE_LOG=<path> or verboseLogging.\n");
  } else printText(data);
  if (error) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`nudge-report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
