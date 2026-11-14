'use strict';

const assert = require('node:assert');
const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const { getTree } = require(path.join(ROOT, 'state-store'));

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-smoke-'));
  return { dir, file: path.join(dir, 'state.json') };
}

function stateEnv(file, extra = {}) {
  const env = { ...process.env, PROGRESS_STATE_PATH: file };
  // Keep the suite deterministic even when it runs under OpenCode (which sets
  // OPENCODE_SESSION_ID for the harness session itself).
  delete env.PROGRESS_SESSION_ID;
  delete env.OPENCODE_SESSION_ID;
  return { ...env, ...extra };
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [INDEX, ...args], {
    encoding: 'utf8',
    env: stateEnv(options.state, options.env),
    input: options.input,
    timeout: 10000,
  });
}

test('emit writes one milestone without touching stdin', () => {
  const { file } = tempState();
  const result = run(
    ['emit', '--id', 'emit-1', '--status', 'running', '--title', 'Emit', '--detail', 'hello', '--progress', '25%'],
    { state: file }
  );

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['emit-1'];
  assert.equal(entry.id, 'emit-1');
  assert.equal(entry.status, 'running');
  assert.equal(entry.title, 'Emit');
  assert.equal(entry.detail, 'hello');
  assert.equal(entry.progress, 0.25);
  assert.ok(entry.startedAt);
});

test('emit normalizes escaped newlines and HTML breaks in title/detail', () => {
  const { file } = tempState();
  const result = run(
    [
      'emit',
      '--id',
      'lines-1',
      '--status',
      'running',
      '--title',
      'Line one\\nLine two',
      '--detail',
      'alpha\\nbeta<br>gamma\\r\\ndelta\\u000aepsilon',
    ],
    { state: file }
  );

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['lines-1'];
  assert.equal(entry.title, 'Line one\nLine two');
  assert.equal(entry.detail, 'alpha\nbeta\ngamma\ndelta\nepsilon');
});

test('emit resolves session scope from explicit flag, then environment', () => {
  const { file } = tempState();

  run(['emit', '--id', 'scoped-explicit', '--status', 'running', '--title', 'Explicit'], {
    state: file,
    env: { OPENCODE_SESSION_ID: 'env-session' },
  });
  run(['emit', '--id', 'scoped-override', '--session', 'flag-session', '--status', 'running', '--title', 'Override'], {
    state: file,
    env: { OPENCODE_SESSION_ID: 'env-session' },
  });
  run(['emit', '--id', 'scoped-env', '--status', 'running', '--title', 'Env'], {
    state: file,
    env: { PROGRESS_SESSION_ID: 'progress-session', OPENCODE_SESSION_ID: 'env-session' },
  });

  const state = readState(file);
  assert.equal(state.entries['env-session:scoped-explicit'].id, 'scoped-explicit');
  assert.equal(state.entries['env-session:scoped-explicit'].sessionId, 'env-session');
  assert.equal(state.entries['flag-session:scoped-override'].sessionId, 'flag-session');
  assert.equal(
    state.entries['progress-session:scoped-env'].sessionId,
    'progress-session'
  );
});

test('pipe mode tees output and marks done on EOF', () => {
  const { file } = tempState();
  const result = run(['relay', '--id', 'pipe-1'], {
    state: file,
    input: 'step 1\n45%\nfinished\n',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /45%/);
  const entry = readState(file).entries['pipe-1'];
  assert.equal(entry.status, 'done');
  assert.equal(entry.progress, 1);
  assert.equal(entry.detail, 'finished');
});

test('pipe mode flushes a final line without a trailing newline', () => {
  const { file } = tempState();
  const result = run(['relay', '--id', 'pipe-nolf'], {
    state: file,
    input: 'last line 72%',
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['pipe-nolf'];
  assert.equal(entry.status, 'done');
  assert.equal(entry.detail, 'last line 72%');
});

test('wrap mode captures a failing exit code and leaves parsed progress', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'wrap-fail', '--', 'bash', '-c', 'echo "working 6/10"; echo "boom" >&2; exit 3'],
    { state: file }
  );

  assert.equal(result.status, 3);
  const entry = readState(file).entries['wrap-fail'];
  assert.equal(entry.status, 'error');
  assert.equal(entry.progress, 0.6);
  assert.match(entry.detail, /boom/);
  assert.match(entry.detail, /exit 3/);
});

