'use strict';

/**
 * #5354 seal credit: a sealed plan is credited per kind. The seal stands in for RED only when the plan has
 * no live RED; with a live RED it is never consulted. Generated seal values against every live-kind subset.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

const PHASE = '.planning/phases/01-x';
const GREEN = 'b'.repeat(40);
const SUBSETS = [
  { name: 'none', subjects: [], liveRed: false, liveGreen: false },
  { name: 'test only', subjects: ['test(01-01): red'], liveRed: true, liveGreen: false },
  { name: 'feat only', subjects: ['feat(01-01): green'], liveRed: false, liveGreen: true },
  { name: 'test then feat', subjects: ['test(01-01): red', 'feat(01-01): green'], liveRed: true, liveGreen: true },
];

const git = (dir, ...a) => gitOrThrow(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });

function fixture(subjects) {
  const dir = createTempGitProject('gate-5354-seal-credit-');
  fs.mkdirSync(path.join(dir, PHASE), { recursive: true });
  fs.writeFileSync(path.join(dir, PHASE, '01-01-PLAN.md'), '---\nphase: 1\nplan: 1\ntype: tdd\n---\n# Plan\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'docs: plans');
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), s);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', s);
  });
  return dir;
}

const redArb = fc.oneof(
  fc.stringMatching(/^[0-9a-f]{40}$/),
  fc.stringMatching(/^[0-9a-f]{39}$/),
  fc.stringMatching(/^[0-9a-f]{41}$/),
  fc.stringMatching(/^[0-9A-F]{40}$/),
  fc.constant(GREEN),
);

for (const { name, subjects, liveRed, liveGreen } of SUBSETS) {
  test(`property: seal credit with live commits (${name}) follows the per-kind rule`, () => {
    const dir = fixture(subjects);
    try {
      fc.assert(fc.property(redArb, (red) => {
        fs.writeFileSync(path.join(dir, PHASE, 'TDD-REVIEW-SEAL.json'), JSON.stringify({ plans: { '01-01': { red, green: GREEN } } }));
        const status = evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1'] }).payload.rows[0].status;
        const sealRed = /^[0-9a-f]{40}$/.test(red) && red !== GREEN;
        const expected = (liveRed && liveGreen) || (!liveRed && sealRed) ? 'Pass' : 'FAIL';
        return status === expected;
      }), { numRuns: 25 });
    } finally {
      cleanup(dir);
    }
  });
}
