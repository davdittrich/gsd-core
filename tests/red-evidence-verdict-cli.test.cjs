'use strict';

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, runGit } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { routeTaskCommand } = require('../gsd-core/bin/lib/task-command-router.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const BASE = '1'.repeat(40);
const RED = '2'.repeat(40);

function contract(target = 'tests/red receipt Ω\ncase.test.cjs', type = 'auto') {
  return `<task type="${type}" tdd="true">
  <files>src/task-command-router.cts, ${target}</files>
  <behavior>capture once</behavior>
  <red_contract>
    <target_test>${target}</target_test>
    <implementation_target>src/task-command-router.cts</implementation_target>
    <expected_failure>
      <class_or_mode>assertion_failure</class_or_mode><phase>test</phase>
      <subject>capture once and consume bounded task-bound RED receipt without rerun</subject>
    </expected_failure>
  </red_contract>
</task>`;
}

function planText(target, selectedType = 'auto') {
  return [
    contract('tests/decoy.test.cjs'),
    '<task type="checkpoint:human-verify"><name>middle</name></task>',
    contract(target, selectedType),
  ].join('\n');
}

function trailer(target, exitStatus = 1) {
  return `red-evidence: ${JSON.stringify({
    command: 'printf never-executed-trailer-command',
    exit_status: exitStatus,
    target_test: target,
    expected: {
      phase: 'test',
      class_or_mode: 'assertion_failure',
      subject: 'capture once and consume bounded task-bound RED receipt without rerun',
    },
    actual: { phase: 'test', class_or_mode: 'assertion_failure', subject: target },
    location: {
      declared: { file: 'src/task-command-router.cts', line: 1 },
      observed: { file: 'src/task-command-router.cts', line: 1 },
    },
  })}`;
}

function createProject(t, target = 'tests/red receipt Ω\ncase.test.cjs', selectedType = 'auto') {
  const root = createTempDir('red-receipt-project-');
  fs.mkdirSync(path.join(root, '.planning'));
  fs.mkdirSync(path.join(root, '.git'));
  const plan = '.planning/02 plan Ω\nPLAN.md';
  fs.writeFileSync(path.join(root, plan), planText(target, selectedType));
  t.after(() => cleanup(root));
  return { root, plan, target };
}

function result(exitCode = 0, overrides = {}) {
  return { exitCode, stdout: '', stderr: '', signal: null, error: null, timedOut: false, ...overrides };
}

function gitSeam(root, target, options = {}) {
  const parent = options.parent ?? BASE;
  const parentLine = options.parentLine ?? `${RED} ${parent}`;
  const changed = options.changed ?? target;
  const changedOutput = options.changedOutput ?? `${changed}\0`;
  const failures = options.failures ?? [];
  return (program, argv, execOptions) => {
    assert.equal(program, 'git');
    assert.equal(execOptions.cwd, fs.realpathSync(root));
    if (failures.some((prefix) => argv.join(' ').startsWith(prefix))) {
      return result(1, { stderr: 'sensitive git fault' });
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-dir')) {
      return result(0, { stdout: `${path.join(root, '.git')}\n` });
    }
    if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') return result(0, { stdout: `${BASE}\n` });
    if (argv[0] === 'rev-list') return result(0, { stdout: `${parentLine}\n` });
    if (argv[0] === 'diff-tree') return result(0, { stdout: changedOutput });
    throw new Error(`unexpected git argv: ${JSON.stringify(argv)}`);
  };
}

function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const original = fs.writeSync.bind(fs);
  const write = mock.method(fs, 'writeSync', (fd, buffer, ...rest) => {
    if (fd === 1 || fd === 2) {
      const value = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
      (fd === 1 ? stdout : stderr).push(value);
      return Buffer.byteLength(value);
    }
    return original(fd, buffer, ...rest);
  });
  let thrown = null;
  try { fn(); } catch (err) { thrown = err; } finally { write.mock.restore(); }
  return { stdout: stdout.join(''), stderr: stderr.join(''), thrown };
}

function routeCapture(project, execToolFn, extra = {}) {
  return captureOutput(() => routeTaskCommand({
    args: ['task', 'red-evidence-capture', '--task-file', project.plan, '--task-index', '3', '--',
      'node', '--test', project.target],
    cwd: project.root,
    raw: true,
    execToolFn,
    gitToolFn: gitSeam(project.root, project.target),
    ...extra,
  }));
}

