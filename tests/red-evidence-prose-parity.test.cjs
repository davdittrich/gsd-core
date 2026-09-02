'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('stale RED membership and verdict exit contracts are rejected and their guard is CI-selected', () => {
  const commands = read('docs/COMMANDS.md');
  const inventory = read('docs/INVENTORY.md');
  const executor = read('agents/gsd-executor.md');
  const tdd = read('gsd-core/references/tdd.md');

  assert.doesNotMatch(commands, /commit changed the declared target path/);
  assert.match(commands, /`--red-sha`.*sole parent.*NUL-delimited changed paths/s);
  assert.match(commands, /selected `<red_contract>`'s `target_test`/);
  assert.doesNotMatch(commands, /receipt is consumed terminally on every verdict path/i);
  assert.match(commands, /Missing or duplicate required security flags.*exit `0`.*before any receipt claim/s);
  assert.match(commands, /valid-shape `--red-sha`.*after the receipt is claimed and read.*consume.*exit `0`/s);
  assert.match(commands, /Successfully claimed receipts are consumed on every terminal verdict path/);
  assert.match(commands, /Strict command-shape parser rejection exits non-zero/);
  assert.doesNotMatch(inventory, /consumes the capture receipt terminally on every verdict path/i);
  assert.match(inventory, /Security-flag cardinality failures.*before claim.*valid-shape.*after claim\/read.*claimed receipts.*consumed.*terminal/s);

  assert.doesNotMatch(inventory, /`--changed-files`/);
  assert.match(inventory, /`--red-sha`.*sole parent.*NUL-delimited changed paths/s);
  assert.match(inventory, /selected `<red_contract>`'s `target_test`/);

  assert.doesNotMatch(executor, /file the trailer declares/);
  assert.match(executor, /`--red-sha`.*NUL-delimited changed paths.*`target_test`/s);

  assert.doesNotMatch(tdd, /file its (?:own )?evidence (?:names|reports|declares)/);
  assert.match(tdd, /`--red-sha`.*NUL-delimited changed paths.*`target_test`/s);
});
