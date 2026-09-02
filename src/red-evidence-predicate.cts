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
  implementation_target: string;
  expected_failure: {
    phase: string;
    class_or_mode: string;
    subject: string;
  };
}

interface RedEvidenceContext {
  plan: string;
  task_index: number;
  red_parent: string;
}

interface RedEvidenceReceipt {
  version: number;
  plan: string;
  task_index: number;
  target: string;
  pre_red_head: string;
  exit_status: number | null;
  signal: string | null;
  timed_out: boolean;
  error: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
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
const RECEIPT_KEYS = [
  'error', 'exit_status', 'plan', 'pre_red_head', 'signal', 'stderr_bytes',
  'stdout_bytes', 'target', 'task_index', 'timed_out', 'version',
].sort();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && !v.includes('\0');
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
  const opens = [...taskSource.matchAll(/<red_contract>/g)];
  const closes = [...taskSource.matchAll(/<\/red_contract>/g)];
  if (opens.length !== 1 || closes.length !== 1) return null;
  const start = opens[0].index ?? -1;
  const end = taskSource.indexOf('</red_contract>', start);
  return start === -1 || end === -1 ? null : taskSource.slice(start, end + '</red_contract>'.length);
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : '';
}

function extractExactTag(block: string, tag: string): string | null {
  if (countTags(block, tag) !== 1
    || [...block.matchAll(new RegExp(`</${tag}>`, 'g'))].length !== 1) return null;
  return extractTag(block, tag);
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
  if (countTags(block, 'program') !== 0 || countTags(block, 'argv_json') !== 0) {
    return {
      ok: false,
      reason: 'the selected <red_contract> must not declare executable program or argv_json text',
    };
  }
  const target_test = extractExactTag(block, 'target_test');
  const implementation_target = extractExactTag(block, 'implementation_target');
  const failureBlock = extractExactTag(block, 'expected_failure');
  if (!isNonEmptyString(target_test) || !isNonEmptyString(implementation_target)
    || !isNonEmptyString(failureBlock)) {
    return {
      ok: false,
      reason: 'the selected <red_contract> must declare exactly one non-empty target_test, implementation_target, and expected_failure',
    };
  }
  const expected_failure = {
    phase: extractExactTag(failureBlock, 'phase'),
    class_or_mode: extractExactTag(failureBlock, 'class_or_mode'),
    subject: extractExactTag(failureBlock, 'subject'),
  };
  if (!isNonEmptyString(expected_failure.phase)
    || !isNonEmptyString(expected_failure.class_or_mode)
    || !isNonEmptyString(expected_failure.subject)) {
    return {
      ok: false,
      reason: 'the selected <red_contract> expected_failure must declare non-empty phase, class_or_mode, and subject',
    };
  }
  return {
    ok: true,
    plan: {
      target_test,
      implementation_target,
      expected_failure: {
        phase: expected_failure.phase,
        class_or_mode: expected_failure.class_or_mode,
        subject: expected_failure.subject,
      },
    },
  };
}

function extractTrailerJson(trailerText: string): string {
  if (typeof trailerText !== 'string') return '';
  const idx = trailerText.indexOf('{');
  return idx === -1 ? '' : trailerText.slice(idx);
}

function evaluateRedEvidence(
  taskSource: string,
  trailerText: string,
  receiptText: string,
  context: RedEvidenceContext,
  parsedContract = parseRedContract(taskSource),
): RedEvidenceResult {
  if (!parsedContract.ok) {
    return { verdict: 'red_commit_not_failing', reason: parsedContract.reason };
  }
  const plan = parsedContract.plan;
  const parsedReceipt = safeJsonParse(receiptText, { label: 'red-evidence receipt' });
  if (!parsedReceipt.ok || !keysEqual(parsedReceipt.value, RECEIPT_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: 'the red-evidence receipt must be JSON with the exact required key set',
    };
  }
  const receipt = parsedReceipt.value as RedEvidenceReceipt;
  const receiptShapeValid = receipt.version === 1
    && isNonEmptyString(receipt.plan)
    && Number.isSafeInteger(receipt.task_index) && receipt.task_index > 0
    && isNonEmptyString(receipt.target)
    && isNonEmptyString(receipt.pre_red_head)
    && (receipt.exit_status === null || Number.isSafeInteger(receipt.exit_status))
    && (receipt.signal === null || isNonEmptyString(receipt.signal))
    && typeof receipt.timed_out === 'boolean'
    && typeof receipt.error === 'boolean'
    && Number.isSafeInteger(receipt.stdout_bytes) && receipt.stdout_bytes >= 0
    && Number.isSafeInteger(receipt.stderr_bytes) && receipt.stderr_bytes >= 0;
  if (!receiptShapeValid) {
    return { verdict: 'red_commit_not_failing', reason: 'the red-evidence receipt values are invalid' };
  }
  if (!isNonEmptyString(context?.plan)
    || !Number.isSafeInteger(context?.task_index) || context.task_index <= 0
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(context?.red_parent ?? '')
    || receipt.plan !== context.plan
    || receipt.task_index !== context.task_index
    || receipt.target !== plan.target_test
    || receipt.pre_red_head !== context.red_parent) {
    return { verdict: 'red_commit_not_failing', reason: 'the receipt is stale or bound to another plan, task, target, or RED parent' };
  }
  const parsed = safeJsonParse(extractTrailerJson(trailerText), { label: 'red-evidence trailer' });
  if (!parsed.ok || !keysEqual(parsed.value, TOP_LEVEL_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: 'the red-evidence trailer must be JSON with the exact required key set',
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
  if (!Number.isSafeInteger(exitStatus) || receipt.exit_status !== exitStatus) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer exit_status must be an integer' };
  }
  if (receipt.error || receipt.signal !== null || receipt.timed_out || receipt.exit_status === null) {
    return { verdict: 'red_commit_not_failing', reason: 'the captured RED process did not terminate normally' };
  }
  if (exitStatus === 0) {
    return { verdict: 'unexpected_pass', reason: 'the captured RED invocation exited 0' };
  }
  if (!isNonEmptyString(trailer['command'])) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer command must be non-empty inert display text' };
  }

  if (!keysEqual(trailer['expected'], TRIPLE_KEYS) || !keysEqual(trailer['actual'], TRIPLE_KEYS)) {
    return { verdict: 'red_commit_not_failing', reason: 'the trailer expected and actual triples are invalid' };
  }
  const expectedTriple = trailer['expected'] as Record<string, unknown>;
  const actualTriple = trailer['actual'] as Record<string, unknown>;
  const declaredPoint = { file: declared['file'], line: declared['line'] as number };
  const observedPoint = { file: observed['file'], line: observed['line'] as number };
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