function routeVerdict(project, exitStatus = 1, extra = {}) {
  return captureOutput(() => routeTaskCommand({
    args: ['task', 'red-evidence-verdict', '--task-file', project.plan, '--task-index', '3',
      '--red-sha', RED, '--trailer', trailer(project.target, exitStatus)],
    cwd: project.root,
    raw: true,
    execToolFn: () => { throw new Error('verdict must not execute a test'); },
    gitToolFn: gitSeam(project.root, project.target),
    ...extra,
  }));
}

function receiptFiles(root) {
  return fs.readdirSync(path.join(root, '.git'))
    .filter((name) => name.startsWith('gsd-red-evidence-') && name.endsWith('.json'));
}

function receiptArtifacts(root) {
  return fs.readdirSync(path.join(root, '.git')).filter((name) => name.startsWith('gsd-red-evidence-'));
}

describe('task red-evidence-capture — explicit vector and bounded receipt', () => {
  test('executes post-sentinel argv once and persists metadata only', (t) => {
    const project = createProject(t);
    const calls = [];
    const captured = routeCapture(project, (program, argv, options) => {
      calls.push({ program, argv, options });
      return result(1, { stdout: 'stdout-secret', stderr: 'stderr-secret' });
    });

    assert.equal(captured.thrown, null, captured.stderr);
    assert.deepEqual(calls, [{
      program: 'node', argv: ['--test', project.target],
      options: { cwd: fs.realpathSync(project.root), timeout: 30_000 },
    }]);
    assert.doesNotMatch(captured.stdout + captured.stderr, /stdout-secret|stderr-secret/);
    const files = receiptFiles(project.root);
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(project.root, '.git', files[0]), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), [
      'error', 'exit_status', 'plan', 'pre_red_head', 'signal', 'stderr_bytes',
      'stdout_bytes', 'target', 'task_index', 'timed_out', 'version',
    ]);
    assert.equal(stored.stdout_bytes, Buffer.byteLength('stdout-secret'));
    assert.equal(stored.stderr_bytes, Buffer.byteLength('stderr-secret'));
    assert.doesNotMatch(JSON.stringify(stored), /stdout-secret|stderr-secret|--test|argv|env/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(project.root, '.git', files[0])).mode & 0o777, 0o600);
    }
  });

  test('sets restrictive mode before atomic publication inside the worktree git-dir', (t) => {
    const project = createProject(t);
    const events = [];
    const fsFn = Object.create(fs);
    fsFn.openSync = (...args) => { events.push(['open', args[1], args[2]]); return fs.openSync(...args); };
    fsFn.fchmodSync = (...args) => { events.push(['fchmod', args[1]]); return fs.fchmodSync(...args); };
    fsFn.renameSync = (...args) => { events.push(['rename', ...args]); return fs.renameSync(...args); };
    const captured = routeCapture(project, () => result(1), { fsFn });
    assert.equal(captured.thrown, null, captured.stderr);
    assert.deepEqual(events[0], ['open', 'wx', 0o600]);
    assert.deepEqual(events[1], ['fchmod', 0o600]);
    assert.equal(events[2][0], 'rename');
    for (const publishedPath of events[2].slice(1)) {
      assert.equal(path.dirname(publishedPath), path.join(project.root, '.git'));
    }
  });

  test('rejects malformed grammar, target ambiguity, invalid selection, and NUL before execution', (t) => {
    const project = createProject(t);
    const base = ['task', 'red-evidence-capture', '--task-file', project.plan, '--task-index', '3', '--',
      'node', '--test', project.target];
    const invalid = [
      base.filter((arg) => arg !== '--'),
      base.slice(0, 7),
      [...base, project.target],
      base.map((arg) => arg === project.target ? `${arg}\0x` : arg),
      base.map((arg) => arg === '3' ? '0' : arg),
      base.map((arg) => arg === '3' ? '2' : arg),
      [...base.slice(0, 4), '--task-file', project.plan, ...base.slice(4)],
      base.map((arg) => arg === project.target ? `${project.target}.other` : arg),
    ];
    for (const args of invalid) {
      let calls = 0;
      const out = captureOutput(() => routeTaskCommand({
        args, cwd: project.root, raw: true,
        execToolFn: () => { calls++; return result(1); },
        gitToolFn: gitSeam(project.root, project.target),
      }));
      assert.ok(out.thrown instanceof ExitError, `${JSON.stringify(args)} should fail`);
      assert.equal(calls, 0);
    }

    const programTarget = createProject(t, 'node');
    const programOnly = captureOutput(() => routeTaskCommand({
      args: ['task', 'red-evidence-capture', '--task-file', programTarget.plan, '--task-index', '3', '--',
        'node', '--test', 'tests/other.test.cjs'],
      cwd: programTarget.root,
      raw: true,
      execToolFn: () => { throw new Error('target-as-program must not execute'); },
      gitToolFn: gitSeam(programTarget.root, programTarget.target),
    }));
    assert.ok(programOnly.thrown instanceof ExitError);
  });
});

