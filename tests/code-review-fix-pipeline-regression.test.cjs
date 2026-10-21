// allow-test-rule: source-text-is-the-product (see #3190)
// The workflow .md IS the product: its embedded bash/node snippets are loaded
// and executed verbatim by the agent host at runtime. Testing that the deployed
// commit-fix step exports the env var its own inline `node -e` body reads, and
// that the docs commit stages the converged REVIEW.md alongside REVIEW-FIX.md,
// asserts the deployed contract — not an implementation detail. There is no
// runtime API that exposes these inlined snippets; the text IS the spec.
//
// Pattern mirrors tests/code-review-pipeline-regression.test.cjs: a behavioral
// run of the inline parser body (via process-seam) PLUS docs-parity on the
// workflow text. See .gsd/bug/fix-3190-code-review-fix-auto-rewrite-review/.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
// Same gate the shipped fences carry everywhere in this suite: bash is not assumed on win32.
const HAS_BASH = process.platform !== 'win32';

// Extract the bash fence out of a named <step>, so a test can RUN it rather than grep it.
// Line-scanned rather than matched with a multiline regex: an ad-hoc fence regex trips
// local/no-adhoc-markdown-parsing, and a bare \n against readFileSync content trips
// local/no-crlf-fragile-split (Windows autocrlf yields \r\n). Same shape as bashFences() in
// tests/code-review-pipeline-regression.test.cjs, which solved this first.
function stepFence(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found`);
  const close = src.indexOf('</step>', open);
  const lines = src.slice(open, close).replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^```bash\s*$/.test(lines[i])) { start = i + 1; continue; }
    if (start !== -1 && /^```\s*$/.test(lines[i])) return lines.slice(start, i).join('\n');
  }
  assert.fail(`step "${name}" carries no bash fence`);
}
const { createTempDir, cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review-fix.md');

// ---------------------------------------------------------------------------
// The FIX_REPORT frontmatter validator body, mirrored from code-review-fix.md's
// commit_fix_report HAS_STATUS inline `node -e` script. If those lines change,
// this must be updated in tandem (the docs-parity assertions below catch a
// mismatch at the env-name level).
//
// Bug (#3190): the deployed workflow launches this body with REVIEW_PATH
// exported but the body reads process.env.FIX_REPORT_PATH — so at runtime the
// readFileSync throws and HAS_STATUS silently becomes "". The behavioral tests
// below prove the BODY is sound when FIX_REPORT_PATH is wired, and that the
// mis-wiring is the sole failure mode.
// ---------------------------------------------------------------------------
const VALIDATOR_BODY = `
  const fs = require('fs');
  const content = fs.readFileSync(process.env.FIX_REPORT_PATH, 'utf-8');
  const match = content.replace(/\\r\\n/g, '\\n').match(/^---\\n([\\s\\S]*?)\\n---/);
  if (match && /status:/.test(match[1])) { console.log('valid'); } else { console.log('invalid'); }
`;

const VALID_FIX_REPORT = [
  '---',
  'status: all_fixed',
  'findings_in_scope: 3',
  'fixed: 3',
  'skipped: 0',
  'iteration: 2',
  '---',
  '',
  'All findings resolved across 2 iterations.',
].join('\n');

/** Slice the workflow text of a single <step name="...">…</step> region. */
function stepRegion(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found in workflow`);
  const close = src.indexOf('</step>', open);
  assert.notStrictEqual(close, -1, `step "${name}" has no closing </step>`);
  return src.slice(open, close + '</step>'.length);
}

