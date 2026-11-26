/**
 * Strict-mode monitor decision tests. monitor.ts is TypeScript, so it is
 * transpiled to CJS with esbuild before requiring it.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-monitor-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'monitor.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'monitor.cjs')}`],
  { stdio: 'pipe' }
);
const {
  observeToolCall,
  normalizeStrictMode,
  normalizeStaleAfterMs,
  normalizeStaleCooldownMs,
  normalizeStaleEscalateAfter,
  normalizeWallClockMs,
  silentRunNudge,
  staleProgressNudge,
  staleProgressEscalation,
  idleReminder,
  wallClockNudge,
  relayCommandPattern,
  relayHintFor,
  relayHintMessage,
  relayPatternHintMessage,
} = require(path.join(OUT, 'monitor.cjs'));

const idle = () => ({
  count: 0,
  callsSinceProgress: 0,
  nudged: false,
  forced: false,
  lastStaleNudgeAt: 0,
  staleNudges: 0,
  escalated: false,
  nudgedAt: 0,
});

/** Copy the fields observeToolCall owns back onto the mutable monitor. */
const apply = (monitor, step) => {
  monitor.count = step.count;
  monitor.callsSinceProgress = step.callsSinceProgress;
  monitor.lastStaleNudgeAt = step.lastStaleNudgeAt;
  monitor.staleNudges = step.staleNudges;
  monitor.escalated = step.escalated;
  monitor.nudgedAt = step.nudgedAt;
  if (step.action === 'nudge' || step.action === 'force' || step.action === 'stale-nudge' || step.action === 'stale-escalate') {
    monitor.nudged = true;
  }
  if (step.action === 'force') monitor.forced = true;
  if (step.action === 'clear') monitor.nudged = false;
  return step;
};

test('off disables everything', () => {
  const step = observeToolCall(idle(), { isProgressCall: false, hasActive: false }, { strictMode: 'off' });
  assert.equal(step.action, 'none');
  assert.equal(step.count, 0);
});

test('silent-run: nudges at the threshold, once, then clears on a progress call', () => {
  const monitor = idle();
  const opts = { strictMode: 'nudge', threshold: 3 };
  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none');
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none');
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'nudge');
  monitor.count = step.count;
  monitor.nudged = true;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none', 'does not re-nudge while standing');

  step = observeToolCall(monitor, { isProgressCall: true, hasActive: true }, opts);
  assert.equal(step.action, 'clear', 'compliance clears the standing nudge');
});

test('force fires once, then softens to nudge', () => {
  const monitor = idle();
  const opts = { strictMode: 'force', threshold: 2 };
  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'force');
  monitor.count = step.count;
  monitor.nudged = true;
  monitor.forced = true;

  // Compliance clears the standing nudge…
  step = observeToolCall(monitor, { isProgressCall: true, hasActive: true }, opts);
  assert.equal(step.action, 'clear');
  monitor.nudged = false;
  monitor.count = 0;

  // …but force does not repeat in the same monitor lifetime:
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'nudge', 'forced already used → soft nudge');
});

test('stale-progress: needs pending tasks, elapsed time, and calls since progress', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, cooldownMs: 2 * 60 * 1000, staleMinCalls: 3 };
  const monitor = idle();
  const lastProgressAt = now - 10 * 60 * 1000; // 10 minutes ago

  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now }, opts);
  assert.equal(step.action, 'none', 'first call: only 1 call since progress');
  monitor.callsSinceProgress = step.callsSinceProgress;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 1000 }, opts);
  assert.equal(step.action, 'none');
  monitor.callsSinceProgress = step.callsSinceProgress;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 2000 }, opts);
  assert.equal(step.action, 'stale-nudge');
  monitor.lastStaleNudgeAt = step.lastStaleNudgeAt;

  // Within cooldown: quiet.
  step = observeToolCall(
    { ...monitor, nudged: true },
    { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 30_000 },
    opts
  );
  assert.equal(step.action, 'none');

  // After cooldown: nudge again.
  step = observeToolCall(
    { ...monitor, nudged: true },
    { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 4 * 60 * 1000 },
    opts
  );
  assert.equal(step.action, 'stale-nudge');
});