describe('task red-evidence-verdict — consume without rerun', () => {
  test('authorizes bound RED parent and consumes receipt exactly once', (t) => {
    const project = createProject(t, 'tests/receipt.test.cjs', 'tracer');
    assert.equal(routeCapture(project, () => result(1, { stderr: 'expected failure' })).thrown, null);
    assert.equal(receiptFiles(project.root).length, 1);

    const verdict = routeVerdict(project);
    assert.equal(verdict.thrown, null, verdict.stderr);
    assert.equal(JSON.parse(verdict.stdout).verdict, 'authorize');
    assert.equal(receiptFiles(project.root).length, 0);

    const replay = routeVerdict(project);
    assert.equal(replay.thrown, null, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).verdict, 'red_commit_not_failing');
  });

  test('maps zero exit distinctly and rejects signal, timeout, error, and stale parent', (t) => {
    const rows = [
      { captured: result(0), trailerExit: 0, expected: 'unexpected_pass' },
      { captured: result(1, { signal: 'SIGTERM' }), trailerExit: 1, expected: 'red_commit_not_failing' },
      { captured: result(1, { timedOut: true }), trailerExit: 1, expected: 'red_commit_not_failing' },
      { captured: result(1, { error: new Error('secret argv env buffer failure') }), trailerExit: 1, expected: 'red_commit_not_failing' },
    ];
    for (const [index, row] of rows.entries()) {
      const project = createProject(t, `tests/process-${index}.test.cjs`);
      routeCapture(project, () => row.captured);
      const verdict = routeVerdict(project, row.trailerExit);
      assert.equal(JSON.parse(verdict.stdout).verdict, row.expected);
      assert.doesNotMatch(verdict.stdout + verdict.stderr, /secret argv env buffer failure/);
      assert.equal(receiptFiles(project.root).length, 0);
    }

    const stale = createProject(t, 'tests/stale.test.cjs');
    routeCapture(stale, () => result(1));
    const verdict = routeVerdict(stale, 1, {
      gitToolFn: gitSeam(stale.root, stale.target, { parent: '3'.repeat(40) }),
    });
    assert.equal(JSON.parse(verdict.stdout).verdict, 'red_commit_not_failing');
    assert.equal(receiptFiles(stale.root).length, 0);
  });

  test('rejects malformed/cross-task receipts, Git faults, and missing receipts', (t) => {
    const mutations = [
      (stored) => ({ ...stored, task_index: 1 }),
      (stored) => ({ ...stored, target: 'tests/other.test.cjs' }),
      (stored) => ({ ...stored, unexpected: true }),
      () => '{',
      () => 'SECRET_TOKEN_not_json',
    ];
    for (const [index, mutate] of mutations.entries()) {
      const project = createProject(t, `tests/tamper-${index}.test.cjs`);
      routeCapture(project, () => result(1));
      const receiptPath = path.join(project.root, '.git', receiptFiles(project.root)[0]);
      const next = mutate(JSON.parse(fs.readFileSync(receiptPath, 'utf8')));
      fs.writeFileSync(receiptPath, typeof next === 'string' ? next : JSON.stringify(next));
      const verdict = routeVerdict(project);
      assert.equal(JSON.parse(verdict.stdout).verdict, 'red_commit_not_failing');
      assert.equal(receiptFiles(project.root).length, 0);
    }

    const gitFault = createProject(t, 'tests/git-fault.test.cjs');
    routeCapture(gitFault, () => result(1));
    const failed = routeVerdict(gitFault, 1, {
      gitToolFn: gitSeam(gitFault.root, gitFault.target, { failures: ['rev-list'] }),
    });
    assert.equal(JSON.parse(failed.stdout).verdict, 'red_commit_not_failing');
    assert.doesNotMatch(failed.stdout + failed.stderr, /sensitive git fault/);
    assert.equal(receiptFiles(gitFault.root).length, 0);

    const invalidGitRows = [
      { parentLine: RED },
      { parentLine: `${RED} ${BASE} ${'3'.repeat(40)}` },
      { parentLine: `${RED} ${RED}` },
      { parentLine: `${'4'.repeat(40)} ${BASE}` },
      { changed: 'tests/decoy.test.cjs' },
      { changedOutput: 'tests/not-nul-delimited.test.cjs' },
    ];
    for (const [index, options] of invalidGitRows.entries()) {
      const project = createProject(t, `tests/git-shape-${index}.test.cjs`);
      routeCapture(project, () => result(1));
      const rejected = routeVerdict(project, 1, {
        gitToolFn: gitSeam(project.root, project.target, options),
      });
      assert.equal(JSON.parse(rejected.stdout).verdict, 'red_commit_not_failing');
      assert.equal(receiptFiles(project.root).length, 0);
    }

    const absent = createProject(t, 'tests/absent.test.cjs');
    assert.equal(JSON.parse(routeVerdict(absent).stdout).verdict, 'red_commit_not_failing');
  });

  test('rejects escaping/broken symlinks and terminal unlink failure', (t) => {
    const project = createProject(t, 'tests/symlink.test.cjs');
    routeCapture(project, () => result(1));
    const receiptPath = path.join(project.root, '.git', receiptFiles(project.root)[0]);
    fs.unlinkSync(receiptPath);
    const outside = path.join(project.root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, receiptPath);
    assert.equal(JSON.parse(routeVerdict(project).stdout).verdict, 'red_commit_not_failing');
    assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
    assert.throws(() => fs.lstatSync(receiptPath), { code: 'ENOENT' });
    fs.symlinkSync(path.join(project.root, 'missing.json'), receiptPath);
    assert.equal(JSON.parse(routeVerdict(project).stdout).verdict, 'red_commit_not_failing');
    assert.throws(() => fs.lstatSync(receiptPath), { code: 'ENOENT' });

    const unlink = createProject(t, 'tests/unlink.test.cjs');
    routeCapture(unlink, () => result(1));
    const fsFn = Object.create(fs);
    fsFn.unlinkSync = () => { throw new Error('secret unlink'); };
    const unlinkFailure = routeVerdict(unlink, 1, { fsFn });
    assert.equal(JSON.parse(unlinkFailure.stdout).verdict, 'red_commit_not_failing');
    assert.doesNotMatch(unlinkFailure.stdout + unlinkFailure.stderr, /secret unlink/);

    const deleted = createProject(t, 'tests/deleted-after-claim.test.cjs');
    routeCapture(deleted, () => result(1));
    const deletingFs = Object.create(fs);
    deletingFs.readFileSync = (filePath, ...args) => {
      const value = fs.readFileSync(filePath, ...args);
      if (path.basename(filePath).endsWith('.claim')) fs.unlinkSync(filePath);
      return value;
    };
    const deletedVerdict = routeVerdict(deleted, 1, { fsFn: deletingFs });
    assert.equal(JSON.parse(deletedVerdict.stdout).verdict, 'red_commit_not_failing');
  });
});

