'use strict';

/**
 * #5297 — git-source install must stage exactly the requested ref (bare tag/branch,
 * `tag:<name>`, `sha:<commit>`), not only the default-branch tip. Real git against a
 * local bare repo; the exec seam rewrites the fake URL to the repo path.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveCapabilitySource } = require('../gsd-core/bin/lib/capability-source.cjs');
const { cleanup, createTempDir } = require('./helpers.cjs');

const URL = 'https://example.invalid/repo.git';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function manifest(version) {
  return JSON.stringify({
    id: 'ref-cap', role: 'feature', version, title: 'ref-cap', description: 'd', tier: 'standard',
    requires: [], engines: { gsd: '>=1.0.0' }, runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
  });
}

describe('#5297 git install honors non-tip refs', () => {
  let root, bare, gsdHome, mid;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ref-'));
    const work = path.join(root, 'work');
    bare = path.join(root, 'bare.git');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 't@t');
    git(work, 'config', 'user.name', 't');
    const commit = (v) => {
      fs.writeFileSync(path.join(work, 'capability.json'), manifest(v));
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', v);
    };
    commit('0.1.0');
    git(work, 'tag', 'v0.1.0');
    commit('0.2.0');
    mid = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', '-a', 'v0.2.0', '-m', 'annotated');
    git(work, 'checkout', '-q', '-b', 'side');
    commit('0.3.0-side');
    git(work, 'checkout', '-q', 'main');
    commit('0.4.0');
    git(root, 'clone', '-q', '--bare', work, bare);
  });

  after(() => cleanup(root));

  const run = (spec, extra = {}) => {
    gsdHome = createTempDir('gsd-home-');
    const execGit = (args, o) => {
      const a = args.map((x) => (x === URL ? bare : x));
      const r = spawnSync('git', a, { encoding: 'utf8', timeout: o?.timeout });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, signal: r.signal, error: r.error ?? null };
    };
    return resolveCapabilitySource(spec, { gsdHome, hostVersion: '1.5.0', execOverrides: { git: execGit }, ...extra });
  };
  const versionOf = (res) => res.version;

  for (const [label, ref, want] of [
    ['bare tag behind tip', 'v0.1.0', '0.1.0'],
    ['tag: prefix', 'tag:v0.1.0', '0.1.0'],
    ['annotated tag', 'v0.2.0', '0.2.0'],
    ['non-default branch', 'side', '0.3.0-side'],
    ['no ref tracks default', null, '0.4.0'],
  ]) {
    test(label, async () => {
      const res = await run(ref ? `git+${URL}#${ref}` : `git+${URL}`);
      try { assert.equal(versionOf(res), want); } finally { cleanup(gsdHome); }
    });
  }

  test('sha: non-tip commit', async () => {
    const res = await run(`git+${URL}#sha:${mid}`);
    try { assert.equal(versionOf(res), '0.2.0'); } finally { cleanup(gsdHome); }
  });
});
