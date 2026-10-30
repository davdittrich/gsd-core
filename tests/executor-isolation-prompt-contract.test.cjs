'use strict';

/**
 * #3637 — the orchestrator-worktree process spawn must carry the gsd-executor
 * identity and execution contract, not a short objective-only prompt.
 *
 * The process-spawned child has NO host subagent machinery: nothing loads the
 * gsd-executor agent definition or the execute-plan workflow unless the
 * EXECUTOR_PROMPT carries them. A short prompt forced both reporters' executors
 * to reconstruct their role from repository search AND left them unaware of the
 * gitignored-planning skip semantics — so they force-staged gitignored
 * SUMMARY.md files (`git add -f`) to satisfy an unconditional
 * "SUMMARY.md created AND committed" criterion.
 *
 * These are source-text-is-the-product assertions: the workflow markdown IS
 * what the orchestrator runtime loads. The contract checked here is the
 * documented dispatch text, per the issue's acceptance list.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

// The orchestrator substitutes a fresh random {nonce} into the delimiter (opening and terminator lines).
const NONCE = '0f1e2d3c4b5a6978';
const ASSIGN = `IFS= read -r -d '' EXECUTOR_PROMPT <<'GSD_EXECUTOR_PROMPT_EOF_${NONCE}' || true`;
const TERMINATOR = `\nGSD_EXECUTOR_PROMPT_EOF_${NONCE}\n`;
const TEMPLATE_ASSIGN = ASSIGN.replace(NONCE, '{nonce}');
const TEMPLATE_TERMINATOR = TERMINATOR.replace(NONCE, '{nonce}');

/** The EXECUTOR_PROMPT quoted-heredoc assignment: full statement, and its body. */
function promptAssignment() {
  const start = content.indexOf(TEMPLATE_ASSIGN);
  const end = content.indexOf(TEMPLATE_TERMINATOR, start);
  assert.ok(start !== -1 && end !== -1, 'EXECUTOR_PROMPT quoted-heredoc assignment must exist');
  return content.slice(start, end + TEMPLATE_TERMINATOR.length).replaceAll('{nonce}', NONCE);
}
function promptBody() {
  return promptAssignment().slice(ASSIGN.length);
}

test('#3637: the executor prompt carries the required-reading contract with the explicit plan path', () => {
  const body = promptBody();
  assert.match(body, /<required_reading>/, 'the prompt must carry the required-reading contract');
  assert.match(body, /\{phase_dir\}\/\{plan_file\}/, 'the prompt must name the explicit plan path');
  assert.match(body, /PROJECT\.md/, 'project context is required reading');
});

test('#3637: the executor prompt carries the execution-context build-time embeds', () => {
  const body = promptBody();
  assert.match(body, /<execution_context>/, 'the prompt must carry an execution_context block');
  assert.match(body, /execute-plan\.md/, 'execute-plan.md must be embedded (the executor workflow)');
  assert.match(body, /worktree-path-safety\.md/, 'worktree path safety must be embedded');
});

test('#3637: the success criteria make an intentional gitignored skip a success path and forbid force-staging', () => {
  const body = promptBody();
  assert.match(body, /skipped_gitignored/, 'skipped_gitignored must be named as an intentional success path');
  assert.match(body, /git add -f/, 'force-staging must be explicitly forbidden');
  assert.doesNotMatch(
    body,
    /SUMMARY\.md created AND committed(?![^\n]*OR)/,
    'the unconditional "created AND committed" criterion that drove git add -f must not appear bare',
  );
});

test('#3637: the compose step fails closed when the embeds are missing', () => {
  assert.match(
    content,
    /grep -q '<required_reading>'[\s\S]{0,400}exit 1/,
    'a prompt missing the required-reading contract must halt before spawn',
  );
  assert.match(
    content,
    /grep -q 'skipped_gitignored'[\s\S]{0,400}exit 1/,
    'a prompt missing the skip semantics must halt before spawn',
  );
});