describe('receipt filesystem faults', () => {
  test('open, short-write, chmod, fsync, rename, cleanup, and collision fail closed', (t) => {
    const rows = [
      ['openSync', () => { throw new Error('secret open'); }],
      ['writeSync', () => 1],
      ['fchmodSync', () => { throw new Error('secret chmod'); }],
      ['fsyncSync', () => { throw new Error('secret fsync'); }],
      ['renameSync', () => { throw new Error('secret rename'); }],
    ];
    for (const [index, [method, replacement]] of rows.entries()) {
      const project = createProject(t, `tests/fs-${index}.test.cjs`);
      const fsFn = Object.create(fs);
      fsFn[method] = replacement;
      if (method !== 'openSync') fsFn.unlinkSync = () => { throw new Error('secret cleanup'); };
      const captured = routeCapture(project, () => result(1, { stderr: 'secret child output' }), { fsFn });
      assert.ok(captured.thrown instanceof ExitError, `${method} must fail closed`);
      assert.doesNotMatch(captured.stdout + captured.stderr, /secret|--test|argv|env/);
      assert.equal(receiptFiles(project.root).length, 0);
      if (method !== 'openSync') assert.equal(receiptArtifacts(project.root).length, 1);
    }

    const collision = createProject(t, 'tests/collision.test.cjs');
    routeCapture(collision, () => result(1));
    let calls = 0;
    const second = routeCapture(collision, () => { calls++; return result(1); });
    assert.ok(second.thrown instanceof ExitError);
    assert.equal(calls, 0);

    const readFault = createProject(t, 'tests/read-fault.test.cjs');
    routeCapture(readFault, () => result(1));
    const fsFn = Object.create(fs);
    fsFn.readFileSync = (filePath, ...args) => {
      if (path.basename(filePath).startsWith('gsd-red-evidence-')) {
        throw new Error('secret receipt read');
      }
      return fs.readFileSync(filePath, ...args);
    };
    const failedRead = routeVerdict(readFault, 1, { fsFn });
    assert.equal(JSON.parse(failedRead.stdout).verdict, 'red_commit_not_failing');
    assert.doesNotMatch(failedRead.stdout + failedRead.stderr, /secret receipt read/);
    assert.equal(receiptFiles(readFault.root).length, 0);
  });
});

