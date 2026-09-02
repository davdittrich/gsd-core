/**
 * Task command router — is-behavior-adding subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/task-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import redEvidencePredicateMod = require('./red-evidence-predicate.cjs');
const { evaluateRedEvidence, parseRedContract } = redEvidencePredicateMod;
import { execTool } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLoaderMod = require('./capability-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import taskContentResolutionMod = require('./task-content-resolution.cjs');
const {
  resolveTaskContent,
  ResolverAmbiguousError,
  ResolverFailedError,
  ResolverTimeoutError,
  ResolverMalformedOutputError,
} = taskContentResolutionMod;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BehaviorAddingChecks {
  tdd_true: boolean;
  has_behavior_block: boolean;
  has_source_files: boolean;
}

interface BehaviorAddingResult {
  is_behavior_adding: boolean;
  checks: BehaviorAddingChecks;
  reason: string | null;
}

interface RouteTaskCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  execToolFn?: typeof execTool;
  gitToolFn?: typeof execTool;
  fsFn?: typeof fs;
}

interface PlanTaskLike {
  index: number;
  kind: string;
  taskSource: string;
  trackerId: string | null;
}

interface CapabilityLike {
  id: string;
  taskContentResolver?: unknown;
}

/**
 * Testability seam for `routeResolveContent` (mirrors this codebase's other
 * routers' `_`-prefixed injection convention, e.g.
 * `refactor-trigger-command-router.cts`'s `_git`/`_windows`/`_core`).
 * Production callers omit both fields.
 */
interface ResolveContentDeps {
  loadCapabilities?: (cwd: string) => CapabilityLike[];
  resolveTaskContentFn?: typeof resolveTaskContent;
}

interface SelectedPlanTask {
  projectRoot: string;
  planPath: string;
  relativePlan: string;
  taskIndex: number;
  task: PlanTaskLike;
}

interface ReceiptPaths {
  finalPath: string;
  temporaryPath: string;
  claimedPath: string;
}

const RECEIPT_PREFIX = 'gsd-red-evidence-';
const RECEIPT_LIMIT_BYTES = 16 * 1024;
const RED_PROCESS_TIMEOUT_MS = 30_000;

// ─── Implementation ───────────────────────────────────────────────────────────

