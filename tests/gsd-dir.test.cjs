'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { prepareGsdDir, MAX_READ_BYTES } = require('../gsd-core/bin/lib/gsd-dir.cjs');

const NAME = 'model escalation';
const RULES = ['/model-escalation-*'];
const MARKER = `# gsd-core ${NAME}`;

test('prepareGsdDir seeds a bare * into a new .gsd/.gitignore and returns the directory', (t) => {
  const root = createTempDir('gsd-dir-seed-');
  t.after(() => cleanup(root));
  assert.equal(prepareGsdDir(root, NAME, RULES), path.join(root, '.gsd'));
  assert.equal(fs.readFileSync(path.join(root, '.gsd', '.gitignore'), 'utf8'), '*\n');
});

test('property: a covering .gitignore is kept; any other gets the marker block appended exactly once', (t) => {
  const root = createTempDir('gsd-dir-prop-');
  t.after(() => cleanup(root));
  const ignore = path.join(root, '.gsd', '.gitignore');
  const line = fc.constantFrom('*', '!keep.txt', '/other', '# note', MARKER, '/model-escalation-*', '');
  fc.assert(fc.property(fc.array(line, { maxLength: 6 }), fc.constantFrom('\n', '\r\n'), fc.boolean(), (lines, eol, trailing) => {
    cleanup(path.join(root, '.gsd'));
    fs.mkdirSync(path.join(root, '.gsd'));
    const before = lines.join(eol) + (trailing && lines.length ? eol : '');
    fs.writeFileSync(ignore, before);
    prepareGsdDir(root, NAME, RULES);
    const once = fs.readFileSync(ignore, 'utf8');
    prepareGsdDir(root, NAME, RULES);
    const covered = lines.includes('*') || lines.includes(MARKER);
    const want = covered ? before : `${before}${before.endsWith('\n') ? '' : '\n'}${MARKER}\n${RULES.join('\n')}\n`;
    return once === want && fs.readFileSync(ignore, 'utf8') === once;
  }));
});

test('boundary: a .gitignore of MAX_READ_BYTES-1 and MAX_READ_BYTES bytes is updated, MAX_READ_BYTES+1 is left alone', (t) => {
  for (const [delta, updated] of [[-1, true], [0, true], [1, false]]) {
    const root = createTempDir('gsd-dir-cap-');
    t.after(() => cleanup(root));
    const start = '#'.repeat(MAX_READ_BYTES + delta);
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(path.join(root, '.gsd', '.gitignore'), start);
    prepareGsdDir(root, NAME, RULES);
    const want = updated ? `${start}\n${MARKER}\n${RULES.join('\n')}\n` : start;
    assert.equal(fs.readFileSync(path.join(root, '.gsd', '.gitignore'), 'utf8'), want, `cap${delta}`);
  }
});

test('a symlinked .gsd directory is refused and nothing is written through it', { skip: process.platform === 'win32' }, (t) => {
  const root = createTempDir('gsd-dir-link-');
  const elsewhere = createTempDir('gsd-dir-elsewhere-');
  t.after(() => { cleanup(root); cleanup(elsewhere); });
  fs.symlinkSync(elsewhere, path.join(root, '.gsd'));
  assert.throws(() => prepareGsdDir(root, NAME, RULES));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
