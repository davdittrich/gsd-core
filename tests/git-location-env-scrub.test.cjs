'use strict';
// #5548: git repo-location env vars must never redirect a git call away from its cwd.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const proj = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const probe = require(path.join(ROOT, 'hooks', 'lib', 'git-probe.js'));

describe('git location env scrub (#5548)', () => {
  test('scrubGitLocationEnv drops every location var, any casing, keeps config injection', () => {
    const env = { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1', Git_Dir: 'x' };
    for (const k of proj.GIT_LOCATION_ENV_VARS) env[k] = 'x';
    assert.deepEqual(proj.scrubGitLocationEnv(env), { PATH: '/bin', GIT_AUTHOR_NAME: 'a', GIT_CONFIG_COUNT: '1' });
  });

  test('location list is `git rev-parse --local-env-vars` minus config-injection vars', () => {
    const local = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const expected = local.filter((v) => !/^GIT_CONFIG(_PARAMETERS|_COUNT)?$/.test(v)).sort();
    assert.deepEqual([...proj.GIT_LOCATION_ENV_VARS].sort(), expected);
  });

  test('hooks/lib/git-probe.js list matches the src list (hooks ship standalone)', () => {
    assert.deepEqual([...probe.GIT_LOCATION_ENV_VARS].sort(), [...proj.GIT_LOCATION_ENV_VARS].sort());
  });

  test('gitEnv() strips the vars from process.env', () => {
    const saved = process.env.GIT_COMMON_DIR;
    process.env.GIT_COMMON_DIR = '/elsewhere';
    try { assert.equal('GIT_COMMON_DIR' in probe.gitEnv(), false); }
    finally { if (saved === undefined) delete process.env.GIT_COMMON_DIR; else process.env.GIT_COMMON_DIR = saved; }
  });

  test('every raw git spawn in src/ and hooks/ passes a scrubbed env', () => {
    const files = [];
    for (const dir of ['src', 'hooks']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (/\.(cts|js)$/.test(f)) files.push(path.join(dir, f));
    }
    const offenders = files.filter((rel) => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      return /(spawnSync|execFileSync|execFile|spawn)\(\s*'git'/.test(text) && !/scrubGitLocationEnv\(|gitEnv\(\)/.test(text);
    });
    assert.deepEqual(offenders, []);
  });
});