test('stale-progress: escalates to a synthetic action after N entry reminders, once per stretch', () => {
  const now = 1_000_000_000;
  const opts = {
    strictMode: 'nudge',
    staleAfterMs: 5 * 60 * 1000,
    staleMinCalls: 1,
    cooldownMs: 60_000,
    staleEscalateAfter: 3,
  };
  const monitor = idle();
  const lastProgressAt = now - 10 * 60 * 1000;
  const input = (t) => ({ isProgressCall: false, hasActive: true, lastProgressAt, now: t });

  // Reminders 1–3 stay soft (instructions entry).
  for (let i = 1; i <= 3; i += 1) {
    const step = apply(monitor, observeToolCall(monitor, input(now + i * 60_000), opts));
    assert.equal(step.action, 'stale-nudge', `reminder ${i} is an entry nudge`);
    assert.equal(step.staleNudges, i);
    assert.equal(step.escalated, false);
  }

  // Reminder 4 escalates exactly once.
  let step = apply(monitor, observeToolCall(monitor, input(now + 4 * 60_000), opts));
  assert.equal(step.action, 'stale-escalate');
  assert.equal(step.staleNudges, 4);
  assert.equal(step.escalated, true);

  // No escalation loop: later reminders return to the standing entry.
  step = apply(monitor, observeToolCall(monitor, input(now + 5 * 60_000), opts));
  assert.equal(step.action, 'stale-nudge');
  assert.equal(step.escalated, true);

  // Any real progress write resets the ladder and clears the nudge.
  step = apply(
    monitor,
    observeToolCall(monitor, { isProgressCall: true, hasActive: true, now: now + 6 * 60_000 }, opts)
  );
  assert.equal(step.action, 'clear');
  assert.equal(step.staleNudges, 0);
  assert.equal(step.escalated, false);
  assert.equal(step.nudgedAt, 0);
});

test('stale-progress: staleEscalateAfter 0 disables escalation; 1 escalates on the second reminder', () => {
  const now = 1_000_000_000;
  const base = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, staleMinCalls: 1, cooldownMs: 0 };
  const input = (t) => ({ isProgressCall: false, hasActive: true, lastProgressAt: now - 10 * 60_000, now: t });

  const off = idle();
  for (let i = 0; i < 8; i += 1) {
    const step = apply(off, observeToolCall(off, input(now + i * 1000), { ...base, staleEscalateAfter: 0 }));
    assert.equal(step.action, 'stale-nudge', 'escalation disabled');
  }

  const early = idle();
  let step = apply(early, observeToolCall(early, input(now), { ...base, staleEscalateAfter: 1 }));
  assert.equal(step.action, 'stale-nudge', 'first reminder is always soft');
  step = apply(early, observeToolCall(early, input(now + 1000), { ...base, staleEscalateAfter: 1 }));
  assert.equal(step.action, 'stale-escalate', 'second reminder escalates');
});

test('relay activity (progressAdvanced) resets the stale counter and escalation ladder', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, staleMinCalls: 3 };
  const monitor = { ...idle(), callsSinceProgress: 5, staleNudges: 4, escalated: true };
  const step = observeToolCall(
    monitor,
    { isProgressCall: false, hasActive: true, lastProgressAt: now - 10 * 60 * 1000, progressAdvanced: true, now },
    opts
  );
  assert.equal(step.action, 'none');
  assert.equal(step.callsSinceProgress, 0);
  assert.equal(step.staleNudges, 0);
  assert.equal(step.escalated, false);
});

test('recent progress activity never nudges', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, staleMinCalls: 1 };
  const step = observeToolCall(
    { ...idle(), callsSinceProgress: 9 },
    { isProgressCall: false, hasActive: true, lastProgressAt: now - 10_000, now },
    opts
  );
  assert.equal(step.action, 'none');
});

test('idle reminder: fresh relay ticks are excluded (only stale entries nag)', () => {
  const now = 1_000_000_000;
  const entries = [
    { id: 'live', status: 'running', updatedAt: now - 2000 }, // relay ticking
    { id: 'stale', status: 'running', updatedAt: now - 10 * 60_000 },
    { id: 'unknown', status: 'waiting' },
  ];
  const decision = idleReminder({ signature: '', lastAt: 0, count: 0 }, entries, { now, staleAfterMs: 60_000 });
  assert.equal(decision.action, 'remind');
  assert.match(decision.message, /stale \(running, 10m\)/);
  assert.match(decision.message, /unknown \(waiting, unknown\)/);
  assert.doesNotMatch(decision.message, /live \(running\)/);
});

test('idle reminder: only fresh entries → silent', () => {
  const now = 1_000_000_000;
  const decision = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [{ id: 'live', status: 'running', updatedAt: now - 1000 }],
    { now }
  );
  assert.equal(decision.action, 'none');
});

