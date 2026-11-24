'use strict';

/**
 * Out-of-band progress relay.
 *
 * The relay is the data plane for the progress tool. It owns high-frequency
 * telemetry (stdout/stderr lines, percentages, elapsed time) so the agent
 * never has to poll, sleep, or spend tokens keeping a UI fresh.
 *
 * Two modes, same state file:
 *
 *   Wrap a command (exit code is captured):
 *     progress-relay --id build-1 -- npm run build
 *
 *   Pipe a command (exit code unknown; marks done on EOF):
 *     npm run build | progress-relay --id build-1
 *
 * One-shot milestone emit (for scripts and non-pipe harnesses):
 *     progress-emit --id build-1 --status running --title "Building"
 *
 * This file is intentionally dependency-free so any harness can vendor it
 * or reimplement the same contract.
 */

const { spawn } = require('child_process');
const {
  readState,
  resolveStatePath,
  resolveSessionId,
  resolveSessionScope,
  storageKey,
  upsertProgress,
  touchProgress,
} = require('./state-store');

const DEFAULT_MAX_HZ = (() => {
  const raw = Number.parseFloat(process.env.PROGRESS_RELAY_MAX_HZ || '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 4;
})();
const MAX_DETAIL_LENGTH = 240;
const MAX_LINE_BUFFER = 64 * 1024;
const STATUSES = ['pending', 'running', 'waiting', 'done', 'error'];

// OSC 9;4 "progress report" sequence (ConEmu / Windows Terminal convention),
// emitted natively by Gradle's rich console, mise, PowerShell 7.4+, and other
// build tools. Grammar:
//   ESC ] 9 ; 4 ; <state> [ ; <progress 0-100> ] ( BEL | ESC \ )
// States: 0 clear, 1 normal, 2 error, 3 indeterminate, 4 paused/warning.
const OSC94_RE = /\x1b\]9;4;([0-4])(?:;(\d{1,3}))?(?:\x07|\x1b\\)/g;
// A plausible *incomplete* OSC 9;4 sequence at the end of a chunk. Only tails
// that could still become one of our sequences are held back across chunks;
// everything else passes through untouched so foreign escape sequences keep
// their existing behavior (stripped per line by cleanLine).
const OSC94_PARTIAL_RE = /\x1b\]9;4;?[0-9;]*$/;
const OSC94_MAX_PARTIAL = 64;

const ANSI_RE =
  // CSI sequences, OSC sequences, and common single-character escapes.
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;

function safeWrite(stream, chunk) {
  try {
    stream.write(chunk);
  } catch (e) {
    // A closed stdout/stderr must not take down the wrapped command.
  }
}

