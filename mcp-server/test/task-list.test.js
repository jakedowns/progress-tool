'use strict';

/**
 * Optional Markdown task-list mirror.
 *
 * Covers the pure renderer (ordering, checkboxes, timestamps, hierarchy),
 * path/config resolution, and the state-store hook that keeps the file in
 * sync without touching it on relay telemetry ticks.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const { taskListConfig, resolveTaskListPath, renderTaskList, syncTaskList } = require(
  path.join(ROOT, 'task-list')
);
const { upsertProgress, readState } = require(path.join(ROOT, 'state-store'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'progress-tasklist-'));
}

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 1, 10, 5, 0);
const T3 = Date.UTC(2026, 0, 1, 10, 10, 0);

function sampleState() {
  return {
    entries: {
      old: {
        id: 'old',
        sessionId: 'ses_test',
        status: 'done',
        title: 'Old task',
        createdAt: T1,
        statusUpdatedAt: T2,
        updatedAt: T3,
      },
      fresh: {
        id: 'fresh',
        sessionId: 'ses_test',
        status: 'running',
        title: 'Fresh task',
        detail: 'compiling\nwith details',
        createdAt: T3,
        statusUpdatedAt: T3,
        updatedAt: T3,
      },
      child: {
        id: 'child',
        sessionId: 'ses_test',
        parentId: 'fresh',
        status: 'waiting',
        title: 'Child task',
        createdAt: T2,
        statusUpdatedAt: T2,
        updatedAt: T2,
      },
      relayOk: {
        id: 'relay-ok',
        sessionId: 'ses_test',
        relay: true,
        status: 'done',
        title: 'Build succeeded',
        createdAt: T3,
        statusUpdatedAt: T3,
        updatedAt: T3,
      },
      relayError: {
        id: 'relay-error',
        sessionId: 'ses_test',
        relay: true,
        status: 'error',
        title: 'Build failed',
        detail: 'compile error',
        createdAt: T3,
        statusUpdatedAt: T3,
        updatedAt: T3,
      },
      foreign: {
        id: 'foreign',
        sessionId: 'ses_other',
        status: 'error',
        title: 'Other session',
        createdAt: T3,
      },
    },
  };
}

test('renderTaskList is newest-first with checkboxes, timestamps, and children', () => {
  const md = renderTaskList(sampleState(), { sessionID: 'ses_test', order: 'newest-first' });
  assert.match(md, /^# Task list — ses_test$/m);
  assert.match(md, /- \[x\] \*\*Old task\*\* — done · created 2026-01-01T10:00:00\.000Z · updated 2026-01-01T10:05:00\.000Z/);
  assert.match(md, /- \[ \] \*\*Fresh task\*\* — running/);
  assert.match(md, /\n  - \[ \] \*\*Child task\*\* — waiting/);
  assert.ok(md.indexOf('Fresh task') < md.indexOf('Old task'), 'newest root comes first');
  assert.ok(!md.includes('Other session'), 'other sessions are excluded');
  assert.ok(!md.includes('Build succeeded'), 'relay-created entries are off by default');
  assert.ok(!md.includes('Build failed'), 'relay-created errors are off by default');
  assert.match(md, /compiling with details/);
});

test('relayMirrorLevel gates relay-created entries, never agent tasks', () => {
  const zero = renderTaskList(sampleState(), { sessionID: 'ses_test' });
  assert.ok(!zero.includes('Build succeeded'));
  assert.ok(!zero.includes('Build failed'));

  const all = renderTaskList(sampleState(), { sessionID: 'ses_test', relayMirrorLevel: 1 });
  assert.ok(all.includes('Build succeeded'));
  assert.ok(all.includes('Build failed'));
  assert.ok(all.includes('Fresh task'), 'agent tasks still mirror at level 1');

  const errors = renderTaskList(sampleState(), { sessionID: 'ses_test', relayMirrorLevel: 2 });
  assert.ok(!errors.includes('Build succeeded'), 'successful relay runs are hidden');
  assert.match(errors, /\*\*Build failed\*\* — error/);
  assert.ok(errors.includes('Fresh task'), 'agent tasks still mirror at level 2');

  const retried = sampleState();
  retried.entries.relayError = { ...retried.entries.relayError, status: 'done', title: 'Build retried' };
  const afterSuccess = renderTaskList(retried, { sessionID: 'ses_test', relayMirrorLevel: 2 });
  assert.ok(!afterSuccess.includes('Build retried'), 'level 2 follows the current status');
});

test('renderTaskList can append older-first and omits empty state gracefully', () => {
  const md = renderTaskList(sampleState(), { sessionID: 'ses_test', order: 'oldest-first' });
  assert.ok(md.indexOf('Old task') < md.indexOf('Fresh task'), 'oldest root comes first');
  assert.match(md, /_Mirrored from progress-tool\. Oldest first\./);

  const empty = renderTaskList({ entries: {} }, { sessionID: 'ses_empty' });
  assert.match(empty, /_No tasks yet\._/);
});

test('taskListConfig is opt-in and normalizes order/session', () => {
  assert.equal(taskListConfig({}, '/work').enabled, false);
  assert.equal(taskListConfig({ PROGRESS_TASKLIST: '1' }, '/work').enabled, true);
  assert.equal(taskListConfig({ PROGRESS_TASKLIST_PATH: 'out.md' }, '/work').enabled, true);
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST: '1', PROGRESS_TASKLIST_ORDER: 'oldest-first' }, '/work')
      .order,
    'oldest-first'
  );
  assert.equal(taskListConfig({ PROGRESS_SESSION_ID: 'ses_x' }, '/work').sessionID, 'ses_x');
  assert.equal(taskListConfig({}, '/work').relayMirrorLevel, 0, 'off by default');
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST_RELAY_LEVEL: '2' }, '/work').relayMirrorLevel,
    2
  );
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST_RELAY_LEVEL: 'log' }, '/work').relayMirrorLevel,
    1
  );
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST_RELAY_LEVEL: 'err' }, '/work').relayMirrorLevel,
    2
  );
  assert.equal(
    taskListConfig({ PROGRESS_TASKLIST_RELAY_LEVEL: 'nonsense' }, '/work').relayMirrorLevel,
    0
  );
});

test('resolveTaskListPath defaults to <session>-tasklist.md and honors directories', () => {
  const config = { configuredPath: '', sessionID: 'ses_x', cwd: '/work' };
  assert.equal(resolveTaskListPath(config), '/work/ses_x-tasklist.md');

  const dir = tempDir();
  const withDir = { configuredPath: dir, sessionID: 'ses_x', cwd: dir };
  assert.equal(resolveTaskListPath(withDir), path.join(dir, 'ses_x-tasklist.md'));
  const trailing = { configuredPath: `${dir}${path.sep}`, sessionID: 'ses_x', cwd: dir };
  assert.equal(resolveTaskListPath(trailing), path.join(dir, 'ses_x-tasklist.md'));
});

test('syncTaskList writes once, then skips identical content', () => {
  const dir = tempDir();
  const file = path.join(dir, 'tasks.md');
  const env = {
    PROGRESS_TASKLIST: '1',
    PROGRESS_TASKLIST_PATH: file,
    PROGRESS_SESSION_ID: 'ses_test',
  };
  const first = syncTaskList(sampleState(), { env, cwd: dir });
  assert.equal(first.written, true);
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  const second = syncTaskList(sampleState(), { env, cwd: dir });
  assert.equal(second.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('syncTaskList is a no-op when disabled', () => {
  const dir = tempDir();
  const result = syncTaskList(sampleState(), { env: {}, cwd: dir });
  assert.equal(result.written, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('syncTaskList prefers the writing session over env for the default filename', () => {
  const dir = tempDir();
  const result = syncTaskList(sampleState(), {
    env: { PROGRESS_TASKLIST: '1' },
    cwd: dir,
    sessionID: 'ses_test',
  });
  assert.equal(result.written, true);
  assert.equal(result.file, path.join(dir, 'ses_test-tasklist.md'));
  const md = fs.readFileSync(result.file, 'utf8');
  assert.ok(!md.includes('Other session'));
});

test('only entries created by the relay carry the relay marker', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const keys = [
    'PROGRESS_SESSION_ID',
    'OPENCODE_SESSION_ID',
    'PROGRESS_TASKLIST',
    'PROGRESS_TASKLIST_PATH',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    upsertProgress(
      { id: 'relay-build', status: 'running', title: 'Build', source: 'relay' },
      stateFile
    );
    let entries = readState(stateFile).entries;
    assert.equal(entries['relay-build'].relay, true, 'relay creation is marked');

    upsertProgress(
      { id: 'agent-task', status: 'running', title: 'Agent task' },
      stateFile
    );
    entries = readState(stateFile).entries;
    assert.equal(entries['agent-task'].relay, undefined, 'agent task is unmarked');

    upsertProgress({ id: 'agent-task', progress: 0.5, source: 'relay' }, stateFile);
    entries = readState(stateFile).entries;
    assert.equal(
      entries['agent-task'].relay,
      undefined,
      'relay updates do not reclassify an agent-created task'
    );

    upsertProgress({ id: 'relay-build', status: 'done', source: 'relay' }, stateFile);
    entries = readState(stateFile).entries;
    assert.equal(entries['relay-build'].relay, true, 'marker survives later updates');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the state-store hook derives the session from the write when env is absent', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const previous = {
    PROGRESS_TASKLIST: process.env.PROGRESS_TASKLIST,
    PROGRESS_TASKLIST_PATH: process.env.PROGRESS_TASKLIST_PATH,
    PROGRESS_SESSION_ID: process.env.PROGRESS_SESSION_ID,
    OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
  };
  process.env.PROGRESS_TASKLIST = '1';
  process.env.PROGRESS_TASKLIST_PATH = dir; // directory: use <session>-tasklist.md
  delete process.env.PROGRESS_SESSION_ID;
  delete process.env.OPENCODE_SESSION_ID;

  try {
    upsertProgress(
      { id: 'derived', sessionId: 'ses_derived', status: 'running', title: 'Derived' },
      stateFile
    );
    const file = path.join(dir, 'ses_derived-tasklist.md');
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] \*\*Derived\*\* — running/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the state-store hook mirrors transitions and keeps status timestamps', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  const listFile = path.join(dir, 'tasks.md');
  const previous = {
    PROGRESS_TASKLIST: process.env.PROGRESS_TASKLIST,
    PROGRESS_TASKLIST_PATH: process.env.PROGRESS_TASKLIST_PATH,
    PROGRESS_SESSION_ID: process.env.PROGRESS_SESSION_ID,
    OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
  };
  process.env.PROGRESS_TASKLIST = '1';
  process.env.PROGRESS_TASKLIST_PATH = listFile;
  process.env.PROGRESS_SESSION_ID = 'ses_test';
  delete process.env.OPENCODE_SESSION_ID;

  try {
    const running = upsertProgress(
      { id: 'build', status: 'running', title: 'Build', detail: 'compiling' },
      stateFile
    );
    const firstUpdated = running.statusUpdatedAt;
    assert.ok(firstUpdated > 0);
    assert.match(fs.readFileSync(listFile, 'utf8'), /- \[ \] \*\*Build\*\* — running/);

    const repeat = upsertProgress({ id: 'build', progress: 0.5 }, stateFile);
    assert.ok(repeat.statusUpdatedAt >= firstUpdated);

    const relayTick = upsertProgress({ id: 'build', progress: 0.6, source: 'relay' }, stateFile);
    assert.equal(
      relayTick.statusUpdatedAt,
      repeat.statusUpdatedAt,
      'relay ticks without a transition keep the timestamp'
    );

    const done = upsertProgress({ id: 'build', status: 'done', source: 'relay' }, stateFile);
    assert.ok(done.statusUpdatedAt >= relayTick.statusUpdatedAt);
    const md = fs.readFileSync(listFile, 'utf8');
    assert.match(md, /- \[x\] \*\*Build\*\* — done/);
    assert.ok(Object.keys(readState(stateFile).entries).length > 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
