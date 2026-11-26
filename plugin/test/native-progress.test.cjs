'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-native-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'native-progress.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'native-progress.cjs')}`,
  ],
  { stdio: 'pipe' }
);
const { upsertNativeProgress } = require(path.join(OUT, 'native-progress.cjs'));

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-native-state-'));
  const file = path.join(dir, 'state.json');
  const previous = process.env.PROGRESS_STATE_PATH;
  process.env.PROGRESS_STATE_PATH = file;
  return {
    file,
    restore: () => {
      if (previous === undefined) delete process.env.PROGRESS_STATE_PATH;
      else process.env.PROGRESS_STATE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('native writer upserts one entry with optional progress and subagent tags', () => {
  const state = tempState();
  try {
    upsertNativeProgress([
      {
        id: 'write',
        status: 'running',
        title: 'Write the contract',
        detail: 'authoring',
        sessionId: 'ses_a',
      },
    ]);
    let entry = JSON.parse(fs.readFileSync(state.file, 'utf8')).entries['ses_a:write'];
    assert.equal(entry.status, 'running');
    assert.equal(entry.title, 'Write the contract');
    assert.equal(entry.detail, 'authoring');
    assert.equal(entry.progress, null, 'fraction is optional');
    assert.equal(entry.sessionId, 'ses_a');

    upsertNativeProgress([
      {
        id: 'child',
        status: 'running',
        title: 'Review docs',
        parentId: 'write',
        sessionId: 'ses_a',
        subagent: true,
        subagentAgent: 'explore',
        subagentName: 'Review docs',
      },
    ]);
    entry = JSON.parse(fs.readFileSync(state.file, 'utf8')).entries['ses_a:child'];
    assert.equal(entry.subagent, true);
    assert.equal(entry.subagentAgent, 'explore');
    assert.equal(entry.subagentName, 'Review docs');
    assert.equal(entry.parentId, 'write');
    assert.equal(entry.progress, null);
  } finally {
    state.restore();
  }
});

test('done normalizes progress to 1 and a restart clears the fraction', () => {
  const state = tempState();
  try {
    upsertNativeProgress([
      { id: 'task', status: 'running', title: 'Task', progress: 0.4, sessionId: 'ses_b' },
    ]);
    upsertNativeProgress([{ id: 'task', status: 'done', title: 'Task', sessionId: 'ses_b' }]);
    let entry = JSON.parse(fs.readFileSync(state.file, 'utf8')).entries['ses_b:task'];
    assert.equal(entry.progress, 1);

    upsertNativeProgress([{ id: 'task', status: 'running', title: 'Task', sessionId: 'ses_b' }]);
    entry = JSON.parse(fs.readFileSync(state.file, 'utf8')).entries['ses_b:task'];
    assert.equal(entry.progress, null);
  } finally {
    state.restore();
  }
});