function printUsage(mode, stream) {
  const out = stream || process.stdout;
  if (mode === 'touch') {
    out.write(
      [
        'Usage: progress-touch --id <id> [--detail <text>]',
        '',
        'Refresh an existing entry without changing its status, title, or',
        'progress. Use it during long single-step work so the reminder engine',
        'knows the task is still live. Multiple ids: repeat --id.',
        '',
        'Options:',
        '  --id <id>            Entry id to touch (repeatable; or PROGRESS_ID)',
        '  --detail <text>      Optional replacement detail',
        '  --session <id>       Session scope (or PROGRESS_SESSION_ID / OPENCODE_SESSION_ID)',
        '  --state-path <path>  Override ~/.opencode-progress-state.json',
        '  -h, --help           Show this help',
        '',
      ].join('\n')
    );
    return;
  }
  if (mode === 'emit') {
    out.write(
      [
        'Usage: progress-emit --id <id> [options]',
        '',
        'Emit one progress milestone and exit. Use this from scripts that do',
        'not have a long-running stdout stream to relay.',
        '',
        'Options:',
        '  --id <id>            Stable task id (or PROGRESS_ID)',
        '  --status <status>    pending | running | waiting | done | error (default: running)',
        '  --title <title>      Human-readable task label',
        '  --detail <text>      Detail line (e.g. current step)',
        '  --progress <value>   0..1, 45%, or 6/10',
        '  --parent <id>        Parent task id for tree nesting',
        '  --session <id>       Session scope (or PROGRESS_SESSION_ID / OPENCODE_SESSION_ID)',
        '  --state-path <path>  Override ~/.opencode-progress-state.json',
        '  -h, --help           Show this help',
        '',
        'Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID or',
        'PROGRESS_SESSION_ID. Keep using clean task ids like "build-1"; do not',
        'manually prefix them with the session id.',
        '',
        'Example:',
        '  progress-emit --id build-1 --status done --title "Build" --progress 1',
        '',
        'Touch (refresh without progress):',
        '  progress-touch --id build-1 --detail "still compiling"',
        '',
      ].join('\n')
    );
    return;
  }

  out.write(
    [
      'Usage: progress-relay --id <id> [options] [--] [command...]',
      '',
      'Stream command output into the shared progress state file without',
      'burning agent tokens. With a command, the relay captures its exit code',
      'and marks the task done or error automatically.',
      '',
      'Options:',
      '  --id <id>            Stable task id (or PROGRESS_ID)',
      '  --title <title>      Human-readable task label (only needed for new tasks)',
      '  --parent <id>        Parent task id for tree nesting',
      '  --detail <text>      Initial detail line',
      '  --progress <value>   0..1, 45%, or 6/10',
      '  --status <status>    Initial status (default: running)',
      '  --session <id>       Session scope (or PROGRESS_SESSION_ID / OPENCODE_SESSION_ID)',
      '  --max-hz <n>         Max state writes per second (default: 4, 0 = unlimited)',
      '  --quiet, --no-tee    Do not echo command output to this process stdout/stderr',
      '  --state-path <path>  Override ~/.opencode-progress-state.json',
      '  --once               Emit one update and exit (same as progress-emit)',
      '  -h, --help           Show this help',
      '',
      'Structured input: OSC 9;4 terminal progress sequences (ConEmu / Windows',
      'Terminal; emitted by Gradle rich console, mise, PowerShell 7.4+, ...) are',
      'parsed before text heuristics, and their state maps to running/waiting/error.',
      '',
      'Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID or',
      'PROGRESS_SESSION_ID. Keep using clean task ids like "build-1"; do not',
      'manually prefix them with the session id.',
      '',
      'Examples:',
      '  progress-relay --id build-1 -- npm run build',
      '  npm run build | progress-relay --id build-1',
      '  progress-relay --id test-1 --parent build-1 -- pytest -q',
      '',
      'Exit code:',
      '  Wrap mode exits with the wrapped command\'s exit code.',
      '  Pipe mode exits 0 when stdin closes (it cannot see the upstream exit code).',
      '',
    ].join('\n')
  );
}

function parseProgressValue(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();

  if (value.endsWith('%')) {
    const pct = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return Math.max(0, Math.min(1, pct / 100));
  }

  if (value.includes('/')) {
    const [a, b] = value.split('/').map((part) => Number.parseFloat(part));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    return Math.max(0, Math.min(1, a / b));
  }

  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  // Be forgiving: 45 means 45%, 0.45 means 0.45.
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}

