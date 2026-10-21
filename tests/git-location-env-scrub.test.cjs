'use strict';
// #5548: git repo-location env vars must never redirect a git call away from its cwd.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const proj = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const probe = require(path.join(ROOT, 'hooks', 'lib', 'git-probe.js'));

describe('git location env scrub (#5548)', () => {
  test('scrubGitLocationEnv drops every location var, any casing, keeps config injection', () => {
    const env = { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1', Git_Dir: 'x' };
    for (const k of proj.GIT_LOCATION_ENV_VARS) env[k] = 'x';
    assert.deepEqual(proj.scrubGitLocationEnv(env), { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1' });
  });

  test('location list is a subset of `git rev-parse --local-env-vars`, and omits only config-injection vars', () => {
    const r = runGit(['rev-parse', '--local-env-vars']);
    const local = r.stdout.split('\n').filter(Boolean);
    const configInjection = /^GIT_CONFIG(_PARAMETERS|_COUNT)?$/;
    for (const v of proj.GIT_LOCATION_ENV_VARS) assert.ok(local.includes(v), `${v} is not a git local env var`);
    const missing = local.filter((v) => !configInjection.test(v) && !proj.GIT_LOCATION_ENV_VARS.includes(v));
    assert.deepEqual(missing, [], 'new git local env vars: add them to GIT_LOCATION_ENV_VARS and hooks/lib/git-probe.js');
  });

  test('hooks/lib/git-probe.js list matches the src list (hooks ship standalone)', () => {
    assert.deepEqual([...probe.GIT_LOCATION_ENV_VARS].sort(), [...proj.GIT_LOCATION_ENV_VARS].sort());
  });

  describe('gitEnv()', () => {
    let saved;
    beforeEach(() => { saved = process.env.GIT_COMMON_DIR; });
    afterEach(() => { if (saved === undefined) delete process.env.GIT_COMMON_DIR; else process.env.GIT_COMMON_DIR = saved; });
    test('strips the vars from process.env', () => {
      process.env.GIT_COMMON_DIR = '/elsewhere';
      assert.equal('GIT_COMMON_DIR' in probe.gitEnv(), false);
    });
  });

  // Per-call window (as windows-robustness.test.cjs): every runtime git spawn must
  // pass a scrubbed env. Covers hooks/lib and the pr-branch workflow's inline node.
  test('every runtime git spawn passes a scrubbed env', () => {
    const list = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);
    const files = [...list('src', /\.cts$/), ...list('hooks', /\.js$/), ...list('hooks/lib', /\.js$/), 'gsd-core/workflows/pr-branch.md'];
    const callRe = /(?:execSync|execFileSync|execFile|spawnSync|spawn)\s*\(\s*(?:`|'|")git\b/g;
    const scrubbed = /(?:env:\s*|\.\.\.)(?:scrubGitLocationEnv\(|gitEnv\b)/;
    const offenders = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      let m;
      while ((m = callRe.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(\*|\/\/)/.test(src.slice(lineStart, m.index))) continue; // doc comment, not a call
        // look back too: execGit builds `env` just above its spawn
        if (!scrubbed.test(src.slice(Math.max(0, m.index - 300), m.index + 400))) offenders.push(`${rel}: ${src.slice(m.index, m.index + 48).replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('pr-branch.md inline scrub lists every location var', () => {
    const md = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'pr-branch.md'), 'utf8');
    const m = md.match(/!\/\^GIT_\(([^)]{0,300})\)\$\/i/);
    assert.ok(m, 'inline scrub regex not found');
    assert.deepEqual(m[1].split('|').sort(), proj.GIT_LOCATION_ENV_VARS.map((v) => v.slice(4)).sort());
  });
});