function isBehaviorAddingTaskContent(content: string): BehaviorAddingResult {
  const tddTrue = /\btdd\s*=\s*["']true["']/i.test(content);

  const behaviorMatch = content.match(/<behavior>([\s\S]*?)<\/behavior>/i);
  const hasBehaviorBlock = Boolean(behaviorMatch && behaviorMatch[1].trim().length > 0);

  const filesMatch = content.match(/<files>([\s\S]*?)<\/files>/i);
  let hasSourceFiles = false;
  if (filesMatch) {
    const fileLines = filesMatch[1]
      .split(/[\n,]/)
      .map((line) => line.trim().replace(/^[-*]\s*/, ''))
      .filter(Boolean);
    hasSourceFiles = fileLines.some((file) =>
      !/\.md$/i.test(file) &&
      !/\.json$/i.test(file) &&
      !/\.test\.[^.]+$/i.test(file) &&
      !/\.spec\.[^.]+$/i.test(file) &&
      !/(^|[\\/])tests?[\\/]/i.test(file) &&
      !/\.(yml|yaml|toml|ini|cfg|conf|properties)$/i.test(file) &&
      !/(^|[\\/])\.env(\..+)?$/i.test(file)
    );
  }

  const isBehaviorAdding = tddTrue && hasBehaviorBlock && hasSourceFiles;
  const missing: string[] = [];
  if (!tddTrue) missing.push('tdd="true" frontmatter absent');
  if (!hasBehaviorBlock) missing.push('<behavior> block missing or empty');
  if (!hasSourceFiles) missing.push('<files> has no non-test source file');

  return {
    is_behavior_adding: isBehaviorAdding,
    checks: {
      tdd_true: tddTrue,
      has_behavior_block: hasBehaviorBlock,
      has_source_files: hasSourceFiles,
    },
    reason: isBehaviorAdding ? null : `Not behavior-adding: ${missing.join('; ')}`,
  };
}

/**
 * Default (production) capability loader for `resolve-content`: the merged
 * first-party + validated-installed-overlay registry (ADR-1244 D2), the
 * established runtime read path for "installed capabilities including
 * third-party" — as opposed to `capability-loader.cts`'s heavier build-time
 * validation entry points or the static `capability-registry.cjs` alone
 * (first-party only, would miss a third-party capability's
 * `taskContentResolver` declaration entirely).
 */
function defaultLoadCapabilities(cwd: string): CapabilityLike[] {
  const registry = capabilityLoaderMod.loadRegistry({ includeInstalled: true, cwd }) as {
    capabilities?: Record<string, CapabilityLike>;
  };
  return Object.values(registry.capabilities ?? {});
}

function canonicalTaskIndex(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizedRelativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function selectPlanTask(
  taskFile: unknown,
  taskIndexText: unknown,
  cwd: string,
  fsImpl: typeof fs,
): SelectedPlanTask | null {
  if (typeof taskFile !== 'string' || taskFile.length === 0 || taskFile.includes('\0')) return null;
  const taskIndex = canonicalTaskIndex(taskIndexText);
  if (taskIndex === null) return null;

  let projectRoot: string;
  let planPath: string;
  try {
    projectRoot = fsImpl.realpathSync(path.resolve(cwd || process.cwd()));
    planPath = fsImpl.realpathSync(path.resolve(projectRoot, taskFile));
    if (!fsImpl.statSync(planPath).isFile() || !isContainedPath(projectRoot, planPath)) return null;
  } catch {
    return null;
  }
  try {
    const source = fsImpl.readFileSync(planPath, 'utf8');
    const plan = parsePlanDocument(source, planPath) as { tasks?: PlanTaskLike[] };
    const task = (plan.tasks ?? []).find((candidate) => candidate.index === taskIndex);
    if (!task || !['auto', 'tracer'].includes(task.kind) || typeof task.taskSource !== 'string') return null;
    return {
      projectRoot,
      planPath,
      relativePlan: normalizedRelativePath(projectRoot, planPath),
      taskIndex,
      task,
    };
  } catch {
    return null;
  }
}

function safeGitText(result: ReturnType<typeof execTool>): string | null {
  if (result.exitCode !== 0 || result.error || result.signal || result.timedOut
    || typeof result.stdout !== 'string' || result.stdout.includes('\0')) return null;
  return result.stdout.replace(/\r?\n$/, '');
}

function resolveGitDir(
  projectRoot: string,
  gitToolFn: typeof execTool,
  fsImpl: typeof fs,
): string | null {
  let raw: string | null;
  try {
    raw = safeGitText(gitToolFn(
      'git', ['rev-parse', '--path-format=absolute', '--git-dir'],
      { cwd: projectRoot, timeout: RED_PROCESS_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }
  if (!raw || raw.includes('\n') || raw.includes('\r')) return null;
  try {
    const gitDir = fsImpl.realpathSync(path.resolve(projectRoot, raw));
    return fsImpl.statSync(gitDir).isDirectory() ? gitDir : null;
  } catch {
    return null;
  }
}

function receiptPaths(gitDir: string, selected: SelectedPlanTask, target: string): ReceiptPaths {
  const id = crypto.createHash('sha256')
    .update(`${selected.relativePlan}\0${selected.taskIndex}\0${target}`)
    .digest('hex');
  return {
    finalPath: path.join(gitDir, `${RECEIPT_PREFIX}${id}.json`),
    temporaryPath: path.join(gitDir, `${RECEIPT_PREFIX}${id}.tmp`),
    claimedPath: path.join(gitDir, `${RECEIPT_PREFIX}${id}.claim`),
  };
}

function failCapture(): never {
  error('RED evidence capture failed closed', ERROR_REASON.UNKNOWN);
  throw new Error('unreachable');
}

function existsNoFollow(filePath: string, fsImpl: typeof fs): boolean {
  try {
    fsImpl.lstatSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
}

function unlinkIfPresent(filePath: string, fsImpl: typeof fs): boolean {
  try {
    fsImpl.unlinkSync(filePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

function reserveReceipt(
  paths: ReceiptPaths,
  fsImpl: typeof fs,
): number {
  let fd: number | null = null;
  let owned = false;
  try {
    if (existsNoFollow(paths.finalPath, fsImpl)
      || existsNoFollow(paths.temporaryPath, fsImpl)
      || existsNoFollow(paths.claimedPath, fsImpl)) throw new Error('receipt collision');
    fd = fsImpl.openSync(paths.temporaryPath, 'wx', 0o600);
    owned = true;
    fsImpl.fchmodSync(fd, 0o600);
    return fd;
  } catch {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch { /* fail closed below */ }
    }
    if (owned) unlinkIfPresent(paths.temporaryPath, fsImpl);
    failCapture();
  }
}

function publishReceipt(
  paths: ReceiptPaths,
  receiptText: string,
  fd: number,
  fsImpl: typeof fs,
): void {
  let open = true;
  try {
    if (Buffer.byteLength(receiptText) > RECEIPT_LIMIT_BYTES) throw new Error('receipt too large');
    const bytes = Buffer.from(receiptText, 'utf8');
    if (fsImpl.writeSync(fd, bytes, 0, bytes.length, null) !== bytes.length) {
      throw new Error('short receipt write');
    }
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    open = false;
    if (existsNoFollow(paths.finalPath, fsImpl)
      || existsNoFollow(paths.claimedPath, fsImpl)) throw new Error('receipt collision');
    fsImpl.renameSync(paths.temporaryPath, paths.finalPath);
  } catch {
    if (open) {
      try { fsImpl.closeSync(fd); } catch { /* fail closed below */ }
    }
    unlinkIfPresent(paths.temporaryPath, fsImpl);
    failCapture();
  }
}

function abandonReservation(fd: number, paths: ReceiptPaths, fsImpl: typeof fs): never {
  try { fsImpl.closeSync(fd); } catch { /* fail closed below */ }
  unlinkIfPresent(paths.temporaryPath, fsImpl);
  return failCapture();
}

function parseResolveContentArgs(args: string[]): { plan: string | null; taskId: string | null } {
  let plan: string | null = null;
  let taskId: string | null = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--plan') {
      plan = args[i + 1] ?? null;
      i++;
    } else if (args[i] === '--task-id') {
      taskId = args[i + 1] ?? null;
      i++;
    }
  }
  return { plan, taskId };
}

/**
 * `task resolve-content --plan <PLAN.md path> --task-id <tracker-id value> --raw`
 * (ADR-3646 Decision 2). Resolves one task's content from the external
 * tracker its `tracker-id` attribute names, via `task-content-resolution.cts`.
 *
 * HARD-HALT CONTRACT: a thrown `ResolverAmbiguousError` / `ResolverFailedError`
 * / `ResolverTimeoutError` / `ResolverMalformedOutputError` from
 * `resolveTaskContent` is turned into this CLI's own non-zero exit via
 * `error()` — never swallowed into a `{resolved: false}` JSON answer. Any
 * other thrown error is not one of the four documented resolver-error
 * classes and is allowed to propagate uncaught.
 */
function routeResolveContent(
  { args, cwd, raw }: RouteTaskCommandOptions,
  deps: ResolveContentDeps = {},
): void {
  const usage = 'Usage: task resolve-content --plan <path> --task-id <tracker-id> --raw';
  const { plan, taskId } = parseResolveContentArgs(args);
  if (!plan || !taskId) {
    error(usage, ERROR_REASON.USAGE);
    return;
  }

  const projectRoot = path.resolve(cwd || process.cwd());
  const resolvedPlanPath = path.resolve(projectRoot, plan);
  const rel = path.relative(projectRoot, resolvedPlanPath);
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
    error(`Plan file is outside project scope: ${plan}`, ERROR_REASON.USAGE);
    return;
  }
  if (!fs.existsSync(resolvedPlanPath)) {
    error(`Plan file not found: ${plan}`, ERROR_REASON.USAGE);
    return;
  }

  const planContent = fs.readFileSync(resolvedPlanPath, 'utf-8');
  const parsedPlan = parsePlanDocument(planContent, resolvedPlanPath) as { tasks?: PlanTaskLike[] };
  const task = (parsedPlan.tasks ?? []).find((t) => t.trackerId === taskId);
  if (!task) {
    error(`No task with tracker-id '${taskId}' found in plan: ${plan}`, ERROR_REASON.USAGE);
    return;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const capabilities = loadCapabilities(projectRoot);
  const resolveFn = deps.resolveTaskContentFn ?? resolveTaskContent;

  let result;
  try {
    result = resolveFn({ trackerId: task.trackerId, capabilities });
  } catch (err) {
    if (
      err instanceof ResolverAmbiguousError ||
      err instanceof ResolverFailedError ||
      err instanceof ResolverTimeoutError ||
      err instanceof ResolverMalformedOutputError
    ) {
      error((err as Error).message, ERROR_REASON.UNKNOWN);
      return;
    }
    throw err;
  }

  switch (result.kind) {
    case 'not-applicable':
      output({ resolved: false }, raw, undefined);
      return;
    case 'no-resolver':
      output({ resolved: false, reason: 'no-resolver' }, raw, undefined);
      return;
    case 'empty':
      output({ resolved: false, reason: 'empty' }, raw, undefined);
      return;
    case 'resolved':
      output({ resolved: true, content: result.content }, raw, undefined);
      return;
  }
}

function routeRedEvidenceCapture({
  args, cwd, raw, execToolFn, gitToolFn, fsFn,
}: RouteTaskCommandOptions): void {
  const separator = args.indexOf('--');
  if (separator === -1) failCapture();
  const prefix = args.slice(0, separator);
  const vector = args.slice(separator + 1);
  const opts = parseNamedArgsOrExit(
    prefix,
    { valueFlags: ['task-file', 'task-index'], positionals: 2 },
    error,
  );
  if (['task-file', 'task-index'].some((flag) =>
    prefix.filter((arg) => arg === `--${flag}`).length !== 1)
    || vector.length === 0
    || vector.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || vector[0].length === 0) failCapture();

  const fsImpl = fsFn ?? fs;
  const selected = selectPlanTask(opts['task-file'], opts['task-index'], cwd, fsImpl);
  if (!selected) failCapture();
  const contract = parseRedContract(selected.task.taskSource);
  if (!contract.ok) failCapture();
  if (vector.slice(1).filter((arg) => arg === contract.plan.target_test).length !== 1) failCapture();

  const git = gitToolFn ?? execTool;
  const gitDir = resolveGitDir(selected.projectRoot, git, fsImpl);
  if (!gitDir) failCapture();
  const paths = receiptPaths(gitDir, selected, contract.plan.target_test);
  const receiptFd = reserveReceipt(paths, fsImpl);

  let preRedHead: string | null;
  try {
    preRedHead = safeGitText(git(
      'git', ['rev-parse', 'HEAD'],
      { cwd: selected.projectRoot, timeout: RED_PROCESS_TIMEOUT_MS },
    ));
  } catch {
    abandonReservation(receiptFd, paths, fsImpl);
  }
  if (!preRedHead || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(preRedHead)) {
    abandonReservation(receiptFd, paths, fsImpl);
  }

  let spawned: ReturnType<typeof execTool>;
  try {
    spawned = (execToolFn ?? execTool)(
      vector[0], vector.slice(1),
      { cwd: selected.projectRoot, timeout: RED_PROCESS_TIMEOUT_MS },
    );
  } catch {
    spawned = {
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: null,
      error: new Error('red process failed'),
      timedOut: false,
    };
  }
  const receipt = {
    version: 1,
    plan: selected.relativePlan,
    task_index: selected.taskIndex,
    target: contract.plan.target_test,
    pre_red_head: preRedHead,
    exit_status: Number.isSafeInteger(spawned.exitCode) ? spawned.exitCode : null,
    signal: typeof spawned.signal === 'string' ? spawned.signal : null,
    timed_out: spawned.timedOut === true,
    error: spawned.error !== null && spawned.error !== undefined,
    stdout_bytes: typeof spawned.stdout === 'string' ? Buffer.byteLength(spawned.stdout) : 0,
    stderr_bytes: typeof spawned.stderr === 'string' ? Buffer.byteLength(spawned.stderr) : 0,
  };
  publishReceipt(paths, JSON.stringify(receipt), receiptFd, fsImpl);
  output({
    captured: true,
    pre_red_head: preRedHead,
    exit_status: receipt.exit_status,
    signal: receipt.signal,
    timed_out: receipt.timed_out,
    error: receipt.error,
    stdout_bytes: receipt.stdout_bytes,
    stderr_bytes: receipt.stderr_bytes,
  }, raw, undefined);
}

function terminalReceiptFailure(raw: boolean, reason: string): void {
  output({
    verdict: 'red_commit_not_failing',
    reason,
    observed_exit_status: null,
    stderr_captured: false,
  }, raw, undefined);
}

function consumeReceipt(filePath: string, fsImpl: typeof fs): boolean {
  try {
    fsImpl.unlinkSync(filePath);
    return !existsNoFollow(filePath, fsImpl);
  } catch {
    return false;
  }
}

function claimReceipt(paths: ReceiptPaths, fsImpl: typeof fs): string | null {
  try {
    if (existsNoFollow(paths.claimedPath, fsImpl)) return null;
    fsImpl.renameSync(paths.finalPath, paths.claimedPath);
    return paths.claimedPath;
  } catch {
    return null;
  }
}

function readBoundedReceipt(filePath: string, gitDir: string, fsImpl: typeof fs): string | null {
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECEIPT_LIMIT_BYTES) return null;
    const resolved = fsImpl.realpathSync(filePath);
    if (path.dirname(resolved) !== gitDir || resolved !== filePath) return null;
    const receipt = fsImpl.readFileSync(filePath, 'utf8');
    return Buffer.byteLength(receipt) <= RECEIPT_LIMIT_BYTES ? receipt : null;
  } catch {
    return null;
  }
}

function routeRedEvidenceVerdict({
  args, cwd, raw, gitToolFn, fsFn,
}: RouteTaskCommandOptions): void {
  const securityFlags = ['task-file', 'task-index', 'red-sha', 'trailer'];
  const opts = parseNamedArgsOrExit(
    args,
    { valueFlags: securityFlags, positionals: 2 },
    error,
  );
  if (securityFlags.some((flag) => args.filter((arg) => arg === `--${flag}`).length !== 1)) {
    terminalReceiptFailure(raw, 'the verdict flags must occur exactly once');
    return;
  }
  const fsImpl = fsFn ?? fs;
  const selected = selectPlanTask(opts['task-file'], opts['task-index'], cwd, fsImpl);
  const trailer = opts['trailer'];
  const redSha = opts['red-sha'];
  if (!selected) {
    terminalReceiptFailure(raw, 'the selected task or verdict input is invalid');
    return;
  }
  const contract = parseRedContract(selected.task.taskSource);
  if (!contract.ok) {
    terminalReceiptFailure(raw, contract.reason);
    return;
  }
  const git = gitToolFn ?? execTool;
  const gitDir = resolveGitDir(selected.projectRoot, git, fsImpl);
  if (!gitDir) {
    terminalReceiptFailure(raw, 'the worktree Git directory is unavailable');
    return;
  }
  const paths = receiptPaths(gitDir, selected, contract.plan.target_test);
  const claimedPath = claimReceipt(paths, fsImpl);
  if (claimedPath === null) {
    terminalReceiptFailure(raw, 'the bounded RED receipt is missing, colliding, or invalid');
    return;
  }
  const receiptText = readBoundedReceipt(claimedPath, gitDir, fsImpl);
  if (receiptText === null) {
    const consumed = consumeReceipt(claimedPath, fsImpl);
    terminalReceiptFailure(raw, consumed
      ? 'the bounded RED receipt is missing or invalid'
      : 'the RED receipt could not be consumed');
    return;
  }
  if (typeof trailer !== 'string' || trailer.includes('\0')
    || typeof redSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(redSha)) {
    const consumed = consumeReceipt(claimedPath, fsImpl);
    terminalReceiptFailure(raw, consumed
      ? 'the selected task or verdict input is invalid'
      : 'the RED receipt could not be consumed');
    return;
  }

  let result: ReturnType<typeof evaluateRedEvidence> = {
    verdict: 'red_commit_not_failing',
    reason: 'Git metadata validation failed closed',
  };
  let observedExitStatus: number | null = null;
  let stderrCaptured = false;
  try {
    const parentText = safeGitText(git(
      'git', ['rev-list', '--parents', '-n', '1', redSha],
      { cwd: selected.projectRoot, timeout: RED_PROCESS_TIMEOUT_MS },
    ));
    const parents = parentText?.split(' ') ?? [];
    if (parents.length === 2 && parents[0] === redSha && parents[1] !== redSha
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parents[1])) {
      const changed = git(
        'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', redSha],
        { cwd: selected.projectRoot, timeout: RED_PROCESS_TIMEOUT_MS },
      );
      if (changed.exitCode === 0 && !changed.error && !changed.signal && !changed.timedOut
        && typeof changed.stdout === 'string') {
        result = evaluateRedEvidence(
          selected.task.taskSource,
          trailer,
          receiptText,
          { plan: selected.relativePlan, task_index: selected.taskIndex, red_parent: parents[1] },
          contract,
        );
        const receiptParsed = JSON.parse(receiptText) as { exit_status?: unknown; stderr_bytes?: unknown };
        observedExitStatus = Number.isSafeInteger(receiptParsed.exit_status) ? receiptParsed.exit_status as number : null;
        stderrCaptured = Number.isSafeInteger(receiptParsed.stderr_bytes);
        if (result.verdict === 'authorize'
          && !changedFilesInclude(changed.stdout, contract.plan.target_test)) {
          result = {
            verdict: 'red_commit_not_failing',
            reason: `the commit's changed files do not include "${contract.plan.target_test}"`,
          };
        }
      }
    }
  } catch {
    result = { verdict: 'red_commit_not_failing', reason: 'Git metadata validation failed closed' };
  }

  if (!consumeReceipt(claimedPath, fsImpl)) {
    result = { verdict: 'red_commit_not_failing', reason: 'the RED receipt could not be consumed' };
  }
  output({
    verdict: result.verdict,
    reason: result.reason,
    observed_exit_status: observedExitStatus,
    stderr_captured: stderrCaptured,
  }, raw, undefined);
}

/** Exact membership in Git's required NUL-delimited changed-path output. */
function changedFilesInclude(changedFilesText: string, declaredFile: string): boolean {
  if (!changedFilesText.endsWith('\0')) return false;
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const declaredPath = norm(declaredFile);
  return changedFilesText
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map(norm)
    .some((changed) => changed === declaredPath);
}

function routeTaskCommand(options: RouteTaskCommandOptions): void {
  const { args, cwd, raw } = options;
  const subcommand = args[1];
  if (subcommand === 'resolve-content') {
    routeResolveContent({ args, cwd, raw });
    return;
  }
  if (subcommand === 'red-evidence-capture') {
    routeRedEvidenceCapture(options);
    return;
  }
  if (subcommand === 'red-evidence-verdict') {
    routeRedEvidenceVerdict(options);
    return;
  }
  if (subcommand !== 'is-behavior-adding') {
    error(
      'Unknown task subcommand. Available: is-behavior-adding, resolve-content, '
        + 'red-evidence-capture, red-evidence-verdict',
      ERROR_REASON.SDK_UNKNOWN_COMMAND,
    );
  }

  let content: string | null = null;
  if (args[2] && args[2] !== '--task-content') {
    const requestedPath = args[2];
    // Resolve symlinks on BOTH sides before comparing (same rationale as
    // routeRedEvidenceVerdict above): `process.cwd()` is already OS-canonicalized,
    // but `requestedPath` typically is not, so comparing one resolved side against
    // one unresolved side falsely reports "outside project scope" for any project
    // under a symlinked root (e.g. macOS's `/var` -> `/private/var` temp dirs).
    let projectRoot: string;
    let resolvedTaskPath: string;
    try {
      projectRoot = fs.realpathSync(path.resolve(cwd || process.cwd()));
      resolvedTaskPath = fs.realpathSync(path.resolve(projectRoot, requestedPath));
    } catch {
      error(`Task file not found: ${requestedPath}`, ERROR_REASON.USAGE);
      return;
    }
    const rel = path.relative(projectRoot, resolvedTaskPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      error(`Task file is outside project scope: ${requestedPath}`, ERROR_REASON.USAGE);
    }
    const taskIndexFlag = args.indexOf('--task-index');
    const selected = taskIndexFlag === -1 ? null : selectPlanTask(
      requestedPath,
      args[taskIndexFlag + 1],
      cwd,
      fs,
    );
    if (!selected || args.filter((arg) => arg === '--task-index').length !== 1) {
      error('--task-index must select one executable task in the plan', ERROR_REASON.USAGE);
      return;
    }
    content = selected.task.taskSource;
  }

  if (!content) {
    error('Usage: task.is-behavior-adding <plan-file-path> --task-index <positive-index>', ERROR_REASON.USAGE);
  }

  output(isBehaviorAddingTaskContent(content as string), raw, undefined);
}

export = {
  isBehaviorAddingTaskContent,
  routeTaskCommand,
  routeResolveContent,
  routeRedEvidenceCapture,
  routeRedEvidenceVerdict,
};