function cleanLine(raw) {
  return String(raw)
    .replace(ANSI_RE, '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text) {
  if (text == null) return text;
  return text.length > MAX_DETAIL_LENGTH
    ? text.slice(0, MAX_DETAIL_LENGTH - 1) + '…'
    : text;
}

function parseProgressLine(line) {
  const cleaned = cleanLine(line);
  if (!cleaned) return null;

  const percents = [...cleaned.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)];
  const lastPct = percents[percents.length - 1];
  if (lastPct) {
    const pct = Number.parseFloat(lastPct[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct / 100;
  }

  const ratios = [...cleaned.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  for (let i = ratios.length - 1; i >= 0; i--) {
    const done = Number.parseInt(ratios[i][1], 10);
    const total = Number.parseInt(ratios[i][2], 10);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done <= total) {
      return done / total;
    }
  }

  return null;
}

/**
 * Structured progress source: extract OSC 9;4 sequences from raw chunks
 * BEFORE line splitting and ANSI stripping.
 *
 * Why chunk level: OSC 9;4 sequences usually arrive without a trailing
 * newline, often several per redraw, and can be split across read chunk
 * boundaries. A line-oriented parser would miss them or leak partial escape
 * bytes into `detail`.
 *
 * The filter calls `onOsc({ state, progress })` for every complete sequence
 * (progress is 0..1 or null when absent) and forwards all remaining text to
 * `onText(text, meta)`, where `meta.hasOsc94` tells the line handler that
 * structured progress was present in this chunk (so text heuristics like
 * "45%" must not compete with it).
 */
function makeOsc94Filter(onOsc, onText) {
  let carry = '';

  function push(chunk, meta) {
    carry += chunk;
    OSC94_RE.lastIndex = 0;

    let match;
    let lastEnd = 0;
    let consumed = 0;

    while ((match = OSC94_RE.exec(carry)) !== null) {
      const state = Number.parseInt(match[1], 10);
      const progress =
        match[2] !== undefined
          ? Math.max(0, Math.min(1, Number.parseInt(match[2], 10) / 100))
          : null;
      onText(carry.slice(lastEnd, match.index), meta);
      onOsc({ state, progress });
      meta.hasOsc94 = true;
      lastEnd = OSC94_RE.lastIndex;
      consumed = lastEnd;
    }

    // Hold back only a plausible incomplete OSC 9;4 sequence so a sequence
    // split across chunks still parses once its terminator arrives.
    let tail = carry.slice(consumed);
    const partial = OSC94_PARTIAL_RE.exec(tail);
    if (partial && partial[0].length <= OSC94_MAX_PARTIAL) {
      tail = tail.slice(0, tail.length - partial[0].length);
      carry = partial[0];
    } else {
      carry = '';
    }
    if (tail) onText(tail, meta);
  }

  push.flush = function flush(meta) {
    if (!carry) return;
    const text = carry;
    carry = '';
    onText(text, meta);
  };

  return push;
}

function parseArgs(argv) {
  const envSessionId = resolveSessionId();
  const opts = {
    id: process.env.PROGRESS_ID || null,
    title: process.env.PROGRESS_TITLE || null,
    parentId: process.env.PROGRESS_PARENT || null,
    // The true caller (env), kept separately so a subagent passing the
    // parent via --session can still be flagged.
    callerSessionId: envSessionId,
    sessionId: envSessionId,
    detail: null,
    progress: null,
    status: null,
    maxHz: DEFAULT_MAX_HZ,
    tee: true,
    stateFile: resolveStatePath(),
    command: null,
    once: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      opts.command = argv.slice(i + 1);
      break;
    }

    switch (arg) {
      case '--id': {
        const next = argv[++i];
        if (!opts.ids) opts.ids = [];
        if (next) opts.ids.push(next);
        opts.id = next;
        break;
      }
      case '--parent':
      case '--parent-id':
        opts.parentId = argv[++i];
        break;
      case '--title':
        opts.title = argv[++i];
        break;
      case '--session':
        opts.sessionId = argv[++i];
        break;
      case '--detail':
        opts.detail = argv[++i];
        break;
      case '--progress': {
        const parsed = parseProgressValue(argv[++i]);
        if (parsed == null) throw new Error(`Invalid --progress value: ${argv[i]}`);
        opts.progress = parsed;
        break;
      }
      case '--status': {
        const status = argv[++i];
        if (!STATUSES.includes(status)) {
          throw new Error(`Invalid --status: ${status} (expected ${STATUSES.join('|')})`);
        }
        opts.status = status;
        break;
      }
      case '--max-hz': {
        const hz = Number.parseFloat(argv[++i]);
        if (!Number.isFinite(hz) || hz < 0) throw new Error(`Invalid --max-hz: ${argv[i]}`);
        opts.maxHz = hz;
        break;
      }
      case '--quiet':
      case '--no-tee':
        opts.tee = false;
        break;
      case '--tee':
        opts.tee = true;
        break;
      case '--state-path':
        opts.stateFile = argv[++i];
        break;
      case '--once':
        opts.once = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.command = argv.slice(i);
        i = argv.length;
        break;
    }
  }

  if (opts.parentId === '') opts.parentId = null;
  if (opts.title === '') opts.title = null;
  if (opts.detail === '') opts.detail = null;
  if (opts.command && opts.command.length === 0) opts.command = null;
  opts.sessionId = resolveSessionScope(opts.sessionId);

  return opts;
}

function commandTitle(command) {
  if (!command || command.length === 0) return null;
  return truncate(command.join(' '));
}

function existingEntry(opts) {
  try {
    const key = storageKey(opts.id, opts.sessionId);
    return readState(opts.stateFile).entries[key] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve entry fields once at startup. The relay must not clobber the
 * title/parent/status an agent already set via the MCP tool, so missing
 * options are inherited from the current entry.
 */
function baseEntry(opts) {
  const prev = existingEntry(opts);
  const wasTerminal = prev?.status === 'done' || prev?.status === 'error';
  const isRestart = wasTerminal && !opts.status;

  return {
    id: opts.id,
    sessionId: opts.sessionId,
    status: opts.status || 'running',
    title:
      opts.title !== null ? opts.title : prev?.title || commandTitle(opts.command),
    detail:
      opts.detail !== null ? opts.detail : isRestart ? null : prev?.detail ?? null,
    progress:
      opts.progress !== null
        ? opts.progress
        : isRestart
        ? null
        : prev?.progress ?? null,
    parentId: opts.parentId !== null ? opts.parentId : prev?.parentId ?? null,
    callerSessionId: opts.callerSessionId || null,
    startedAt: prev?.startedAt,
  };
}

function createReporter(opts) {
  const interval = opts.maxHz > 0 ? 1000 / opts.maxHz : 0;
  let entry = baseEntry(opts);
  let lastWrite = 0;
  let timer = null;
  let dirty = false;
  let finished = false;
  let warned = false;
  let oscSeen = false;

  function warn(err) {
    if (warned) return;
    warned = true;
    safeWrite(process.stderr, `progress-relay: state update failed: ${err.message}\n`);
  }

  function write(force) {
    if (!dirty && !force) return;
    const now = Date.now();

    if (!force && interval > 0 && now - lastWrite < interval) {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          write(false);
        }, Math.max(1, interval - (now - lastWrite)));
        if (timer.unref) timer.unref();
      }
      return;
    }

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    lastWrite = now;
    dirty = false;

    try {
      // `source: 'relay'` tells the store this is telemetry, not an agent
      // update: relay ticks must not clear a user's dismissal (§4.9).
      upsertProgress({ ...entry, source: 'relay' }, opts.stateFile);
    } catch (err) {
      warn(err);
    }
  }

  function setLine(raw) {
    const line = cleanLine(raw);
    if (!line) return;

    entry.detail = truncate(line);
    // Structured OSC 9;4 progress wins over text guessing ("45%", "6/10"):
    // once a stream has reported structured progress it will keep doing so,
    // and mixing both sources makes the bar jump backwards. The sticky flag
    // also covers lines held in the splitter's carry buffer across chunks,
    // where per-chunk attribution is unreliable.
    if (!oscSeen) {
      const parsed = parseProgressLine(line);
      if (parsed != null) entry.progress = parsed;
    }
    dirty = true;
    write(false);
  }

  /**
   * Apply an OSC 9;4 progress report. These writes are PROVISIONAL:
   * they never produce `done`, and the real exit mapping in finish() is
   * authoritative and always overwrites them when the command ends.
   */
  function setOsc94({ state, progress }) {
    oscSeen = true;
    switch (state) {
      case 0: // clear indicator
        entry.progress = null;
        break;
      case 1: // normal progress
        if (progress != null) entry.progress = progress;
        break;
      case 2: // error state (provisional; exit code wins at termination)
        entry.status = 'error';
        if (progress != null) entry.progress = progress;
        break;
      case 3: // indeterminate / busy
        entry.progress = null;
        break;
      case 4: // paused / warning
        entry.status = 'waiting';
        if (progress != null) entry.progress = progress;
        break;
    }
    dirty = true;
    write(false);
  }

  function finish(status, detail) {
    if (finished) return;
    finished = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    entry.status = status;
    if (detail !== undefined && detail !== null) {
      entry.detail = truncate(detail);
    } else if (!entry.detail) {
      entry.detail = status === 'done' ? 'completed' : 'finished';
    }
    if (status === 'done') entry.progress = 1;
    dirty = true;
    write(true);
  }

  return {
    start() {
      dirty = true;
      write(true);
    },
    setLine,
    setOsc94,
    finish,
    get detail() {
      return entry.detail;
    },
    get progress() {
      return entry.progress;
    },
  };
}