test('wall-clock: dormant sessions are never nudged (provider-queue stalls)', () => {
  const now = 1_000_000_000;
  const stale = now - 20 * 60 * 1000;
  // Last tool call 20 minutes ago → dormant, even with pending tasks.
  assert.equal(
    wallClockNudge(
      { lastAt: 0 },
      { hasActive: true, lastProgressAt: stale, lastToolCallAt: stale, now },
      { thresholdMs: 120_000 }
    ).action,
    'none'
  );
  // No tool call ever recorded → dormant.
  assert.equal(
    wallClockNudge({ lastAt: 0 }, { hasActive: true, lastProgressAt: stale, now }, { thresholdMs: 120_000 }).action,
    'none'
  );
  // Active within the window → reminds.
  assert.equal(
    wallClockNudge(
      { lastAt: 0 },
      { hasActive: true, lastProgressAt: stale, lastToolCallAt: now - 60_000, now },
      { thresholdMs: 120_000 }
    ).action,
    'remind'
  );
});

test('wall-clock: streak caps reminders per non-progress stretch', () => {
  const now = 1_000_000_000;
  const opts = { thresholdMs: 120_000, cooldownMs: 0, maxStreak: 2 };
  const input = { hasActive: true, lastProgressAt: now - 10 * 60 * 1000, lastToolCallAt: now - 60_000, now };
  assert.equal(wallClockNudge({ lastAt: 0, streak: 0 }, input, opts).action, 'remind');
  assert.equal(wallClockNudge({ lastAt: 0, streak: 2 }, input, opts).action, 'none', 'capped');
  assert.equal(
    wallClockNudge({ lastAt: 0, streak: 2 }, input, { ...opts, maxStreak: 0 }).action,
    'remind',
    '0 = uncapped'
  );
});

test('relay hint: detects long commands, skips relays and quick commands', () => {
  assert.equal(relayHintFor('npm test'), 'npm test');
  assert.equal(relayHintFor('npx vite build'), 'npx vite build');
  assert.equal(relayHintFor('pytest -q'), 'pytest -q');
  assert.equal(relayHintFor('cargo test --release'), 'cargo test --release');
  assert.equal(relayHintFor('npm test | progress-relay --id t1'), null, 'already relayed');
  assert.equal(relayHintFor('progress-relay --id b1 -- make'), null, 'already relayed');
  assert.equal(
    relayHintFor('cd /repo && node ../mcp-server/index.js relay --id b1 -- npm test'),
    null,
    'bundled relay invocation is already relayed'
  );
  assert.equal(relayHintFor('git status'), null);
  assert.equal(relayHintFor('git commit -m "fix npm test"'), null, 'git commit messages mention commands in prose');
  assert.equal(relayHintFor('ls -la'), null);
  assert.equal(relayHintFor(''), null);
  assert.equal(
    relayHintFor("python3 - <<'PY'\nprint('npm run build')\nPY"),
    null,
    'heredoc bodies are script text, not the command to relay'
  );
  assert.equal(relayHintFor('node -e "require(\'child_process\').execSync(\'npm test\')"'), null);

  assert.match(relayHintMessage('npm test'), /progress-relay --id <id> -- npm test/);
  assert.match(relayHintMessage('npm test'), /^Long command/);
  assert.match(relayHintMessage('npm test'), /Exit code maps to done\/error/);
});

