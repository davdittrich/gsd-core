import path from 'node:path';
import { safeJsonParse } from './security.cjs';

/**
 * RED-Evidence Predicate — issue #3770 (Phase 3)
 *
 * Pure leaf evaluator for the `red-evidence:` trailer against a task's
 * `<red_contract>` declaration. `gsd-core/references/tdd.md`'s `### RED
 * Predicate` fence is the canonical predicate; this module implements it and
 * never restates or quotes it beyond naming the conjuncts as code.
 *
 * This is a leaf pure module: no fs, no child_process, no config. The caller
 * (`routeRedEvidenceVerdict` in `task-command-router.cts`) reads the task
 * file and the trailer text itself and passes both in as strings — this
 * module owns all JSON parsing and every key-set equality check: the
 * trailer's top level, `location`'s two points, each point's two fields,
 * and `expected`/`actual`'s three fields.
 *
 * `evaluateRedEvidence` never throws and never defaults to `authorize`: every
 * malformed or ambiguous input returns `red_commit_not_failing` with a
 * `reason`, and only a fully-conforming six-key trailer that satisfies the
 * predicate returns `authorize`.
 */

interface RedContractPlan {
  target_test: string;
  program: string;
  argv: string[];
  expected_failure: {
    phase: string;
    class_or_mode: string;
    subject: string;
  };
}

interface RedEvidenceObservation {
  exit_status: number | null;
  stderr_captured: boolean;
  spawn_error: boolean;
  signal: string | null;
  timed_out: boolean;
}

type RedEvidenceVerdict = 'authorize' | 'red_commit_not_failing' | 'unexpected_pass';

interface RedEvidenceResult {
  verdict: RedEvidenceVerdict;
  reason: string;
  failed?: string[];
  declared_file?: string;
}

const TOP_LEVEL_KEYS = [
  'actual', 'command', 'exit_status', 'expected', 'location', 'target_test',
].sort();
const LOCATION_KEYS = ['declared', 'observed'].sort();
const LOCATION_POINT_KEYS = ['file', 'line'].sort();
const TRIPLE_KEYS = ['class_or_mode', 'phase', 'subject'].sort();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function keysEqual(obj: unknown, expectedSortedKeys: readonly string[]): boolean {
  if (!isPlainObject(obj)) return false;
  const actual = Object.keys(obj).sort();
  return actual.length === expectedSortedKeys.length
    && actual.every((key, i) => key === expectedSortedKeys[i]);
}

function sameTriple(a: Record<string, unknown>, b: RedContractPlan['expected_failure']): boolean {
  return a['phase'] === b['phase']
    && a['class_or_mode'] === b['class_or_mode']
    && a['subject'] === b['subject'];
}

function locationsAgree(
  declared: { file: string; line: number },
  observed: { file: string; line: number },
): boolean {
  return path.win32.basename(declared.file) === path.win32.basename(observed.file)
    && declared.line === observed.line;
}

function countTags(block: string, tag: string): number {
  return [...block.matchAll(new RegExp(`<${tag}>`, 'g'))].length;
}

function extractRedContractBlock(taskSource: string): string | null {
  const matches = [...taskSource.matchAll(/<red_contract>/g)];
  if (matches.length !== 1) return null;
  const start = matches[0].index ?? -1;
  const end = taskSource.indexOf('</red_contract>', start);
  return start === -1 || end === -1 ? null : taskSource.slice(start, end + '</red_contract>'.length);
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : '';
}

function parseRedContract(taskSource: string):
  | { ok: true; plan: RedContractPlan }
  | { ok: false; reason: string } {
  const block = extractRedContractBlock(taskSource);
  if (!block) {
    return {
      ok: false,
      reason: 'the selected task must carry exactly one well-formed <red_contract> declaration',
    };
  }
  const required = ['target_test', 'program', 'argv_json'];
  if (required.some((tag) => countTags(block, tag) !== 1)) {
    return {
      ok: false,
      reason: 'the selected <red_contract> must declare exactly one <target_test>, <program>, and <argv_json>',
    };
  }

  const target_test = extractTag(block, 'target_test');
  const program = extractTag(block, 'program');
  const argvParsed = safeJsonParse(extractTag(block, 'argv_json'), { label: 'red_contract argv_json' });
  if (!isNonEmptyString(target_test) || !isNonEmptyString(program)
    || !argvParsed.ok || !Array.isArray(argvParsed.value)
    || !argvParsed.value.every((value) => typeof value === 'string')) {
    return {
      ok: false,
      reason: 'the selected <red_contract> must declare non-empty program, target_test, and argv_json string array',
    };
  }
  const argv = argvParsed.value as string[];
  if (!argv.includes(target_test)) {
    return {
      ok: false,
      reason: 'the selected <red_contract> target_test must equal one complete argv_json element',
    };
  }

  const failureBlock = extractTag(block, 'expected_failure');
  const expected_failure = {
    phase: extractTag(failureBlock, 'phase'),
    class_or_mode: extractTag(failureBlock, 'class_or_mode'),
    subject: extractTag(failureBlock, 'subject'),
  };
  if (![expected_failure.phase, expected_failure.class_or_mode, expected_failure.subject].every(isNonEmptyString)) {
    return {
      ok: false,
      reason: 'the selected <red_contract> expected_failure must declare non-empty phase, class_or_mode, and subject',
    };
  }
  return { ok: true, plan: { target_test, program, argv, expected_failure } };
}