function makeLineSplitter(onLine) {
  let carry = '';

  function push(chunk) {
    carry += chunk;

    // A runaway line (binary output, no newlines) must not grow forever.
    if (carry.length > MAX_LINE_BUFFER) {
      onLine(carry.slice(0, MAX_LINE_BUFFER));
      carry = carry.slice(MAX_LINE_BUFFER);
    }

    const parts = carry.split(/\r\n|\n|\r/);
    carry = parts.pop();
    for (const part of parts) onLine(part);
  }

  push.flush = function flush() {
    if (!carry) return;
    const line = carry;
    carry = '';
    onLine(line);
  };

  return push;
}

function runEmit(opts) {
  const prev = existingEntry(opts);
  const status = opts.status || 'running';
  const wasTerminal = prev?.status === 'done' || prev?.status === 'error';
  const isRestart = wasTerminal && (status === 'running' || status === 'waiting' || status === 'pending');
  const progress =
    opts.progress !== null
      ? opts.progress
      : status === 'done'
      ? 1
      : isRestart
      ? null
      : prev?.progress ?? null;
  const detail =
    opts.detail !== null ? opts.detail : isRestart ? null : prev?.detail ?? null;

  upsertProgress(
    {
      id: opts.id,
      sessionId: opts.sessionId,
      callerSessionId: opts.callerSessionId || null,
      status,
      title: opts.title !== null ? opts.title : prev?.title,
      detail,
      progress,
      parentId: opts.parentId !== null ? opts.parentId : prev?.parentId ?? null,
    },
    opts.stateFile
  );

  return 0;
}

