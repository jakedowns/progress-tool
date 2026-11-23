/**
 * Desktop GUI placement: composer pill vs a pinned side-region panel.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-gui-view-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'gui-view.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'gui-view.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const {
  GUI_PROGRESS_PANEL_ID,
  nextGuiLayout,
  normalizeGuiDetailLines,
  normalizeGuiLayout,
  normalizeGuiSidebarWidth,
  buildNoteToast,
  buildNotesPill,
  noteAuthorLabel,
} = require(path.join(OUT, 'gui-view.cjs'));

test('layout normalizes and swaps between composer and sidebar', () => {
  assert.equal(normalizeGuiLayout('sidebar'), 'sidebar');
  assert.equal(normalizeGuiLayout('nope'), 'composer');
  assert.equal(normalizeGuiLayout(undefined), 'composer');
  assert.equal(nextGuiLayout('composer'), 'sidebar');
  assert.equal(nextGuiLayout('sidebar'), 'composer');
});

test('sidebar width defaults to 360 and clamps to 240..800', () => {
  assert.equal(normalizeGuiSidebarWidth(undefined), 360);
  assert.equal(normalizeGuiSidebarWidth('nope'), 360);
  assert.equal(normalizeGuiSidebarWidth(100), 240);
  assert.equal(normalizeGuiSidebarWidth(2000), 800);
  assert.equal(normalizeGuiSidebarWidth(420), 420);
});

test('detail lines default to 1, allow -1/0, floor fractions and cap at 100', () => {
  assert.equal(normalizeGuiDetailLines(undefined), 1);
  assert.equal(normalizeGuiDetailLines('nope'), 1);
  assert.equal(normalizeGuiDetailLines(-1), -1);
  assert.equal(normalizeGuiDetailLines(-5), -1);
  assert.equal(normalizeGuiDetailLines(0), 0);
  assert.equal(normalizeGuiDetailLines(2), 2);
  assert.equal(normalizeGuiDetailLines(2.9), 2);
  assert.equal(normalizeGuiDetailLines(200), 100);
});

test('the progress panel id is stable', () => {
  assert.equal(GUI_PROGRESS_PANEL_ID, 'progress');
});

const note = (text, at, extra = {}) => ({
  id: String(at),
  sessionId: 's',
  text,
  kind: 'update',
  at,
  ...extra,
});

test('notes pill hides when empty and shows the latest snippet', () => {
  assert.equal(buildNotesPill([]), undefined);
  assert.equal(buildNotesPill(undefined), undefined);

  const pill = buildNotesPill([note('older', 1), note('latest note', 2)]);
  assert.equal(pill.label, 'latest note');
  assert.equal(pill.title, '2 notes · latest update');
  assert.equal(pill.tone, undefined);
});

test('notes pill truncates and warns on blocked/question notes', () => {
  const long = buildNotesPill([note('x'.repeat(200), 1)], { maxChars: 40 });
  assert.match(long.label, /…$/);
  assert.ok(long.label.length <= 40);

  assert.equal(
    buildNotesPill([note('need input', 1, { kind: 'question' })]).tone,
    'warning'
  );
  assert.equal(
    buildNotesPill([note('stuck', 1, { kind: 'blocked', eta: '~5 min' })]).title,
    '1 note · latest blocked · ETA ~5 min'
  );
});

test('noteAuthorLabel distinguishes the root agent from child sessions', () => {
  assert.equal(noteAuthorLabel({ sessionId: 's' }, 's'), 'Agent');
  assert.equal(noteAuthorLabel({ sessionId: 'c', agent: 'explore' }, 's'), 'Subagent (explore)');
  assert.equal(noteAuthorLabel({ sessionId: 'c' }, 's'), 'Subagent');
});

test('note toasts keep child attribution and warn on blocked/question', () => {
  const root = buildNoteToast(note('next phase', 1, { kind: 'update' }), 's');
  assert.equal(root.title, 'update note');
  assert.equal(root.description, 'next phase');
  assert.equal(root.tone, undefined);

  const child = buildNoteToast(
    note('stuck', 2, { sessionId: 'c', agent: 'explore', kind: 'blocked', eta: '~5 min' }),
    's'
  );
  assert.equal(child.title, '[Subagent (explore)] blocked note');
  assert.equal(child.description, 'stuck · ETA ~5 min');
  assert.equal(child.tone, 'warning');

  assert.equal(
    buildNoteToast(note('need input', 3, { kind: 'question' }), 's').tone,
    'warning'
  );
  assert.equal(
    buildNoteToast(note('anonymous child', 4, { sessionId: 'c' }), 's').title,
    '[Subagent] update note'
  );
});
