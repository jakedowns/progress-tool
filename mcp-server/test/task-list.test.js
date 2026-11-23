'use strict';

/**
 * Optional Markdown task-list mirror.
 *
 * Covers the pure renderer (composite keys, UI/raw modes, roll-up, detail
 * safety), the location enum, config/prefs, the state-store hook, the
 * sentinel guard, and the state-path guard.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const {
  MIRROR_MARKER,
  taskListConfig,
  resolveTaskListPath,
  taskListFileName,
  renderTaskList,
  syncTaskList,
  taskListPrefsPath,
  taskListStatusPath,
  readTaskListStatus,
  normalizeLocation,
  normalizeMode,
  normalizeDetail,
  normalizeOrder,
  normalizeRelayMirrorLevel,
} = require(path.join(ROOT, 'task-list'));
const { upsertProgress, clearProgress, readState } = require(path.join(ROOT, 'state-store'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'progress-tasklist-'));
}

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 1, 10, 5, 0);
const T3 = Date.UTC(2026, 0, 1, 10, 10, 0);

function sampleState() {
  return {
    entries: {
      'ses_b:build': {
        id: 'build',
        sessionId: 'ses_b',
        status: 'done',
        title: 'B build',
        createdAt: T2,
        updatedAt: T2,
      },
      'ses_a:build': {
        id: 'build',
        sessionId: 'ses_a',
        status: 'running',
        title: 'A build',
        detail: 'compiling\nwith details',
        createdAt: T1,
        statusUpdatedAt: T2,
        updatedAt: T3,
      },
      'ses_a:parent': {
        id: 'parent',
        sessionId: 'ses_a',
        status: 'running',
        title: 'Parent task',
        createdAt: T1,
        updatedAt: T2,
      },
      'ses_a:child': {
        id: 'child',
        sessionId: 'ses_a',
        parentId: 'parent',
        status: 'done',
        title: 'Child task',
        createdAt: T2,
        updatedAt: T3,
      },
      'ses_a:dismissed': {
        id: 'dismissed',
        sessionId: 'ses_a',
        status: 'running',
        title: 'Dismissed task',
        dismissed: { status: 'running', at: T2 },
        createdAt: T1,
      },
      'ses_a:cleared': {
        id: 'cleared',
        sessionId: 'ses_a',
        status: 'done',
        title: 'Cleared task',
        cleared: { at: T2 },
        createdAt: T1,
      },
      'ses_a:relay-ok': {
        id: 'relay-ok',
        sessionId: 'ses_a',
        relay: true,
        status: 'done',
        title: 'Relay build succeeded',
        createdAt: T3,
        updatedAt: T3,
      },
      'ses_a:relay-error': {
        id: 'relay-error',
        sessionId: 'ses_a',
        relay: true,
        status: 'error',
        title: 'Relay build failed',
        detail: 'compile error',
        createdAt: T3,
        updatedAt: T3,
      },
    },
  };
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('UI mode: composite keys, hide dismissed/cleared, roll up status, safe detail', () => {
  const md = renderTaskList(sampleState(), {
    sessionID: 'ses_a',
    mode: 'ui',
    detail: 'code',
  });
  assert.ok(md.startsWith(MIRROR_MARKER), 'marker is the first line');
  assert.match(md, /^# Task list — ses_a$/m);
  assert.match(md, /\*\*A build\*\* — running/);
  assert.doesNotMatch(md, /B build/);
  assert.doesNotMatch(md, /Dismissed task/);
  assert.doesNotMatch(md, /Cleared task/);
  assert.doesNotMatch(md, /Relay build/);
  assert.match(md, /\*\*Parent task\*\* — done/, 'all children done rolls parent up to done');
  assert.match(md, /\n  - \[x\] \*\*Child task\*\* — done/);
  assert.match(md, /```text/);
});

test('raw mode: keeps dismissed/cleared and stored status', () => {
  const md = renderTaskList(sampleState(), {
    sessionID: 'ses_a',
    mode: 'raw',
    detail: 'raw',
  });
  assert.match(md, /\*\*Dismissed task\*\* — running .*dismissed/);
  assert.match(md, /\*\*Cleared task\*\* — done .*cleared/);
  assert.match(md, /\*\*Parent task\*\* — running/, 'raw mode does not roll status up');
  assert.doesNotMatch(md, /```text/);
  assert.doesNotMatch(md, /Relay build/, 'relay entries stay hidden at the default level');
});

test('relayMirrorLevel gates relay-created entries and never agent tasks', () => {
  const zero = renderTaskList(sampleState(), { sessionID: 'ses_a' });
  assert.doesNotMatch(zero, /Relay build/);

  const all = renderTaskList(sampleState(), { sessionID: 'ses_a', relayMirrorLevel: 1 });
  assert.match(all, /\*\*Relay build succeeded\*\* — done/);
  assert.match(all, /\*\*Relay build failed\*\* — error/);
  assert.match(all, /\*\*A build\*\*/);

  const errors = renderTaskList(sampleState(), { sessionID: 'ses_a', relayMirrorLevel: 2 });
  assert.doesNotMatch(errors, /Relay build succeeded/);
  assert.match(errors, /\*\*Relay build failed\*\* — error/);
  assert.match(errors, /\*\*A build\*\*/);

  assert.equal(normalizeRelayMirrorLevel('log'), 1);
  assert.equal(normalizeRelayMirrorLevel('all'), 1);
  assert.equal(normalizeRelayMirrorLevel('err'), 2);
  assert.equal(normalizeRelayMirrorLevel('bogus'), 0);
});

