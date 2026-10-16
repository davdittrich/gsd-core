'use strict';

/**
 * #5469 — /gsd:pr-branch repeat publishes: the published-marker ref
 * (`refs/gsd/pr-published/<branch>`) bounds the commit range, and a leftover
 * `<branch>-pr` is replaced when merged / refused when not.
 *
 * L2 only: parses the SHIPPED bash blocks out of
 * `gsd-core/workflows/pr-branch.md` (via the pr-branch-filter seam) and runs
 * them in order against real git fixtures. No source-grep, no hand-copied
 * recipe. The one non-shipped line is the pick-list assignment, which the
 * workflow leaves to prose classification.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  WORKFLOW_PATH,
  extractPickLoop,
  extractBashBlockContaining,
} = require('./helpers/pr-branch-filter.cjs');

const MARKER = 'refs/gsd/pr-published/feature';

const ISOLATED_ENV = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ISOLATED_ENV(dir), timeout: 30000 }).trim();
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prmarker-'));
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'code.txt', 'v0\n');
  write(dir, '.planning/STATE.md', 's0\n');
  commitAll(dir, 'chore: base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

// One code+planning commit and one planning-only commit, both tagged rN.
function commitRound(dir, n) {
  write(dir, 'code.txt', `v${n}\n`);
  write(dir, `.planning/phases/r${n}.md`, `plan ${n}\n`);
  commitAll(dir, `feat: r${n}`);
  write(dir, '.planning/STATE.md', `s${n}\n`);
  commitAll(dir, `docs: r${n}`);
}

// Runs the shipped blocks in workflow order under pr_strict.
function publish(dir) {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const b = (marker) => extractBashBlockContaining(text, marker);
  const script = [
    'CURRENT_BRANCH=feature',
    'TARGET=main',
    'PR_STRICT=true',
    b('AHEAD=$(git rev-list'),
    b('TRANSIENT_DIRS="phases'),
    b('FILTER_PATHS=$(for d'),
    b('git log --oneline'),
    'INCLUDED_COMMITS=$(git rev-list --reverse "${BASE:-$TARGET}".."$CURRENT_BRANCH")',
    b('PR_BRANCH="${CURRENT_BRANCH}-pr"'),
    extractPickLoop(text),
    b('git checkout "$CURRENT_BRANCH"'),
    b('DIFF_PATHS=$(git diff'),
    b('git update-ref "$MARKER_REF"'),
  ].join('\n');
  const r = spawnSync('sh', ['-c', script], {
    cwd: dir, encoding: 'utf8', env: ISOLATED_ENV(dir), timeout: 30000,
  });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Fast-forward the bare target to the published -pr branch (a merged PR).
function mergePr(dir) {
  git(dir, 'merge-base', '--is-ancestor', 'main', 'feature-pr');
  git(dir, 'update-ref', 'refs/heads/main', 'refs/heads/feature-pr');
}

const markerOf = (dir) => {
  try { return git(dir, 'rev-parse', '-q', '--verify', MARKER); } catch { return ''; }
};

describe('#5469 pr-branch published marker (real git)', () => {
  const dirs = [];
  const repo = () => { const d = buildRepo(); dirs.push(d); return d; };
  const teardown = () => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); };

  test('round 3 replays only the round-3 commits; marker follows the tip; merged leftover -pr is replaced', () => {
    const dir = repo();
    try {
      for (const n of [1, 2, 3]) {
        commitRound(dir, n);
        const tip = git(dir, 'rev-parse', 'feature');
        const r = publish(dir);
        assert.equal(r.status, 0, `round ${n} failed: ${r.stderr}`);
        const logged = r.stdout.split('\n').filter((l) => /\b(feat|docs): r\d/.test(l));
        assert.equal(logged.length, 2, `round ${n} must list only its own 2 commits:\n${r.stdout}`);
        assert.ok(logged.every((l) => l.includes(`r${n}`)), `round ${n} log replays older rounds:\n${r.stdout}`);
        assert.equal(git(dir, 'rev-list', '--count', 'main..feature-pr'), '1');
        assert.equal(markerOf(dir), tip, 'marker must equal the TIP captured at start');
        mergePr(dir);
      }
    } finally { teardown(); }
  });

  test('leftover UNmerged -pr is refused with a message naming it, and left intact', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      const prTip = git(dir, 'rev-parse', 'feature-pr');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /feature-pr/);
      assert.match(r.stderr, /unpublished|unmerged/);
      assert.match(r.stderr, /git branch -D feature-pr/);
      assert.equal(git(dir, 'rev-parse', 'feature-pr'), prTip);
      assert.equal(git(dir, 'branch', '--show-current'), 'feature');
    } finally { teardown(); }
  });

  test('rebased working branch (marker not an ancestor) falls back to TARGET with a warning', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      mergePr(dir);
      // Rewrite history: reword the tip so the marker is no longer an ancestor.
      git(dir, 'commit', '-q', '--amend', '-m', 'docs: r1 reworded');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /refs\/gsd\/pr-published\/feature/);
      assert.match(r.stderr, /main/);
      assert.equal(git(dir, 'show', 'feature-pr:code.txt'), 'v2');
      assert.equal(markerOf(dir), git(dir, 'rev-parse', 'feature'));
    } finally { teardown(); }
  });

  test('marker does not advance when a conflict halts the run', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      const m1 = markerOf(dir);
      assert.equal(m1, git(dir, 'rev-parse', 'feature'), 'round 1 must record the marker');
      mergePr(dir);
      git(dir, 'checkout', '-q', 'main');
      write(dir, 'code.txt', 'main-diverged\n');
      commitAll(dir, 'chore: main diverges');
      git(dir, 'checkout', '-q', 'feature');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.notEqual(r.status, 0, 'conflict must halt');
      assert.equal(markerOf(dir), m1, 'marker must stay at the last published tip');
    } finally { teardown(); }
  });
});