describe('public CLI receipt lifecycle', () => {
  function git(root, args) {
    const out = runGit(args, {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.equal(out.exitCode, 0, out.stderr);
    return out.stdout.trim();
  }

  test('real capture is consumed after a RED commit without executing command text', (t) => {
    const root = createTempDir('red-receipt-public-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning'));
    git(root, ['init', '-q']);
    const target = 'tests/public receipt Ω.test.cjs';
    const plan = '.planning/02 public plan.md';
    fs.writeFileSync(path.join(root, plan), contract(target));
    git(root, ['add', '--', plan]);
    git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);

    const captured = runNode([
      GSD_TOOLS, 'query', 'task', 'red-evidence-capture', '--project-dir', root,
      '--task-file', plan, '--task-index', '1', '--', process.execPath, '--eval',
      'process.stdout.write("raw-public-out");process.stderr.write("raw-public-err");process.exit(1)', target,
    ], { cwd: root });
    assert.equal(captured.exitCode, 0, captured.stderr);
    assert.doesNotMatch(captured.stdout + captured.stderr, /raw-public-out|raw-public-err/);

    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, target), 'public RED\n');
    git(root, ['add', '--', target]);
    git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'test: RED']);
    const red = git(root, ['rev-parse', 'HEAD']);
    const verdict = runNode([
      GSD_TOOLS, 'query', 'task', 'red-evidence-verdict', '--project-dir', root,
      '--task-file', plan, '--task-index', '1', '--red-sha', red,
      '--trailer', trailer(target), '--raw',
    ], { cwd: root });
    assert.equal(verdict.exitCode, 0, verdict.stderr);
    assert.equal(JSON.parse(verdict.stdout).verdict, 'authorize');
    assert.equal(fs.existsSync(path.join(root, 'never-executed-trailer-command')), false);
  });

  test('public capture preserves every post-sentinel child argv element', (t) => {
    const spellings = [
      { leading: [], command: ['task', 'red-evidence-capture'], project: 'spaced', pick: true },
      { leading: [], command: ['task.red-evidence-capture'], project: 'dotted', pick: false },
      { leading: ['--json-errors'], command: ['task', 'red-evidence-capture'], project: 'leading-json-spaced', pick: false },
      { leading: ['--json-errors'], command: ['task.red-evidence-capture'], project: 'leading-json-dotted', pick: false },
      { leading: ['--exit-contract=v2'], command: ['task', 'red-evidence-capture'], project: 'leading-exit-spaced', pick: false },
      { leading: ['--exit-contract=v2'], command: ['task.red-evidence-capture'], project: 'leading-exit-dotted', pick: false },
    ];

    for (const { leading, command, project, pick } of spellings) {
      const root = createTempDir(`red-receipt-${project}-`);
      t.after(() => cleanup(root));
      fs.mkdirSync(path.join(root, '.planning'));
      git(root, ['init', '-q']);

      const target = 'tests/sentinel receipt Ω.test.cjs';
      const plan = '.planning/02 sentinel plan.md';
      const recorder = path.join(root, 'record-child-argv.cjs');
      const observed = path.join(root, 'observed-child-argv.json');
      fs.writeFileSync(path.join(root, plan), contract(target));
      fs.writeFileSync(
        recorder,
        "'use strict';require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)));process.exit(1);\n",
      );
      git(root, ['add', '--', plan]);
      git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);

      const childArgs = [
        observed,
        target,
        '--json-errors',
        '--exit-contract=typed',
        '--cwd',
        '--project-dir',
        '--raw',
        '--pick',
        '--default',
        '--help',
        '',
        '  spaces  ',
        '雪',
        '--',
      ];
      const publicPrefix = ['query', ...command];
      const projection = pick ? ['--pick', 'exit_status'] : [];
      const captured = runNode([
        GSD_TOOLS, ...leading, ...publicPrefix, '--project-dir', root,
        '--task-file', plan, '--task-index', '1', ...projection, '--',
        process.execPath, recorder, ...childArgs,
      ], { cwd: root });

      assert.equal(captured.exitCode, 0, captured.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(observed, 'utf8')), childArgs);
      if (pick) {
        assert.equal(captured.stdout, '1');
      } else {
        assert.equal(JSON.parse(captured.stdout).exit_status, 1);
      }
    }
  });
});
