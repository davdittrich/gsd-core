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
  // allow-test-rule: docs-parity (#3770) — these shipped docs must mirror the executable verdict contract.
  const commands = read('docs/COMMANDS.md');
  // allow-test-rule: docs-parity (#3770) — this inventory row must mirror the executable verdict contract.
  const inventory = read('docs/INVENTORY.md');
  // allow-test-rule: source-text-is-the-product (#3770) — the agent Markdown is the deployed instruction.
  const executor = read('agents/gsd-executor.md');
  // allow-test-rule: source-text-is-the-product (#3770) — the reference Markdown is the deployed instruction.
  const tdd = read('gsd-core/references/tdd.md');

  assert.doesNotMatch(commands, /atomically claims\s+and deletes the receipt/i);
  assert.doesNotMatch(commands, /commit changed the declared target path/);
  assert.match(commands, /`--red-sha`.*sole parent.*NUL-delimited changed paths/s);
  assert.match(commands, /selected `<red_contract>`'s `target_test`/);
  assert.doesNotMatch(commands, /receipt is consumed terminally on every verdict path/i);
  assert.match(commands, /Missing or duplicate required security flags.*exit `0`.*before\s+any receipt claim/s);
  assert.match(commands, /valid-shape `--red-sha`.*after\s+the receipt is claimed\s+and\s+read.*consume.*exit `0`/s);
  assert.doesNotMatch(commands, /Successfully claimed receipts are consumed on every terminal verdict path/);
  assert.match(commands, /After a successful claim.*consumption is attempted.*terminal verdict path.*inability to consume.*typed fail-closed/s);
  assert.match(commands, /Strict\s+command-shape parser rejection exits non-zero/);
  assert.doesNotMatch(inventory, /successfully claimed receipts are consumed|consumes (?:the capture|every successfully claimed) receipt/i);
  assert.match(inventory, /Security-flag cardinality.*failures.*before claim.*valid-shape.*after claim\/read/s);
  assert.match(inventory, /consumption is attempted.*after a successful claim.*inability to consume.*typed fail-closed/s);
  assert.match(inventory, /attempts to consume.*successfully claimed receipt.*terminal path.*fails closed.*cannot complete/s);

  assert.doesNotMatch(inventory, /`--changed-files`/);
  assert.match(inventory, /`--red-sha`.*sole parent.*NUL-delimited changed paths/s);
  assert.match(inventory, /selected `<red_contract>`'s `target_test`/);

  assert.doesNotMatch(executor, /file the trailer declares/);
  assert.match(executor, /`--red-sha`.*NUL-delimited changed paths.*`target_test`/s);

  assert.doesNotMatch(tdd, /file its (?:own )?evidence (?:names|reports|declares)/);
  assert.match(tdd, /`--red-sha`.*NUL-delimited changed paths.*`target_test`/s);
});
