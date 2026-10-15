'use strict';

/** #5354: tdd.review-checkpoint evidence survives a squash merge through TDD-REVIEW-SEAL.json. */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const gate = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

const PHASE = '.planning/phases/01-x';
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function git(dir, ...a) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true }).trim();
}
function w(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
function commit(dir, file, msg) { w(dir, file, msg); git(dir, 'add', '-A'); git(dir, 'commit', '-m', msg); }
function fixture(subjects, { summary = true } = {}) {
  const dir = createTempGitProject('gate-5354-');
  dirs.push(dir);
  w(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
  if (summary) w(dir, `${PHASE}/01-01-SUMMARY.md`, '# done\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'docs: plans');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-b', 'feature');
  subjects.forEach((s, i) => commit(dir, `f${i}.txt`, s));
  return { dir, base };
}
function squash(dir, base) {
  git(dir, 'checkout', '-b', 'merged', base);
  git(dir, 'merge', '--squash', 'feature');
  git(dir, 'commit', '-m', 'feat: squashed');
}
const run = (dir, ...args) => gate.evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1', ...args] });

describe('#5354 tdd review checkpoint seal', () => {
  test('a record written before the squash keeps the plan passing after git merge --squash', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    const before = run(dir, '--record');
    assert.equal(before.payload.violations, 0);
    const seal = JSON.parse(fs.readFileSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json'), 'utf8'));
    assert.match(seal.plans['01-01'].red, /^[0-9a-f]{40}$/);
    assert.match(seal.plans['01-01'].green, /^[0-9a-f]{40}$/);
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'docs(01-01): seal');
    squash(dir, base);
    const after = run(dir);
    assert.equal(after.payload.violations, 0);
    assert.equal(after.block, false);
    assert.equal(after.payload.rows[0].status, 'Pass');
  });

  test('no record and no reachable commits but a SUMMARY is not evaluable, not a failure', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green']);
    squash(dir, base);
    const r = run(dir);
    assert.equal(r.payload.violations, 0);
    assert.equal(r.block, false);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.match(r.payload.message, /not evaluable/);
  });

  test('a plan with reachable commits lacking test()/feat() still fails', () => {
    const { dir } = fixture(['docs(01-01): notes']);
    const r = run(dir);
    assert.equal(r.payload.violations, 1);
    assert.equal(r.block, true);
    assert.deepEqual(r.payload.rows[0].missing, ['RED', 'GREEN']);
  });

  test('no commits, no SUMMARY, no seal still fails', () => {
    const { dir } = fixture([], { summary: false });
    const r = run(dir);
    assert.equal(r.payload.violations, 1);
    assert.equal(r.payload.rows[0].status, 'FAIL');
  });

  test('--record writes nothing when the evaluation has a violation', () => {
    const { dir } = fixture(['test(01-01): red']);
    const r = run(dir, '--record');
    assert.equal(r.payload.violations, 1);
    assert.equal(fs.existsSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json')), false);
  });

  test('a malformed seal credits nothing', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, `${PHASE}/TDD-REVIEW-SEAL.json`, '{not json');
    assert.equal(run(dir).payload.violations, 1);
  });
});