function installSignalForwarding(getChild, reporter) {
  const handlers = {};

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[signal] = () => {
      const child = getChild();
      if (child && !child.killed) {
        try {
          child.kill(signal);
        } catch (e) {}
        return;
      }
      reporter.finish('error', `terminated by ${signal}`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on(signal, handlers[signal]);
  }

  return () => {
    for (const [signal, handler] of Object.entries(handlers)) {
      process.removeListener(signal, handler);
    }
  };
}

function runWrappedCommand(opts, reporter) {
  let child = null;
  let settled = false;

  const removeSignals = installSignalForwarding(() => child, reporter);
  const splitOut = makeLineSplitter((line) => reporter.setLine(line));
  const splitErr = makeLineSplitter((line) => reporter.setLine(line));
  // Structured OSC 9;4 progress is extracted from raw chunks before line
  // splitting so multi-sequence redraws and chunk-split sequences parse.
  const oscOut = makeOsc94Filter(
    (event) => reporter.setOsc94(event),
    (text) => splitOut(text)
  );
  const oscErr = makeOsc94Filter(
    (event) => reporter.setOsc94(event),
    (text) => splitErr(text)
  );

  function settle(fn) {
    if (settled) return;
    settled = true;
    removeSignals();
    fn();
  }

  try {
    child = spawn(opts.command[0], opts.command.slice(1), {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    settle(() => {
      reporter.finish('error', err.message);
      process.exitCode = 127;
    });
    return;
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    if (opts.tee) safeWrite(process.stdout, chunk);
    oscOut(chunk, { hasOsc94: false });
  });

  child.stderr.on('data', (chunk) => {
    if (opts.tee) safeWrite(process.stderr, chunk);
    oscErr(chunk, { hasOsc94: false });
  });

  child.on('error', (err) => {
    settle(() => {
      reporter.finish('error', err.message);
      process.exitCode = 127;
    });
  });

  child.on('close', (code, signal) => {
    settle(() => {
      oscOut.flush({ hasOsc94: false });
      oscErr.flush({ hasOsc94: false });
      splitOut.flush();
      splitErr.flush();

      if (signal) {
        reporter.finish('error', `terminated by ${signal}`);
        process.exitCode = 1;
        return;
      }

      if (code === 0) {
        reporter.finish('done', reporter.detail || 'exit 0');
        process.exitCode = 0;
        return;
      }

      const detail = reporter.detail
        ? `exit ${code}: ${reporter.detail}`
        : `exit ${code}`;
      reporter.finish('error', detail);
      process.exitCode = typeof code === 'number' ? code : 1;
    });
  });
}

function runPipedInput(opts, reporter) {
  const removeSignals = installSignalForwarding(() => null, reporter);
  const split = makeLineSplitter((line) => reporter.setLine(line));
  const osc = makeOsc94Filter(
    (event) => reporter.setOsc94(event),
    (text) => split(text)
  );

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    if (opts.tee) safeWrite(process.stdout, chunk);
    osc(chunk, { hasOsc94: false });
  });

  process.stdin.on('error', (err) => {
    removeSignals();
    reporter.finish('error', err.message);
    process.exitCode = 1;
  });

  process.stdin.on('end', () => {
    removeSignals();
    osc.flush({ hasOsc94: false });
    split.flush();
    reporter.finish('done', reporter.detail || 'stdin closed');
    process.exitCode = 0;
  });
}