test('normalizers and message texts', () => {
  assert.equal(normalizeStrictMode({ strictMode: 'force' }), 'force');
  assert.equal(normalizeStrictMode({ strictMode: 'off' }), 'off');
  assert.equal(normalizeStrictMode({}), 'nudge');
  assert.equal(normalizeStaleAfterMs({ staleAfterMs: 10_000 }), 5 * 60 * 1000, 'below floor → default');
  assert.equal(normalizeStaleAfterMs({ staleAfterMs: 120_000 }), 120_000);
  assert.equal(normalizeStaleCooldownMs({}), 2 * 60 * 1000);
  assert.equal(normalizeStaleCooldownMs({ cooldownMs: 45_000 }), 45_000);
  assert.equal(normalizeStaleCooldownMs({ cooldownMs: 5_000 }), 2 * 60 * 1000, 'below floor → default');
  assert.equal(normalizeStaleEscalateAfter({}), 3, 'default is three entry chances');
  assert.equal(normalizeStaleEscalateAfter({ staleEscalateAfter: 0 }), 0, '0 disables escalation');
  assert.equal(normalizeStaleEscalateAfter({ staleEscalateAfter: 1 }), 1);
  assert.equal(normalizeStaleEscalateAfter({ staleEscalateAfter: 2.8 }), 2);
  assert.equal(normalizeStaleEscalateAfter({ staleEscalateAfter: -1 }), 3, 'invalid → default');
  assert.equal(normalizeStaleEscalateAfter({ staleEscalateAfter: 999 }), 50, 'capped');

  assert.match(silentRunNudge(4), /^\[warn\] /);
  assert.match(silentRunNudge(4), /4 steps with no progress entry/);
  assert.match(silentRunNudge(1), /1 step with no progress entry/);
  assert.match(staleProgressNudge(7), /^\[warn\] /);
  assert.match(staleProgressNudge(7), /7 steps without a progress change/);
  assert.doesNotMatch(staleProgressNudge(7), /any updates\?/);
  assert.match(staleProgressNudge(7), /update detail\/progress or close it/);
  const target = { id: 'wr03', status: 'running', ageMs: 12 * 60_000 };
  assert.match(staleProgressNudge(7, target), /wr03 running 12m/);
  assert.match(staleProgressNudge(7, target), /update detail\/progress or close it/);
  assert.match(staleProgressEscalation(20, 4), /^\[block\] /);
  assert.match(staleProgressEscalation(20, 4), /progress reminder #4/);
  assert.match(staleProgressEscalation(20, 4), /tree unchanged after 20 steps/);
});

test('idle reminder: fires for open entries, skips dismissed/closed, names them', () => {
  const now = 1_000_000_000;
  const entries = [
    { id: 'build', status: 'running' },
    { id: 'docs', status: 'waiting' },
    { id: 'closed', status: 'done' },
    { id: 'muted', status: 'running', dismissed: { at: 1 } },
  ];
  const decision = idleReminder({ signature: '', lastAt: 0, count: 0 }, entries, { now });
  assert.equal(decision.action, 'remind');
  assert.match(decision.message, /^\[block\] turn ending with 2 stale\/error own tasks/);
  assert.match(decision.message, /build \(running, unknown\)/);
  assert.match(decision.message, /docs \(waiting, unknown\)/);
  assert.doesNotMatch(decision.message, /closed/);
  assert.doesNotMatch(decision.message, /muted/);
});

test('idle reminder: ignores child-owned work, blocked parents, and fresh entries', () => {
  const now = 1_000_000_000;
  const stale = now - 20 * 60_000;
  const fresh = now - 2 * 60_000;
  const entries = [
    { id: 'own', status: 'running', updatedAt: stale },
    { id: 'sub', status: 'running', updatedAt: stale, subagent: true },
    { id: 'parent', status: 'running', updatedAt: stale },
    { id: 'child', status: 'running', updatedAt: fresh, parentId: 'parent' },
    { id: 'failed', status: 'error', updatedAt: fresh },
    { id: 'young', status: 'running', updatedAt: now - 6 * 60_000 },
  ];
  const decision = idleReminder({ signature: '', lastAt: 0, count: 0 }, entries, { now });
  assert.equal(decision.action, 'remind');
  assert.match(decision.message, /turn ending with 2 stale\/error own tasks/);
  assert.match(decision.message, /own \(running, 20m\)/);
  assert.match(decision.message, /failed \(error, 2m\)/);
  assert.doesNotMatch(decision.message, /\((sub|parent|child|young),/);
  assert.match(decision.message, /1 child-owned/);
  assert.match(decision.message, /1 blocked on children/);
});

test('idle reminder: old terminal errors are history, not nagging material', () => {
  const now = 1_000_000_000;
  const oldError = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [{ id: 'old-failure', status: 'error', updatedAt: now - 2 * 60 * 60_000 }],
    { now }
  );
  assert.equal(oldError.action, 'none');

  const recentError = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [{ id: 'fresh-failure', status: 'error', updatedAt: now - 5 * 60_000 }],
    { now }
  );
  assert.equal(recentError.action, 'remind');
  assert.match(recentError.message, /fresh-failure \(error, 5m\)/);
});

test('idle reminder: 6m without progress is not stale (10m default)', () => {
  const now = 1_000_000_000;
  const decision = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [{ id: 'building', status: 'running', updatedAt: now - 6 * 60_000 }],
    { now }
  );
  assert.equal(decision.action, 'none');
});

test('relay patterns: stable per command shape, one hint per pattern', () => {
  assert.equal(relayCommandPattern('export JAVA_HOME=/opt/jdk gradlew assembleDebug'), 'gradlew assembleDebug');
  assert.equal(relayCommandPattern('cd /repo && ./gradlew assembleDebug'), 'gradlew assembleDebug');
  assert.equal(relayCommandPattern('npm test'), 'npm test');
  assert.equal(relayCommandPattern('npm test | progress-relay --id t1'), null);
  assert.equal(relayCommandPattern('git status'), null);
  assert.notEqual(
    relayCommandPattern('gradlew assembleDebug'),
    relayCommandPattern('gradlew test')
  );
  const message = relayPatternHintMessage('gradlew assembleDebug', 3, 'gradlew assembleDebug');
  assert.match(message, /Repeating long command \(3×\)/);
  assert.match(message, /progress-relay --id <id>/);
});

