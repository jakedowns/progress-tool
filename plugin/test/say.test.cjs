/**
 * Experimental `say` tool tests. say.ts is TypeScript, so it is transpiled to
 * CJS with esbuild before requiring it (same pattern as monitor.test.cjs).
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-say-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'say.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'say.cjs')}`],
  { stdio: 'pipe' }
);
const {
  clampSayText,
  createSayController,
  decideSay,
  emptySayState,
  guiSaySurfaces,
  normalizeSayModes,
  normalizeSayOptions,
  normalizeSayText,
  sayEnabled,
  sayResultMessage,
  sayToolDescription,
  tuiSaySurfaces,
  visibleSayNotes,
  normalizeSayToastScope,
  sayToastDurationMs,
  sayToastNotes,
  SAY_TOAST_DURATION_MS,
  SAY_WARNING_TOAST_DURATION_MS,
} = require(path.join(OUT, 'say.cjs'));

const enabled = (overrides = {}) =>
  normalizeSayOptions({ say: true, ...overrides });

test('say is opt-in and defaults are 180-260, 3 per turn, 15s cooldown', () => {
  assert.equal(sayEnabled({}), false);
  assert.equal(sayEnabled({ say: false }), false);
  assert.equal(sayEnabled({ say: true }), true);

  const options = enabled();
  assert.equal(options.minChars, 180);
  assert.equal(options.maxChars, 260);
  assert.equal(options.budgetPerTurn, 3);
  assert.equal(options.cooldownMs, 15_000);
  assert.equal(options.chatNotes, true);
  assert.equal(options.finalGuard, true);
  assert.deepEqual(options.modes, ['tree']);
  assert.equal(options.autoHideTimeoutMs, 60_000);
});

test('sayAutoHideTimeoutMs defaults to 60s and clamps to 0..24h', () => {
  assert.equal(enabled().autoHideTimeoutMs, 60_000);
  assert.equal(
    normalizeSayOptions({ say: true, sayAutoHideTimeoutMs: 0 }).autoHideTimeoutMs,
    0
  );
  assert.equal(
    normalizeSayOptions({ say: true, sayAutoHideTimeoutMs: -5 }).autoHideTimeoutMs,
    0
  );
  assert.equal(
    normalizeSayOptions({ say: true, sayAutoHideTimeoutMs: 86_400_001 })
      .autoHideTimeoutMs,
    86_400_000
  );
  assert.equal(
    normalizeSayOptions({ say: true, sayAutoHideTimeoutMs: 1234.9 })
      .autoHideTimeoutMs,
    1234
  );
  assert.equal(
    normalizeSayOptions({ say: true, sayAutoHideTimeoutMs: 'nope' })
      .autoHideTimeoutMs,
    60_000
  );
});

test('visibleSayNotes hides at the exact boundary and keeps 0 always visible', () => {
  const notes = [
    { id: 'at-timeout', at: 1_000 },
    { id: 'still-visible', at: 1_001 },
  ];
  assert.deepEqual(
    visibleSayNotes(notes, 61_000, 60_000).map((note) => note.id),
    ['still-visible'],
    'now - at === timeout is hidden'
  );
  assert.deepEqual(
    visibleSayNotes(notes, 60_999, 60_000).map((note) => note.id),
    ['at-timeout', 'still-visible'],
    'order is preserved and one millisecond earlier is visible'
  );
  assert.deepEqual(
    visibleSayNotes(notes, 999_999, 0).map((note) => note.id),
    ['at-timeout', 'still-visible'],
    '0 disables auto-hide'
  );
  assert.deepEqual(visibleSayNotes(undefined, 1, 60_000), []);
});

test('sayModes defaults to tree and accepts scalar, alias, dedupe, and empty', () => {
  assert.deepEqual(normalizeSayOptions({ say: true }).modes, ['tree']);
  assert.deepEqual(normalizeSayModes(undefined), ['tree']);
  assert.deepEqual(normalizeSayModes('pill'), ['pill']);
  assert.deepEqual(normalizeSayModes(['toast', 'pill', 'toast', 'nope']), [
    'toast',
    'pill',
  ]);
  assert.deepEqual(normalizeSayModes('nope'), [], 'an explicit unknown value drops to none');
  assert.deepEqual(normalizeSayModes([]), [], 'an explicit empty array is allowed');
  assert.deepEqual(normalizeSayOptions({ sayModes: [] }).modes, []);
  assert.deepEqual(normalizeSayOptions({ sayMode: 'toast' }).modes, ['toast']);
  assert.deepEqual(
    normalizeSayOptions({ sayModes: ['tree'], sayMode: 'pill' }).modes,
    ['tree'],
    'sayModes wins over the scalar alias'
  );
  assert.deepEqual(
    normalizeSayOptions({ sayModes: null, sayMode: 'pill' }).modes,
    ['pill'],
    'a null sayModes falls back to the alias'
  );
});

test('TUI surfaces fold pill into the tree line and dedupe with tree', () => {
  assert.deepEqual(tuiSaySurfaces(['tree']), { line: true, toast: false });
  assert.deepEqual(tuiSaySurfaces(['pill']), { line: true, toast: false });
  assert.deepEqual(tuiSaySurfaces(['pill', 'tree']), { line: true, toast: false });
  assert.deepEqual(tuiSaySurfaces(['pill', 'toast', 'tree']), {
    line: true,
    toast: true,
  });
  assert.deepEqual(tuiSaySurfaces([]), { line: false, toast: false });
});

test('GUI surfaces fall back from tree to the pill in composer layout', () => {
  assert.deepEqual(guiSaySurfaces(['tree'], 'composer'), {
    pill: true,
    line: true,
    toast: false,
  });
  assert.deepEqual(guiSaySurfaces(['tree'], 'sidebar'), {
    pill: false,
    line: true,
    toast: false,
  });
  assert.deepEqual(guiSaySurfaces(['pill'], 'sidebar'), {
    pill: true,
    line: false,
    toast: false,
  });
  assert.deepEqual(guiSaySurfaces(['toast'], 'composer'), {
    pill: false,
    line: false,
    toast: true,
  });
  assert.deepEqual(guiSaySurfaces([], 'composer'), {
    pill: false,
    line: false,
    toast: false,
  });
});

test('option clamping keeps min <= max and bounds every numeric field', () => {
  const options = normalizeSayOptions({
    say: true,
    sayMinChars: 5,
    sayMaxChars: 5000,
    sayBudgetPerTurn: 99,
    sayCooldownMs: -1,
  });
  assert.equal(options.minChars, 20);
  assert.equal(options.maxChars, 600);
  assert.equal(options.budgetPerTurn, 10);
  assert.equal(options.cooldownMs, 0);

  const narrow = normalizeSayOptions({ say: true, sayMinChars: 20, sayMaxChars: 80 });
  assert.equal(narrow.minChars, 20, '20 is the widened lower bound');
  assert.equal(narrow.maxChars, 80);

  const inverted = normalizeSayOptions({ say: true, sayMinChars: 400, sayMaxChars: 200 });
  assert.equal(inverted.maxChars, 400);
});

test('text is normalized to one line', () => {
  assert.equal(normalizeSayText('  checking\n\n the   tests  '), 'checking the tests');
  assert.equal(normalizeSayText(undefined), '');
});

test('clampSayText still caps at a word boundary for explicit callers', () => {
  const text = 'word '.repeat(100).trim();
  const clamped = clampSayText(text, 40);
  assert.ok(clamped.length <= 40, `expected <= 40, got ${clamped.length}`);
  assert.ok(clamped.endsWith('…'));
  assert.ok(!clamped.includes('  '));
});

test('under-min notes are accepted with a warning', () => {
  const options = enabled();
  const { state, decision } = decideSay(emptySayState(), {
    text: 'short note',
    now: 1_000,
    options,
  });
  assert.equal(decision.accept, true);
  assert.match(decision.warning, /shorter than the preferred 180 chars/);
  assert.equal(state.count, 1);
  assert.equal(state.accepted, true);
});

test('over-max notes are accepted unchanged and warned', () => {
  const options = enabled({ sayMinChars: 80, sayMaxChars: 100 });
  const text = 'x '.repeat(200);
  const { decision } = decideSay(emptySayState(), {
    text,
    now: 1_000,
    options,
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.text, text.trim(), 'the note text is never shortened');
  assert.match(
    decision.warning,
    /Heads-up: that note was longer than the preferred 100 chars; aim for 80–100 next time\./
  );
});

test('budget and cooldown no longer reject notes', () => {
  const options = enabled({ sayBudgetPerTurn: 1, sayCooldownMs: 15_000 });
  let state = emptySayState();
  for (const [index, text] of ['first note', 'second note', 'third note'].entries()) {
    const result = decideSay(state, { text, now: 1_000 + index * 100, options });
    assert.equal(result.decision.accept, true, result.decision.reason);
    state = result.state;
  }
  assert.equal(state.count, 3);
});

test('repeating the same note consecutively is skipped as duplicate', () => {
  const options = enabled();
  const first = decideSay(emptySayState(), { text: 'same note', now: 1_000, options });
  const second = decideSay(first.state, { text: 'same note', now: 2_000, options });
  assert.equal(second.decision.accept, false);
  assert.equal(second.decision.reason, 'duplicate');
});

test('empty notes are skipped, not accepted', () => {
  const { decision } = decideSay(emptySayState(), {
    text: '   \n  ',
    now: 1_000,
    options: enabled(),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'empty');
});

test('accepted result tells the model to keep working and not conclude', () => {
  const message = sayResultMessage({ accept: true, text: 'note' });
  assert.match(message, /Continue working/);
  assert.match(message, /not the final answer/);
});

test('tool schema has no text.maxLength so the host cannot reject long notes', () => {
  const controller = createSayController(enabled({ sayMinChars: 20, sayMaxChars: 80 }));
  const text = controller.tool.input.properties.text;
  assert.equal(text.type, 'string');
  assert.equal('maxLength' in text, false);
  assert.match(text.description, /20–80 chars preferred/);
  assert.match(text.description, /longer notes are accepted with a reminder/);
  assert.doesNotMatch(text.description, /trim/);
});

test('execute accepts an over-max note unchanged and warns for the next call', async () => {
  const options = enabled({ sayMinChars: 20, sayMaxChars: 80, sayCooldownMs: 0 });
  const seen = { progress: [], synthetic: [], recorded: [] };
  const controller = createSayController(options, {
    synthetic: async (input) => seen.synthetic.push(input.text),
    recordNote: (note) => seen.recorded.push(note.text),
  });
  const long = `${'a'.repeat(40)} ${'b'.repeat(41)}`;
  assert.equal(long.length, 82, 'the fixture is longer than max');

  const result = await controller.tool.execute(
    { text: long },
    {
      sessionID: 'ses_say_long',
      progress: async (input) => seen.progress.push(input.status),
    }
  );

  assert.match(result.content, /^Noted/);
  assert.match(
    result.content,
    /Heads-up: that note was longer than the preferred 80 chars; aim for 20–80 next time\./
  );
  assert.match(result.content, /Continue working; this is not the final answer\./);
  assert.doesNotMatch(result.content, /trim/);
  assert.deepEqual(seen.progress, [long], 'progress gets the full note');
  assert.deepEqual(seen.synthetic, [long], 'the synthetic note gets the full note');
  assert.deepEqual(seen.recorded, [long], 'recordNote gets the full note');
  assert.equal(controller.get('ses_say_long').lastText, long);
});

test('execute accepts an under-min note as-is and warns with the range', async () => {
  const seen = [];
  const controller = createSayController(
    enabled({ sayMinChars: 80, sayMaxChars: 100, sayCooldownMs: 0 }),
    { synthetic: async (input) => seen.push(input.text) }
  );

  const result = await controller.tool.execute(
    { text: 'short note' },
    { sessionID: 'ses_say_short', progress: async () => {} }
  );

  assert.match(result.content, /^Noted/);
  assert.match(
    result.content,
    /Heads-up: that note was shorter than the preferred 80 chars; aim for 80–100 next time\./
  );
  assert.deepEqual(seen, ['short note'], 'under-min notes are passed through unchanged');
  assert.equal(controller.get('ses_say_short').count, 1);
});

test('execute accepts a note of exactly max chars without a length warning', async () => {
  const controller = createSayController(
    enabled({ sayMinChars: 20, sayMaxChars: 80, sayCooldownMs: 0 }),
    { synthetic: async () => {} }
  );

  const result = await controller.tool.execute(
    { text: 'x'.repeat(80) },
    { sessionID: 'ses_say_boundary', progress: async () => {} }
  );

  assert.match(result.content, /^Noted/);
  assert.doesNotMatch(result.content, /Heads-up/);
  assert.doesNotMatch(result.content, /longer than|shorter than/);
});

test('controller fans out to progress then synthetic with resume:false', async () => {
  const calls = [];
  const controller = createSayController(
    enabled({ sayBudgetPerTurn: 1, sayCooldownMs: 0 }),
    {
      synthetic: async (input) => calls.push({ type: 'synthetic', ...input }),
    }
  );

  const result = await controller.tool.execute(
    { text: 'Reading the plugin sources before editing.', kind: 'intent', eta: '~1 min' },
    {
      sessionID: 'ses_say_1',
      progress: async (input) => calls.push({ type: 'progress', ...input }),
    }
  );

  assert.match(result.content, /Noted/);
  assert.deepEqual(calls.map((call) => call.type), ['progress', 'synthetic']);
  assert.equal(calls[0].status, 'Reading the plugin sources before editing.');
  assert.equal(calls[1].resume, false);
  assert.equal(calls[1].sessionID, 'ses_say_1');
  assert.equal(calls[1].metadata.kind, 'agent.note');
  assert.equal(calls[1].metadata.tone, 'intent');
  assert.equal(calls[1].metadata.eta, '~1 min');
  assert.equal(controller.get('ses_say_1').count, 1);
});

test('accepted notes persist through recordNote with kind and eta', async () => {
  const recorded = [];
  const controller = createSayController(
    enabled({ sayCooldownMs: 0 }),
    { synthetic: async () => {}, recordNote: (note) => recorded.push(note) }
  );

  const result = await controller.tool.execute(
    { text: 'Persisting this note for the notes lane.', kind: 'update', eta: '~2 min' },
    { sessionID: 'ses_say_notes', progress: async () => {} }
  );

  assert.match(result.content, /Noted/);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sessionID, 'ses_say_notes');
  assert.equal(recorded[0].text, 'Persisting this note for the notes lane.');
  assert.equal(recorded[0].kind, 'update');
  assert.equal(recorded[0].eta, '~2 min');
  assert.equal(typeof recorded[0].at, 'number');
});

test('recordNote runs for every accepted note when chat notes are disabled', async () => {
  const recorded = [];
  const controller = createSayController(
    enabled({ sayChatNotes: false }),
    { recordNote: (note) => recorded.push(note) }
  );

  await controller.tool.execute(
    { text: 'First and only accepted note.' },
    { sessionID: 'ses_say_notes2', progress: async () => {} }
  );
  await controller.tool.execute(
    { text: 'Second note is over budget.' },
    { sessionID: 'ses_say_notes2', progress: async () => {} }
  );

  assert.equal(recorded.length, 2, 'both notes are persisted');
});

test('controller skips synthetic when chat notes are disabled', async () => {
  const calls = [];
  const controller = createSayController(
    enabled({ sayChatNotes: false, sayCooldownMs: 0 }),
    { synthetic: async (input) => calls.push(input) }
  );
  await controller.tool.execute(
    { text: 'A note that should only reach the tool progress line.' },
    { sessionID: 'ses_say_2', progress: async () => {} }
  );
  assert.equal(calls.length, 0);
});

test('controller survives a synthetic failure (progress line already landed)', async () => {
  const controller = createSayController(
    enabled({ sayCooldownMs: 0 }),
    { synthetic: async () => { throw new Error('synthetic down'); } }
  );
  const result = await controller.tool.execute(
    { text: 'A note whose synthetic copy fails.' },
    { sessionID: 'ses_say_3', progress: async () => {} }
  );
  assert.match(result.content, /Noted/);
});

test('reset clears per-turn state; notes are not capped', async () => {
  const controller = createSayController(
    enabled(),
    { synthetic: async () => {} }
  );
  await controller.tool.execute(
    { text: 'first turn note' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  const second = await controller.tool.execute(
    { text: 'second note same turn' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  assert.match(second.content, /Noted/);

  controller.markGuarded('ses_say_4');
  assert.equal(controller.get('ses_say_4').guarded, true);

  controller.reset('ses_say_4');
  assert.equal(controller.get('ses_say_4'), undefined);

  const afterReset = await controller.tool.execute(
    { text: 'first note of the next turn' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  assert.match(afterReset.content, /Noted/);
});

test('toast scope defaults to own notes and normalizes values', () => {
  assert.equal(normalizeSayOptions({ say: true }).toastScope, 'own');
  assert.equal(normalizeSayToastScope('warnings'), 'warnings');
  assert.equal(normalizeSayToastScope('all'), 'all');
  assert.equal(normalizeSayToastScope('nope'), 'own');
});

test('sayToastNotes filters child notes by scope', () => {
  const notes = [
    { id: 'a', sessionId: 'root', kind: 'intent' },
    { id: 'b', sessionId: 'child', kind: 'update' },
    { id: 'c', sessionId: 'child', kind: 'blocked' },
    { id: 'd', sessionId: 'child', kind: 'question' },
  ];
  assert.deepEqual(sayToastNotes(notes, 'root', 'own').map((n) => n.id), ['a']);
  assert.deepEqual(
    sayToastNotes(notes, 'root', 'warnings').map((n) => n.id),
    ['a', 'c', 'd']
  );
  assert.deepEqual(sayToastNotes(notes, 'root', 'all').map((n) => n.id), ['a', 'b', 'c', 'd']);
});

test('warning notes get the longer toast duration', () => {
  assert.equal(sayToastDurationMs('intent'), SAY_TOAST_DURATION_MS);
  assert.equal(sayToastDurationMs('update'), SAY_TOAST_DURATION_MS);
  assert.equal(sayToastDurationMs('blocked'), SAY_WARNING_TOAST_DURATION_MS);
  assert.equal(sayToastDurationMs('question'), SAY_WARNING_TOAST_DURATION_MS);
  assert.equal(SAY_TOAST_DURATION_MS, 5000);
  assert.equal(SAY_WARNING_TOAST_DURATION_MS, 12000);
});