test('#3637: embed PERFORMANCE is gated — an un-embedded template halts before spawn', () => {
  // The two template-completeness greps above cannot detect skipped embeds
  // (the placeholders live in the template itself). The performance gates
  // catch the raw-template dispatch: the provenance parenthetical must be
  // GONE and the persona marker must be substituted (#3637 review finding).
  assert.match(
    content,
    /grep -q 'Inline the actual contents'[\s\S]{0,300}exit 1/,
    'a prompt still carrying its compose-time placeholder means the embeds were skipped — halt',
  );
  assert.match(
    content,
    /grep -q '\\\$\{AGENT_SKILLS\}'[\s\S]{0,300}exit 1/,
    'an un-substituted persona marker means the role definition was not spliced — halt',
  );
});

test('#4266: embed PERFORMANCE is gated — an un-substituted TDD_APPLICABLE marker halts before spawn', () => {
  // Matches the ${AGENT_SKILLS} gate immediately above: a third performance gate for
  // the #4266/#4272 TDD-applicability predicate, halting before worktree creation
  // when the marker survives composition.
  assert.match(
    content,
    /grep -q '\\\$\{TDD_APPLICABLE'[\s\S]{0,300}exit 1/,
    'an un-substituted TDD_APPLICABLE marker means the TDD-applicability decision was not resolved into the prompt — halt',
  );
});

test('#3637: the gsd-executor ROLE DEFINITION is a mandatory embed with provenance', () => {
  // The agent-skills query alone is conditional (its block is a skills list
  // whenever the project configures agent_skills; only unconfigured
  // non-Claude projects get the full agent file via the #2454 fallback).
  // The child has no host subagent machinery — the role definition itself
  // must ride the prompt (#3637 acceptance bullets 1 and 5).
  const body = promptBody();
  assert.match(body, /agents\/gsd-executor\.md/, 'the role definition file must be named as an embedded source');
  assert.match(body, /steps\s*0\/0a\/0b/, 'the per-commit HEAD/cwd-drift/path-guard discipline must be pointed at');
});

test('#3637: prior-wave summaries are required reading (parallel waves must not clobber siblings)', () => {
  const body = promptBody();
  assert.match(body, /prior_wave_summaries/, 'prior-wave SUMMARY files must be required reading on this parallel-wave backend');
});

test('#3637: the persona rides the prompt (${AGENT_SKILLS}), same as the harness path', () => {
  assert.match(promptBody(), /\$\{AGENT_SKILLS\}/, 'the gsd-executor persona variable must be spliced into the prompt');
});

test('#5531: apostrophe-bearing spliced content reaches the prompt byte-for-byte', (t) => {
  // Evaluate the documented assignment in bash after the orchestrator's textual
  // ${AGENT_SKILLS} substitution. A persona has apostrophes ("user's vision").
  const dir = createTempDir('gsd-5531-');
  t.after(() => cleanup(dir));
  const sentinel = path.join(dir, 'pwned');
  const persona = `<persona>\nthe user's vision; it doesn't '$(touch ${sentinel})' \`touch ${sentinel}\` "q" \\ end\n</persona>`;
  const stmt = promptAssignment().replace('${AGENT_SKILLS}', () => persona);
  const script = path.join(dir, 'compose.sh');
  fs.writeFileSync(script, stmt + '\nprintf "%s" "$EXECUTOR_PROMPT"');
  const r = runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes(persona), 'the spliced persona must appear verbatim in the prompt');
  assert.ok(r.stdout.startsWith('<objective>'), 'the template must be intact');
  assert.ok(r.stdout.includes('</success_criteria>'), 'the template must be complete');
  assert.ok(!fs.existsSync(sentinel), 'spliced text must not be executed');
});

// The documented guard that opens the second bash block: it must run outside the
// heredoc, because an unterminated heredoc swallows everything after it.
function promptGuard() {
  const lines = splitLines(content);
  const start = lines.findIndex((l) => l.startsWith('# Unterminated-heredoc guard'));
  const end = start < 0 ? -1 : lines.indexOf('esac', start);
  assert.ok(end > start, 'the unterminated-heredoc guard must exist in the post-compose block');
  return lines.slice(start, end + 1).join('\n') + '\n';
}

