/**
 * Keep a machine-local file out of `git status` without touching any tracked
 * file: append an anchored entry to the enclosing repo's `info/exclude` (#5551).
 *
 * Used for files GSD writes under `.planning/` that are per-machine state, not
 * project content (the milestone claim and the derived `state.json`, #5505). A
 * copy that is already tracked is left alone — an exclude entry never untracks,
 * and migrating it is the user's call.
 *
 * Best-effort by contract: never throws. Ignoring is optional, so no failure
 * here (no git, read-only `.git`, odd path) may perturb the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
import { splitLines } from './text-lines.cjs';

// excludeFromGit runs on every boundary command's hot path: bound its one rev-parse.
const REV_PARSE_TIMEOUT_MS = 5_000;

/** Escape gitignore metacharacters so a directory or file name matches literally. */
function escapeGitignore(s: string): string {
  return s.replace(/[\\*?[]/g, '\\$&');
}

/**
 * Exclude `<dir>/<filename>` from git via the repo-local `info/exclude`.
 * `dir` must already exist (it is the spawn cwd).
 */
export function excludeFromGit(dir: string, filename: string): void {
  try {
    // gitignore cannot express a newline in a pattern, and git's line output could not be split.
    if (/[\r\n]/.test(dir)) return;
    // The prefix goes last: stdout is trimmed, and a non-empty prefix ends in `/`, so only an
    // empty prefix (dir is the git root) loses its line; a leading space survives.
    const revParse = execGit(['rev-parse', '--git-path', 'info/exclude', '--show-prefix'], { cwd: dir, timeout: REV_PARSE_TIMEOUT_MS });
    const [excludeRel, prefix = ''] = splitLines(String(revParse.stdout));
    if (revParse.exitCode !== 0 || !excludeRel) return;
    const exclude = path.resolve(dir, excludeRel);
    const entry = `/${escapeGitignore(prefix)}${escapeGitignore(filename)}`;
    // read-check-append is not atomic: linked worktrees share this file, so a racing
    // publish can append a duplicate line, which git reads as one.
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const present = splitLines(existing);
    // an earlier !entry is the user's choice to track the file (last match wins)
    if (present.includes(entry) || present.includes(`!${entry}`)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (existing && !existing.endsWith('\n') ? '\n' : '') + entry + '\n');
  } catch {
    // advisory: see the module header.
  }
}
