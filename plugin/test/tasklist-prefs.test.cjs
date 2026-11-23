/**
 * Task-list preferences/status helpers and the plugin-side state-file guard.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-tasklist-prefs-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
for (const name of ['state', 'tasklist-prefs']) {
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(ROOT, 'src', `${name}.ts`),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      `--outfile=${path.join(OUT, `${name}.cjs`)}`,
    ],
    { stdio: 'pipe' }
  );
}
const {
  normalizeTaskListDetail,
  normalizeTaskListLocation,
  normalizeTaskListView,
  normalizeTaskListOrder,
  readTaskListPrefs,
  writeTaskListPrefs,
  readTaskListStatus,
  taskListPrefsPath,
  taskListStatusPath,
  toggleTaskListMode,
} = require(path.join(OUT, 'tasklist-prefs.cjs'));
const { writeDismissal } = require(path.join(OUT, 'state.cjs'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'progress-tasklist-prefs-'));
}

test('normalizers clamp the enums', () => {
  assert.equal(normalizeTaskListView('raw'), 'raw');
  assert.equal(normalizeTaskListView('bogus'), 'ui');
  assert.equal(normalizeTaskListDetail('escaped'), 'escaped');
  assert.equal(normalizeTaskListDetail('raw'), 'raw');
  assert.equal(normalizeTaskListDetail('bogus'), 'code');
  assert.equal(normalizeTaskListLocation(0), 0);
  assert.equal(normalizeTaskListLocation(2), 2);
  assert.equal(normalizeTaskListLocation(99), 1);
  assert.equal(normalizeTaskListOrder('oldest-first'), 'oldest-first');
  assert.equal(normalizeTaskListOrder('bogus'), 'newest-first');
});

test('prefs/status live next to the state file and round-trip', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  assert.equal(taskListPrefsPath(stateFile), path.join(dir, '.opencode-progress-tasklist-prefs.json'));
  assert.equal(taskListStatusPath(stateFile), path.join(dir, '.opencode-progress-tasklist-status.json'));

  assert.deepEqual(readTaskListPrefs(stateFile), {});
  assert.equal(writeTaskListPrefs({ mode: 'raw' }, stateFile), true);
  assert.deepEqual(readTaskListPrefs(stateFile), { mode: 'raw' });

  fs.writeFileSync(
    taskListStatusPath(stateFile),
    JSON.stringify({
      enabled: true,
      mode: 'raw',
      detail: 'escaped',
      location: 0,
      order: 'oldest-first',
      file: '/tmp/tasklist-ses.md',
      sessionID: 'ses_x',
      updatedAt: 123,
    })
  );
  const status = readTaskListStatus(stateFile);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'raw');
  assert.equal(status.detail, 'escaped');
  assert.equal(status.location, 0);
  assert.equal(status.order, 'oldest-first');
  assert.equal(status.file, '/tmp/tasklist-ses.md');
  assert.equal(status.updatedAt, 123);
});

test('toggle flips ui/raw and persists across calls', () => {
  const dir = tempDir();
  const stateFile = path.join(dir, 'state.json');
  assert.equal(toggleTaskListMode('ui', stateFile), 'raw');
  assert.equal(readTaskListPrefs(stateFile).mode, 'raw');
  assert.equal(toggleTaskListMode('ui', stateFile), 'ui');
  assert.equal(readTaskListPrefs(stateFile).mode, 'ui');
});

test('plugin state writes refuse non-json and non-state files', () => {
  const dir = tempDir();
  const saved = process.env.PROGRESS_STATE_PATH;
  try {
    process.env.PROGRESS_STATE_PATH = path.join(dir, '.bashrc');
    fs.writeFileSync(process.env.PROGRESS_STATE_PATH, 'original\n');
    assert.equal(writeDismissal('ses:task', 'running'), false);
    assert.equal(fs.readFileSync(process.env.PROGRESS_STATE_PATH, 'utf8'), 'original\n');

    const packageFile = path.join(dir, 'package.json');
    process.env.PROGRESS_STATE_PATH = packageFile;
    fs.writeFileSync(packageFile, '{"name":"not-progress"}\n');
    assert.equal(writeDismissal('ses:task', 'running'), false);
    assert.equal(fs.readFileSync(packageFile, 'utf8'), '{"name":"not-progress"}\n');

    const valid = path.join(dir, 'state.json');
    process.env.PROGRESS_STATE_PATH = valid;
    fs.writeFileSync(
      valid,
      JSON.stringify({ version: 2, entries: { 'ses:task': { id: 'task', sessionId: 'ses', status: 'running' } } })
    );
    assert.equal(writeDismissal('ses:task', 'running'), true);
    const parsed = JSON.parse(fs.readFileSync(valid, 'utf8'));
    assert.equal(parsed.entries['ses:task'].dismissed.status, 'running');
  } finally {
    if (saved === undefined) delete process.env.PROGRESS_STATE_PATH;
    else process.env.PROGRESS_STATE_PATH = saved;
  }
});
