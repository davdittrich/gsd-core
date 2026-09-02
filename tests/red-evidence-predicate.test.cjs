'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  evaluateRedEvidence,
  parseRedContract,
} = require('../gsd-core/bin/lib/red-evidence-predicate.cjs');

const TARGET = 'tests/red-evidence-verdict-cli.test.cjs';
const PLAN = '.planning/quick/plan/02-PLAN.md';
const PARENT = '1'.repeat(40);

function task(overrides = {}) {
  const values = {
    target: TARGET,
    implementation: 'src/task-command-router.cts',
    phase: 'test',
    mode: 'assertion_failure',
    subject: 'capture once and consume bounded task-bound RED receipt without rerun',
    ...overrides,
  };
  return `<task type="auto" tdd="true">
  <red_contract>
    <target_test>${values.target}</target_test>
    <implementation_target>${values.implementation}</implementation_target>
    <expected_failure>
      <class_or_mode>${values.mode}</class_or_mode>
      <phase>${values.phase}</phase>
      <subject>${values.subject}</subject>
    </expected_failure>
  </red_contract>
</task>`;
}

function trailer(overrides = {}) {
  return `red-evidence: ${JSON.stringify({
    command: 'node --test tests/red-evidence-verdict-cli.test.cjs',
    exit_status: 1,
    target_test: TARGET,
    expected: {
      phase: 'test',
      class_or_mode: 'assertion_failure',
      subject: 'capture once and consume bounded task-bound RED receipt without rerun',
    },
    actual: { phase: 'test', class_or_mode: 'assertion_failure', subject: TARGET },
    location: {
      declared: { file: 'src/task-command-router.cts', line: 1 },
      observed: { file: 'src/task-command-router.cts', line: 1 },
    },
    ...overrides,
  })}`;
}

function receipt(overrides = {}) {
  return JSON.stringify({
    version: 1,
    plan: PLAN,
    task_index: 1,
    target: TARGET,
    pre_red_head: PARENT,
    exit_status: 1,
    signal: null,
    timed_out: false,
    error: false,
    stdout_bytes: 0,
    stderr_bytes: 17,
    ...overrides,
  });
}

const context = { plan: PLAN, task_index: 1, red_parent: PARENT };

describe('parseRedContract — selected-task exact cardinality', () => {
  test('requires one target, implementation target, expected block, and every expected field', () => {
    assert.equal(parseRedContract(task()).ok, true);

    for (const invalid of [
      task().replace('<target_test>', '<target_test>x</target_test><target_test>'),
      task().replace('<implementation_target>', '<implementation_target>x</implementation_target><implementation_target>'),
      task().replace('<expected_failure>', '<expected_failure></expected_failure><expected_failure>'),
      task().replace('<phase>test</phase>', ''),
      task().replace('<class_or_mode>assertion_failure</class_or_mode>', ''),
      task().replace('<subject>capture once and consume bounded task-bound RED receipt without rerun</subject>', ''),
    ]) {
      assert.equal(parseRedContract(invalid).ok, false);
    }
  });

  test('rejects PLAN-authored program and argv_json execution declarations', () => {
    const withLegacyCommands = task().replace(
      '<target_test>',
      '<program>node</program><argv_json>["--eval","process.exit(0)"]</argv_json><target_test>',
    );
    assert.equal(parseRedContract(withLegacyCommands).ok, false);
  });
});

describe('evaluateRedEvidence — bounded receipt and semantic trailer', () => {
  test('authorizes only exact plan/task/target/parent-bound non-zero observation', () => {
    assert.equal(evaluateRedEvidence(task(), trailer(), receipt(), context).verdict, 'authorize');

    const invalidReceipts = [
      receipt({ plan: `${PLAN}.other` }),
      receipt({ task_index: 2 }),
      receipt({ target: `${TARGET}.other` }),
      receipt({ pre_red_head: '2'.repeat(40) }),
      receipt({ exit_status: 0 }),
      receipt({ signal: 'SIGTERM' }),
      receipt({ timed_out: true }),
      receipt({ error: true }),
      receipt({ stdout_bytes: -1 }),
      receipt({ stderr_bytes: 1.5 }),
      receipt({ extra: true }),
      '{',
    ];
    for (const value of invalidReceipts) {
      assert.equal(evaluateRedEvidence(task(), trailer(), value, context).verdict, 'red_commit_not_failing');
    }
  });

  test('reports observed zero exit as unexpected_pass', () => {
    assert.equal(
      evaluateRedEvidence(task(), trailer({ exit_status: 0 }), receipt({ exit_status: 0 }), context).verdict,
      'unexpected_pass',
    );
  });

  test('requires non-empty inert command text but never matches it to executable argv', () => {
    assert.equal(evaluateRedEvidence(task(), trailer({ command: 'rm -rf ignored' }), receipt(), context).verdict, 'authorize');
    assert.equal(evaluateRedEvidence(task(), trailer({ command: '' }), receipt(), context).verdict, 'red_commit_not_failing');
  });

  test('keeps bounded byte-count validation total under arbitrary safe integers', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      (stdoutBytes, stderrBytes) => {
        const result = evaluateRedEvidence(
          task(),
          trailer(),
          receipt({ stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes }),
          context,
        );
        assert.equal(result.verdict, 'authorize');
      },
    ), { numRuns: 500 });
  });
});
