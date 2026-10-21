/**
 * Seed `<dir>/.gitignore` so a tool-owned `.gsd` directory stays out of user projects (#5328, #5524).
 * One owner for the dispatch sentinel and the model-escalation record: both need the same
 * no-follow, replace-by-rename handling of a pre-existing ignore file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { retryRenameSync } from './shell-command-projection.cjs';

export interface IgnoreSeed {
  /** True when the existing ignore text already covers the caller's files. */
  covers: (current: string) => boolean;
  /** Rules appended when it does not. */
  append: string;
}

/** Best-effort except a symlinked ignore file, which is reported so the caller can refuse. */
export function seedGsdIgnore(dir: string, { covers, append }: IgnoreSeed): 'ok' | 'symlink' {
  const ignore = path.join(dir, '.gitignore');
  try {
    fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
    return 'ok';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'ok';
  }
  // Read through an fd opened without following links where supported; replace by rename rather
  // than append through the path, so a link swapped in after the check cannot redirect a write.
  let fd: number | undefined;
  let tmp: string | undefined;
  try {
    if (fs.lstatSync(ignore).isSymbolicLink()) return 'symlink';
    fd = fs.openSync(ignore, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return 'ok';
    const current = fs.readFileSync(fd, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
    if (!covers(current)) {
      tmp = `${ignore}.${process.pid}.tmp`;
      fs.rmSync(tmp, { force: true }); // left by a crashed writer whose pid was reused
      fs.writeFileSync(tmp, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${append}`, { flag: 'wx' });
      if (fs.lstatSync(ignore).isSymbolicLink()) return 'symlink';
      retryRenameSync(tmp, ignore);
      tmp = undefined;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') return 'symlink';
    // best-effort: the guard still works if this path cannot be read or updated
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (tmp) fs.rmSync(tmp, { force: true });
  }
  return 'ok';
}
