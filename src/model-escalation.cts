/**
 * Model escalation record (#5328) — the one owner of the file
 * `resolve-execution --attempt N` writes and hooks/lib/agent-model-check.js reads.
 *
 * Single slot per agent type: `.gsd/model-escalation-<agent>.json` holds the model
 * an escalation resolved, when, and (when known) the session that asked for it.
 * The guard honours it for ESCALATION_WINDOW_MS, only for that model and, when both
 * sides know a session id, only in that session. Unauthenticated by design: a
 * guard against drift, not a security boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock, type Clock } from './clock.cjs';
import { retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLedgerMod = require('./capability-ledger.cjs');

const { readSmallRegularFile } = capabilityLedgerMod;

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

export const escalationFile = (root: string, agentType: string): string =>
  path.join(root, '.gsd', `model-escalation-${agentType}.json`);

/** Compare at tier-alias level: `claude-sonnet-4-6` and `sonnet` are the same. */
export function modelFamily(model: unknown): string {
  const s = String(model).toLowerCase();
  return /(?:^|[^a-z0-9])(opus|sonnet|haiku|fable)(?:$|[^a-z])/.exec(s)?.[1] ?? s;
}

/** Best-effort: a write failure only costs a guard warning. */
export function writeEscalation(
  root: string, agentType: string, model: string, session?: string, clock: Pick<Clock, 'now'> = realClock,
): void {
  if (!GUARDED_AGENT_TYPES.has(agentType)) return; // also keeps agentType, a file name, from traversing
  try {
    const dir = path.join(root, '.gsd');
    const file = escalationFile(root, agentType);
    fs.mkdirSync(dir, { recursive: true });
    // Catches a planted .gsd symlink; racing a swap after this needs repo write access already.
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    const ignore = path.join(dir, '.gitignore');
    try {
      fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
    } catch {
      // Pre-existing (e.g. the dispatch sentinel's rules only): a bare `*` already covers the record,
      // else add our own rule. Replace by rename so a link swapped in after the lstat is not written through.
      if (!fs.lstatSync(ignore).isSymbolicLink()) {
        const cur = readSmallRegularFile(ignore, MAX_READ_BYTES) ?? '';
        if (!/^\*\r?$/m.test(cur) && !/^\/model-escalation-\*\r?$/m.test(cur)) {
          const next = `${ignore}.${process.pid}.tmp`;
          fs.writeFileSync(next, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}/model-escalation-*\n`, { flag: 'wx' });
          retryRenameSync(next, ignore);
        }
      }
    }
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

/** Parsed record, or null when absent, a symlink, non-regular, oversized or unparseable. */
export function readEscalation(root: string, agentType: string): EscalationRecord | null {
  try {
    const file = escalationFile(root, agentType);
    // The shared reader follows links (SKILL.md and others rely on it), so refuse one here; the fd
    // check then rejects FIFOs and devices. Racing a swap after the lstat needs repo write access already.
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const text = readSmallRegularFile(file, MAX_READ_BYTES);
    return text === null ? null : JSON.parse(text) as EscalationRecord;
  } catch {
    return null;
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
