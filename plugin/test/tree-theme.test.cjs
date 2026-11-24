/**
 * Tree theme switching: config discovery, JSONC-preserving edits, and the
 * project-over-global write order used by the palette command.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-tree-theme-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
for (const name of ['tree', 'tree-theme']) {
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
const { TREE_THEME_CHOICES, nextTreeTheme, treeThemeLabel } = require(
  path.join(OUT, 'tree.cjs')
);
const {
  globalConfigDir,
  isProgressPluginPackage,
  treeThemeConfigCandidates,
  updateTreeThemeInConfig,
  writeTreeThemeToConfig,
} = require(path.join(OUT, 'tree-theme.cjs'));

const PACKAGE = '@jakedowns/progress-tool-opencode-plugin@latest';
const matches = (ref) => ref.includes('progress-tool-opencode-plugin');

function tempDir(prefix = 'progress-tree-theme-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function envFor(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
}

test('theme helpers expose both themes and flip between them', () => {
  assert.deepEqual(
    TREE_THEME_CHOICES.map((choice) => choice.value),
    ['default', 'compact']
  );
  assert.equal(nextTreeTheme('default'), 'compact');
  assert.equal(nextTreeTheme('compact'), 'default');
  assert.equal(treeThemeLabel('compact'), 'Compact');
  assert.equal(treeThemeLabel('default'), 'Default');
});

test('an existing treeTheme is replaced without touching comments or other keys', () => {
  const text = `{
  // keep this comment
  "plugins": [
    {
      "package": "${PACKAGE}",
      "options": {
        "say": true,
        "treeTheme": "default" // view-only
      }
    }
  ]
}
`;
  const updated = updateTreeThemeInConfig(text, 'compact', { matches });
  assert.ok(updated);
  assert.match(updated, /"treeTheme": "compact"/);
  assert.doesNotMatch(updated, /"treeTheme": "default"/);
  assert.match(updated, /\/\/ keep this comment/);
  assert.match(updated, /"say": true/);
});

test('treeTheme is inserted into an existing options object', () => {
  const text = JSON.stringify(
    { plugins: [{ package: PACKAGE, options: { say: true } }] },
    null,
    2
  );
  const updated = updateTreeThemeInConfig(text, 'compact', { matches });
  assert.ok(updated);
  assert.equal(JSON.parse(updated).plugins[0].options.treeTheme, 'compact');
  assert.equal(JSON.parse(updated).plugins[0].options.say, true);
});

test('a plugin entry without options gains an options object', () => {
  const text = `{
  "plugins": [
    { "package": "${PACKAGE}", "options": {} }
  ]
}`;
  const updated = updateTreeThemeInConfig(text, 'compact', { matches });
  assert.ok(updated);
  assert.equal(JSON.parse(updated).plugins[0].options.treeTheme, 'compact');
});

test('a trailing comma in the options object is reused', () => {
  const text = `{
  "plugins": [
    {
      "package": "${PACKAGE}",
      "options": {
        "say": true,
      },
    },
  ],
}`;
  const updated = updateTreeThemeInConfig(text, 'default', { matches });
  assert.ok(updated);
  assert.match(updated, /"say": true,\s*"treeTheme": "default"/);
});

test('a UTF-8 BOM is preserved', () => {
  const text = `\uFEFF{ "plugins": [{ "package": "${PACKAGE}", "options": {} }] }`;
  const updated = updateTreeThemeInConfig(text, 'compact', { matches });
  assert.ok(updated);
  assert.equal(updated.charCodeAt(0), 0xfeff);
  assert.equal(JSON.parse(updated.slice(1)).plugins[0].options.treeTheme, 'compact');
});

test('a shorthand string plugin entry is upgraded to the object form', () => {
  const text = `{ "plugins": ["${PACKAGE}"] }`;
  const updated = updateTreeThemeInConfig(text, 'compact', { matches });
  assert.ok(updated);
  const parsed = JSON.parse(updated);
  assert.equal(parsed.plugins[0].package, PACKAGE);
  assert.equal(parsed.plugins[0].options.treeTheme, 'compact');
});

test('unrelated plugins and missing plugin entries are left alone', () => {
  const text = `{
  "plugins": [
    { "package": "some-other-plugin", "options": { "treeTheme": "default" } }
  ]
}`;
  assert.equal(updateTreeThemeInConfig(text, 'compact', { matches }), undefined);
  assert.equal(updateTreeThemeInConfig('not json', 'compact', { matches }), undefined);
  assert.equal(updateTreeThemeInConfig('[]', 'compact', { matches }), undefined);
});

test('isProgressPluginPackage matches the package name, version tags, and local paths', () => {
  assert.equal(isProgressPluginPackage(PACKAGE), true);
  assert.equal(isProgressPluginPackage('@jakedowns/progress-tool-opencode-plugin'), true);
  assert.equal(isProgressPluginPackage('some-other-plugin'), false);

  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@jakedowns/progress-tool-opencode-plugin' })
  );
  assert.equal(isProgressPluginPackage(dir), true);
  assert.equal(isProgressPluginPackage('.', dir), true);
});

test('config candidates prefer the project and then the global config', () => {
  const project = path.join(path.sep, 'tmp', 'project');
  const home = path.join(path.sep, 'tmp', 'home');
  const candidates = treeThemeConfigCandidates(project, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  });
  assert.deepEqual(candidates, [
    path.join(project, 'opencode.json'),
    path.join(project, 'opencode.jsonc'),
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  ]);
  assert.equal(
    globalConfigDir({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') }),
    path.join(home, 'xdg', 'opencode')
  );
});

test('writeTreeThemeToConfig edits the project config first', () => {
  const project = tempDir();
  const home = tempDir('progress-tree-theme-home-');
  const projectConfig = path.join(project, 'opencode.json');
  const globalConfig = path.join(globalConfigDir(envFor(home)), 'opencode.json');
  fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
  fs.writeFileSync(
    globalConfig,
    JSON.stringify({ plugins: [{ package: PACKAGE, options: { treeTheme: 'default' } }] })
  );
  fs.writeFileSync(
    projectConfig,
    JSON.stringify(
      { plugins: [{ package: PACKAGE, options: { say: true } }] },
      null,
      2
    )
  );

  const result = writeTreeThemeToConfig('compact', {
    directory: project,
    env: envFor(home),
  });
  assert.equal(result.ok, true);
  assert.equal(result.file, projectConfig);
  assert.equal(JSON.parse(fs.readFileSync(projectConfig, 'utf8')).plugins[0].options.treeTheme, 'compact');
  assert.equal(
    JSON.parse(fs.readFileSync(globalConfig, 'utf8')).plugins[0].options.treeTheme,
    'default',
    'global config stays untouched when the project config wins'
  );
});

test('writeTreeThemeToConfig falls back to the global config', () => {
  const project = tempDir();
  const home = tempDir('progress-tree-theme-home-');
  const env = envFor(home);
  const globalConfig = path.join(globalConfigDir(env), 'opencode.json');
  fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
  fs.writeFileSync(
    globalConfig,
    JSON.stringify({ plugins: [{ package: PACKAGE, options: {} }] }, null, 2)
  );
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ theme: 'dark' }));

  const result = writeTreeThemeToConfig('compact', { directory: project, env });
  assert.equal(result.ok, true);
  assert.equal(result.file, globalConfig);
  assert.equal(JSON.parse(fs.readFileSync(globalConfig, 'utf8')).plugins[0].options.treeTheme, 'compact');
});

test('writeTreeThemeToConfig reports when no plugin entry exists and normalizes the theme', () => {
  const project = tempDir();
  const home = tempDir('progress-tree-theme-home-');
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ theme: 'dark' }));

  const result = writeTreeThemeToConfig('nonsense', { directory: project, env: envFor(home) });
  assert.equal(result.ok, false);
  assert.equal(result.theme, 'default');
  assert.match(result.error, /no OpenCode config entry/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8')), {
    theme: 'dark',
  });
});
