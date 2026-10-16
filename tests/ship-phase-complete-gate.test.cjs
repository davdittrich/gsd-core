'use strict';

/** #5221: /gsd:ship blocks PHASE_NOT_COMPLETE only for a phase with an unticked checklist entry (unchecked_phases); everything else fails open. */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');

const SKIP = skipUnless('bash', 'jq', 'node');
const SHIP = 'gsd-core/workflows/ship.md';
const analyze = (number, complete) => JSON.stringify({ phases: [{ number, roadmap_complete: complete }], unchecked_phases: complete ? [] : [number] });

describe('ship preflight: roadmap completeness gate (#5221)', { skip: SKIP }, () => {
  const lines = () => span(SHIP, 'if [ -f .planning/ROADMAP.md ]', 'fi');
  const run = (stdout, rc, phase = '3') => runBash(lines(), { stdout, rc }, { preamble: [`PHASE_NUMBER=${phase}`, 'cd "$(mktemp -d)"; mkdir .planning; : > .planning/ROADMAP.md'], probe: 'echo CONTINUED' });

  test('complete phase continues', () => {
    const r = run(analyze('3', true), 0);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('incomplete phase blocks with PHASE_NOT_COMPLETE and the verify-work hint', () => {
    const r = run(analyze('3', false), 0);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PHASE_NOT_COMPLETE/);
    assert.match(r.stderr, /Run \/gsd:verify-work 3 \(completes the phase\), then re-run \/gsd:ship/);
    assert.ok(!/CONTINUED/.test(r.stdout));
  });

  test('leading-zero PHASE_NUMBER matches an unpadded roadmap number', () => {
    const r = run(analyze('3', false), 0, '03');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PHASE_NOT_COMPLETE/);
  });

  test('multi-segment numbers normalize per segment (03.02 matches 3.2)', () => {
    const r = run(analyze('3.2', false), 0, '03.02');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PHASE_NOT_COMPLETE/);
  });

  test('no checklist entry (phase absent from unchecked_phases) fails open', () => {
    const r = run(JSON.stringify({ phases: [{ number: '3', roadmap_complete: false }], unchecked_phases: [] }), 0);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('missing ROADMAP.md skips the check without calling analyze', () => {
    const r = runBash(lines(), { stdout: '', rc: 69 }, { preamble: ['PHASE_NUMBER=3', 'cd "$(mktemp -d)"'], probe: 'echo CONTINUED' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONTINUED/);
  });

  test('analyze exit 69 is a hard error, never PHASE_NOT_COMPLETE or a skip', () => {
    const r = run(analyze('3', false), 69);
    assert.equal(r.status, 1);
    assert.ok(!/PHASE_NOT_COMPLETE/.test(r.stderr));
    assert.ok(!/CONTINUED/.test(r.stdout));
  });
});