test('idle reminder: no open entries → silent', () => {
  const decision = idleReminder({ signature: '', lastAt: 0, count: 0 }, [{ id: 'done', status: 'done' }]);
  assert.equal(decision.action, 'none');
});

test('idle reminder: same signature is throttled and capped; changed signature resets', () => {
  const now = 1_000_000_000;
  const entries = [{ id: 'a', status: 'running' }];
  const tracker = { signature: '', lastAt: 0, count: 0 };

  let d = idleReminder(tracker, entries, { now, cooldownMs: 60_000, maxPerRun: 2 });
  assert.equal(d.action, 'remind');
  tracker.signature = d.signature;
  tracker.lastAt = d.lastAt;
  tracker.count = d.count;

  // Immediately idle again with the same open entry: throttled.
  d = idleReminder(tracker, entries, { now: now + 1000, cooldownMs: 60_000, maxPerRun: 2 });
  assert.equal(d.action, 'none');

  // After cooldown: second reminder.
  d = idleReminder(tracker, entries, { now: now + 61_000, cooldownMs: 60_000, maxPerRun: 2 });
  assert.equal(d.action, 'remind');
  tracker.lastAt = d.lastAt;
  tracker.count = d.count;

  // Cap reached for this signature: silent even after cooldown.
  d = idleReminder(tracker, entries, { now: now + 10 * 60_000, cooldownMs: 60_000, maxPerRun: 2 });
  assert.equal(d.action, 'none', 'per-run cap suppresses repeats for the same signature');

  // A changed set of open entries resets the run and reminds again.
  d = idleReminder(tracker, [...entries, { id: 'b', status: 'waiting' }], {
    now: now + 10 * 60_000,
    cooldownMs: 60_000,
    maxPerRun: 2,
  });
  assert.equal(d.action, 'remind');
  assert.equal(d.count, 1);
});

test('wall-clock: fires only with open tasks, after the threshold, with cooldown', () => {
  const now = 1_000_000_000;
  const lastProgressAt = now - 20 * 60 * 1000;
  const active = { lastToolCallAt: now - 60_000 };
  const opts = { thresholdMs: 120_000 };

  assert.equal(
    wallClockNudge({ lastAt: 0 }, { hasActive: false, lastProgressAt, ...active, now }, opts).action,
    'none'
  );
  assert.equal(
    wallClockNudge(
      { lastAt: 0 },
      { hasActive: true, lastProgressAt: now - 60_000, ...active, now },
      opts
    ).action,
    'none',
    'fresh progress → no nudge'
  );

  const decision = wallClockNudge(
    { lastAt: 0 },
    { hasActive: true, lastProgressAt, ...active, now },
    opts
  );
  assert.equal(decision.action, 'remind');
  assert.match(decision.message, /^\[warn\] no progress for 20m/);
  assert.match(decision.message, /update detail\/progress or close it/);
  assert.match(decision.message, /relay/);

  assert.equal(
    wallClockNudge(
      { lastAt: decision.lastAt },
      { hasActive: true, lastProgressAt, ...active, now: now + 60_000 },
      opts
    ).action,
    'none',
    'cooldown suppresses repeats'
  );
  assert.equal(
    wallClockNudge(
      { lastAt: decision.lastAt },
      { hasActive: true, lastProgressAt, ...active, now: now + 3 * 60 * 1000 },
      opts
    ).action,
    'remind',
    'reminds again after the cooldown'
  );
});
test('wall-clock: threshold 0 disables; normalizer defaults to 120s and floors at 60s', () => {
  assert.equal(
    wallClockNudge({ lastAt: 0 }, { hasActive: true, lastProgressAt: 0, now: 10 ** 12 }, { thresholdMs: 0 }).action,
    'none'
  );
  assert.equal(normalizeWallClockMs({}), 10 * 60 * 1000);
  assert.equal(normalizeWallClockMs({ wallClockMs: 0 }), 0);
  assert.equal(normalizeWallClockMs({ wallClockMs: 5_000 }), 10 * 60 * 1000, 'below floor → default');
  assert.equal(normalizeWallClockMs({ wallClockMs: 120_000 }), 120_000);
});