test('shared mode keeps same-id tasks from different sessions', () => {
  const md = renderTaskList(sampleState(), { mode: 'raw' });
  assert.match(md, /\*\*A build\*\*/);
  assert.match(md, /\*\*B build\*\*/);
  assert.match(md, /^# Task list — shared session$/m);
});

test('location enum and fixed filename', () => {
  assert.equal(taskListFileName('ses_x'), 'tasklist-ses_x.md');
  assert.equal(taskListFileName(''), 'tasklist-shared.md');
  const base = { sessionID: 'ses_x', cwd: '/work' };
  assert.equal(resolveTaskListPath({ ...base, location: 0 }), '/work/.progress/tasklist-ses_x.md');
  assert.equal(resolveTaskListPath({ ...base, location: 1 }), '/work/tasklist-ses_x.md');
  assert.equal(
    resolveTaskListPath({ ...base, location: 2 }),
    path.join(os.homedir(), '.opencode-progress', 'tasklist-ses_x.md')
  );
  assert.equal(normalizeLocation('0'), 0);
  assert.equal(normalizeLocation(2), 2);
  assert.equal(normalizeLocation(99), 1);
});

test('config is opt-in, normalizes enums, and lets prefs override mode', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  assert.equal(taskListConfig({}, dir, stateFile).enabled, false);
  const config = taskListConfig(
    {
      PROGRESS_TASKLIST: '1',
      PROGRESS_TASKLIST_LOCATION: '0',
      PROGRESS_TASKLIST_MODE: 'raw',
      PROGRESS_TASKLIST_DETAIL: 'escaped',
      PROGRESS_TASKLIST_ORDER: 'oldest-first',
    },
    dir,
    stateFile
  );
  assert.equal(config.location, 0);
  assert.equal(config.mode, 'raw');
  assert.equal(config.detail, 'escaped');
  assert.equal(config.order, 'oldest-first');
  assert.equal(config.relayMirrorLevel, 0, 'relay entries are hidden by default');
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_RELAY_LEVEL: '2' }, dir, stateFile)
      .relayMirrorLevel,
    2
  );

  fs.writeFileSync(taskListPrefsPath(stateFile), JSON.stringify({ mode: 'ui' }));
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_MODE: 'raw' }, dir, stateFile).mode,
    'ui',
    'prefs override the env default'
  );
  assert.equal(normalizeMode('bogus'), 'ui');
  assert.equal(normalizeDetail('bogus'), 'code');
  assert.equal(normalizeOrder('bogus'), 'newest-first');
});

