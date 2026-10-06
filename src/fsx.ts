// Small filesystem helpers shared by the record, transcript and operation
// modules. They exist for reasons the standard API does not cover: atomic
// replacement of files the desktop app may read at any moment, moving trees
// between volumes (the app data lives on the system volume, this tool's
// backups may live on another one, so rename() alone can fail with EXDEV),
// and durable writes for the journal, whose entries must reach the disk
// before the change they describe (see operation-log.ts). Since 2026-10-05
// (review) the durable writes also flush the directory entry, appends keep
// a torn last line from swallowing the next one, and the tool's own data
// directories are created private (0700).
import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a file or directory exists at a path. Every error answers false,
 * not only ENOENT; the journal and rollback code use it to skip steps that
 * never happened.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a path is a directory (links followed); false when it is missing or cannot be read. */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The temporary file a write to `target` goes through: next to the target
 * (same volume, so the final rename is atomic) and tagged with the pid and a
 * timestamp, so two writers never share one. tempSiblings() finds the ones a
 * process left behind when it died between the write and the rename.
 */
export function tempPathFor(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.tmp`;
}

/** Temporary files of cut-short writes to `target` (see tempPathFor), as absolute paths. */
export async function tempSiblings(target: string): Promise<string[]> {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+\.\d+\.tmp$/.test(name.slice(prefix.length)))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Options of writeFileAtomic: the permission bits of the new file, and
 * whether it is flushed to the disk before the rename (the journal and the
 * lineage file are).
 */
export interface WriteOptions {
  /** Permission bits of the new file (the process umask still applies). */
  mode?: number | undefined;
  /**
   * Flush the file to the disk before it replaces the target. FileHandle.sync()
   * runs fcntl(F_FULLFSYNC) on macOS (libuv), which also empties the drive's
   * write cache, so the content survives a power cut once the write returns.
   */
  sync?: boolean | undefined;
  /**
   * Also flush the directory after the file is in place (see syncDirectory):
   * a flushed file whose directory entry was not flushed can still be
   * missing after a power cut. The journal and the lineage file set it.
   */
  syncDir?: boolean | undefined;
}

/**
 * Flushes a directory's entries to the disk, so a rename into it or a new
 * file in it survives a power cut once this returns; a file's own fsync
 * covers its content, not its directory entry. Added 2026-10-05 (review):
 * the journal's content was flushed, the rename that put it in place was
 * not. A file system that cannot flush a directory (the call fails with
 * EINVAL or ENOTSUP) is left as it is: the content is still flushed, and
 * refusing to write would be worse than the small window.
 */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Write next to the target, then rename over it. A reader never sees a
 * half-written file, and the rename is atomic within one volume.
 */
export async function writeFileAtomic(filePath: string, data: string, options: WriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tempPathFor(filePath);
  try {
    const handle = await open(tmp, 'w', options.mode);
    try {
      await handle.writeFile(data, 'utf8');
      if (options.sync) await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  if (options.syncDir) await syncDirectory(path.dirname(filePath));
}

/**
 * Appends text to a file and flushes it to the disk before returning (see
 * WriteOptions.sync; `mode` applies when the file is new, `syncDir` flushes
 * the directory as well). When the file does not end with a newline, one
 * goes first: found by the audit of 2026-10-05 (journal.test.ts), a line
 * torn by a crash used to swallow the next entry appended to it, and the
 * reader then skipped both. Kept apart, the torn line is skipped alone.
 */
export async function appendFileDurable(filePath: string, data: string, options: WriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a+', options.mode);
  try {
    const { size } = await handle.stat();
    let separator = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) separator = '\n';
    }
    await handle.appendFile(`${separator}${data}`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.syncDir) await syncDirectory(path.dirname(filePath));
}

/**
 * Creates a directory for this tool's own state with permission bits 0700,
 * and sets them on one that exists, so the summary cache (the first prompt
 * of every transcript on the machine), the account e-mails and the backups
 * of other accounts' transcripts are readable by this user alone. Added
 * 2026-10-05 (review); before, data/ took the umask, 0755 as a rule, while
 * the transcripts inside the backups kept their 0600.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * Move a file or directory, falling back to copy + delete when the source and
 * destination sit on different volumes. The destination's parent is created.
 * A move across volumes cut short between the copy and the delete leaves both
 * ends in place; restore (operations.ts) recognises that and leaves both.
 */
export async function moveTree(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Where a backup of an absolute path lives under a backup root: the absolute
 * path is mirrored below the root, so restoring is a plain reverse copy.
 */
export function mirrorPath(root: string, absolutePath: string): string {
  const parts = absolutePath.split(path.sep).filter((part) => part.length > 0);
  return path.join(root, ...parts);
}

/** Lists immediate subdirectory names, or an empty list when the directory is missing. */
export async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
