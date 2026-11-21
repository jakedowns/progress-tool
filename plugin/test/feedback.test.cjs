/**
 * Feedback link tests. feedback.ts is transpiled with esbuild before requiring,
 * matching the other pure-helper suites. Run via: cd plugin && npm test
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-feedback-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'feedback.ts'), '--bundle', '--format=cjs', `--outfile=${path.join(OUT, 'feedback.cjs')}`],
  { stdio: 'pipe' }
);
const { feedbackIssueUrl } = require(path.join(OUT, 'feedback.cjs'));

test('feedback link prefills a versioned issue title', () => {
  assert.equal(
    feedbackIssueUrl('2.17.0'),
    'https://github.com/jakedowns/progress-tool/issues/new?title=%5BFeedback%5D%20v2.17.0'
  );
});

test('feedback link survives unusual version strings', () => {
  const url = feedbackIssueUrl('3.0.0-beta.1+build');
  const title = new URL(url).searchParams.get('title');
  assert.equal(title, '[Feedback] v3.0.0-beta.1+build');
});