test('wrap mode marks a successful command done at 100%', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'wrap-ok', '--title', 'Build', '--', 'bash', '-c', 'echo "compiling 50%"; echo "done"'],
    { state: file }
  );

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['wrap-ok'];
  assert.equal(entry.status, 'done');
  assert.equal(entry.progress, 1);
  assert.equal(entry.title, 'Build');
});

test('relay preserves fields set earlier by the MCP tool', () => {
  const { file } = tempState();
  run(['emit', '--id', 'attach-1', '--status', 'running', '--title', 'Agent title', '--parent', 'root'], {
    state: file,
  });

  run(['relay', '--id', 'attach-1', '--quiet'], { state: file, input: '50%\n' });

  const entry = readState(file).entries['attach-1'];
  assert.equal(entry.title, 'Agent title');
  assert.equal(entry.parentId, 'root');
  assert.equal(entry.progress, 1);
});

test('reusing a completed id starts a fresh lifecycle', () => {
  const { file } = tempState();
  run(['emit', '--id', 'reuse-1', '--status', 'done', '--title', 'Build', '--detail', 'old', '--progress', '1'], {
    state: file,
  });
  const first = readState(file).entries['reuse-1'];

  run(['emit', '--id', 'reuse-1', '--status', 'running', '--title', 'Build'], {
    state: file,
  });
  const second = readState(file).entries['reuse-1'];

  assert.equal(second.status, 'running');
  assert.equal(second.progress, null);
  assert.equal(second.detail, null);
  assert.equal(second.title, 'Build');
  assert.ok(second.startedAt >= first.startedAt);
});

test('MCP handshake exposes the zero-polling contract and relay hint', async () => {
  const { file } = tempState();
  const child = spawn(process.execPath, [INDEX], {
    env: stateEnv(file),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {
          id: 'mcp-1',
          status: 'running',
          title: 'MCP task',
          detail: 'starting',
          progress: 0.1,
        },
      },
    },
  ];

  for (const request of requests) {
    child.stdin.write(JSON.stringify(request) + '\n');
  }
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const responses = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(stderr, '');
  assert.equal(responses.length, 3);

  const init = responses.find((r) => r.id === 1);
  assert.equal(init.result.serverInfo.version, '2.1.0');
  assert.match(init.result.instructions, /Never poll, sleep/);
  assert.match(init.result.instructions, /OPENCODE_SESSION_ID/);
  assert.match(init.result.instructions, /line breaks/i);

  const list = responses.find((r) => r.id === 2);
  const tool = list.result.tools[0];
  assert.equal(tool.name, 'progress');
  assert.match(tool.description, /ZERO-POLLING/);
  assert.match(tool.description, /OPENCODE_SESSION_ID/);
  assert.match(tool.description, /LINE BREAKS & LONG TEXT/);
  assert.equal(tool.inputSchema.properties.sessionId.type, 'string');
  assert.match(tool.inputSchema.properties.detail.description, /line breaks/i);

  const call = responses.find((r) => r.id === 3);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /Recorded progress \[mcp-1\]/);
  assert.match(call.result.content[0].text, /relay --id mcp-1/);
  assert.match(call.result.content[0].text, /Do NOT poll/);

  const entry = readState(file).entries['mcp-1'];
  assert.equal(entry.status, 'running');
  assert.equal(entry.progress, 0.1);
});