/**
 * The real first bash block from the assignment on (the heredoc plus the checks that follow it), so an
 * unterminated heredoc swallows them exactly as in production. The two compose-time placeholders the
 * checks reject are resolved inside the template only, as the orchestrator's embeds would.
 */
function block1(agentSkills) {
  const start = content.indexOf(TEMPLATE_ASSIGN);
  const block = content.slice(start, content.indexOf('\n```', start) + 1).replaceAll('{nonce}', NONCE);
  const split = block.indexOf(TERMINATOR) + TERMINATOR.length;
  const template = block.slice(0, split)
    .replace('${AGENT_SKILLS}', () => agentSkills)
    .replace('Inline the actual contents', 'Inlined the contents')
    .replace('${TDD_APPLICABLE', 'TDD_APPLICABLE');
  return template + block.slice(split);
}

/** Run block 1 (sourced, so an unterminated heredoc ends at the block's EOF), then the guard as the next block. */
function composeThenGuard(agentSkills, { mutate = (x) => x, strict = false } = {}) {
  const dir = createTempDir('gsd-5531-');
  try {
    fs.writeFileSync(path.join(dir, 'block1.sh'), mutate(block1(agentSkills)));
    const script = path.join(dir, 'compose.sh');
    fs.writeFileSync(
      script,
      (strict ? 'set -euo pipefail\n' : '') + `. "${dir}/block1.sh"\n` + promptGuard() + '\nprintf "%s" "$EXECUTOR_PROMPT"',
    );
    return runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  } finally {
    cleanup(dir);
  }
}

test('#5531: a terminator that is indented, CRLF or carries another nonce fails closed (the heredoc must not swallow the gate)', () => {
  for (const [name, mutate] of [
    ['indented', (x) => x.replace(TERMINATOR, `\n  ${TERMINATOR.slice(1)}`)],
    ['CRLF', (x) => x.replace(TERMINATOR, `${TERMINATOR.slice(0, -1)}\r\n`)],
    ['nonce mismatch', (x) => x.replace(TERMINATOR, TERMINATOR.replace(NONCE, 'ffffffffffffffff'))],
  ]) {
    const r = composeThenGuard('x', { mutate });
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    if (name === 'CRLF' && process.platform === 'win32') {
      // Git Bash reads the script in text mode, so the CR never reaches the delimiter match;
      // the heredoc terminates normally and the prompt is intact.
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.trimEnd().endsWith('</success_criteria>'), 'win32 CRLF: prompt must be intact');
      continue;
    }
    assert.notEqual(r.exitCode, 0, `${name} terminator must halt, not dispatch`);
    assert.match(r.stderr, /FATAL/, `${name}: halt must be loud`);
  }
});

test('#5531: an embed carrying the old fixed terminator line cannot end the heredoc or run shell', (t) => {
  const dir = createTempDir('gsd-5531-');
  t.after(() => cleanup(dir));
  const sentinel = path.join(dir, 'PWNED_BY_EMBED');
  // The second payload keeps the prompt ending at </success_criteria>: it defeats a tail-only guard.
  const embed = `a\nGSD_EXECUTOR_PROMPT_EOF\ntouch ${sentinel}\n</success_criteria>\nGSD_EXECUTOR_PROMPT_EOF\ntouch ${sentinel}`;
  const r = composeThenGuard(embed, { strict: true });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes(embed), 'the embed must pass through verbatim');
  assert.ok(!fs.existsSync(sentinel), 'embedded text must never be executed');
});

test('#5531: the heredoc delimiter carries a per-run {nonce} in the opening and terminator lines', () => {
  assert.ok(content.includes(TEMPLATE_ASSIGN) && content.includes(TEMPLATE_TERMINATOR));
  assert.match(content, /fresh random \{nonce\}/, 'the orchestrator must be told to generate the nonce');
});

