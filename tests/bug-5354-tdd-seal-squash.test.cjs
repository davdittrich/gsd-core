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
function fixture(subjects, { summary = true, refs = false } = {}) {
  const dir = createTempGitProject('gate-5354-');
  dirs.push(dir);
  w(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
  if (summary) w(dir, `${PHASE}/01-01-SUMMARY.md`, '# done\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'docs: plans');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-b', 'feature');
  subjects.forEach((s, i) => commit(dir, `f${i}.txt`, s));
  if (refs) {
    const shas = git(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
    w(dir, `${PHASE}/01-01-SUMMARY.md`, `# done\n\n## Task Commits\n\n${shas.map((h, i) => `${i + 1}. **Task ${i + 1}: x** - \`${h}\``).join('\n')}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'docs: summary');
  }
  return { dir, base };
}
function squash(dir, base, subject = 'feat: squashed') {
  git(dir, 'checkout', '-b', 'merged', base);
  git(dir, 'merge', '--squash', 'feature');
  git(dir, 'commit', '-m', subject);
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
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
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

  const SEAL = path.join(PHASE, 'TDD-REVIEW-SEAL.json');
  const sha = (c) => c.repeat(40);

  test('a scoped squash title with unreachable SUMMARY hashes is not evaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base, 'feat(01-01): squashed');
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'NotEvaluable');
    assert.equal(r.payload.violations, 0);
  });

  test('an un-squashed plan whose SUMMARY hashes are reachable and has no test() fails', () => {
    const { dir } = fixture(['docs(01-01): notes'], { refs: true });
    const r = run(dir);
    assert.equal(r.payload.rows[0].status, 'FAIL');
    assert.equal(r.block, true);
  });

  test('a dependent plan feat() does not mask a missing RED', () => {
    const { dir } = fixture(['feat(01-02): green'], { summary: false });
    w(dir, `${PHASE}/01-02-PLAN.md`, '---\nphase: 1\nplan: 2\ntype: execute\ndepends_on: [01-01]\n---\n');
    const r = run(dir);
    assert.deepEqual(r.payload.rows[0].missing, ['RED']);
    assert.equal(r.payload.rows[0].status, 'FAIL');
  });

  test('a seal with only red does not make the plan not evaluable', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    w(dir, SEAL, JSON.stringify({ plans: { '01-01': { red: sha('a') } } }));
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'seal');
    squash(dir, base);
    assert.equal(run(dir).payload.rows[0].status, 'FAIL');
  });

  test('a seal entry with red equal to green is ignored', () => {
    const { dir } = fixture([], { summary: false });
    w(dir, SEAL, JSON.stringify({ plans: { '01-01': { red: sha('a'), green: sha('a') } } }));
    assert.equal(run(dir).payload.rows[0].status, 'FAIL');
  });

  test('--record keeps seal entries of other plans', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    w(dir, SEAL, JSON.stringify({ plans: { '01-99': { red: sha('b'), green: sha('c') } } }));
    run(dir, '--record');
    const plans = JSON.parse(fs.readFileSync(path.join(dir, SEAL), 'utf8')).plans;
    assert.deepEqual(Object.keys(plans).sort(), ['01-01', '01-99']);
  });

  test('--record that cannot write reports unreadable instead of throwing', () => {
    const { dir } = fixture(['test(01-01): red', 'feat(01-01): green']);
    fs.mkdirSync(path.join(dir, SEAL));
    const r = run(dir, '--record');
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.unreadable.length, 1);
  });

  test('the review table keeps NotEvaluable inside its column', () => {
    const { dir, base } = fixture(['test(01-01): red', 'feat(01-01): green'], { refs: true });
    squash(dir, base);
    assert.match(run(dir).payload.table, /\| NotEvaluable \|/);
    assert.match(run(dir).payload.table, /\|--------------\|/);
  });
});