test('MCP preserves verbose multi-line details instead of flattening them', async () => {
  const { file } = tempState();
  const detail = [
    'glGenFramebuffers returns 0 on the game GL thread since the knob batch.',
    'Reverted composite shader to working text; added glGetError logging around FBO creation.',
    "Suspect: my error-logging edit didn't land in the last build (log missing) - verifying build chain next.",
  ].join('\n');

  const child = spawn(process.execPath, [INDEX], {
    env: stateEnv(file),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {
          id: 'fbo-regression',
          status: 'running',
          title: 'Fixing FBO=0 regression (black boot)',
          detail,
          progress: 0.5,
        },
      },
    },
  ];

  for (const request of requests) {
    child.stdin.write(JSON.stringify(request) + '\n');
  }
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const responses = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(stderr, '');
  const call = responses.find((r) => r.id === 2);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /glGenFramebuffers/);
  assert.match(call.result.content[0].text, /verifying build chain next/);

  const entry = readState(file).entries['fbo-regression'];
  assert.equal(entry.title, 'Fixing FBO=0 regression (black boot)');
  assert.equal(entry.detail, detail);
  assert.equal(entry.progress, 0.5);
});

test('concurrent writers keep the state file valid and complete', async () => {
  const { file } = tempState();
  const jobs = Array.from({ length: 16 }, (_, i) =>
    execFileAsync(
      process.execPath,
      [INDEX, 'emit', '--id', `concurrent-${i}`, '--status', 'running', '--title', `Task ${i}`],
      { env: stateEnv(file) }
    )
  );

  await Promise.all(jobs);

  const state = readState(file);
  assert.equal(Object.keys(state.entries).length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(state.entries[`concurrent-${i}`].title, `Task ${i}`);
  }
});

test('concurrent sessions using the same task IDs stay isolated', async () => {
  const { file } = tempState();
  const jobs = [
    ['session-a', 'build-1', 'Build A', 'running', null],
    ['session-a', 'test-1', 'Test A', 'done', 'build-1'],
    ['session-b', 'build-1', 'Build B', 'running', null],
    ['session-b', 'test-1', 'Test B', 'error', 'build-1'],
  ].map(([session, id, title, status, parent]) =>
    execFileAsync(
      process.execPath,
      [
        INDEX,
        'emit',
        '--session',
        session,
        '--id',
        id,
        '--status',
        status,
        '--title',
        title,
        ...(parent ? ['--parent', parent] : []),
      ],
      { env: stateEnv(file) }
    )
  );

  await Promise.all(jobs);

  const state = readState(file);
  assert.deepEqual(
    Object.keys(state.entries).sort(),
    ['session-a:build-1', 'session-a:test-1', 'session-b:build-1', 'session-b:test-1']
  );

  const buildA = state.entries['session-a:build-1'];
  const buildB = state.entries['session-b:build-1'];
  assert.equal(buildA.id, 'build-1');
  assert.equal(buildA.sessionId, 'session-a');
  assert.equal(buildA.title, 'Build A');
  assert.equal(buildB.id, 'build-1');
  assert.equal(buildB.sessionId, 'session-b');
  assert.equal(buildB.title, 'Build B');

  // Clean parent IDs are stored, while sibling lookup is session-scoped.
  assert.equal(state.entries['session-a:test-1'].parentId, 'build-1');
  assert.equal(state.entries['session-b:test-1'].parentId, 'build-1');

  const { tree } = getTree(state);
  const rootA = tree.find((entry) => entry.sessionId === 'session-a' && entry.id === 'build-1');
  const rootB = tree.find((entry) => entry.sessionId === 'session-b' && entry.id === 'build-1');

  assert.equal(rootA.status, 'done');
  assert.deepEqual(rootA.children.map((child) => child.id), ['test-1']);
  assert.equal(rootB.status, 'error');
  assert.deepEqual(rootB.children.map((child) => child.id), ['test-1']);
});