test('#5531: only a 16-hex nonce passes the guard (unsubstituted, empty, short, long and non-hex halt)', (t) => {
  const lines = splitLines(content);
  const start = lines.findIndex((l) => l.startsWith('# Nonce guard'));
  assert.ok(start >= 0, 'the nonce guard must exist before the heredoc');
  const guard = lines.slice(start, lines.findIndex((l, i) => i > start && l.startsWith('IFS= read'))).join('\n') + '\n';
  assert.ok(guard.includes("GSD_NONCE='{nonce}'") && !guard.includes('GSD_EXECUTOR_PROMPT_EOF'), 'the guard checks one assigned value, not its own copy of the delimiter');
  const dir = createTempDir('gsd-5531-');
  t.after(() => cleanup(dir));
  const cases = [
    ['skipped', '{nonce}', false], ['empty', '', false], ['short', NONCE.slice(1), false],
    ['long', `${NONCE}0`, false], ['non-hex', 'G'.repeat(16), false],
    ['substituted', NONCE, true],
  ];
  for (const [name, value, ok] of cases) {
    const script = path.join(dir, `${name}.sh`);
    fs.writeFileSync(script, guard.replace("'{nonce}'", `'${value}'`));
    const r = runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
    if (ok) assert.equal(r.exitCode, 0, r.stderr);
    else {
      assert.notEqual(r.exitCode, 0, `${name} nonce must halt`);
      assert.match(r.stderr, /FATAL/);
    }
  }
});

test('#5531: step 2 tells the orchestrator to replace every {nonce} the bash block holds outside embedded text', () => {
  const lines = splitLines(content);
  const open = lines.findIndex((l) => l === TEMPLATE_ASSIGN);
  const term = lines.findIndex((l, i) => i > open && l === TEMPLATE_TERMINATOR.trim());
  const fence = lines.findIndex((l, i) => i > term && l === '```');
  assert.ok(open > 0 && term > open && fence > term);
  const first = lines.slice(0, open).findLastIndex((l) => l.startsWith('```bash'));
  // Code lines only: comments and the heredoc body (embedded text) are outside the substitution set.
  const code = [...lines.slice(first + 1, open + 1), ...lines.slice(term, fence)].filter((l) => !l.startsWith('#'));
  const occurrences = code.join('\n').split('{nonce}').length - 1;
  assert.equal(occurrences, 3, 'the GSD_NONCE assignment, the opening line and the terminator line');
  const step2 = lines.slice(lines.findIndex((l) => /^#\s+2\. /.test(l)), lines.findIndex((l) => /^#\s+3\. Inline/.test(l))).join(' ').replace(/#/g, ' ').replace(/\s+/g, ' ');
  assert.match(step2, /every `?\{nonce\}`?/i, 'step 2 must say every {nonce} is replaced');
  for (const role of ['GSD_NONCE assignment', 'opening line', 'terminator line']) assert.ok(step2.includes(role), `step 2 must name the ${role}`);
});

test('#5531: well-formed compose passes the guard under set -euo pipefail', () => {
  const r = composeThenGuard("the user's 'vision'", { strict: true });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes("the user's 'vision'"));
});

test('#5531: any embed (incl. terminator-like, CR-bearing and indented lines) passes through byte-for-byte', () => {
  const line = fc.oneof(
    fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 40 }),
    fc.constantFrom('GSD_EXECUTOR_PROMPT_EOF', '  GSD_EXECUTOR_PROMPT_EOF', 'GSD_EXECUTOR_PROMPT_EOF\r', 'x\r', '</success_criteria>'),
  );
  fc.assert(
    fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
      const embed = lines.join('\n');
      const r = composeThenGuard(embed, { strict: true });
      // Git Bash reads the script in text mode and drops CR, so win32 expects the embed without it.
      const expected = process.platform === 'win32' ? embed.replaceAll('\r', '') : embed;
      return r.exitCode === 0 && r.stdout.includes(expected);
    }),
    { numRuns: 10 },
  );
});
