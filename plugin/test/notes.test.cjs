/**
 * `say` note persistence: per-author ring buffer, child→parent roll-up, and
 * purge semantics. state.ts is TypeScript, so it is transpiled to CJS with
 * esbuild first (same pattern as say.test.cjs).
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-notes-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'state.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'state.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const {
  SAY_NOTES_PER_SESSION,
  hardDeleteAll,
  hardDeleteSession,
  readProgressState,
  recordSayNote,
  rootSessionFor,
  sayNotesForSession,
  softClearSession,
} = require(path.join(OUT, 'state.cjs'));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-notes-state-'));
const STATE = path.join(DIR, 'state.json');
const MAP = path.join(DIR, 'sessions.json');

process.env.PROGRESS_STATE_PATH = STATE;
process.env.PROGRESS_SESSION_MAP_PATH = MAP;

function reset() {
  fs.writeFileSync(STATE, JSON.stringify({ entries: {}, version: 2 }));
  fs.writeFileSync(MAP, JSON.stringify({}));
}

function writeMap(links) {
  fs.writeFileSync(MAP, JSON.stringify(links));
}

test.beforeEach(reset);

test('recordSayNote keeps a newest-first ring buffer per author session', () => {
  reset();
  for (let i = 0; i < SAY_NOTES_PER_SESSION + 5; i++) {
    recordSayNote({
      sessionID: 'parent',
      text: `note ${i}`,
      kind: 'update',
      eta: '~1 min',
      at: 1000 + i,
    });
  }
  recordSayNote({ sessionID: 'other', text: 'unrelated', at: 2000 });

  const state = readProgressState();
  const parent = state.notes.parent;
  assert.equal(parent.length, SAY_NOTES_PER_SESSION, 'ring buffer is capped');
  assert.equal(parent[0].text, `note ${SAY_NOTES_PER_SESSION + 4}`, 'newest first');
  assert.equal(parent[parent.length - 1].text, 'note 5', 'oldest retained entry');
  assert.equal(parent[0].kind, 'update');
  assert.equal(parent[0].eta, '~1 min');
  assert.equal(state.notes.other.length, 1, 'sessions are isolated');
});

test('recordSayNote trims text and ignores empty notes', () => {
  reset();
  assert.equal(recordSayNote({ sessionID: 's', text: '   ' }), undefined);
  assert.equal(recordSayNote({ sessionID: '', text: 'hello' }), undefined);

  const note = recordSayNote({ sessionID: 's', text: '  hello \n world  ', at: 5 });
  assert.ok(note);
  assert.equal(note.text, 'hello \n world');
  assert.equal(note.kind, 'intent', 'kind defaults to intent');
});

test('rootSessionFor follows child links and survives cycles', () => {
  assert.equal(
    rootSessionFor('grand', {
      child: { parentId: 'parent', at: 1 },
      grand: { parentId: 'child', at: 1 },
    }),
    'parent'
  );
  assert.equal(
    rootSessionFor('a', {
      a: { parentId: 'b', at: 1 },
      b: { parentId: 'a', at: 1 },
    }),
    'a'
  );
  assert.equal(rootSessionFor('solo', {}), 'solo');
});

test('sayNotesForSession rolls child and grandchild notes up to the root', () => {
  reset();
  writeMap({
    child: { parentId: 'parent', at: 1, agent: 'explore' },
    grand: { parentId: 'child', at: 1 },
  });
  recordSayNote({ sessionID: 'parent', text: 'root note', kind: 'intent', at: 100 });
  recordSayNote({
    sessionID: 'child',
    text: 'child note',
    kind: 'update',
    agent: 'explore',
    at: 200,
  });
  recordSayNote({ sessionID: 'grand', text: 'grand note', kind: 'blocked', at: 300 });
  recordSayNote({ sessionID: 'unrelated', text: 'other tree', at: 400 });

  const state = readProgressState();
  const rolled = sayNotesForSession(state, 'parent');
  assert.deepEqual(
    rolled.map((note) => note.text),
    ['grand note', 'child note', 'root note'],
    'newest-first across the rolled-up tree'
  );

  // Any member of the tree resolves to the same root view.
  assert.deepEqual(
    sayNotesForSession(state, 'child').map((note) => note.text),
    ['grand note', 'child note', 'root note']
  );
  assert.deepEqual(
    sayNotesForSession(state, 'unrelated').map((note) => note.text),
    ['other tree']
  );
  assert.equal(sayNotesForSession(state, undefined, { scope: 'all' }).length, 4);
});

test('sayNotesForSession caps the rolled-up view', () => {
  reset();
  for (let i = 0; i < 30; i++) {
    recordSayNote({ sessionID: 's', text: `n${i}`, at: 1000 + i });
  }
  const notes = sayNotesForSession(readProgressState(), 's', { limit: 5 });
  assert.equal(notes.length, 5);
  assert.equal(notes[0].text, 'n29');
});

test('notes survive soft clear but are purged with the session or the store', () => {
  reset();
  recordSayNote({ sessionID: 'keep', text: 'keep me', at: 1 });
  recordSayNote({ sessionID: 'drop', text: 'drop me', at: 2 });

  softClearSession('keep');
  assert.equal(readProgressState().notes.keep.length, 1, 'soft clear keeps notes');

  hardDeleteSession('drop');
  const afterSession = readProgressState();
  assert.equal(afterSession.notes.drop, undefined, 'session delete purges its notes');
  assert.equal(afterSession.notes.keep.length, 1, 'other sessions are untouched');

  hardDeleteAll();
  assert.deepEqual(readProgressState().notes, {}, 'hard clear wipes every note');
});
