'use strict';

/**
 * Property-based coverage for `evaluateRedEvidence` (#3770) — per
 * RULESET.TESTS.property-based-testing, matching the fast-check property the
 * sibling module `gate-predicate-evaluator.cjs` already carries.
 *
 * The verdict must agree with the `valid_red` formula in `gsd-core/references/tdd.md`'s
 * `### RED Predicate` fence. Each of the formula's seven conjuncts is driven by
 * its own boolean flag (independent random strings would almost never collide,
 * so a plain arbitrary-string generator can't reach `authorize` or isolate a
 * single conjunct). Location `file` values carry no path separators, so
 * `locationsAgree`'s basename reduction is a no-op here; cross-path basename
 * behavior is covered elsewhere (WR-01 in tests/executor-mvp-tdd-section.test.cjs).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { evaluateRedEvidence } = require('../gsd-core/bin/lib/red-evidence-predicate.cjs');

// Safe alphabet: excludes `<`, `>`, `{`, `}`, and whitespace so generated
// values can never be confused with XML tag boundaries, break JSON
// serialization, or be silently trimmed by `extractTag` on the XML side only
// (the JSON side of the same value is never trimmed, so a whitespace-edged
// value would make two conceptually-equal fields compare unequal).
const safeString = fc.stringMatching(/^[a-zA-Z0-9_.-]{1,12}$/);

/** Guaranteed different from `base` (strictly longer), never re-collides with it. */
const differ = (base) => `${base}_alt`;

const trailerCase = fc.record({
  planTargetTest: safeString,
  expectedPhase: safeString,
  expectedClassOrMode: safeString,
  expectedSubject: safeString,
  declaredFile: safeString,
  declaredLine: fc.integer({ min: 0, max: 10000 }),
  exitZero: fc.boolean(),
  nonZeroExit: fc.integer({ min: -2, max: 2 }).filter((n) => n !== 0),
  mismatchExpected: fc.boolean(),
  mismatchActualPhase: fc.boolean(),
  mismatchActualClassOrMode: fc.boolean(),
  mismatchTargetTest: fc.boolean(),
  mismatchLocationFile: fc.boolean(),
  mismatchLocationLine: fc.boolean(),
  mismatchActualSubject: fc.boolean(),
});

function build(c) {
  const trailerExpected = c.mismatchExpected
    ? { phase: differ(c.expectedPhase), class_or_mode: differ(c.expectedClassOrMode), subject: differ(c.expectedSubject) }
    : { phase: c.expectedPhase, class_or_mode: c.expectedClassOrMode, subject: c.expectedSubject };
  const actualPhase = c.mismatchActualPhase ? differ(trailerExpected.phase) : trailerExpected.phase;
  const actualClassOrMode = c.mismatchActualClassOrMode
    ? differ(trailerExpected.class_or_mode) : trailerExpected.class_or_mode;
  const trailerTargetTest = c.mismatchTargetTest ? differ(c.planTargetTest) : c.planTargetTest;
  const observedPoint = {
    file: c.mismatchLocationFile ? differ(c.declaredFile) : c.declaredFile,
    line: c.mismatchLocationLine ? c.declaredLine + 1 : c.declaredLine,
  };
  const actualSubject = c.mismatchActualSubject ? differ(c.planTargetTest) : c.planTargetTest;
  const exitStatus = c.exitZero ? 0 : c.nonZeroExit;

  const taskContent = [
    '<red_contract>',
    `<target_test>${c.planTargetTest}</target_test>`,
    '<expected_failure>',
    `<phase>${c.expectedPhase}</phase>`,
    `<class_or_mode>${c.expectedClassOrMode}</class_or_mode>`,
    `<subject>${c.expectedSubject}</subject>`,
    '</expected_failure>',
    '</red_contract>',
  ].join('\n');

  const trailer = {
    actual: { phase: actualPhase, class_or_mode: actualClassOrMode, subject: actualSubject },
    // `command` participates in no conjunct — only its non-emptiness is checked — so it
    // is a fixed value here rather than another generated field.
    command: 'x',
    exit_status: exitStatus,
    expected: trailerExpected,
    location: { declared: { file: c.declaredFile, line: c.declaredLine }, observed: observedPoint },
    target_test: trailerTargetTest,
  };
  const trailerText = `red-evidence: ${JSON.stringify(trailer)}`;

  return { taskContent, trailerText };
}

/** `valid_red` from `gsd-core/references/tdd.md`'s `### RED Predicate` fence,
 * evaluated directly from the flags the fixture used to build the input. */
function referenceVerdict(c) {
  if (c.exitZero) return 'unexpected_pass';
  const validRed = !c.mismatchExpected
    && !c.mismatchActualPhase
    && !c.mismatchActualClassOrMode
    && !c.mismatchTargetTest
    && !c.mismatchLocationFile
    && !c.mismatchLocationLine
    && !c.mismatchActualSubject;
  return validRed ? 'authorize' : 'red_commit_not_failing';
}

describe('evaluateRedEvidence — RED Predicate round-trip property (fast-check)', () => {
  test('verdict agrees with the tdd.md valid_red formula on arbitrary well-shaped trailers', () => {
    fc.assert(
      fc.property(trailerCase, (c) => {
        const { taskContent, trailerText } = build(c);
        const result = evaluateRedEvidence(taskContent, trailerText);
        assert.equal(result.verdict, referenceVerdict(c));
      }),
      { numRuns: 500 },
    );
  });
});


describe('evaluateRedEvidence — selected invocation observation', () => {
  const task = `<task type="auto">
  <red_contract>
    <target_test>tests/selected-red.test.cjs</target_test>
    <program>node</program>
    <argv_json>["--test","tests/selected-red.test.cjs"]</argv_json>
    <expected_failure>
      <phase>test</phase><class_or_mode>assertion_failure</class_or_mode><subject>selected RED</subject>
    </expected_failure>
  </red_contract>
</task>`;
  const trailer = `red-evidence: ${JSON.stringify({
    command: JSON.stringify(['node', '--test', 'tests/selected-red.test.cjs']),
    exit_status: 7,
    target_test: 'tests/selected-red.test.cjs',
    expected: { phase: 'test', class_or_mode: 'assertion_failure', subject: 'selected RED' },
    actual: { phase: 'test', class_or_mode: 'assertion_failure', subject: 'tests/selected-red.test.cjs' },
    location: { declared: { file: 'tests/selected-red.test.cjs', line: 1 }, observed: { file: 'tests/selected-red.test.cjs', line: 1 } },
  })}`;

  test('requires the selected canonical command and a matching non-zero observed exit', () => {
    const observation = { exit_status: 7, stderr_captured: true, spawn_error: false, signal: null, timed_out: false };
    assert.equal(evaluateRedEvidence(task, trailer, observation).verdict, 'authorize');

    for (const invalidObservation of [
      undefined,
      { ...observation, exit_status: 0 },
      { ...observation, exit_status: 8 },
      { ...observation, spawn_error: true },
      { ...observation, signal: 'SIGTERM' },
      { ...observation, timed_out: true },
    ]) {
      assert.equal(evaluateRedEvidence(task, trailer, invalidObservation).verdict, 'red_commit_not_failing');
    }

    const forgedDisplay = trailer.replace(JSON.stringify(['node', '--test', 'tests/selected-red.test.cjs']), 'node --test tests/selected-red.test.cjs');
    assert.equal(evaluateRedEvidence(task, forgedDisplay, observation).verdict, 'red_commit_not_failing');
  });
});
