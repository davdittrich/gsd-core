/**
 * The project-local `.gsd/` directory (#5086, #5328): the one owner of the checked creation of `.gsd/`
 * (never through a symlink or out of the project) and of the `.gsd/.gitignore` rules a tool-owned file
 * adds. Callers: the dispatch-isolation sentinel (gsd-tools.cjs writeDispatchIsolationSentinel) and the
 * model-escalation record (model-escalation.cts).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { retryRenameSync } from './shell-command-projection.cjs';

/** Read bound for the small files GSD reads beside a project: `.gsd/` files and the hook's root config. */
export const MAX_READ_BYTES = 64 * 1024;

/**
 * Create `<root>/.gsd` and make git ignore `rules` there, under the marker `# gsd-core <name>`; returns
 * the directory. Throws when `.gsd` is a symlink or resolves outside `root`, or `.gsd/.gitignore` is a
 * symlink. Any other ignore-file failure, and a `.gitignore` over MAX_READ_BYTES, leaves the rules as
 * they are: the caller's own write still happens.
 */
export function prepareGsdDir(root: string, name: string, rules: readonly string[]): string {
  const dir = path.join(root, '.gsd');
  fs.mkdirSync(dir, { recursive: true });
  // Never write through a project-supplied .gsd symlink, nor through an ancestor redirect out of the project.
  if (fs.lstatSync(dir).isSymbolicLink() || path.relative(fs.realpathSync(root), fs.realpathSync(dir)) !== '.gsd') {
    throw new Error(`${name} directory is a symlink or resolves outside the project`);
  }
  const ignore = path.join(dir, '.gitignore');
  const linked = `${name} ignore file is a symlink`;
  const marker = `# gsd-core ${name}`;
  try {
    fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
  } catch (seedError) {
    if ((seedError as NodeJS.ErrnoException).code !== 'EEXIST') return dir;
    // Keep a pre-existing file; a bare `*` already ignores everything here. Read through an fd opened
    // without following links where supported, and replace by rename, so a link swapped in after the
    // check cannot redirect the write.
    let fd: number | undefined;
    let tmp: string | null = null;
    try {
      if (fs.lstatSync(ignore).isSymbolicLink()) throw new Error(linked);
      fd = fs.openSync(ignore, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return dir;
      const current = fs.readFileSync(fd, 'utf8');
      fs.closeSync(fd);
      fd = undefined;
      if (!current.includes(marker) && !/^\*\r?$/m.test(current)) {
        tmp = `${ignore}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        fs.writeFileSync(tmp, `${current}${current.endsWith('\n') ? '' : '\n'}${marker}\n${rules.join('\n')}\n`, { flag: 'wx' });
        if (fs.lstatSync(ignore).isSymbolicLink()) throw new Error(linked);
        retryRenameSync(tmp, ignore); // D14: the guarded rename (bounded retry on a Windows lock errno)
        tmp = null;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOOP' || (e as Error).message === linked) throw new Error(linked);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ } }
    }
  }
  return dir;
}