function extractTrailerJson(trailerText: string): string {
  if (typeof trailerText !== 'string') return '';
  const idx = trailerText.indexOf('{');
  return idx === -1 ? '' : trailerText.slice(idx);
}

function evaluateRedEvidence(
  taskSource: string,
  trailerText: string,
  observation?: RedEvidenceObservation,
  parsedContract = parseRedContract(taskSource),
): RedEvidenceResult {
  if (!parsedContract.ok) {
    return { verdict: 'red_commit_not_failing', reason: parsedContract.reason };
  }
  const plan = parsedContract.plan;
  const parsed = safeJsonParse(extractTrailerJson(trailerText), { label: 'red-evidence trailer' });
  if (!parsed.ok || !keysEqual(parsed.value, TOP_LEVEL_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: parsed.error || 'the red-evidence trailer must be JSON with the exact required key set',
    };
  }
  const trailer = parsed.value as Record<string, unknown>;
  if (!keysEqual(trailer['location'], LOCATION_KEYS)) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer location key set is invalid' };
  }
  const location = trailer['location'] as Record<string, unknown>;
  if (!keysEqual(location['declared'], LOCATION_POINT_KEYS)
    || !keysEqual(location['observed'], LOCATION_POINT_KEYS)) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer location points are invalid' };
  }
  const declared = location['declared'] as Record<string, unknown>;
  const observed = location['observed'] as Record<string, unknown>;
  if (!Number.isInteger(declared['line']) || !Number.isInteger(observed['line'])
    || !isNonEmptyString(declared['file']) || !isNonEmptyString(observed['file'])) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer location values are invalid' };
  }

  const exitStatus = trailer['exit_status'];
  if (!Number.isInteger(exitStatus)) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer exit_status must be an integer' };
  }
  if (exitStatus === 0) {
    return { verdict: 'unexpected_pass', reason: 'the declared RED invocation exited 0' };
  }
  if (trailer['command'] !== JSON.stringify([plan.program, ...plan.argv])) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer command is not the selected canonical invocation display' };
  }
  if (!isPlainObject(observation) || !Number.isInteger(observation.exit_status)
    || observation.exit_status === 0 || observation.stderr_captured !== true
    || observation.spawn_error !== false || observation.signal !== null || observation.timed_out !== false
    || observation.exit_status !== exitStatus) {
    return { verdict: 'red_commit_not_failing', reason: 'the selected invocation was not observed to exit with the declared non-zero status and captured stderr' };
  }

  if (!keysEqual(trailer['expected'], TRIPLE_KEYS) || !keysEqual(trailer['actual'], TRIPLE_KEYS)) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer expected and actual triples are invalid' };
  }
  const expectedTriple = trailer['expected'] as Record<string, unknown>;
  const actualTriple = trailer['actual'] as Record<string, unknown>;
  const declaredPoint = { file: declared['file'] as string, line: declared['line'] as number };
  const observedPoint = { file: observed['file'] as string, line: observed['line'] as number };
  const checks: Array<[string, boolean]> = [
    ['trailer.expected == plan.expected_failure', sameTriple(expectedTriple, plan.expected_failure)],
    ['actual.phase == expected.phase', actualTriple['phase'] === expectedTriple['phase']],
    ['actual.class_or_mode == expected.class_or_mode', actualTriple['class_or_mode'] === expectedTriple['class_or_mode']],
    ['trailer.target_test == plan.target_test', trailer['target_test'] === plan.target_test],
    ['location.observed == location.declared', locationsAgree(declaredPoint, observedPoint)],
    ['actual.subject == plan.target_test', actualTriple['subject'] === plan.target_test],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return failed.length === 0
    ? { verdict: 'authorize', reason: 'every conjunct of the RED Predicate holds', declared_file: declaredPoint.file }
    : { verdict: 'red_commit_not_failing', reason: `the RED Predicate does not hold; failed conjuncts: ${failed.join(' | ')}`, failed };
}

export = {
  evaluateRedEvidence,
  parseRedContract,
};
