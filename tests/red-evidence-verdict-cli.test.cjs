'use strict';

/**
 * Behavioural tests for the `task red-evidence-verdict` CLI arm (#3770).
 *
 * The arm had no behavioural coverage: the only existing assertions check that
 * the string `task.red-evidence-verdict` appears in workflow prose. These pin
 * the two guards the arm actually makes claims about — that a task file
 * outside the project is refused, and that a non-file path is refused cleanly
 * rather than by throwing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { routeTaskCommand } = require('../gsd-core/bin/lib/task-command-router.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

/** Create an isolated project so linked-worktree root resolution cannot redirect fixtures to the main checkout. */
function createProject(t) {
  const projectRoot = createTempDir('red-ev-project-');
  fs.mkdirSync(path.join(projectRoot, '.planning'));
  t.after(() => cleanup(projectRoot));
  return projectRoot;
}

/** Run the arm and return its combined output; the seam never throws on exit code. */
function runVerdict(args, projectRoot) {
  const r = runNode([
    GSD_TOOLS, 'query', 'task', 'red-evidence-verdict', '--project-dir', projectRoot, ...args,
  ], { cwd: projectRoot });
  return `${r.stdout}${r.stderr}`;
}

describe('task red-evidence-verdict — path guards', () => {
  test('a symlink pointing outside the project is refused, not followed', (t) => {
    const projectRoot = createProject(t);
    const outside = createTempDir('red-ev-outside-');
    const target = path.join(outside, 'outside.md');
    fs.writeFileSync(target, '<red_contract><target_test>x</target_test></red_contract>\n');
    const link = path.join(projectRoot, `.red-ev-escape-${process.pid}.md`);
    fs.symlinkSync(target, link);
    t.after(() => cleanup(outside));

    assert.match(runVerdict(['--task-file', path.basename(link), '--trailer', '{}'], projectRoot),
      /outside project scope/,
      'the containment guard must resolve symlinks before comparing against the project root — '
      + '`path.resolve` does not, so a symlink planted in the repo reads an arbitrary file '
      + 'while the guard reports success. A guard that announces "outside project scope" and '
      + 'does not enforce it is worse than none.');
  });

  test('a directory path is refused cleanly, without throwing', (t) => {
    const projectRoot = createProject(t);
    const out = runVerdict(['--task-file', '.', '--trailer', '{}'], projectRoot);

    assert.doesNotMatch(out, /EISDIR|at routeTask|at dispatchHostCommand/,
      'the module documents that it never throws; the CLI arm around it must not either. '
      + '`fs.readFileSync` on a directory raises EISDIR with a stack trace instead of the '
      + 'arm\'s own USAGE error.');
    assert.match(out, /not found|outside project scope/,
      'a non-file path must produce the arm\'s own usage error');
  });
});

describe('task red-evidence-verdict — --changed-files membership', () => {
  // A contract that authorizes on its own content, so the ONLY variable under
  // test below is which changed-file list is passed. Go-shaped on purpose:
  // no `tests/` directory and no `.test.` infix, so nothing here can be
  // satisfied by a filename convention (LANG-01).
  const TRAILER = `red-evidence: ${JSON.stringify({
    command: JSON.stringify(['node', '--eval', 'process.exit(1)', 'TestDiscountReducesTotal']),
    exit_status: 1,
    target_test: 'TestDiscountReducesTotal',
    expected: { phase: 'test', class_or_mode: 'undefined: ApplyDiscount', subject: 'TestDiscountReducesTotal' },
    actual: { phase: 'test', class_or_mode: 'undefined: ApplyDiscount', subject: 'TestDiscountReducesTotal' },
    location: {
      declared: { file: 'pkg/pricing/pricing_test.go', line: 6 },
      observed: { file: 'pkg/pricing/pricing_test.go', line: 6 },
    },
  })}`;

  const withTaskFile = (t, projectRoot) => {
    const rel = `.red-ev-task-${process.pid}.md`;
    fs.writeFileSync(path.join(projectRoot, rel), `<task tdd="true">
  <behavior>Applies a percentage discount and reduces the order total.</behavior>
  <files>pkg/pricing/pricing.go</files>
  <red_contract>
    <target_test>TestDiscountReducesTotal</target_test>
    <program>node</program>
    <argv_json>["--eval","process.exit(1)","TestDiscountReducesTotal"]</argv_json>
    <implementation_target>pricing.ApplyDiscount</implementation_target>
    <expected_failure>
      <phase>test</phase>
      <class_or_mode>undefined: ApplyDiscount</class_or_mode>
      <subject>TestDiscountReducesTotal</subject>
    </expected_failure>
  </red_contract>
</task>
`);
    return rel;
  };

  test('the declared file itself satisfies membership', (t) => {
    const projectRoot = createProject(t);
    const out = runVerdict(['--task-file', withTaskFile(t, projectRoot), '--task-index', '1', '--trailer', TRAILER,
      '--changed-files', 'pkg/pricing/pricing_test.go'], projectRoot);
    assert.match(out, /"verdict": "authorize"/,
      'the positive control: a commit that touched exactly the declared file must authorize. '
      + 'Without this, the decoy assertion below could pass simply by refusing everything.');
  });

  test('a same-basename file in a DIFFERENT directory does not satisfy membership (WR-01)', (t) => {
    const projectRoot = createProject(t);
    const out = runVerdict(['--task-file', withTaskFile(t, projectRoot), '--task-index', '1', '--trailer', TRAILER,
      '--changed-files', 'vendor/other/pricing_test.go'], projectRoot);
    assert.match(out, /"verdict": "red_commit_not_failing"/,
      'WR-01: the membership check exists to prove the RED commit touched the file its own '
      + 'evidence names. Comparing basenames lets any same-named file anywhere in the tree '
      + 'stand in for it, which defeats exactly the anti-decoy property the check provides. '
      + 'Both sides here are repo-relative paths from git, so there is no prefix skew to '
      + 'normalize away — unlike locationsAgree, whose declared/observed inputs come from '
      + 'different tools and DO legitimately differ by prefix. Do not close this by changing '
      + 'locationsAgree: an endsWith narrowing there blocks outside-in and '
      + 'fixture-is-the-behavior (REGR-04). See gsd-core-vlh.');
  });
});


