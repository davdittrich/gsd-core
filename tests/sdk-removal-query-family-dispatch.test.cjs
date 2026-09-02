'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('SDK-removal CJS query family dispatch', () => {
  let tmpDir;
  let phaseDir;
  let contextPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-query-families-');
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    contextPath = path.join(phaseDir, '01-CONTEXT.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('query agent.classify-failure classifies quota text', () => {
    const result = runGsdTools(['query', 'agent.classify-failure', '--', '429 retry-after: 45'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.class, 'quota-exceeded');
    assert.equal(parsed.sentinel, '429');
    assert.equal(parsed.retryAfterSeconds, 45);
  });

  test('query task.is-behavior-adding selects the parser-owned plan index for workflow gates', () => {
    const planPath = path.join(phaseDir, '01-01-PLAN.md');
    fs.writeFileSync(planPath, [
      '<task type="auto" tdd="true">',
      '<behavior>User can save a profile</behavior>',
      '<files>',
      '- src/profile.js',
      '- tests/profile.test.js',
      '</files>',
      '</task>',
      '<task type="checkpoint:human-verify"><name>middle</name></task>',
      '<task type="auto"><files>docs/profile.md</files></task>',
    ].join('\n'));

    const first = runGsdTools([
      'query', 'task.is-behavior-adding', planPath, '--task-index', '1', '--pick', 'is_behavior_adding',
    ], tmpDir);
    assert.strictEqual(first.success, true, first.error);
    assert.equal(first.output, 'true');

    const middle = runGsdTools([
      'query', 'task.is-behavior-adding', planPath, '--task-index', '2', '--pick', 'is_behavior_adding',
    ], tmpDir);
    assert.strictEqual(middle.success, false, 'checkpoint task index must fail closed');

    const last = runGsdTools([
      'query', 'task.is-behavior-adding', planPath, '--task-index', '3', '--pick', 'is_behavior_adding',
    ], tmpDir);
    assert.strictEqual(last.success, true, last.error);
    assert.equal(last.output, 'false');
  });

  test('query check auto-mode reads workflow flags from config', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      workflow: {
        auto_advance: false,
        _auto_chain_active: true,
      },
    }, null, 2));

    const result = runGsdTools(['query', 'check', 'auto-mode', '--pick', 'source'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    assert.equal(result.output, 'auto_chain');
  });

  test('query check.decision-coverage-plan reaches the CJS gate and passes covered decisions', () => {
    fs.writeFileSync(contextPath, [
      '<decisions>',
      '### Product',
      '- **D-01:** Keep the runtime command path installed and portable for users.',
      '</decisions>',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'objective: "Implement D-01 in the runtime launcher"',
      'must_haves:',
      '  - "D-01 remains covered"',
      '---',
      '',
      '<tasks>',
      '<task><action>Preserve D-01.</action></task>',
      '</tasks>',
    ].join('\n'));

    const result = runGsdTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath, '--pick', 'passed'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    assert.equal(result.output, 'true');
  });

  test('query check.decision-coverage-verify returns non-blocking misses', () => {
    fs.writeFileSync(contextPath, [
      '<decisions>',
      '### Product',
      '- **D-02:** Keep verification warnings visible when decisions are missing.',
      '</decisions>',
    ].join('\n'));

    const result = runGsdTools(['query', 'check.decision-coverage-verify', phaseDir, contextPath], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.blocking, false);
    assert.equal(parsed.not_honored[0].id, 'D-02');
  });
});