describe('#3190 — code-review-fix --auto REVIEW.md commit + FIX_REPORT_PATH env wiring', () => {
  // -------------------------------------------------------------------------
  // Criterion 3 — behavioral: the validator body correctly detects a valid
  // status field WHEN the env var it reads is actually exported.
  // -------------------------------------------------------------------------
  test('T1 — validator body prints "valid" for a well-formed REVIEW-FIX.md when FIX_REPORT_PATH is set', () => {
    const dir = createTempDir();
    const report = path.join(dir, '05-REVIEW-FIX.md');
    fs.writeFileSync(report, VALID_FIX_REPORT, 'utf8');
    try {
      const res = runNode(['-e', VALIDATOR_BODY], {
        env: { ...process.env, FIX_REPORT_PATH: report },
      });
      assert.strictEqual(res.exitCode, 0, `validator should exit 0; stderr:\n${res.stderr}`);
      assert.strictEqual(res.stdout.trim(), 'valid');
    } finally {
      cleanup(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — behavioral bug demo: the SAME body, with FIX_REPORT_PATH
  // unset (exactly what today's `REVIEW_PATH=`-only export produces in the
  // subshell), throws inside readFileSync → stdout is empty → HAS_STATUS="" →
  // the "invalid frontmatter — Not committing" branch fires unconditionally.
  // This proves the env-name coupling is load-bearing and that the body is not
  // the culprit.
  // -------------------------------------------------------------------------
  test('T2 — validator body does NOT print "valid" when FIX_REPORT_PATH is unset (the mis-wiring)', () => {
    const env = { ...process.env };
    delete env.FIX_REPORT_PATH;
    delete env.REVIEW_PATH;
    const res = runNode(['-e', VALIDATOR_BODY], { env });
    // The throw crashes node (non-zero), stdout has no "valid" — exactly the
    // silent empty string the 2>/dev/null command substitution yields in bash.
    assert.ok(
      !res.stdout.includes('valid'),
      `stdout should not contain "valid" when FIX_REPORT_PATH is unset; got: ${res.stdout}`,
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — docs-parity: the commit_fix_report HAS_STATUS validator must
  // export FIX_REPORT_PATH (the var its body reads), not REVIEW_PATH.
  // -------------------------------------------------------------------------
  test('T3 — commit_fix_report HAS_STATUS exports FIX_REPORT_PATH, not REVIEW_PATH', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'commit_fix_report');
    assert.ok(
      region.includes('HAS_STATUS=$(FIX_REPORT_PATH="${FIX_REPORT_PATH}" node -e'),
      'HAS_STATUS must launch node with FIX_REPORT_PATH exported to match the process.env.FIX_REPORT_PATH its body reads',
    );
    assert.ok(
      !region.includes('HAS_STATUS=$(REVIEW_PATH="${REVIEW_PATH}" node -e'),
      'HAS_STATUS must not export REVIEW_PATH into a script that reads process.env.FIX_REPORT_PATH',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3 — docs-parity: the present_results FIX_FRONTMATTER extractor
  // must export FIX_REPORT_PATH, not REVIEW_PATH (else every summary field is
  // blank).
  // -------------------------------------------------------------------------
  test('T4 — present_results FIX_FRONTMATTER exports FIX_REPORT_PATH, not REVIEW_PATH', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'present_results');
    assert.ok(
      region.includes('FIX_FRONTMATTER=$(FIX_REPORT_PATH="${FIX_REPORT_PATH}" node -e'),
      'FIX_FRONTMATTER must launch node with FIX_REPORT_PATH exported to match the process.env.FIX_REPORT_PATH its body reads',
    );
    assert.ok(
      !region.includes('FIX_FRONTMATTER=$(REVIEW_PATH="${REVIEW_PATH}" node -e'),
      'FIX_FRONTMATTER must not export REVIEW_PATH into a script that reads process.env.FIX_REPORT_PATH',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 1 — docs-parity: in --auto the single docs commit must stage the
  // converged REVIEW.md alongside REVIEW-FIX.md, gated on AUTO_MODE (non-auto
  // single-pass runs never rewrite REVIEW.md and stay out of scope).
  // -------------------------------------------------------------------------
  test('T5 — commit_fix_report stages REVIEW.md alongside REVIEW-FIX.md when AUTO_MODE', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const region = stepRegion(src, 'commit_fix_report');
    assert.ok(
      region.includes('AUTO_MODE'),
      'commit_fix_report must be aware of AUTO_MODE (only --auto rewrites REVIEW.md)',
    );
    assert.ok(
      region.includes('REVIEW_PATH') && region.includes('COMMIT_FILES'),
      'commit_fix_report must build a COMMIT_FILES list that includes REVIEW_PATH in --auto',
    );
    assert.ok(
      region.includes('--files "${COMMIT_FILES[@]}"'),
      'the docs commit must stage the assembled COMMIT_FILES array (REVIEW-FIX.md [+ REVIEW.md in --auto])',
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 2 — docs-parity: on successful convergence the spent .iterN.md
  // backups are removed so the phase directory is clean. Backup CREATION is
  // unchanged (out of scope); they are retained when the loop degrades.
  // -------------------------------------------------------------------------
  test('T6 — spent .iterN.md backups are removed on convergence, AFTER the ledger reads them', () => {
    // #3190's SEMANTICS are unchanged and still asserted here: removed on convergence, retained on
    // degradation, creation intact. What moved is the PLACEMENT, and it had to. This workflow keeps
    // one final version of REVIEW.md and REVIEW-FIX.md rather than per-iteration copies, and the
    // re-review drops a finding once it is fixed — so the backups are the only surviving record of
    // what an early --auto iteration closed. Removing them at the end of the loop erased that record
    // before `record_disposition` could read it, and the ledger then reported those findings as
    // `open (not in the current review)`: indistinguishable from never triaged (#3861 round 5).
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const loop = stepRegion(src, 'auto_iteration_loop');
    const cleanup = stepRegion(src, 'cleanup_iteration_backups');

    // Backups are still CREATED before each overwrite (the unchanged mechanism).
    assert.ok(
      loop.includes('.iter${ITERATION}.md'),
      'backup creation (cp … .iter${ITERATION}.md) must remain intact',
    );
    // And no longer removed inside the loop — that is the regression this test now guards.
    assert.ok(
      !/rm -f[\s\S]*?\.iter[\s\S]*?\*[\s\S]*?\.md/.test(loop),
      'the loop must NOT remove the backups it wrote; the ledger has not read them yet',
    );
    // Removal lives in its own step, still gated on convergence.
    assert.ok(
      /rm -f[\s\S]*?\.iter[\s\S]*?\*[\s\S]*?\.md/.test(cleanup),
      'cleanup_iteration_backups must remove spent .iterN.md backups (rm -f … .iter*.md)',
    );
    // The token greps that stood here PASSED with the branch INVERTED — the round's own review drove
    // it by flipping `= "clean"` to `!=` and watching the test stay green. Checking that FINAL_STATUS,
    // rm and "retained" occur SOMEWHERE says nothing about which branch each sits in. Execute it.
    assert.match(cleanup, /FINAL_STATUS/, 'convergence must still be re-derived from the review status');
    // Ordering is the whole point of the move.
    const recordAt = src.indexOf('<step name="record_disposition">');
    const cleanupAt = src.indexOf('<step name="cleanup_iteration_backups">');
    assert.ok(recordAt > -1 && cleanupAt > -1, 'both steps must exist');
    assert.ok(recordAt < cleanupAt, 'the ledger reads the backups BEFORE they are removed');
  });

  test('T6b — the cleanup fence, EXECUTED: removes on clean, retains on anything else', { skip: !HAS_BASH }, () => {
    // The behavioural half of T6, and the one that survives a branch inversion. Drives the shipped
    // fence in both directions against real files, so an inverted condition fails here rather than
    // passing a token grep — which is exactly what the round's review demonstrated of the first cut.
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const fence = stepFence(src, 'cleanup_iteration_backups');

    const drive = (status) => {
      const dir = createTempDir('gsd-3861-cleanup-');
      try {
        fs.writeFileSync(path.join(dir, '01-REVIEW.md'), ['---', 'status: ' + status, '---'].join('\n'));
        fs.writeFileSync(path.join(dir, '01-REVIEW.iter2.md'), 'scratch');
        fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.iter2.md'), 'scratch');
        const script = [
          'set -euo pipefail',
          'AUTO_MODE=true',
          'REVIEW_PATH="' + path.join(dir, '01-REVIEW.md') + '"',
          'FIX_REPORT_PATH="' + path.join(dir, '01-REVIEW-FIX.md') + '"',
          fence,
        ].join('\n');
        const res = runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
        assert.strictEqual(res.exitCode, 0, 'the cleanup step must never abort: ' + res.stderr);
        return {
          review: fs.existsSync(path.join(dir, '01-REVIEW.iter2.md')),
          fix: fs.existsSync(path.join(dir, '01-REVIEW-FIX.iter2.md')),
          stdout: res.stdout,
        };
      } finally { cleanup(dir); }
    };

    const converged = drive('clean');
    assert.strictEqual(converged.review, false, 'a converged run removes the REVIEW backup');
    assert.strictEqual(converged.fix, false, 'and the FIX-REPORT backup');

    const degraded = drive('issues_found');
    assert.strictEqual(degraded.review, true, 'a degraded run RETAINS the REVIEW backup');
    assert.strictEqual(degraded.fix, true, 'and the FIX-REPORT backup');
    assert.match(degraded.stdout, /retained/i, 'and says so, so the trail is discoverable');

    // An unreadable or unparseable review is not evidence of convergence — retain.
    const unknown = drive('');
    assert.strictEqual(unknown.review, true, 'an unparseable status must retain, never remove');
  });
});

describe('#5019 — --auto re-review keeps the external reviewer lane evidence', () => {
  const BLOCK = '<external_reviewer_evidence>X</external_reviewer_evidence>';
  const FIX = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const REVIEW = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md'), 'utf8');

  // Lines [from, to] (inclusive, first match after `from`) of a step region, so a test RUNS the
  // shipped snippet instead of grepping it.
  const lines = (src, from, to) => {
    const l = splitLines(src);
    const a = l.findIndex((x) => x.includes(from));
    assert.notStrictEqual(a, -1, `marker "${from}" not found`);
    const b = l.findIndex((x, k) => k >= a && x.trim() === to);
    assert.notStrictEqual(b, -1, `end "${to}" not found`);
    return l.slice(a, b + 1).join('\n');
  };
  const bash = (script) => runHook('-c', [script], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  // A scratch TMPDIR holding lane dirs plus an outside "victim" dir the guard must never touch.
  const sandbox = (t, fn) => {
    const dir = createTempDir('gsd-5019-');
    t.after(() => cleanup(dir));
    const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
    const victim = path.join(dir, 'victim'); fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'x');
    return fn({ dir, tmp, victim, review: path.join(dir, '01-REVIEW.md'), file: path.join(dir, '01-REVIEW-lane-evidence.md') });
  };
  const REMOVALS = {
    'cleanup_iteration_backups': () => lines(stepRegion(FIX, 'cleanup_iteration_backups'), 'LE="${REVIEW_PATH%.md}', 'fi'),
    'check_empty_scope': () => lines(stepRegion(REVIEW, 'check_empty_scope'), 'LE="${REVIEW_PATH%.md}', 'fi'),
    // every early exit of code-review-fix inlines the same fence, so each is executed, not grepped
    'check_config_gate': () => lines(stepRegion(FIX, 'check_config_gate'), 'LE="${REVIEW_PATH%.md}', 'fi'),
    'check_review_exists': () => lines(stepRegion(FIX, 'check_review_exists'), 'LE="${REVIEW_PATH%.md}', 'fi'),
    'check_review_status': () => lines(stepRegion(FIX, 'check_review_status'), 'LE="${REVIEW_PATH%.md}', 'fi'),
    'spawn_fixer': () => lines(stepRegion(FIX, 'spawn_fixer'), 'LE="${REVIEW_PATH%.md}', 'fi'),
  };

  for (const [name, snippet] of Object.entries(REMOVALS)) {
    test(`${name}: removal deletes a valid lane dir + file, never anything else`, { skip: !HAS_BASH }, (t) => {
      const run = (sb, line1, mk) => {
        mk && mk(sb);
        fs.writeFileSync(sb.file, `${line1}\nblock\n`);
        bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${snippet()}`);
        return { file: fs.existsSync(sb.file), victim: fs.existsSync(path.join(sb.victim, 'keep')) };
      };
      sandbox(t, (sb) => {
        const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
        const r = run(sb, 'abc123');
        assert.deepStrictEqual(r, { file: false, victim: true });
        assert.strictEqual(fs.existsSync(d), false, 'valid lane dir removed');
      });
      sandbox(t, (sb) => { // traversal: a path is data, not a path
        // 6 chars, so the length arm admits it and only the `*[!A-Za-z0-9]*` class stops it;
        // without the class D = $TMPDIR/gsd-review-lanes-x/../v resolves to the victim $TMPDIR/v.
        fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-x'));
        const v = path.join(sb.tmp, 'v'); fs.mkdirSync(v); fs.writeFileSync(path.join(v, 'keep'), 'x');
        const r = run(sb, 'x/../v');
        assert.deepStrictEqual(r, { file: false, victim: true });
        assert.strictEqual(fs.existsSync(path.join(v, 'keep')), true, 'path-shaped 6-char line 1 must not reach the victim');
      });
      sandbox(t, (sb) => { // symlinked lane dir pointing at the victim
        fs.symlinkSync(sb.victim, path.join(sb.tmp, 'gsd-review-lanes-abc123'));
        const r = run(sb, 'abc123');
        assert.deepStrictEqual(r, { file: false, victim: true });
      });
      sandbox(t, (sb) => { // wrong length / empty line 1
        const real = ['abc12', 'abc1234'].map((n) => { const d = path.join(sb.tmp, `gsd-review-lanes-${n}`); fs.mkdirSync(d); return d; });
        for (const bad of ['abc12', 'abc1234', '']) assert.deepStrictEqual(run(sb, bad), { file: false, victim: true });
        for (const d of real) assert.strictEqual(fs.existsSync(d), true, 'wrong-length suffix names a real dir: kept');
      });
      sandbox(t, (sb) => { // no file: a no-op that does not fail
        bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${snippet()}`);
        assert.strictEqual(fs.existsSync(sb.victim), true);
      });
    });
  }

  test('loop read: block only for a fresh file whose suffix names a real lane dir', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'esac');
    const drive = (sb, line1, ageMs) => {
      fs.writeFileSync(sb.file, `${line1}\n<external_reviewer_evidence>X</external_reviewer_evidence>\n`);
      if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(sb.file, t, t); }
      const out = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      return out.stdout;
    };
    sandbox(t, (sb) => {
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-abc123'));
      // allow-test-rule: source-text-is-the-product (#5019) the block IS the prompt payload handed to the reviewer
      assert.match(drive(sb, 'abc123'), /<external_reviewer_evidence>X<\/external_reviewer_evidence>/);
      // find -mmin -360 rounds differently on GNU and BSD (macOS keeps a file aged exactly 360 min),
      // so the 360 boundary itself is implementation-defined and deliberately not asserted.
      for (const [min, fresh] of [[359, true], [361, false], [420, false]]) {
        assert.strictEqual(drive(sb, 'abc123', min * 60000).includes('X'), fresh, `${min} min old`);
      }
      assert.strictEqual(drive(sb, 'zzz999'), '', 'suffix without a lane dir');
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-x')); // so D resolves to the existing victim dir
      fs.mkdirSync(path.join(sb.tmp, 'v')); // 6-char path-shaped line 1: D = $TMPDIR/v, so only the character class stops it
      assert.strictEqual(drive(sb, 'x/../v'), '', 'a path is not a suffix');
      fs.mkdirSync(path.join(sb.tmp, 'gsd-review-lanes-abc12'));
      assert.strictEqual(drive(sb, 'abc12'), '', 'wrong length names a real dir');
      const noFile = bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.dir}/none-REVIEW.md"\n${read}\nprintf '%s' "$EXTERNAL_EVIDENCE_BLOCK"`);
      assert.strictEqual(noFile.stdout, '', 'absent file leaves the prompt unchanged');
    });
  });

  test('the evidence block round-trips commit_review to the re-review read, and the cited lane file survives', { skip: !HAS_BASH }, (t) => {
    const dir = createTempDir('gsd-5019-');
    t.after(() => cleanup(dir));
    const lanes = path.join(dir, 'gsd-review-lanes-abc123'); fs.mkdirSync(lanes);
    const cited = path.join(lanes, 'gsd-review-x.md'); fs.writeFileSync(cited, 'lane-only finding');
    const review = path.join(dir, '01-REVIEW.md'); fs.writeFileSync(review, '---\nstatus: issues_found\n---\n');
    const block = `<external_reviewer_evidence>\n${cited}\n</external_reviewer_evidence>`;
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'esac');
    // The re-review prompt template, run through bash so the block's place in it is executed, not grepped.
    // The reviewer agent that consumes it is the one step no test can run (stated in the PR body).
    const tpl = lines(stepRegion(FIX, 'auto_iteration_loop'), '${EXTERNAL_EVIDENCE_BLOCK}<config>', '${AGENT_SKILLS_REVIEWER}")').slice(0, -2);
    const out = bash([
      `export TMPDIR="${dir}"; REVIEW_PATH="${review}"; LANE_RUN_DIR="${lanes}"; COMMIT_DOCS=false; FIX_AUTO=true`,
      `EXTERNAL_EVIDENCE_BLOCK='${block}'`, stepFence(REVIEW, 'commit_review'),
      'printf "---\\nstatus: clean\\n---\\n" > "$REVIEW_PATH"', // the re-review overwrites REVIEW.md; the lane finding must survive in the sibling file
      'EXTERNAL_EVIDENCE_BLOCK=""', read,
      'printf "%s" "$EXTERNAL_EVIDENCE_BLOCK"', "printf '\\0'",
      `REVIEW_DEPTH=standard PHASE_DIR="${dir}"; PROMPT="${tpl}"; printf '%s' "$PROMPT"`].join('\n'));
    const [blockOut, prompt] = out.stdout.split('\0');
    // allow-test-rule: source-text-is-the-product (#5019) the block IS the prompt payload handed to the reviewer
    assert.ok(blockOut.endsWith(`${block}\n\n`), 'the re-review reads back the exact block');
    assert.ok(prompt.startsWith(`${block}\n\n<config>\ndepth: standard\n`), 'the re-review prompt is assembled with the block ahead of <config>');
    assert.strictEqual(fs.readFileSync(cited, 'utf8'), 'lane-only finding', 'the reviewer can still re-read the cited path');
  });

  test('loop read: a present but rejected evidence file warns instead of dropping the block silently', { skip: !HAS_BASH }, (t) => {
    const read = lines(stepRegion(FIX, 'auto_iteration_loop'), '# #5019: re-surface', 'fi');
    const warns = (sb, line1, ageMs) => {
      fs.writeFileSync(sb.file, `${line1}\nblock\n`);
      if (ageMs) { const d = new Date(Date.now() - ageMs); fs.utimesSync(sb.file, d, d); }
      return bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}`).stderr;
    };
    sandbox(t, (sb) => {
      const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
      // allow-test-rule: source-text-is-the-product (#5019) the warning text is the user-facing output
      assert.match(warns(sb, 'abc123', 7 * 3600 * 1000), /^Warning: lane evidence .* rejected/, 'stale');
      assert.match(warns(sb, 'zzz999'), /^Warning: lane evidence .* rejected/, 'lane dir missing');
      fs.symlinkSync(sb.victim, path.join(sb.tmp, 'gsd-review-lanes-sym123'));
      assert.match(warns(sb, 'sym123'), /^Warning: lane evidence .* rejected/, 'lane dir is a symlink');
      assert.strictEqual(warns(sb, 'abc123'), '', 'fresh valid evidence: no warning');
      fs.renameSync(sb.file, path.join(sb.dir, 'moved'));
      assert.strictEqual(bash(`export TMPDIR="${sb.tmp}"; REVIEW_PATH="${sb.review}"\n${read}`).stderr, '', 'no file: no warning');
    });
  });

  test('commit_review persists the block + keeps the lane dir only for --auto; else unchanged', { skip: !HAS_BASH }, (t) => {
    const fence = stepFence(REVIEW, 'commit_review');
    const drive = (auto, stale) => {
      const dir = createTempDir('gsd-5019-');
      t.after(() => cleanup(dir));
      const lanes = path.join(dir, 'gsd-review-lanes-abc123'); fs.mkdirSync(lanes);
      const review = path.join(dir, '01-REVIEW.md');
      const file = path.join(dir, '01-REVIEW-lane-evidence.md');
      if (stale) fs.writeFileSync(file, 'stale');
      const script = [
        `REVIEW_PATH="${review}"; LANE_RUN_DIR="${lanes}"; COMMIT_DOCS=false`,
        auto ? 'FIX_AUTO=true' : '',
        `EXTERNAL_EVIDENCE_BLOCK="${BLOCK}"`,
        fence,
      ].join('\n');
      bash(script);
      return { file: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, lanes: fs.existsSync(lanes) };
    };
    // allow-test-rule: source-text-is-the-product (#5019) the persisted file IS the re-review prompt payload
    assert.deepStrictEqual(drive(true, false), { file: `abc123\n${BLOCK}\n`, lanes: true });
    assert.deepStrictEqual(drive(false, false), { file: null, lanes: false });
  });

  test('check_review_exists removes the lane evidence before it exits 1', { skip: !HAS_BASH }, (t) => {
    const fence = lines(stepRegion(FIX, 'check_review_exists'), 'if [ ! -f', 'exit 1') + '\nfi';
    sandbox(t, (sb) => {
      const d = path.join(sb.tmp, 'gsd-review-lanes-abc123'); fs.mkdirSync(d);
      fs.writeFileSync(sb.file, 'abc123\nblock\n');
      const out = bash(`export TMPDIR="${sb.tmp}"; PHASE_ARG=1; REVIEW_PATH="${sb.review}"\n${fence}`);
      assert.strictEqual(out.exitCode, 1);
      assert.deepStrictEqual([fs.existsSync(sb.file), fs.existsSync(d), fs.existsSync(path.join(sb.victim, 'keep'))], [false, false, true]);
    });
  });

  test('the removal fence is byte-identical at all three sites; the loop read shares its suffix guard', () => {
    // Normalised: trimmed, comments dropped, so only the indent and the #5019 comments may differ.
    const fence = (src) => splitLines(src).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const at = (src, step) => { const l = fence(stepRegion(src, step)); const a = l.indexOf('LE="${REVIEW_PATH%.md}-lane-evidence.md"'); return l.slice(a, a + 6); };
    const ref = at(REVIEW, 'check_empty_scope');
    assert.strictEqual(ref.length, 6);
    for (const step of ['check_config_gate', 'check_review_exists', 'check_review_status', 'spawn_fixer']) assert.deepStrictEqual(at(FIX, step), ref, step);
    assert.deepStrictEqual(at(FIX, 'cleanup_iteration_backups'), ref);
    const guard = ref.find((l) => l.startsWith('case "$S"')).split(' ??????')[0];
    assert.ok(fence(stepRegion(FIX, 'auto_iteration_loop')).some((l) => l.startsWith(guard)), 'loop read uses the same suffix class');
  });
});