test('sync writes once, caches content, writes status, and uses 0600', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const env = {
    PROGRESS_TASKLIST: '1',
    PROGRESS_TASKLIST_LOCATION: '1',
  };
  const options = { env, cwd: dir, stateFile, sessionID: 'ses_a' };
  const first = syncTaskList(sampleState(), options);
  assert.equal(first.written, true);
  assert.equal(first.file, path.join(dir, 'tasklist-ses_a.md'));
  const content = read(first.file);
  assert.ok(content.startsWith(MIRROR_MARKER));
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);

  const status = readTaskListStatus(stateFile);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'ui');
  assert.equal(status.file, first.file);

  const second = syncTaskList(sampleState(), options);
  assert.equal(second.written, false);
  assert.equal(second.reason, 'unchanged');

  const changed = sampleState();
  changed.entries['ses_a:build'].title = 'A build renamed';
  const third = syncTaskList(changed, options);
  assert.equal(third.written, true);
  assert.match(read(third.file), /A build renamed/);
});

test('sentinel guard refuses to clobber non-mirror files', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const target = path.join(dir, 'tasklist-ses_a.md');
  const env = { PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_LOCATION: '1' };
  const options = { env, cwd: dir, stateFile, sessionID: 'ses_a' };

  fs.writeFileSync(target, '{"name":"not a mirror"}\n');
  const refused = syncTaskList(sampleState(), options);
  assert.equal(refused.written, false);
  assert.equal(refused.reason, 'not-a-mirror');
  assert.equal(read(target), '{"name":"not a mirror"}\n');

  fs.writeFileSync(target, `${MIRROR_MARKER}\nold mirror\n`);
  const accepted = syncTaskList(sampleState(), options);
  assert.equal(accepted.written, true);
  assert.match(read(target), /A build/);
});

test('sentinel guard re-checks the file when content changes; cache recreates deleted files', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const target = path.join(dir, 'tasklist-ses_a.md');
  const env = { PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_LOCATION: '1' };
  const options = { env, cwd: dir, stateFile, sessionID: 'ses_a' };

  assert.equal(syncTaskList(sampleState(), options).written, true);
  fs.unlinkSync(target);
  assert.equal(syncTaskList(sampleState(), options).written, true, 'recreates a deleted mirror');
  assert.ok(fs.existsSync(target));

  fs.writeFileSync(target, 'not a mirror\n');
  const changed = sampleState();
  changed.entries['ses_a:build'].title = 'Changed after external write';
  const refused = syncTaskList(changed, options);
  assert.equal(refused.written, false);
  assert.equal(refused.reason, 'not-a-mirror');
  assert.equal(read(target), 'not a mirror\n');
});

test('status file is removed when the mirror is disabled', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const enabled = {
    env: { PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_LOCATION: '1' },
    cwd: dir,
    stateFile,
    sessionID: 'ses_a',
  };
  syncTaskList(sampleState(), enabled);
  assert.ok(fs.existsSync(taskListStatusPath(stateFile)));
  syncTaskList(sampleState(), { env: {}, cwd: dir, stateFile, sessionID: 'ses_a' });
  assert.equal(fs.existsSync(taskListStatusPath(stateFile)), false);
});