describe('task red-evidence-verdict — task-scoped execution', () => {
  test('executes only the selected contract and emits typed bounded observation metadata', (t) => {
    const projectRoot = createProject(t);
    const plan = `.red-ev-plan-${process.pid}.md`;
    const selectedTest = `red-ev-selected-${process.pid}.test.cjs`;
    fs.writeFileSync(path.join(projectRoot, plan), `<task type="auto">
  <name>decoy</name><red_contract>
    <target_test>decoy.test.cjs</target_test><program>node</program><argv_json>["--eval","process.exit(0)","decoy.test.cjs"]</argv_json>
    <expected_failure><phase>test</phase><class_or_mode>assertion_failure</class_or_mode><subject>decoy</subject></expected_failure>
  </red_contract>
</task>
<task type="auto">
  <name>selected</name><red_contract>
    <target_test>${selectedTest}</target_test><program>node</program><argv_json>["--eval","process.stderr.write('selected failure'); process.exit(1)","${selectedTest}"]</argv_json>
    <expected_failure><phase>test</phase><class_or_mode>assertion_failure</class_or_mode><subject>selected RED</subject></expected_failure>
  </red_contract>
</task>\n`);
    const trailer = JSON.stringify({
      command: JSON.stringify(['node', '--eval', "process.stderr.write('selected failure'); process.exit(1)", selectedTest]),
      exit_status: 1,
      target_test: selectedTest,
      expected: { phase: 'test', class_or_mode: 'assertion_failure', subject: 'selected RED' },
      actual: { phase: 'test', class_or_mode: 'assertion_failure', subject: selectedTest },
      location: { declared: { file: selectedTest, line: 1 }, observed: { file: selectedTest, line: 1 } },
    });
    const result = runNode([
      GSD_TOOLS, 'query', 'task', 'red-evidence-verdict', '--project-dir', projectRoot,
      '--task-file', plan, '--task-index', '2', '--trailer', trailer,
      '--changed-files', selectedTest, '--raw',
    ], { cwd: projectRoot });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['observed_exit_status', 'reason', 'stderr_captured', 'verdict']);
    assert.equal(payload.verdict, 'authorize', JSON.stringify(payload));
    assert.equal(payload.observed_exit_status, 1);
    assert.equal(payload.stderr_captured, true);
    assert.doesNotMatch(result.stdout, /selected failure/);
    assert.doesNotMatch(result.stderr, /selected failure/);
  });
});


describe('task red-evidence-verdict — selected execTool seam', () => {
  test('passes only selected structured program and argv to execTool', (t) => {
    const projectRoot = createProject(t);
    const plan = 'selected-plan.md';
    const targetTest = 'tests/selected-red.test.cjs';
    fs.writeFileSync(path.join(projectRoot, plan), `<task type="auto">
  <red_contract><target_test>${targetTest}</target_test><program>node</program>
  <argv_json>["--test","${targetTest}"]</argv_json>
  <expected_failure><phase>test</phase><class_or_mode>assertion_failure</class_or_mode><subject>selected RED</subject></expected_failure>
  </red_contract>
</task>`);

    const trailer = JSON.stringify({
      command: JSON.stringify(['node', '--test', targetTest]),
      exit_status: 1,
      target_test: targetTest,
      expected: { phase: 'test', class_or_mode: 'assertion_failure', subject: 'selected RED' },
      actual: { phase: 'test', class_or_mode: 'assertion_failure', subject: targetTest },
      location: { declared: { file: targetTest, line: 1 }, observed: { file: targetTest, line: 1 } },
    });
    const calls = [];
    const writes = [];
    const originalWriteSync = fs.writeSync;
    fs.writeSync = (fd, buffer, offset, length) => {
      if (fd === 1) writes.push(Buffer.from(buffer).subarray(offset, offset + length).toString('utf8'));
      return length;
    };
    t.after(() => { fs.writeSync = originalWriteSync; });

    routeTaskCommand({
      args: ['task', 'red-evidence-verdict', '--task-file', plan, '--task-index', '1',
        '--trailer', trailer, '--changed-files', targetTest],
      cwd: projectRoot,
      raw: false,
      execToolFn: (program, argv, options) => {
        calls.push({ program, argv, options });
        return { exitCode: 1, stdout: 'raw stdout is withheld', stderr: 'raw stderr is withheld', signal: null, error: null, timedOut: false };
      },
    });

    assert.deepEqual(calls, [{ program: 'node', argv: ['--test', targetTest], options: { cwd: projectRoot, timeout: 30_000 } }]);
    assert.doesNotMatch(writes.join(''), /raw stdout is withheld|raw stderr is withheld/);
  });
});
