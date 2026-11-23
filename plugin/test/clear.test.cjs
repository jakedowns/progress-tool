/**
 * Clear/soft-delete semantics for the desktop pill and TUI.
 *
 * state.ts and tree.ts are TypeScript; transpile both with esbuild first, the
 * same way the other plugin suites do. Run via: cd plugin && npm test
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-clear-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
for (const name of ['state', 'tree']) {
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(ROOT, 'src', `${name}.ts`),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${path.join(OUT, `${name}.cjs`)}`,
    ],
    { stdio: 'pipe' }
  );
}
const {
  softClearSession,
  hardDeleteSession,
  hardDeleteAll,
  removeSessionLinks,
} = require(path.join(OUT, 'state.cjs'));
const { buildTree, visibleEntries, summarizeEntries, scopeEntries } = require(
  path.join(OUT, 'tree.cjs')
);

function tempState(entries, links) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-clear-'));
  const file = path.join(dir, 'state.json');
  const mapFile = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify({ version: 3, entries }, null, 2));
  if (links) fs.writeFileSync(mapFile, JSON.stringify({ links }, null, 2));
  process.env.PROGRESS_STATE_PATH = file;
  process.env.PROGRESS_SESSION_MAP_PATH = mapFile;
  return { dir, file, mapFile };
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cleanup() {
  delete process.env.PROGRESS_STATE_PATH;
  delete process.env.PROGRESS_SESSION_MAP_PATH;
}

test('soft clear hides finished and dismissed entries without touching active work', () => {
  const { file } = tempState({
    's1:done': { id: 'done', sessionId: 's1', status: 'done', title: 'Done' },
    's1:err': { id: 'err', sessionId: 's1', status: 'error', title: 'Failed' },
    's1:dim': {
      id: 'dim',
      sessionId: 's1',
      status: 'running',
      title: 'Dismissed but running',
      dismissed: { status: 'running', at: 10 },
    },
    's1:active': { id: 'active', sessionId: 's1', status: 'running', title: 'Active' },
    's1:old': {
      id: 'old',
      sessionId: 's1',
      status: 'done',
      title: 'Already cleared',
      cleared: { at: 5, status: 'done' },
    },
    's2:done': { id: 'done', sessionId: 's2', status: 'done', title: 'Other session' },
  });

  const result = softClearSession('s1');
  assert.equal(result.cleared, 3, 'done + error + dismissed entries are cleared');

  const entries = read(file).entries;
  assert.ok(entries['s1:done'].cleared, 'done entry is cleared');
  assert.ok(entries['s1:err'].cleared, 'error entry is cleared');
  assert.ok(entries['s1:dim'].cleared, 'dismissed entry is cleared');
  assert.equal(entries['s1:dim'].dismissed, undefined, 'clear supersedes dismissal');
  assert.equal(entries['s1:active'].cleared, undefined, 'active entry is untouched');
  assert.equal(entries['s1:old'].cleared.at, 5, 'already-cleared timestamp is preserved');
  assert.equal(entries['s2:done'].cleared, undefined, 'other sessions are untouched');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'state lock is released');
  cleanup();
});

test('cleared entries are absent from trees and every headline count', () => {
  const entries = {
    's1:done': {
      id: 'done',
      sessionId: 's1',
      status: 'done',
      title: 'Done',
      cleared: { at: 10, status: 'done' },
    },
    's1:run': { id: 'run', sessionId: 's1', status: 'running', title: 'Run' },
    's1:dim': {
      id: 'dim',
      sessionId: 's1',
      status: 'done',
      title: 'Dismissed',
      dismissed: { status: 'done', at: 9 },
      cleared: { at: 10, status: 'done' },
    },
  };
  const scoped = scopeEntries(entries, 's1', {});
  const visible = visibleEntries(scoped, Date.now(), {});
  assert.equal(Object.keys(visible).length, 1, 'cleared entries are hidden');
  const roots = buildTree(visible);
  assert.equal(roots.length, 1, 'cleared roots are not built');
  assert.deepEqual(summarizeEntries(scoped), { active: 1, done: 0, dismissed: 0 });
});

test('hard delete removes only the requested session and cleans its links', () => {
  const { dir, file, mapFile } = tempState(
    {
      's1:a': { id: 'a', sessionId: 's1', status: 'done', title: 'A' },
      's1:b': { id: 'b', sessionId: 's1', status: 'running', title: 'B' },
      's2:a': { id: 'a', sessionId: 's2', status: 'done', title: 'Other' },
    },
    {
      s1child: { parentId: 's1', at: 1 },
      s2child: { parentId: 's2', at: 2 },
      orphan: { parentId: 's1', at: 3 },
    }
  );
  const mirror = path.join(dir, 's1-tasklist.md');
  fs.writeFileSync(mirror, '- keep me\n');

  const result = hardDeleteSession('s1');
  assert.equal(result.removed, 2);
  assert.ok(result.freedBytes > 0, 'reports freed bytes');

  const entries = read(file).entries;
  assert.equal(entries['s1:a'], undefined);
  assert.equal(entries['s1:b'], undefined);
  assert.ok(entries['s2:a'], 'other session survives');

  const links = read(mapFile).links;
  assert.equal(links.s1child, undefined, 'deleted session child link removed');
  assert.equal(links.orphan, undefined, 'links whose parent was deleted are removed');
  assert.ok(links.s2child, 'unrelated links survive');

  assert.equal(fs.readFileSync(mirror, 'utf8'), '- keep me\n', 'mirrored tasklist is untouched');
  cleanup();
});

test('hard delete all clears entries and every session link', () => {
  const { file, mapFile } = tempState(
    {
      's1:a': { id: 'a', sessionId: 's1', status: 'done', title: 'A' },
      's2:a': { id: 'a', sessionId: 's2', status: 'done', title: 'B' },
    },
    {
      childA: { parentId: 's1', at: 1 },
      childB: { parentId: 's2', at: 2 },
    }
  );
  const result = hardDeleteAll();
  assert.equal(result.removed, 2);
  assert.deepEqual(read(file).entries, {});
  assert.deepEqual(read(mapFile).links, {});
  cleanup();
});

test('removeSessionLinks accepts an explicit session and removes both directions', () => {
  const { mapFile } = tempState(
    { 's1:a': { id: 'a', sessionId: 's1', status: 'done', title: 'A' } },
    {
      s1: { parentId: 'parent', at: 1 },
      child: { parentId: 's1', at: 2 },
      keep: { parentId: 'other', at: 3 },
    }
  );
  assert.equal(removeSessionLinks('s1'), 2);
  assert.deepEqual(Object.keys(read(mapFile).links), ['keep']);
  cleanup();
});
