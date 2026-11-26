/**
 * Dev-version display: `-dev` is injected at bundle time from tag detection,
 * with PROGRESS_DEV as the escape hatch.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-build-version-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });

function bundle(name, args = []) {
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(ROOT, 'src', 'build-version.ts'),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      ...args,
      `--outfile=${path.join(OUT, name)}`,
    ],
    { stdio: 'pipe' }
  );
  return require(path.join(OUT, name));
}

test('dev builds append -dev and release builds stay clean', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const dev = bundle('dev.cjs', ['--define:__PROGRESS_DEV__=true']);
  assert.equal(dev.displayVersion, `${pkg.version}-dev`);
  assert.equal(dev.isDevBuild, true);

  const release = bundle('release.cjs', ['--define:__PROGRESS_DEV__=false']);
  assert.equal(release.displayVersion, pkg.version);
  assert.equal(release.isDevBuild, false);

  // The server loads the source directly, where the define is absent.
  const plain = bundle('plain.cjs');
  assert.equal(plain.displayVersion, pkg.version);
});

test('PROGRESS_DEV overrides tag detection', async () => {
  const { resolveDevFlag } = await import(
    path.join(ROOT, '..', 'scripts', 'dev-version-flag.mjs')
  );
  assert.equal(resolveDevFlag('/nonexistent', ROOT, { PROGRESS_DEV: '1' }), true);
  assert.equal(resolveDevFlag('/nonexistent', ROOT, { PROGRESS_DEV: '0' }), false);
  // No git repository: treat as a release install, not a dev build.
  assert.equal(resolveDevFlag('/nonexistent', ROOT, {}), false);
});
