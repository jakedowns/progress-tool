/**
 * TUI packaging guard (macOS npm-install failure).
 *
 * OpenCode's bundled Solid transform skips files under node_modules, so a raw
 * `src/tui.tsx` entry gets Bun's default React JSX runtime and fails with
 * `Cannot find package 'react'`. The published entry must be precompiled JS
 * that keeps the host runtime imports bare (bridged, not bundled).
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const OUT = path.join(ROOT, 'dist', 'tui.js');

test('the TUI export points at the compiled bundle', () => {
  assert.equal(pkg.exports['./tui'], './dist/tui.js');
  assert.ok(pkg.files.includes('dist'), 'dist must ship in the npm tarball');
  assert.ok(fs.existsSync(OUT), 'run npm run build (dist/tui.js missing)');
  assert.ok(fs.statSync(OUT).size > 1000, 'compiled TUI looks empty');
});

test('the compiled TUI has no React runtime and keeps host imports bare', () => {
  const js = fs.readFileSync(OUT, 'utf8');
  assert.doesNotMatch(js, /\breact\b/i, 'JSX must compile against OpenTUI Solid, never React');
  assert.doesNotMatch(js, /jsx-runtime|jsxDEV/, 'no JSX runtime import remains');

  for (const specifier of ['@opencode/plugin/tui', '@opentui/solid', 'solid-js']) {
    assert.ok(
      js.includes(`from "${specifier}"`),
      `${specifier} must stay external so the host bridges its own instance`
    );
  }
});

test('the build script compiles the TUI after the GUI bundle', () => {
  assert.match(pkg.scripts.build, /build-gui\.sh/);
  assert.match(pkg.scripts.build, /build-tui\.mjs/);
});