test('detail modes: code fences, escaped links, raw links', () => {
  const state = {
    entries: {
      'ses:one': {
        id: 'one',
        sessionId: 'ses',
        status: 'running',
        title: 'Detail task',
        detail: 'see [x](https://example.com) and **bold** <img src=x>',
        createdAt: T1,
      },
    },
  };
  const code = renderTaskList(state, { sessionID: 'ses', detail: 'code' });
  assert.match(code, /```text/);
  assert.match(code, /\[x\]\(https:\/\/example\.com\)/);

  const escaped = renderTaskList(state, { sessionID: 'ses', detail: 'escaped' });
  assert.doesNotMatch(escaped, /\[x\]\(https:\/\/example\.com\)/);
  assert.ok(escaped.includes('\\[x\\]\\(https://example.com\\)'));
  assert.ok(escaped.includes('\\*\\*bold\\*\\*'));

  const raw = renderTaskList(state, { sessionID: 'ses', detail: 'raw' });
  assert.match(raw, /\[x\]\(https:\/\/example\.com\)/);
});

test('state-store hook mirrors the writing session and clear keeps the session file', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const previousCwd = process.cwd();
  const previous = {
    PROGRESS_TASKLIST: process.env.PROGRESS_TASKLIST,
    PROGRESS_TASKLIST_LOCATION: process.env.PROGRESS_TASKLIST_LOCATION,
    PROGRESS_SESSION_ID: process.env.PROGRESS_SESSION_ID,
    OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
  };
  process.chdir(dir);
  process.env.PROGRESS_TASKLIST = '1';
  process.env.PROGRESS_TASKLIST_LOCATION = '1';
  delete process.env.PROGRESS_SESSION_ID;
  delete process.env.OPENCODE_SESSION_ID;

  try {
    upsertProgress(
      { id: 'derived', sessionId: 'ses_derived', status: 'running', title: 'Derived' },
      stateFile
    );
    const file = path.join(dir, 'tasklist-ses_derived.md');
    assert.ok(fs.existsSync(file));
    assert.match(read(file), /Derived/);
    assert.equal(fs.existsSync(path.join(dir, 'tasklist-shared.md')), false);

    clearProgress('derived', stateFile, 'ses_derived');
    const cleared = read(file);
    assert.match(cleared, /_No tasks yet\._/);
    assert.equal(fs.existsSync(path.join(dir, 'tasklist-shared.md')), false);
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('only entries created by the relay carry the relay marker', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const keys = ['PROGRESS_SESSION_ID', 'OPENCODE_SESSION_ID', 'PROGRESS_TASKLIST'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    upsertProgress(
      { id: 'relay-build', status: 'running', title: 'Build', source: 'relay' },
      stateFile
    );
    assert.equal(readState(stateFile).entries['relay-build'].relay, true, 'relay creation is marked');

    upsertProgress({ id: 'agent-task', status: 'running', title: 'Agent task' }, stateFile);
    assert.equal(readState(stateFile).entries['agent-task'].relay, undefined, 'agent task is unmarked');

    upsertProgress({ id: 'agent-task', progress: 0.5, source: 'relay' }, stateFile);
    assert.equal(
      readState(stateFile).entries['agent-task'].relay,
      undefined,
      'relay updates do not reclassify an agent-created task'
    );

    upsertProgress({ id: 'relay-build', status: 'done', source: 'relay' }, stateFile);
    assert.equal(
      readState(stateFile).entries['relay-build'].relay,
      true,
      'the marker survives later updates'
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('state path guard refuses non-json and non-state files', () => {
  const dir = tempDir();
  assert.throws(
    () => upsertProgress({ id: 'x', status: 'running', title: 'X' }, path.join(dir, '.bashrc')),
    /expected a \.json file/
  );

  const packageFile = path.join(dir, 'package.json');
  fs.writeFileSync(packageFile, '{"name":"not-progress"}\n');
  assert.throws(
    () => upsertProgress({ id: 'x', status: 'running', title: 'X' }, packageFile),
    /missing a progress "entries" object/
  );
  assert.equal(read(packageFile), '{"name":"not-progress"}\n', 'file was not modified');

  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(valid, '{"entries":{}}\n');
  assert.doesNotThrow(() => upsertProgress({ id: 'x', status: 'running', title: 'X' }, valid));

  const fresh = path.join(dir, 'fresh.json');
  assert.doesNotThrow(() => upsertProgress({ id: 'y', status: 'running', title: 'Y' }, fresh));
  assert.ok(fs.existsSync(fresh));
});

test('status parser tolerates missing/invalid files', () => {
  const dir = tempDir();
  assert.equal(readTaskListStatus(path.join(dir, 'state.json')), null);
  fs.writeFileSync(taskListStatusPath(path.join(dir, 'state.json')), 'not json');
  assert.equal(readTaskListStatus(path.join(dir, 'state.json')), null);
});
