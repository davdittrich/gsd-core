'use strict';

/**
 * review-capability-contributions.test.cjs — behavioral tests for gh-3997:
 * the review:pre loop point and the reviewer-contribution seam in
 * gsd-core/workflows/review.md. Marker-content and coverage regressions
 * nothing else in the suite guards; see docs/adr/3997-review-prompt-capability-contributions.md
 * for the full mechanism.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readFileNormalized, cleanup } = require('./helpers.cjs');
const { getWiredKinds } = require('../scripts/gen-loop-host-contract.cjs');
const { validateHooksWired } = require('../gsd-core/bin/lib/capability-validator.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const REVIEW_PATH = path.join(WORKFLOW_DIR, 'review.md');
const CONVERGENCE_PATH = path.join(WORKFLOW_DIR, 'plan-review-convergence.md');

// ─── 1. Structural: review.md's real dispatch prose ───────────────────────────

describe('review.md dispatch prose (gh-3997)', () => {
  const review = readFileNormalized(REVIEW_PATH);

  test('dispatch instruction is well-formed: fetches, names kind=="contribution" and fragment.inline, documents the no-op', () => {
    const lines = review.split('\n');
    const matches = lines.filter((line) => line.startsWith('{Run `gsd_run loop render-hooks review:pre --raw`'));
    assert.equal(matches.length, 1, 'expected exactly one review:pre dispatch instruction');
    const instruction = matches[0];
    assert.match(instruction, /kind\s*==\s*"contribution"/);
    assert.match(instruction, /fragment\.inline/);
    assert.match(instruction, /omit this block entirely/i, 'must be a documented no-op when nothing is active');
  });

  test('dispatch sits inside Review Instructions, before the sign-off — lands in the non-trimmed instructions block', () => {
    const reviewInstructionsIdx = review.indexOf('## Review Instructions');
    const dispatchIdx = review.indexOf('{Run `gsd_run loop render-hooks review:pre --raw`');
    const signOffIdx = review.indexOf('Output your review in markdown format.');
    assert.ok(reviewInstructionsIdx !== -1 && dispatchIdx !== -1 && signOffIdx !== -1);
    assert.ok(
      reviewInstructionsIdx < dispatchIdx && dispatchIdx < signOffIdx,
      'must be inside ## Review Instructions, which becomes INSTRUCTIONS_BLOCK_FILE — the section prompt-budget.cts never trims',
    );
  });
});

// ─── 2. Regression: review:pre must actually be usable by a capability ────────
//
// Removing the `loop render-hooks review:pre` call site out of the dispatch
// instruction moves coveredKindsInRegion's (#3606) credited region past the
// `kind ==` mention and zeroes review:pre's contribution-kind coverage. No
// other test catches this — no in-tree capability declares review:pre yet,
// so tests/capability-registry.test.cjs's #3606 self-enforcement check
// passes vacuously. These two tests are the ones that do.

describe('review:pre is actually usable by a capability (#3606 regression, gh-3997)', () => {
  const wired = getWiredKinds(ROOT);

  test('getWiredKinds(ROOT) credits review:pre with exactly ["contribution"]', () => {
    assert.deepEqual([...(wired.get('review:pre') || [])], ['contribution']);
  });

  test('a capability declaring a review:pre reviewer contribution is accepted, not rejected', () => {
    const cap = {
      id: 'demo',
      contributions: [{ point: 'review:pre', into: 'reviewer', fragment: { inline: 'x' } }],
    };
    assert.deepEqual(validateHooksWired(cap, wired), []);
  });
});

// ─── 3. The contribution reaches every prompt transport (issue #3997 AC) ──────
//
// Real production functions, no mocks: `gsd_run query prompt-budget` (the same
// command review.md's prepare_trimmed_prompt_for_reviewer runs), resolveLanePlan
// (the same function `gsd_run query review-lane invoke` calls), and
// runOpenAiCompatible (the real HTTP-request-body builder) for stdin,
// argv-file-ref, argv, and openai-http respectively.

describe('the injected contribution reaches every prompt transport (issue #3997 AC, gh-3997)', () => {
  const MARKER = '<<gh-3997-reviewer-contribution-marker>>';
  const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
  const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const { runOpenAiCompatible } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');

  // Every test below shares one tmp dir and one budget-trimmed file: the budget test writes
  // it at the exact path resolveLanePlan's artifactPaths() derives from runDir
  // (`${runDir}/gsd-review-prompt.md`), and the transport tests reuse that same runDir — so
  // what's actually proven is the join the issue's AC asks for: the file prompt-budget trims
  // is the file each transport wires, not two independently-marked fixtures that merely share
  // a naming convention.
  let tmp;
  let promptPath;
  let promptBudgetStatus;
  let promptBudgetStderr;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh3997-transport-'));
    promptPath = path.join(tmp, 'gsd-review-prompt.md');
    const instructionsFile = path.join(tmp, 'instructions.md');
    const roadmapFile = path.join(tmp, 'roadmap.md');
    const planFile = path.join(tmp, 'plan.md');
    fs.writeFileSync(instructionsFile, `## Review Instructions\n\n${MARKER}\n`);
    fs.writeFileSync(roadmapFile, '# Roadmap\n');
    fs.writeFileSync(planFile, '# Plan\n'.repeat(500)); // large enough to force real trimming
    const result = spawnSync(process.execPath, [
      GSD_TOOLS, 'query', 'prompt-budget',
      '--budget', '2000', // small: below the untrimmed plan's size, so trimming genuinely happens
      '--instructions-file', instructionsFile,
      '--roadmap-file', roadmapFile,
      '--plan-file', planFile,
      '--output-prompt', promptPath,
      '--output-metadata', path.join(tmp, 'out.meta.json'),
    ], { encoding: 'utf8', timeout: 30_000 });
    promptBudgetStatus = result.status;
    promptBudgetStderr = result.stderr;
  });

  after(() => {
    cleanup(tmp);
  });

  test('gsd_run query prompt-budget preserves the marker verbatim, exactly once, at a small budget', () => {
    assert.equal(promptBudgetStatus, 0, `prompt-budget exited ${promptBudgetStatus}: ${promptBudgetStderr}`);
    const trimmed = fs.readFileSync(promptPath, 'utf8');
    assert.equal(trimmed.split(MARKER).length - 1, 1, 'marker must survive trimming exactly once');
  });

  test('stdin transport (real lane: gemini) — resolveLanePlan wires the trimmed file as stdin', () => {
    const result = resolveLanePlan({ lane: REVIEWER_LANES.find((l) => l.slug === 'gemini'), configGet: () => undefined, runDir: tmp, repoRoot: '/repo' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(fs.readFileSync(result.plan.stdin, 'utf8').includes(MARKER));
  });

  test('argv-file-ref transport (real lane: cursor) — argv names the trimmed file', () => {
    const result = resolveLanePlan({ lane: REVIEWER_LANES.find((l) => l.slug === 'cursor'), configGet: () => undefined, runDir: tmp, repoRoot: '/repo' });
    assert.ok(result.ok, JSON.stringify(result));
    const ref = result.plan.argv.find((a) => a.includes(promptPath));
    assert.ok(ref, 'argv-file-ref transport must name the prompt file path in argv');
    assert.ok(fs.readFileSync(promptPath, 'utf8').includes(MARKER), 'the file argv names must carry the marker');
  });

  test('openai-http transport (real lane: ollama) — the constructed HTTP request body carries the marker', async () => {
    const result = resolveLanePlan({ lane: REVIEWER_LANES.find((l) => l.slug === 'ollama'), configGet: () => undefined, runDir: tmp, repoRoot: '/repo' });
    assert.ok(result.ok, JSON.stringify(result));
    const promptText = fs.readFileSync(result.plan.promptPath, 'utf8'); // what runHttpLane does before calling runOpenAiCompatible
    let capturedBody = null;
    const deps = {
      httpJson: async (url, opts) => {
        capturedBody = opts.body;
        return { ok: true, status: 200, body: JSON.stringify({ model: 'llama3', choices: [{ message: { content: 'ok' } }] }) };
      },
      warn: () => {},
    };
    await runOpenAiCompatible(result.plan, promptText, deps);
    assert.ok(capturedBody, 'runOpenAiCompatible must call deps.httpJson');
    const parsed = JSON.parse(capturedBody);
    assert.ok(parsed.messages[0].content.includes(MARKER), 'the request body sent to the model must carry the marker');
  });

  test('argv transport (synthetic lane — no shipped lane declares bare argv today) — argv carries the literal path', () => {
    const gemini = REVIEWER_LANES.find((l) => l.slug === 'gemini');
    const argvLane = { ...gemini, slug: 'synthetic-argv', invoke: { ...gemini.invoke, args: ['{{prompt}}'], promptChannel: 'argv' } };
    const result = resolveLanePlan({ lane: argvLane, configGet: () => undefined, runDir: tmp, repoRoot: '/repo' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.plan.argv.includes(promptPath), 'argv-channel lane must place the literal prompt path in argv');
  });
});

// ─── 4. plan-review-convergence inherits through delegation, not re-wiring ───

describe('plan-review-convergence inherits review:pre via delegation (gh-3997)', () => {
  test('plan-review-convergence.md delegates to /gsd:review rather than re-assembling its own reviewer prompt', () => {
    const convergence = readFileNormalized(CONVERGENCE_PATH);
    assert.match(convergence, /Run \/gsd:review for Phase/, 'must delegate via the /gsd:review command');
  });
});
