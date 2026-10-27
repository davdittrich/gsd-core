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
 * Read a small file under `.gsd/` as UTF-8: null when it is not a regular file (a FIFO, a device) or holds
 * more than MAX_READ_BYTES, whatever fstat said before the read. Never follows a link: throws (code ELOOP)
 * on a symlink, and any open error (ENOENT included) propagates. O_NONBLOCK keeps a planted FIFO from
 * blocking the open. Not capability-ledger's readSmallRegularFile: that reader follows links, which its
 * callers rely on. win32 lacks O_NOFOLLOW and O_NONBLOCK: there the lstat alone refuses a link, a swap
 * after it needs repo write access (which can forge the file anyway), and FIFOs do not exist.
 */
export function readSmallGsdFile(file: string): string | null {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error(`${file} is a symlink`), { code: 'ELOOP' });
  const fd = fs.openSync(file, O_RDONLY | (O_NONBLOCK || 0) | (O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_READ_BYTES + 1);
    let n = 0;
    for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
    return n > MAX_READ_BYTES ? null : buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create `<root>/.gsd` and make git ignore `rules` there, under the marker `# gsd-core <name>`; returns
 * the directory. Throws when `.gsd` is a symlink or resolves outside `root`, or `.gsd/.gitignore` is a
 * symlink. Any other ignore-file failure, and a `.gitignore` that is not a regular file or holds over
 * MAX_READ_BYTES, leaves the rules as they are: the caller's own write still happens.
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
    // Keep a pre-existing file; a bare `*` already ignores everything here. Read it with the one .gsd/
    // reader (no link, no FIFO block, bounded), and replace by rename, so a link swapped in after the
    // check cannot redirect the write.
    let tmp: string | null = null;
    try {
      const current = readSmallGsdFile(ignore);
      if (current !== null && !current.includes(marker) && !/^\*\r?$/m.test(current)) {
        tmp = `${ignore}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        fs.writeFileSync(tmp, `${current}${current.endsWith('\n') ? '' : '\n'}${marker}\n${rules.join('\n')}\n`, { flag: 'wx' });
        if (fs.lstatSync(ignore).isSymbolicLink()) throw new Error(linked);
        retryRenameSync(tmp, ignore); // guarded rename: bounded retry on a Windows lock errno (DEFECT.WINDOWS-FS-OPS)
        tmp = null;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOOP' || (e as Error).message === linked) throw new Error(linked);
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ } }
    }
  }
  return dir;
}
