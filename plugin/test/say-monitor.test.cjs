/**
 * Opt-in long-tool `say` nudge tests. say-monitor.ts is TypeScript, so it is
 * transpiled to CJS with esbuild before requiring it (same pattern as
 * monitor.test.cjs / say.test.cjs).
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-say-monitor-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'say-monitor.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'say-monitor.cjs')}`],
  { stdio: 'pipe' }
);
const {
  decideSayNudge,
  emptySayNudgeState,
  normalizeSayNudgeOptions,
  recordSayNudge,
  sayNudgeMessage,
  saySilentRunNudgeMessage,
} = require(path.join(OUT, 'say-monitor.cjs'));

const NOW = 1_000_000;

const opts = (overrides = {}) =>
  normalizeSayNudgeOptions({ sayNudge: 'long-tool', ...overrides });

const input = (overrides = {}) => ({
  sessionID: 'ses_test',
  tool: 'bash',
  durationMs: 30_000,
  callsSinceSay: 0,
  saidThisTurn: false,
  progressNudgeActive: false,
  now: NOW,
  ...overrides,
});

test('defaults are off, 20s after, 3 calls, 120s cooldown, 1 per turn', () => {
  for (const raw of [undefined, null, {}]) {
    const options = normalizeSayNudgeOptions(raw);
    assert.deepEqual(options, {
      mode: 'off',
      afterMs: 20_000,
      minCalls: 3,
      cooldownMs: 120_000,
      maxPerTurn: 1,
    });
  }
});

test('mode accepts long-tool, silent-run, both, and true shorthand; everything else is off', () => {
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'long-tool' }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: true }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ mode: 'long-tool' }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'silent-run' }).mode, 'silent-run');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'both' }).mode, 'both');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'off' }).mode, 'off');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: false }).mode, 'off');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'strict' }).mode, 'off');
});

test('numeric options clamp to their floors and reject non-numbers', () => {
  const low = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 0,
    sayNudgeMinCalls: 0,
    sayNudgeCooldownMs: -5,
    sayNudgeMaxPerTurn: 0,
  });
  assert.equal(low.afterMs, 1_000);
  assert.equal(low.minCalls, 1);
  assert.equal(low.cooldownMs, 0);
  assert.equal(low.maxPerTurn, 1);

  const nan = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 'soon',
    sayNudgeMinCalls: 'many',
    sayNudgeCooldownMs: Number.NaN,
    sayNudgeMaxPerTurn: null,
  });
  assert.equal(nan.afterMs, 20_000);
  assert.equal(nan.minCalls, 3);
  assert.equal(nan.cooldownMs, 120_000);
  assert.equal(nan.maxPerTurn, 1);
});

test('numeric options clamp to their ceilings and floor fractions', () => {
  const high = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 10_000_000,
    sayNudgeMinCalls: 10_000,
    sayNudgeCooldownMs: 10_000_000,
    sayNudgeMaxPerTurn: 99,
  });
  assert.equal(high.afterMs, 600_000);
  assert.equal(high.minCalls, 50);
  assert.equal(high.cooldownMs, 3_600_000);
  assert.equal(high.maxPerTurn, 3);

  const fractional = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 2_500.9,
    sayNudgeMinCalls: 4.9,
    sayNudgeCooldownMs: 1.9,
    sayNudgeMaxPerTurn: 2.9,
  });
  assert.equal(fractional.afterMs, 2_500);
  assert.equal(fractional.minCalls, 4);
  assert.equal(fractional.cooldownMs, 1);
  assert.equal(fractional.maxPerTurn, 2);
});

test('off wins over every other condition', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ saidThisTurn: true, durationMs: 0, progressNudgeActive: true }),
    normalizeSayNudgeOptions({})
  );
  assert.equal(decision.nudge, false);
  assert.equal(decision.reason, 'off');
  assert.equal(decision.message, undefined);
});

test('said wins when a say was accepted this turn', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ saidThisTurn: true, durationMs: 0, progressNudgeActive: true }),
    opts()
  );
  assert.deepEqual(decision, { nudge: false, reason: 'said' });
});

test('note counts never suppress the nudge', () => {
  const decision = decideSayNudge(emptySayNudgeState(), input(), opts());
  assert.equal(decision.nudge, true);
  assert.equal(decision.reason, 'accept');
});

test('short skips below afterMs; exactly afterMs accepts', () => {
  const short = decideSayNudge(emptySayNudgeState(), input({ durationMs: 19_999 }), opts());
  assert.deepEqual(short, { nudge: false, reason: 'short' });

  const boundary = decideSayNudge(emptySayNudgeState(), input({ durationMs: 20_000 }), opts());
  assert.equal(boundary.nudge, true);
  assert.equal(boundary.reason, 'accept');
});

test('long-tool mode ignores the call count entirely', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 20_000, callsSinceSay: 0 }),
    opts()
  );
  assert.equal(decision.reason, 'accept');
});

test('silent-run fires at minCalls and catches quiet quick calls', () => {
  const silent = (overrides = {}) =>
    normalizeSayNudgeOptions({ sayNudge: 'silent-run', ...overrides });

  const below = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 50, callsSinceSay: 2 }),
    silent()
  );
  assert.deepEqual(below, { nudge: false, reason: 'few-calls' });

  const atBoundary = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 50, callsSinceSay: 3 }),
    silent()
  );
  assert.equal(atBoundary.nudge, true);
  assert.equal(atBoundary.reason, 'accept');
  assert.match(atBoundary.message, /tool call 3 in a row/);
  assert.match(atBoundary.message, /post a say/);
});

test('silent-run respects a custom sayNudgeMinCalls', () => {
  const options = normalizeSayNudgeOptions({ sayNudge: 'silent-run', sayNudgeMinCalls: 5 });
  assert.equal(options.minCalls, 5);
  assert.equal(
    decideSayNudge(emptySayNudgeState(), input({ durationMs: 0, callsSinceSay: 4 }), options).reason,
    'few-calls'
  );
  assert.equal(
    decideSayNudge(emptySayNudgeState(), input({ durationMs: 0, callsSinceSay: 5 }), options).reason,
    'accept'
  );
});

test('silent-run never nudges once a note was accepted', () => {
  const options = normalizeSayNudgeOptions({ sayNudge: 'silent-run' });
  const said = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 0, callsSinceSay: 9, saidThisTurn: true }),
    options
  );
  assert.deepEqual(said, { nudge: false, reason: 'said' });
});

test('silent-run still honors cooldown, per-turn cap, and a standing progress nudge', () => {
  const options = normalizeSayNudgeOptions({ sayNudge: 'silent-run' });
  const quiet = input({ durationMs: 0, callsSinceSay: 9 });

  assert.deepEqual(
    decideSayNudge({ lastNudgeAt: NOW - 1, nudgesThisTurn: 0 }, quiet, options),
    { nudge: false, reason: 'cooldown' }
  );
  assert.deepEqual(
    decideSayNudge({ lastNudgeAt: NOW - 200_000, nudgesThisTurn: 1 }, quiet, options),
    { nudge: false, reason: 'cap' }
  );
  assert.deepEqual(
    decideSayNudge(
      emptySayNudgeState(),
      { ...quiet, progressNudgeActive: true },
      options
    ),
    { nudge: false, reason: 'progress-nudge' }
  );
});

test('both mode accepts either trigger and skips only when neither is met', () => {
  const options = normalizeSayNudgeOptions({ sayNudge: 'both' });

  const quietCalls = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 0, callsSinceSay: 3 }),
    options
  );
  assert.equal(quietCalls.reason, 'accept');
  assert.match(quietCalls.message, /tool call 3 in a row/);

  const longCall = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 30_000, callsSinceSay: 1 }),
    options
  );
  assert.equal(longCall.reason, 'accept');
  assert.match(longCall.message, /ran 30s/);

  const both = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 30_000, callsSinceSay: 3 }),
    options
  );
  assert.equal(both.reason, 'accept');
  assert.match(both.message, /ran 30s after 3 tool calls/);

  const neither = decideSayNudge(
    emptySayNudgeState(),
    input({ durationMs: 1_000, callsSinceSay: 2 }),
    options
  );
  assert.deepEqual(neither, { nudge: false, reason: 'few-calls' });
});

test('cooldown blocks inside the window and opens exactly at the boundary', () => {
  const inside = decideSayNudge(
    { lastNudgeAt: NOW - 119_999, nudgesThisTurn: 0 },
    input(),
    opts({ sayNudgeMaxPerTurn: 3 })
  );
  assert.deepEqual(inside, { nudge: false, reason: 'cooldown' });

  const boundary = decideSayNudge(
    { lastNudgeAt: NOW - 120_000, nudgesThisTurn: 0 },
    input(),
    opts({ sayNudgeMaxPerTurn: 3 })
  );
  assert.equal(boundary.reason, 'accept');

  const fresh = decideSayNudge(
    emptySayNudgeState(),
    input({ now: 0, durationMs: 30_000 }),
    opts({ sayNudgeMaxPerTurn: 3 })
  );
  assert.equal(fresh.reason, 'accept', 'lastNudgeAt 0 means never nudged, not epoch-cooldown');
});

test('cap skips once the per-turn limit is reached', () => {
  const capped = decideSayNudge({ lastNudgeAt: 0, nudgesThisTurn: 1 }, input(), opts());
  assert.deepEqual(capped, { nudge: false, reason: 'cap' });

  const room = decideSayNudge(
    { lastNudgeAt: 0, nudgesThisTurn: 1 },
    input(),
    opts({ sayNudgeMaxPerTurn: 2 })
  );
  assert.equal(room.reason, 'accept');
});

test('an active progress nudge suppresses the say nudge', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ progressNudgeActive: true }),
    opts()
  );
  assert.deepEqual(decision, { nudge: false, reason: 'progress-nudge' });
});

test('silent-run reasons are evaluated in the documented order', () => {
  const options = normalizeSayNudgeOptions({ sayNudge: 'silent-run', sayNudgeMaxPerTurn: 3 });
  const quiet = input({ durationMs: 0, callsSinceSay: 3 });
  const order = [
    ['off', normalizeSayNudgeOptions({}), emptySayNudgeState(), { ...quiet, saidThisTurn: true, progressNudgeActive: true }],
    ['said', options, emptySayNudgeState(), { ...quiet, saidThisTurn: true, progressNudgeActive: true }],
    ['few-calls', options, emptySayNudgeState(), { ...quiet, callsSinceSay: 2 }],
    ['cooldown', options, { lastNudgeAt: NOW - 1, nudgesThisTurn: 3 }, quiet],
    ['cap', options, { lastNudgeAt: NOW - 200_000, nudgesThisTurn: 3 }, quiet],
    ['progress-nudge', options, emptySayNudgeState(), { ...quiet, progressNudgeActive: true }],
    ['accept', options, emptySayNudgeState(), quiet],
  ];

  for (const [expected, optionsForStep, state, stepInput] of order) {
    const decision = decideSayNudge(state, stepInput, optionsForStep);
    assert.equal(decision.reason, expected, `expected ${expected}, got ${decision.reason}`);
  }
});

test('reasons are evaluated in the documented order', () => {
  const options = opts({ sayNudgeMaxPerTurn: 3 });
  const cooling = { lastNudgeAt: NOW - 1, nudgesThisTurn: 3 };
  const capReached = { lastNudgeAt: NOW - 200_000, nudgesThisTurn: 3 };
  const blocked = input({
    saidThisTurn: true,
    durationMs: 0,
    progressNudgeActive: true,
  });
  const order = [
    ['off', normalizeSayNudgeOptions({}), cooling, blocked],
    ['said', options, cooling, blocked],
    ['short', options, cooling, { ...blocked, saidThisTurn: false }],
    ['cooldown', options, cooling, { ...blocked, saidThisTurn: false, durationMs: 30_000 }],
    ['cap', options, capReached, { ...blocked, saidThisTurn: false, durationMs: 30_000, progressNudgeActive: false }],
    ['progress-nudge', options, emptySayNudgeState(), { ...blocked, saidThisTurn: false, durationMs: 30_000 }],
    ['accept', options, emptySayNudgeState(), input()],
  ];

  for (const [expected, optionsForStep, state, stepInput] of order) {
    const decision = decideSayNudge(state, stepInput, optionsForStep);
    assert.equal(decision.reason, expected, `expected ${expected}, got ${decision.reason}`);
  }
});

test('accepted message names the tool and seconds, stays under 260 chars', () => {
  const decision = decideSayNudge(emptySayNudgeState(), input({ tool: 'bash', durationMs: 21_000 }), opts());
  assert.equal(decision.nudge, true);
  assert.match(decision.message, /bash/);
  assert.match(decision.message, /\b21s\b/);
  assert.match(decision.message, /post a say/);
  assert.ok(decision.message.length < 260, `message too long: ${decision.message.length}`);
  assert.ok(!decision.message.includes('!'), 'no scolding');
});

test('message keeps fractional seconds compact and truncates long tool names', () => {
  assert.match(sayNudgeMessage('bash', 20_500), /\b20\.5s\b/);
  assert.match(sayNudgeMessage('bash', 30_000), /\b30s\b/);

  const long = sayNudgeMessage('x'.repeat(400), 60_000);
  assert.ok(long.length < 260, `message too long: ${long.length}`);
  assert.ok(long.includes('…'));
  assert.equal(sayNudgeMessage('   ', 5_000).includes(' tool call ran '), true);
});

test('recordSayNudge increments the turn count, stamps the clock, and stays pure', () => {
  const state = { lastNudgeAt: 0, nudgesThisTurn: 0 };
  const first = recordSayNudge(state, NOW);
  assert.deepEqual(first, { lastNudgeAt: NOW, nudgesThisTurn: 1 });
  assert.deepEqual(state, { lastNudgeAt: 0, nudgesThisTurn: 0 }, 'input must not be mutated');

  const second = recordSayNudge(first, NOW + 5_000);
  assert.deepEqual(second, { lastNudgeAt: NOW + 5_000, nudgesThisTurn: 2 });
  assert.equal(first.nudgesThisTurn, 1);
});

test('a fresh state resets the per-turn cap while the cooldown clock survives', () => {
  const nudged = recordSayNudge(emptySayNudgeState(), NOW);
  const sameTurn = { ...nudged, lastNudgeAt: NOW - 200_000 };
  assert.equal(
    decideSayNudge(sameTurn, input(), opts()).reason,
    'cap',
    'same turn, past cooldown: cap'
  );

  const nextTurn = { ...nudged, nudgesThisTurn: 0 };
  assert.equal(
    decideSayNudge(nextTurn, input({ now: NOW + 1_000 }), opts()).reason,
    'cooldown',
    'new turn: cooldown still applies'
  );
  assert.equal(
    decideSayNudge(nextTurn, input({ now: NOW + 120_000 }), opts()).reason,
    'accept'
  );
});

test('decideSayNudge never mutates the state it reads', () => {
  const state = { lastNudgeAt: NOW - 200_000, nudgesThisTurn: 0 };
  const snapshot = { ...state };
  decideSayNudge(state, input(), opts());
  assert.deepEqual(state, snapshot);
});
