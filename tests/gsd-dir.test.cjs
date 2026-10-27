'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { prepareGsdDir, readSmallGsdFile, MAX_READ_BYTES } = require('../gsd-core/bin/lib/gsd-dir.cjs');

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

test('a .gitignore that grows past MAX_READ_BYTES after fstat is still not read past the bound', (t) => {
  const root = createTempDir('gsd-dir-grow-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, '.gsd'));
  const start = '#'.repeat(MAX_READ_BYTES + 1);
  fs.writeFileSync(path.join(root, '.gsd', '.gitignore'), start);
  const realFstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args) => Object.assign(realFstat(...args), { size: 1 })); // fstat saw it small
  prepareGsdDir(root, NAME, RULES);
  assert.equal(fs.readFileSync(path.join(root, '.gsd', '.gitignore'), 'utf8'), start);
});

test('property: readSmallGsdFile returns a regular file whole iff it holds at most MAX_READ_BYTES (limit-1, limit, limit+1)', (t) => {
  const root = createTempDir('gsd-dir-read-');
  t.after(() => cleanup(root));
  const file = path.join(root, 'f');
  fc.assert(fc.property(fc.integer({ min: -3, max: 3 }), fc.constantFrom('a', '#', '*'), (delta, ch) => {
    const text = ch.repeat(MAX_READ_BYTES + delta);
    fs.writeFileSync(file, text);
    return readSmallGsdFile(file) === (delta <= 0 ? text : null);
  }), { numRuns: 30 });
});

test('readSmallGsdFile refuses a symlink with ELOOP', { skip: process.platform === 'win32' }, (t) => {
  const root = createTempDir('gsd-dir-readlink-');
  t.after(() => cleanup(root));
  fs.writeFileSync(path.join(root, 'target'), 'x');
  fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'));
  assert.throws(() => readSmallGsdFile(path.join(root, 'link')), { code: 'ELOOP' });
});

test('parity: readSmallGsdFile and capability-ledger readSmallRegularFile refuse the same file kinds', (t) => {
  const { readSmallRegularFile } = require('../gsd-core/bin/lib/capability-ledger.cjs');
  const root = createTempDir('gsd-dir-parity-');
  t.after(() => cleanup(root));
  const at = (name) => path.join(root, name);
  fs.writeFileSync(at('limit'), 'a'.repeat(MAX_READ_BYTES));
  fs.writeFileSync(at('over'), 'a'.repeat(MAX_READ_BYTES + 1));
  fs.mkdirSync(at('dir'));
  // Same text at the limit.
  assert.equal(readSmallGsdFile(at('limit')), readSmallRegularFile(at('limit'), MAX_READ_BYTES));
  // Shared refusals: readSmallGsdFile returns null, readSmallRegularFile throws (its contract).
  for (const name of ['over', 'dir']) {
    assert.equal(readSmallGsdFile(at(name)), null, name);
    assert.throws(() => readSmallRegularFile(at(name), MAX_READ_BYTES), name);
  }
});

test('parity: both bounded readers refuse a FIFO without blocking', { skip: process.platform === 'win32' }, (t) => {
  const { readSmallRegularFile } = require('../gsd-core/bin/lib/capability-ledger.cjs');
  const { runHook } = require('./helpers/process-seam.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const root = createTempDir('gsd-dir-fifo-');
  t.after(() => cleanup(root));
  const fifo = path.join(root, 'fifo');
  if (runHook(fifo, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }).exitCode !== 0) return t.skip('mkfifo unavailable');
  assert.equal(readSmallGsdFile(fifo), null);
  assert.throws(() => readSmallRegularFile(fifo, MAX_READ_BYTES));
});
