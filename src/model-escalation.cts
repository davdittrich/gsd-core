/**
 * Model escalation record (#5328) — the one owner of the file
 * `resolve-execution --attempt N` writes and hooks/lib/agent-model-check.js reads.
 *
 * One slot per agent type and model family: `.gsd/model-escalation-<agent>.<family>.json`
 * holds the model an escalation resolved, when, and (when known) the session that asked
 * for it. Sibling escalations of one agent to different models therefore keep their own
 * records. The guard honours the passed model's record for ESCALATION_WINDOW_MS and, when
 * both sides know a session id, only in that session. Unauthenticated by design: a
 * guard against drift, not a security boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock, type Clock } from './clock.cjs';
import { retryRenameSync } from './shell-command-projection.cjs';
import { seedGsdIgnore } from './gsd-ignore.cjs';

export const ESCALATION_WINDOW_MS = 10 * 60 * 1000;
/** Tolerated clock skew for a record stamped slightly in the future. */
export const ESCALATION_SKEW_MS = 5000;
/** A record is a few hundred bytes; anything bigger is not ours. */
export const MAX_READ_BYTES = 64 * 1024;

/** The agent types the guard checks; also the only ones an escalation record is written for. */
export const GUARDED_AGENT_TYPES: ReadonlySet<string> = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

export interface EscalationRecord {
  model: string;
  written_at: number;
  session?: string;
}

/** Compare at tier-alias level: `claude-sonnet-4-6` and `sonnet` are the same. */
export function modelFamily(model: unknown): string {
  const s = String(model).toLowerCase();
  return /(?:^|[^a-z0-9])(opus|sonnet|haiku|fable)(?:$|[^a-z])/.exec(s)?.[1] ?? s;
}

/**
 * The family is model-authored, so it is reduced to file-name-safe characters and capped.
 * Lossy: distinct families can share a file (e.g. `a/b` and `a_b`); the worst case is a false
 * mismatch (a warning, or a block under `deny`), never a bypass, because `escalationAllows` re-checks the stored model's family.
 */
export const escalationFile = (root: string, agentType: string, model: string): string =>
  path.join(root, '.gsd', `model-escalation-${agentType}.${modelFamily(model).replace(/[^a-z0-9._-]/g, '_').slice(0, 64)}.json`);

/** Best-effort: after a failed write the guard sees no record, so it warns, or blocks under `deny`. */
export function writeEscalation(
  root: string, agentType: string, model: string, session?: string, clock: Pick<Clock, 'now'> = realClock,
): void {
  if (!GUARDED_AGENT_TYPES.has(agentType)) return; // also keeps agentType, a file name, from traversing
  try {
    const dir = path.join(root, '.gsd');
    const file = escalationFile(root, agentType, model);
    fs.mkdirSync(dir, { recursive: true });
    // Catches a planted .gsd symlink; racing a swap after this needs repo write access already.
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    seedGsdIgnore(dir, {
      covers: (cur) => /^\*\r?$/m.test(cur) || /^\/model-escalation-\*\r?$/m.test(cur),
      append: (cur) => `${cur === '' || cur.endsWith('\n') ? '' : '\n'}/model-escalation-*\n`,
      tmp: `${path.join(dir, '.gitignore')}.${process.pid}.tmp`,
    });
    const rec: EscalationRecord = { model, written_at: clock.now(), ...(session ? { session } : {}) };
    // tmp + rename on every platform: the hook never reads a half-written record, and rename
    // replaces a symlink planted at `file` instead of following it. 'wx': nor is one at `tmp` followed.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true }); // left by a crashed writer whose pid was reused
    try {
      fs.writeFileSync(tmp, JSON.stringify(rec), { flag: 'wx' });
      retryRenameSync(tmp, file); // Windows: a reader can hold `file` open briefly
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  } catch { /* best-effort */ }
}

/** Parsed record for `passedModel`'s family, or null when absent, a symlink, non-regular, oversized or unparseable. */
export function readEscalation(root: string, agentType: string, passedModel: string): EscalationRecord | null {
  // Own no-follow open, not the shared reader (it follows links; SKILL.md and others rely on that).
  // O_NOFOLLOW closes the lstat-then-open race; win32 lacks it (and O_NONBLOCK), so there the lstat
  // alone refuses a link, and a swap after it needs repo write access, which forges a record anyway.
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  let fd: number | undefined;
  try {
    const file = escalationFile(root, agentType, passedModel);
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, O_RDONLY | (O_NONBLOCK || 0) | (O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return null; // FIFO, device
    const buf = Buffer.alloc(MAX_READ_BYTES + 1);
    let n = 0;
    for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
    return n > MAX_READ_BYTES ? null : JSON.parse(buf.toString('utf8', 0, n)) as EscalationRecord;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Does `rec` legitimise `passedModel` now, for the dispatching `session` (undefined = unknown)? */
export function escalationAllows(
  rec: EscalationRecord | null,
  passedModel: string,
  { now, session }: { now: number; session?: string },
): boolean {
  if (!rec || typeof rec.model !== 'string') return false;
  const age = now - rec.written_at;
  if (!(age > -ESCALATION_SKEW_MS && age < ESCALATION_WINDOW_MS)) return false;
  if (typeof rec.session === 'string' && session !== undefined && rec.session !== session) return false;
  return modelFamily(rec.model) === modelFamily(passedModel);
}
