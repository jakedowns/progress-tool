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

// --- OSC 9;4 structured progress ---

const { makeOsc94Filter, parseOsc94Progress } = require(INDEX.replace(/index\.js$/, 'relay.js'));

test('parseOsc94Progress handles BEL, ST, missing progress, and clamps', () => {
  assert.deepEqual(parseOsc94Progress('\x1b]9;4;1;42\x07'), { state: 1, progress: 0.42 });
  assert.deepEqual(parseOsc94Progress('\x1b]9;4;1;42\x1b\\'), { state: 1, progress: 0.42 });
  assert.deepEqual(parseOsc94Progress('\x1b]9;4;3\x07'), { state: 3, progress: null });
  assert.deepEqual(parseOsc94Progress('\x1b]9;4;1;150\x07'), { state: 1, progress: 1 });
  assert.deepEqual(parseOsc94Progress('\x1b]9;4;2;75\x1b\\'), { state: 2, progress: 0.75 });
  assert.equal(parseOsc94Progress('plain text'), null);
});

test('osc94 filter parses split sequences, multiple per chunk (last wins), and never leaks escape bytes', () => {
  const oscs = [];
  const texts = [];
  const filter = makeOsc94Filter(
    (event) => oscs.push(event),
    (text, meta) => texts.push({ text, meta })
  );

  // A sequence split across two chunks.
  filter('\x1b]9;4;1;4', { hasOsc94: false });
  filter('2\x07 remainder\n', { hasOsc94: false });

  // Two sequences in one chunk: both fire, last one wins.
  filter('\x1b]9;4;1;10\x07\x1b]9;4;1;20\x07', { hasOsc94: false });

  assert.equal(oscs.length, 3);
  assert.deepEqual(oscs[0], { state: 1, progress: 0.42 });
  assert.deepEqual(oscs[2], { state: 1, progress: 0.2 });
  assert.ok(texts.every((t) => !/\x1b/.test(t.text)), 'no escape bytes reach text');
  assert.ok(texts.some((t) => t.text.includes('remainder')));
  assert.ok(texts.every((t) => t.meta.hasOsc94 === true));
});

test('wrap mode: OSC 9;4 BEL sets structured progress, escapes stay out of detail', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'osc-bel', '--quiet', '--', 'bash', '-c', "printf 'step\\n\\e]9;4;1;42\\a'; exit 3"],
    { state: file }
  );

  assert.equal(result.status, 3);
  const entry = readState(file).entries['osc-bel'];
  assert.equal(entry.status, 'error');
  assert.equal(entry.progress, 0.42);
  assert.match(entry.detail, /step/);
  assert.doesNotMatch(entry.detail, /\x1b/);
});

test('wrap mode: OSC 9;4 with ST terminator parses the same way', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'osc-st', '--quiet', '--', 'bash', '-c', "printf '\\e]9;4;1;64\\e\\\\'; echoboom; exit 2"],
    { state: file }
  );

  assert.equal(result.status, 2);
  const entry = readState(file).entries['osc-st'];
  assert.equal(entry.progress, 0.64);
  assert.doesNotMatch(entry.detail, /\x1b/);
});

test('OSC 9;4 takes precedence over text heuristics on the same chunk', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'osc-precedence', '--quiet', '--', 'bash', '-c', "printf '50%%\\e]9;4;1;80\\a'; exit 3"],
    { state: file }
  );

  assert.equal(result.status, 3);
  const entry = readState(file).entries['osc-precedence'];
  // The text "50%" must not compete with the structured 80 in the same chunk.
  assert.equal(entry.progress, 0.8);
});

test('OSC state 2 is provisional: a later exit 0 still reports done', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'osc-err-ok', '--quiet', '--', 'bash', '-c', "printf '\\e]9;4;2;50\\a'; exit 0"],
    { state: file }
  );

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['osc-err-ok'];
  assert.equal(entry.status, 'done');
  assert.equal(entry.progress, 1);
});

