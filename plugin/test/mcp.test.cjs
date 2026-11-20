/**
 * Companion MCP launch resolution guard (issue #1).
 *
 * Under OpenCode Desktop `process.execPath` is the `opencode` binary, so using
 * it as the MCP interpreter made the server chdir into the `.js` entrypoint and
 * die with ENOTDIR. These tests pin the fallback order: explicit option →
 * real execPath → node/bun → npx, and `null` when nothing usable exists.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-mcp-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'mcp.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'mcp.cjs')}`],
  { stdio: 'pipe' }
);
const { isJsRuntime, resolveMcpLaunch, MCP_PACKAGE } = require(path.join(OUT, 'mcp.cjs'));

const ENTRY = '/Users/tester/.cache/opencode/npm/@jakedowns/progress-tool-mcp/index.js';
const HOME = '/Users/tester';

/** Minimal filesystem double: `files` is the set of paths that "exist". */
function probe(files, overrides = {}) {
  return {
    platform: 'darwin',
    home: HOME,
    env: { PATH: '/usr/bin:/bin' },
    exists: (candidate) => files.has(candidate),
    readdir: () => [],
    ...overrides,
  };
}

test('only real JS runtimes are accepted as an interpreter', () => {
  assert.equal(isJsRuntime('/usr/local/bin/node'), true);
  assert.equal(isJsRuntime('/Users/tester/.bun/bin/bun'), true);
  assert.equal(isJsRuntime('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(isJsRuntime('/opt/homebrew/bin/deno'), true);
  assert.equal(isJsRuntime('/Applications/OpenCode.app/Contents/MacOS/opencode'), false);
  assert.equal(isJsRuntime('/usr/local/bin/npx'), false);
  assert.equal(isJsRuntime(undefined), false);
});

test('Desktop: opencode execPath is rejected, nvm node is used instead', () => {
  const nvm = path.join(HOME, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node');
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set([nvm]), {
      execPath: '/Applications/OpenCode.app/Contents/MacOS/opencode',
      readdir: (dir) =>
        dir === path.join(HOME, '.nvm', 'versions', 'node') ? ['v22.18.0'] : [],
    })
  );

  assert.ok(launch, 'should resolve a launch command');
  assert.deepEqual(launch.command, [nvm, ENTRY]);
  assert.equal(launch.command[0], nvm, 'must never spawn the opencode binary');
  assert.doesNotMatch(launch.command[0], /opencode/);
});

test('PATH node wins over bun', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set(['/usr/bin/node', '/usr/bin/bun']), {
      execPath: '/Applications/OpenCode.app/Contents/MacOS/opencode',
    })
  );
  assert.deepEqual(launch.command, ['/usr/bin/node', ENTRY]);
});

test('bun is used when node is missing (Desktop bundles bun)', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set([path.join(HOME, '.bun', 'bin', 'bun')]), {
      execPath: '/Applications/OpenCode.app/Contents/MacOS/opencode',
    })
  );
  assert.deepEqual(launch.command, [path.join(HOME, '.bun', 'bin', 'bun'), ENTRY]);
});

test('a real runtime execPath (plain node/bun dev run) is used as-is', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set(), { execPath: '/Users/tester/.nvm/versions/node/v22.18.0/bin/node' })
  );
  assert.deepEqual(launch.command, ['/Users/tester/.nvm/versions/node/v22.18.0/bin/node', ENTRY]);
});

test('options.mcpRuntime overrides everything', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set(['/usr/bin/node']), { runtime: '/custom/runtime/bun', execPath: '/usr/bin/node' })
  );
  assert.deepEqual(launch.command, ['/custom/runtime/bun', ENTRY]);
  assert.match(launch.source, /mcpRuntime/);
});

test('falls back to npx when no runtime is installed', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set(['/usr/bin/npx']), {
      execPath: '/Applications/OpenCode.app/Contents/MacOS/opencode',
    })
  );
  assert.deepEqual(launch.command, ['/usr/bin/npx', '-y', MCP_PACKAGE]);
});

test('returns null (skip registration) when nothing runnable exists', () => {
  const launch = resolveMcpLaunch(
    ENTRY,
    probe(new Set(), { execPath: '/Applications/OpenCode.app/Contents/MacOS/opencode' })
  );
  assert.equal(launch, null);
});