function main(argv, mode) {
  const resolvedMode = mode || 'relay';

  // Never let a closed pipe (harness cancel, pager quit) crash the relay.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  let opts;

  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`progress-${resolvedMode}: ${err.message}\n\n`);
    printUsage(resolvedMode, process.stderr);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printUsage(resolvedMode);
    return;
  }

  if (!opts.id) {
    process.stderr.write(
      `progress-${resolvedMode}: missing required --id (or PROGRESS_ID)\n\n`
    );
    printUsage(resolvedMode, process.stderr);
    process.exitCode = 2;
    return;
  }

  if (resolvedMode === 'touch') {
    try {
      const ids = opts.ids && opts.ids.length > 0 ? opts.ids : opts.id ? [opts.id] : [];
      const result = touchProgress(ids, opts.detail, opts.stateFile, opts.sessionId);
      for (const entry of result.touched) {
        process.stdout.write(`[${entry.id}] (${entry.status}) ${entry.title} — touched\n`);
      }
      if (result.missing.length > 0) {
        process.stderr.write(`progress-touch: not found: ${result.missing.join(', ')}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = 0;
      }
    } catch (err) {
      process.stderr.write(`progress-touch: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (resolvedMode === 'emit' || opts.once) {
    try {
      process.exitCode = runEmit(opts);
    } catch (err) {
      process.stderr.write(`progress-emit: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!opts.command && process.stdin.isTTY) {
    // A TTY with no command and no stream is usually a request for a
    // one-shot milestone (for example --status running --detail "started").
    const wantsOneShot =
      opts.detail !== null || opts.progress !== null || opts.status !== null;
    if (wantsOneShot) {
      try {
        process.exitCode = runEmit(opts);
      } catch (err) {
        process.stderr.write(`progress-relay: ${err.message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    process.stderr.write(
      'progress-relay: no command and stdin is a TTY.\n' +
        'Provide a command, pipe output, or use --once / progress-emit for a single update.\n\n'
    );
    printUsage(resolvedMode, process.stderr);
    process.exitCode = 2;
    return;
  }

  const reporter = createReporter(opts);
  reporter.start();

  if (opts.command && opts.command.length > 0) {
    runWrappedCommand(opts, reporter);
  } else {
    runPipedInput(opts, reporter);
  }
}

module.exports = {
  main,
  parseArgs,
  parseProgressValue,
  parseProgressLine,
  parseOsc94Progress: (raw) => {
    OSC94_RE.lastIndex = 0;
    const match = OSC94_RE.exec(String(raw));
    if (!match) return null;
    return {
      state: Number.parseInt(match[1], 10),
      progress:
        match[2] !== undefined
          ? Math.max(0, Math.min(1, Number.parseInt(match[2], 10) / 100))
          : null,
    };
  },
  makeOsc94Filter,
  cleanLine,
};