test('OSC state 3 (indeterminate) clears a previously parsed percentage', () => {
  const { file } = tempState();
  const result = run(
    [
      'relay',
      '--id',
      'osc-indeterminate',
      '--quiet',
      '--',
      'bash',
      '-c',
      "printf '\\e]9;4;1;42\\a\\e]9;4;3\\a'; exit 3",
    ],
    { state: file }
  );

  assert.equal(result.status, 3);
  const entry = readState(file).entries['osc-indeterminate'];
  assert.equal(entry.progress, null);
});

test('OSC state 0 clears progress; exit mapping still wins at termination', () => {
  const { file } = tempState();
  const result = run(
    ['relay', '--id', 'osc-clear', '--quiet', '--', 'bash', '-c', "printf '\\e]9;4;1;30\\a\\e]9;4;0\\a'; exit 3"],
    { state: file }
  );

  assert.equal(result.status, 3);
  const entry = readState(file).entries['osc-clear'];
  assert.equal(entry.progress, null);
});

test('OSC state 4 (paused) marks waiting mid-run; exit 0 still reports done', async () => {
  const { file } = tempState();
  const child = spawn(
    process.execPath,
    [INDEX, 'relay', '--id', 'osc-wait', '--quiet', '--max-hz', '0', '--', 'bash', '-c', "printf '\\e]9;4;4;30\\a'; sleep 6; exit 0"],
    { env: stateEnv(file), stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // Wait (bounded) for the relay to boot and the OSC state to land, instead
  // of racing a fixed delay against node + bash startup on loaded machines.
  const deadline = Date.now() + 12000;
  let mid = null;
  for (;;) {
    try {
      mid = readState(file).entries['osc-wait'];
    } catch (e) {
      mid = null; // state file not written yet
    }
    if (mid && mid.status === 'waiting') break;
    if (Date.now() > deadline) throw new Error(`timed out waiting for waiting state: ${JSON.stringify(mid)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(mid.status, 'waiting');
  assert.equal(mid.progress, 0.3);

  await new Promise((resolve) => child.on('close', resolve));
  const final = readState(file).entries['osc-wait'];
  assert.equal(final.status, 'done');
  assert.equal(final.progress, 1);
});

test('osc-demo script pipes structured OSC 9;4 progress through the relay end-to-end', () => {
  const { file } = tempState();
  const demo = path.join(ROOT, '..', 'demo', 'osc-demo.sh');

  const result = spawnSync('bash', [demo], {
    encoding: 'utf8',
    env: stateEnv(file),
    timeout: 30000,
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = readState(file).entries['osc-demo'];
  assert.equal(entry.status, 'done');
  assert.equal(entry.progress, 1);
  assert.equal(entry.title, 'OSC 9;4 demo build');
  assert.match(entry.detail, /packaging/);
});

test('tree-demo script builds a nested tree that rolls up to done', () => {
  const { file } = tempState();
  const demo = path.join(ROOT, '..', 'demo', 'tree-demo.sh');

  const result = spawnSync('bash', [demo], {
    encoding: 'utf8',
    env: stateEnv(file),
    timeout: 30000,
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readState(file).entries;
  assert.equal(state['tree-demo'].status, 'done');
  assert.equal(state['tree-demo'].progress, 1);
  for (const child of ['build', 'test-unit', 'test-e2e']) {
    assert.equal(state[child].parentId, 'tree-demo', child);
  }
  assert.equal(state['compile'].parentId, 'build');
  assert.equal(state['link'].parentId, 'build');
});

test('tree-demo failure mode rolls an error up to the parent', () => {
  const { file } = tempState();
  const demo = path.join(ROOT, '..', 'demo', 'tree-demo.sh');

  const result = spawnSync('bash', [demo], {
    encoding: 'utf8',
    env: stateEnv(file, { PROGRESS_TREE_DEMO_FAIL: '1' }),
    timeout: 30000,
  });

  assert.equal(result.status, 1, result.stderr);
  const state = readState(file).entries;
  assert.equal(state['test-e2e'].status, 'error');
  assert.match(state['test-e2e'].detail, /payment regression/);
  assert.equal(state['tree-demo'].status, 'error');
  // Siblings are unaffected by the failing child.
  assert.equal(state['test-unit'].status, 'done');
  assert.equal(state['build'].status, 'done');
});

test('running response nudges the tree for numbered step lists, silently skips plain entries', async () => {
  const { file } = tempState();
  const child = spawn(process.execPath, [INDEX], {
    env: stateEnv(file),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const numberedTitle = ['UI polish batch', '1 changelog tab', '2 slider drag', '3 zero parallax'].join('\n');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {
          id: 'anti-pattern',
          status: 'running',
          title: numberedTitle,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {
          id: 'anti-pattern',
          status: 'running',
          title: numberedTitle,
          progress: 0.15,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {
          id: 'plain-entry',
          status: 'running',
          title: 'Compiling SDL2',
          detail: 'linking libSDL2.a',
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
  const firstOffense = responses.find((r) => r.id === 2);
  assert.equal(firstOffense.result.isError, true, 'first numbered-list call returns an error result');
  assert.match(firstOffense.result.content[0].text, /INVALID USAGE — this entry embeds a numbered step list/);
  assert.match(firstOffense.result.content[0].text, /parentId: "anti-pattern"/);
  assert.match(firstOffense.result.content[0].text, /The update WAS recorded/);

  const repeat = responses.find((r) => r.id === 3);
  assert.equal(repeat.result.isError, false, 'strike is capped: later calls soften to a text tip');
  assert.match(repeat.result.content[0].text, /Tip: a numbered step list inside one entry/);

  const plain = responses.find((r) => r.id === 4);
  assert.equal(plain.result.isError, false);
  assert.doesNotMatch(plain.result.content[0].text, /Tip: a numbered step list/);
  assert.match(plain.result.content[0].text, /relay --id plain-entry/);
});

test('agent writes clear dismissal on the entry and ancestors; relay telemetry preserves it', () => {
  const { file } = tempState();
  const store = require(path.join(ROOT, 'state-store'));

  run(['emit', '--id', 'dismiss-parent', '--status', 'running', '--title', 'Parent'], { state: file });
  run(['emit', '--id', 'dismiss-child', '--status', 'running', '--title', 'Child', '--parent', 'dismiss-parent'], {
    state: file,
  });

  store.mutateState((state) => {
    for (const entry of Object.values(state.entries)) entry.dismissed = { status: 'running', at: 12345 };
    return state;
  }, file);

  // Relay telemetry (source: 'relay') preserves the flags — dismissed running
  // tasks must not resurrect on every 4Hz tick.
  run(['relay', '--id', 'dismiss-child', '--quiet'], { state: file, input: 'tick\n' });
  let entries = readState(file).entries;
  assert.deepEqual(entries['dismiss-child'].dismissed, { status: 'running', at: 12345 });

  // An agent update on the child clears its own flag AND its ancestors'.
  run(['emit', '--id', 'dismiss-child', '--status', 'running', '--detail', 'agent update'], { state: file });
  entries = readState(file).entries;
  assert.equal(entries['dismiss-child'].dismissed ?? null, null);
  assert.equal(entries['dismiss-parent'].dismissed ?? null, null, 'ancestor dismissal cleared by descendant update');
});

test('lifecycle restart clears a stale dismissal', () => {
  const { file } = tempState();
  const store = require(path.join(ROOT, 'state-store'));
  run(['emit', '--id', 'restart-1', '--status', 'done', '--title', 'Task'], { state: file });
  store.mutateState((state) => {
    const entry = Object.values(state.entries).find((e) => e.id === 'restart-1');
    entry.dismissed = { status: 'done', at: 12345 };
    return state;
  }, file);

  run(['emit', '--id', 'restart-1', '--status', 'running'], { state: file });
  const entry = readState(file).entries['restart-1'];
  assert.equal(entry.dismissed ?? null, null);
});

test('bulk entries[] lands a whole tree in one atomic, all-or-nothing write', async () => {
  const { file } = tempState();
  const child = spawn(process.execPath, [INDEX], {
    env: stateEnv(file),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const parent = { id: 'bulk-plan', status: 'running', title: 'Bulk plan' };
  const children = [1, 2, 3].map((n) => ({
    id: `bulk-plan-step-${n}`,
    status: n === 1 ? 'running' : 'waiting',
    title: `Step ${n}`,
    parentId: 'bulk-plan',
  }));
  const badBatch = [
    parent,
    { id: 'no-title', status: 'running' }, // missing title -> whole batch rejected
  ];

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'progress', arguments: { entries: [parent, ...children] } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'progress', arguments: { entries: badBatch } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'progress', arguments: { id: 'both', status: 'running', title: 'Both', entries: [parent] } } },
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
  const okBulk = responses.find((r) => r.id === 2);
  assert.equal(okBulk.result.isError, false);
  assert.match(okBulk.result.content[0].text, /Recorded 4 progress entries in one atomic write/);
  assert.match(okBulk.result.content[0].text, /parent=bulk-plan/);

  const state = readState(file).entries;
  assert.equal(state['bulk-plan'].status, 'running');
  assert.equal(state['bulk-plan-step-1'].status, 'running');
  assert.equal(state['bulk-plan-step-3'].parentId, 'bulk-plan');
  assert.equal(Object.keys(state).length, 4, 'exactly the batch entries exist');

  const badBatchResponse = responses.find((r) => r.id === 3);
  assert.equal(badBatchResponse.result.isError, true, 'invalid batch rejects all-or-nothing');
  assert.match(badBatchResponse.result.content[0].text, /nothing was written/);
  assert.equal(Object.keys(readState(file).entries).length, 4, 'no partial write from the rejected batch');

  const bothForms = responses.find((r) => r.id === 4);
  assert.equal(bothForms.result.isError, true);
  assert.match(bothForms.result.content[0].text, /not both/);
});

test('closing a parent cascades done at 100% to all descendants in the same session', () => {
  const { file } = tempState();
  run(['emit', '--id', 'casc-parent', '--status', 'running', '--title', 'Parent'], { state: file });
  run(['emit', '--id', 'casc-child', '--status', 'running', '--title', 'Child', '--progress', '0.4', '--parent', 'casc-parent'], { state: file });
  run(['emit', '--id', 'casc-grand', '--status', 'waiting', '--title', 'Grandchild', '--parent', 'casc-child'], { state: file });
  run(['emit', '--id', 'casc-other', '--status', 'running', '--title', 'Unrelated'], { state: file });

  run(['emit', '--id', 'casc-parent', '--status', 'done', '--progress', '1'], { state: file });

  const state = readState(file).entries;
  assert.equal(state['casc-parent'].status, 'done');
  assert.equal(state['casc-child'].status, 'done', 'child auto-closed');
  assert.equal(state['casc-child'].progress, 1, 'partial child jumps to 100% when auto-closed');
  assert.match(state['casc-child'].detail, /auto-closed: parent casc-parent completed/);
  assert.equal(state['casc-grand'].status, 'done', 'grandchild cascades recursively');
  assert.equal(state['casc-grand'].progress, 1, 'null progress becomes 100% when auto-closed');
  assert.equal(state['casc-other'].status, 'running', 'unrelated entries are untouched');
});

test('a done parent normalizes stale progress to 100% on a plain MCP-style upsert', () => {
  const { file } = tempState();
  const { upsertProgress } = require(path.join(ROOT, 'state-store'));

  // This test calls the store in-process, so strip the harness session env
  // the way stateEnv() does for subprocesses.
  const envKeys = ['PROGRESS_SESSION_ID', 'OPENCODE_SESSION_ID'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  envKeys.forEach((key) => delete process.env[key]);
  let entry;
  try {
    upsertProgress({ id: 'plain', status: 'running', title: 'Plain', progress: 0.6 }, file);
    // The MCP tool forwards status without a progress field — this is the path
    // that used to leave a "done" root showing 60% in the pill.
    entry = upsertProgress({ id: 'plain', status: 'done' }, file);
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }

  assert.equal(entry.status, 'done');
  assert.equal(entry.progress, 1);
  assert.equal(readState(file).entries['plain'].progress, 1);
});

test('closing a parent leaves errored descendants (and their subtree) unresolved', () => {
  const { file } = tempState();
  run(['emit', '--id', 'err-parent', '--status', 'running', '--title', 'Parent'], { state: file });
  run(['emit', '--id', 'err-child', '--status', 'error', '--title', 'Failed child', '--progress', '0.3', '--parent', 'err-parent'], { state: file });
  run(['emit', '--id', 'err-grand', '--status', 'running', '--title', 'Child of failure', '--parent', 'err-child'], { state: file });
  run(['emit', '--id', 'err-sibling', '--status', 'running', '--title', 'Healthy child', '--progress', '0.7', '--parent', 'err-parent'], { state: file });

  run(['emit', '--id', 'err-parent', '--status', 'done'], { state: file });

  const state = readState(file).entries;
  assert.equal(state['err-parent'].progress, 1, 'parent itself still reads 100%');
  assert.equal(state['err-child'].status, 'error', 'failure is not silently closed');
  assert.equal(state['err-child'].progress, 0.3, 'failure keeps its real progress');
  assert.equal(state['err-grand'].status, 'running', 'error subtree is left for the agent');
  assert.equal(state['err-sibling'].status, 'done');
  assert.equal(state['err-sibling'].progress, 1, 'healthy sibling auto-closes at 100%');

  const { tree } = getTree(readState(file));
  const root = tree.find((n) => n.id === 'err-parent');
  assert.equal(root.status, 'error', 'rolled-up root surfaces the failure');
  assert.ok(root.progress < 1, 'error root keeps an honest partial bar');
});

test('retention is opt-in: nothing pruned by default; both knobs enable it', () => {
  const fs = require('node:fs');
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const seed = (file) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        entries: {
          'old-running': { id: 'old-running', status: 'running', title: 'Orphan', updatedAt: old },
          'old-waiting': { id: 'old-waiting', status: 'waiting', title: 'Paused', updatedAt: old },
          'old-done': { id: 'old-done', status: 'done', title: 'Finished', updatedAt: old },
        },
        version: 2,
      })
    );

  // Default: entries ride forever, for reporting.
  const { file } = tempState();
  seed(file);
  run(['emit', '--id', 'trigger', '--status', 'done', '--title', 'Trigger'], { state: file });
  let entries = readState(file).entries;
  assert.ok(entries['old-running'], 'default keeps old running entries');
  assert.ok(entries['old-waiting'], 'default keeps old waiting entries');
  assert.ok(entries['old-done'], 'default keeps old done entries');

  // Opt in to completed-entry retention.
  const { file: file2 } = tempState();
  seed(file2);
  run(['emit', '--id', 'trigger2', '--status', 'done', '--title', 'Trigger'], {
    state: file2,
    env: { PROGRESS_AUTO_PRUNE_S: '3600' },
  });
  entries = readState(file2).entries;
  assert.equal(entries['old-done'], undefined, 'completed entries pruned when opted in');
  assert.ok(entries['old-running'], 'running entries unaffected by TTL');

  // Opt in to the running-orphan sweep.
  const { file: file3 } = tempState();
  seed(file3);
  run(['emit', '--id', 'trigger3', '--status', 'done', '--title', 'Trigger'], {
    state: file3,
    env: { PROGRESS_STALE_MS: '3600000' },
  });
  entries = readState(file3).entries;
  assert.equal(entries['old-running'], undefined, 'stale running entry swept when opted in');
  assert.ok(entries['old-waiting'], 'waiting entries are never swept');
});

test('terminal dismissal survives terminal re-reports; non-terminal dismissal clears on any agent update', () => {
  const { file } = tempState();
  const store = require(path.join(ROOT, 'state-store'));

  // Dismissed while DONE → later done/error re-reports are not news.
  run(['emit', '--id', 'term-1', '--status', 'done', '--title', 'Finished'], { state: file });
  store.mutateState((state) => {
    const entry = Object.values(state.entries).find((e) => e.id === 'term-1');
    entry.dismissed = { status: 'done', at: 12345 };
    return state;
  }, file);
  run(['emit', '--id', 'term-1', '--status', 'done', '--detail', 're-confirmed'], { state: file });
  assert.deepEqual(
    readState(file).entries['term-1'].dismissed,
    { status: 'done', at: 12345 },
    'terminal dismissal preserved through a terminal re-report'
  );

  // A lifecycle restart still revives it.
  run(['emit', '--id', 'term-1', '--status', 'running'], { state: file });
  assert.equal(readState(file).entries['term-1'].dismissed ?? null, null);

  // Dismissed while RUNNING → closing it counts as an update and revives.
  run(['emit', '--id', 'run-1', '--status', 'running', '--title', 'Working'], { state: file });
  store.mutateState((state) => {
    const entry = Object.values(state.entries).find((e) => e.id === 'run-1');
    entry.dismissed = { status: 'running', at: 67890 };
    return state;
  }, file);
  run(['emit', '--id', 'run-1', '--status', 'done'], { state: file });
  assert.equal(readState(file).entries['run-1'].dismissed ?? null, null, 'completion revives a running-state dismissal');
});

test('list tool reads session trees; dismissed hidden by default', async () => {
  const { file } = tempState();
  run(['emit', '--id', 'root-a', '--status', 'running', '--title', 'Root A', '--progress', '0.4'], { state: file });
  run(['emit', '--id', 'child-a', '--status', 'waiting', '--title', 'Child A', '--parent', 'root-a'], { state: file });
  run(['emit', '--id', 'muted', '--status', 'running', '--title', 'Muted task'], { state: file });
  run(['emit', '--id', 'done-a', '--status', 'done', '--title', 'Finished task'], { state: file });
  const store = require(path.join(ROOT, 'state-store'));
  store.mutateState((state) => {
    const entry = Object.values(state.entries).find((e) => e.id === 'muted');
    entry.dismissed = { status: 'running', at: 1 };
    return state;
  }, file);

  const child = spawn(process.execPath, [INDEX], { env: stateEnv(file), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list', arguments: { includeDismissed: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list', arguments: { includeTerminal: false, parentId: 'root-a' } } },
  ];
  for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const responses = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(stderr, '');
  const list = responses.find((r) => r.id === 2);
  const listText = list.result.content[0].text;
  assert.match(listText, /scope=session/);
  assert.match(listText, /- \[root-a\] \(running\) 40% Root A/);
  assert.match(listText, /  - \[child-a\] \(waiting\)/);
  assert.doesNotMatch(listText, /Muted task/, 'dismissed hidden by default');

  const widened = responses.find((r) => r.id === 3).result.content[0].text;
  assert.match(widened, /Muted task/);
  assert.match(widened, /dismissed/);

  const openOnly = responses.find((r) => r.id === 4).result.content[0].text;
  assert.match(openOnly, /root-a/);
  assert.match(openOnly, /child-a/, 'waiting entries are not terminal');
  assert.doesNotMatch(openOnly, /Finished task/, 'done entries excluded when includeTerminal=false');
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
  assert.equal(init.result.serverInfo.version, '2.8.0');
  assert.match(init.result.instructions, /Never poll, sleep/);
  assert.match(init.result.instructions, /OPENCODE_SESSION_ID/);
  assert.match(init.result.instructions, /line breaks/i);

  const list = responses.find((r) => r.id === 2);
  const tool = list.result.tools[0];
  assert.equal(tool.name, 'progress');
  assert.ok(
    !(tool.inputSchema.required ?? []).includes('id'),
    'top-level id must not be required: entries[]-only bulk calls must validate'
  );
  assert.deepEqual(tool.inputSchema.properties.entries.items.required, ['id', 'status', 'title']);
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

// --- Subagent session attribution -------------------------------------------

async function mcpSession(stateFile, env, requests) {
  const child = spawn(process.execPath, [INDEX], {
    env: stateEnv(stateFile, env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(stderr, '');
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeSessionMap(dir, links) {
  const file = path.join(dir, 'sessions.json');
  const map = {};
  for (const [child, parentId] of Object.entries(links)) {
    map[child] = { parentId, at: Date.now() };
  }
  fs.writeFileSync(file, JSON.stringify({ links: map }));
  return file;
}

test('resolveParentSession follows chains, stops at cycles, and ignores unknowns', () => {
  const { resolveParentSession } = require(path.join(ROOT, 'state-store'));
  const map = {
    'child-b': { parentId: 'child-a' },
    'child-a': { parentId: 'parent' },
  };
  assert.equal(resolveParentSession('child-b', map), 'parent');
  assert.equal(resolveParentSession('child-a', map), 'parent');
  assert.equal(resolveParentSession('root', map), 'root');

  const cyclic = { x: { parentId: 'y' }, y: { parentId: 'x' } };
  const resolved = resolveParentSession('x', cyclic);
  assert.ok(resolved === 'x' || resolved === 'y');
  assert.equal(resolveParentSession(null, map), null);
});

test('a subagent MCP call writes under the parent and adopts earlier child entries', async () => {
  const { dir, file } = tempState();
  const mapFile = writeSessionMap(dir, { child: 'parent' });

  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      entries: {
        'child:early': {
          id: 'early',
          sessionId: 'child',
          status: 'running',
          title: 'Early child milestone',
          createdAt: now,
          updatedAt: now,
        },
      },
    })
  );

  const responses = await mcpSession(
    file,
    { PROGRESS_SESSION_MAP_PATH: mapFile },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'progress',
          arguments: { id: 'late', status: 'done', title: 'Late child milestone' },
          _meta: { 'ai.opencode/sessionID': 'child' },
        },
      },
    ]
  );

  assert.ok(responses.find((response) => response.id === 2).result);
  const state = readState(file);
  assert.deepEqual(Object.keys(state.entries).sort(), ['parent:early', 'parent:late']);
  assert.equal(state.entries['parent:early'].sessionId, 'parent');
  assert.equal(state.entries['parent:late'].sessionId, 'parent');
  assert.equal(state.entries['parent:late'].status, 'done');
});

test('list called from a mapped child session shows the parent scope', async () => {
  const { dir, file } = tempState();
  const mapFile = writeSessionMap(dir, { child: 'parent' });

  await mcpSession(file, { PROGRESS_SESSION_MAP_PATH: mapFile }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: { id: 'shared', status: 'running', title: 'Shared work' },
        _meta: { 'ai.opencode/sessionID': 'parent' },
      },
    },
  ]);

  const responses = await mcpSession(file, { PROGRESS_SESSION_MAP_PATH: mapFile }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'list',
        arguments: {},
        _meta: { 'ai.opencode/sessionID': 'child' },
      },
    },
  ]);

  const text = responses.find((response) => response.id === 2).result.content[0].text;
  assert.match(text, /\[shared\]/);
  assert.doesNotMatch(text, /No progress entries/);
});
