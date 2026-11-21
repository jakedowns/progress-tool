/**
 * Child→parent session attribution map.
 *
 * The map is the write side of the subagent-progress fix: the plugin's idle
 * hook records `childSessionID → sessionID`, and the MCP server/relay read the
 * same file to roll a subagent's progress up under the parent session. These
 * tests pin the file location, the merge behaviour, and corrupt-file recovery.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-session-map-test-${process.pid}`);
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
  adoptChildEntries,
  recordChildSession,
  readSessionMap,
  sessionMapFilePath,
  stateFilePath,
} = require(path.join(OUT, 'state.cjs'));

function withTempEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-session-map-'));
  const prevState = process.env.PROGRESS_STATE_PATH;
  const prevMap = process.env.PROGRESS_SESSION_MAP_PATH;
  process.env.PROGRESS_STATE_PATH = path.join(dir, 'state.json');
  delete process.env.PROGRESS_SESSION_MAP_PATH;
  try {
    return run(dir);
  } finally {
    if (prevState === undefined) delete process.env.PROGRESS_STATE_PATH;
    else process.env.PROGRESS_STATE_PATH = prevState;
    if (prevMap === undefined) delete process.env.PROGRESS_SESSION_MAP_PATH;
    else process.env.PROGRESS_SESSION_MAP_PATH = prevMap;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('map lives next to the state file and merges child links', () => {
  withTempEnv((dir) => {
    assert.equal(
      sessionMapFilePath(),
      path.join(dir, '.opencode-progress-sessions.json')
    );
    assert.equal(path.dirname(sessionMapFilePath()), path.dirname(stateFilePath()));

    assert.equal(recordChildSession('child-a', 'parent'), true);
    assert.equal(recordChildSession('child-b', 'parent'), true);
    // Re-recording the same relation is a no-op success, not a duplicate.
    assert.equal(recordChildSession('child-a', 'parent'), true);
    // A link to itself is meaningless and must be ignored.
    assert.equal(recordChildSession('child-a', 'child-a'), false);

    const map = readSessionMap();
    assert.deepEqual(Object.keys(map).sort(), ['child-a', 'child-b']);
    assert.equal(map['child-a'].parentId, 'parent');
    assert.equal(map['child-b'].parentId, 'parent');
    assert.ok(map['child-a'].at > 0, 'timestamp recorded for TTL pruning');
  });
});

test('an explicit PROGRESS_SESSION_MAP_PATH wins', () => {
  withTempEnv((dir) => {
    const explicit = path.join(dir, 'elsewhere.json');
    process.env.PROGRESS_SESSION_MAP_PATH = explicit;
    assert.equal(sessionMapFilePath(), explicit);
    assert.equal(recordChildSession('child', 'parent'), true);
    assert.equal(readSessionMap().child.parentId, 'parent');
  });
});

test('a corrupt map is treated as empty and rewritten cleanly', () => {
  withTempEnv((dir) => {
    const file = path.join(dir, '.opencode-progress-sessions.json');
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(readSessionMap(), {});
    assert.equal(recordChildSession('child', 'parent'), true);
    assert.equal(readSessionMap().child.parentId, 'parent');
  });
});

test('adoptChildEntries re-keys entries a child wrote before the link existed', () => {
  withTempEnv(() => {
    fs.writeFileSync(
      stateFilePath(),
      JSON.stringify({
        version: 2,
        entries: {
          'child:early': {
            id: 'early',
            sessionId: 'child',
            status: 'running',
            title: 'Early child milestone',
            createdAt: 1,
            updatedAt: 1,
          },
        },
      })
    );

    assert.equal(adoptChildEntries('child', 'parent'), 1);
    const state = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    assert.deepEqual(Object.keys(state.entries), ['parent:early']);
    assert.equal(state.entries['parent:early'].sessionId, 'parent');
    // Nothing left to adopt on a repeat call.
    assert.equal(adoptChildEntries('child', 'parent'), 0);
    assert.equal(adoptChildEntries('child', 'child'), 0);
  });
});
