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
} = require(path.join(OUT, 'say-monitor.cjs'));

const NOW = 1_000_000;

const opts = (overrides = {}) =>
  normalizeSayNudgeOptions({ sayNudge: 'long-tool', ...overrides });

const input = (overrides = {}) => ({
  sessionID: 'ses_test',
  tool: 'bash',
  durationMs: 30_000,
  saidThisTurn: false,
  sayCount: 0,
  sayBudget: 3,
  progressNudgeActive: false,
  now: NOW,
  ...overrides,
});

test('defaults are off, 20s after, 120s cooldown, 1 per turn', () => {
  for (const raw of [undefined, null, {}]) {
    const options = normalizeSayNudgeOptions(raw);
    assert.deepEqual(options, {
      mode: 'off',
      afterMs: 20_000,
      cooldownMs: 120_000,
      maxPerTurn: 1,
    });
  }
});

test('mode only accepts long-tool (or true shorthand); everything else is off', () => {
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'long-tool' }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: true }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ mode: 'long-tool' }).mode, 'long-tool');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'off' }).mode, 'off');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: false }).mode, 'off');
  assert.equal(normalizeSayNudgeOptions({ sayNudge: 'strict' }).mode, 'off');
});

test('numeric options clamp to their floors and reject non-numbers', () => {
  const low = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 0,
    sayNudgeCooldownMs: -5,
    sayNudgeMaxPerTurn: 0,
  });
  assert.equal(low.afterMs, 1_000);
  assert.equal(low.cooldownMs, 0);
  assert.equal(low.maxPerTurn, 1);

  const nan = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 'soon',
    sayNudgeCooldownMs: Number.NaN,
    sayNudgeMaxPerTurn: null,
  });
  assert.equal(nan.afterMs, 20_000);
  assert.equal(nan.cooldownMs, 120_000);
  assert.equal(nan.maxPerTurn, 1);
});

test('numeric options clamp to their ceilings and floor fractions', () => {
  const high = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 10_000_000,
    sayNudgeCooldownMs: 10_000_000,
    sayNudgeMaxPerTurn: 99,
  });
  assert.equal(high.afterMs, 600_000);
  assert.equal(high.cooldownMs, 3_600_000);
  assert.equal(high.maxPerTurn, 3);

  const fractional = normalizeSayNudgeOptions({
    sayNudge: 'long-tool',
    sayNudgeAfterMs: 2_500.9,
    sayNudgeCooldownMs: 1.9,
    sayNudgeMaxPerTurn: 2.9,
  });
  assert.equal(fractional.afterMs, 2_500);
  assert.equal(fractional.cooldownMs, 1);
  assert.equal(fractional.maxPerTurn, 2);
});

test('off wins over every other condition', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ saidThisTurn: true, sayCount: 99, durationMs: 0, progressNudgeActive: true }),
    normalizeSayNudgeOptions({})
  );
  assert.equal(decision.nudge, false);
  assert.equal(decision.reason, 'off');
  assert.equal(decision.message, undefined);
});

test('said wins when a say was accepted this turn', () => {
  const decision = decideSayNudge(
    emptySayNudgeState(),
    input({ saidThisTurn: true, sayCount: 99, durationMs: 0, progressNudgeActive: true }),
    opts()
  );
  assert.deepEqual(decision, { nudge: false, reason: 'said' });
});

test('budget skips at sayCount === sayBudget, not below it', () => {
  const atBudget = decideSayNudge(emptySayNudgeState(), input({ sayCount: 3, sayBudget: 3 }), opts());
  assert.deepEqual(atBudget, { nudge: false, reason: 'budget' });

  const overBudget = decideSayNudge(emptySayNudgeState(), input({ sayCount: 5, sayBudget: 3 }), opts());
  assert.equal(overBudget.reason, 'budget');

  const underBudget = decideSayNudge(emptySayNudgeState(), input({ sayCount: 2, sayBudget: 3 }), opts());
  assert.equal(underBudget.reason, 'accept');
});

test('short skips below afterMs; exactly afterMs accepts', () => {
  const short = decideSayNudge(emptySayNudgeState(), input({ durationMs: 19_999 }), opts());
  assert.deepEqual(short, { nudge: false, reason: 'short' });

  const boundary = decideSayNudge(emptySayNudgeState(), input({ durationMs: 20_000 }), opts());
  assert.equal(boundary.nudge, true);
  assert.equal(boundary.reason, 'accept');
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

test('reasons are evaluated in the documented order', () => {
  const options = opts({ sayNudgeMaxPerTurn: 3 });
  const cooling = { lastNudgeAt: NOW - 1, nudgesThisTurn: 3 };
  const capReached = { lastNudgeAt: NOW - 200_000, nudgesThisTurn: 3 };
  const blocked = input({
    saidThisTurn: true,
    sayCount: 99,
    durationMs: 0,
    progressNudgeActive: true,
  });
  const order = [
    ['off', normalizeSayNudgeOptions({}), cooling, blocked],
    ['said', options, cooling, blocked],
    ['budget', options, cooling, { ...blocked, saidThisTurn: false }],
    ['short', options, cooling, { ...blocked, saidThisTurn: false, sayCount: 0 }],
    ['cooldown', options, cooling, { ...blocked, saidThisTurn: false, sayCount: 0, durationMs: 30_000 }],
    ['cap', options, capReached, { ...blocked, saidThisTurn: false, sayCount: 0, durationMs: 30_000, progressNudgeActive: false }],
    ['progress-nudge', options, emptySayNudgeState(), { ...blocked, saidThisTurn: false, sayCount: 0, durationMs: 30_000 }],
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
