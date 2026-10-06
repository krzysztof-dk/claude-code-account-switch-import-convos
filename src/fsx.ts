// Small filesystem helpers shared by the record, transcript and operation
// modules. They exist for reasons the standard API does not cover: atomic
// replacement of files the desktop app may read at any moment, moving trees
// between volumes (the app data lives on the system volume, this tool's
// backups may live on another one, so rename() alone can fail with EXDEV),
// and durable writes for the journal, whose entries must reach the disk
// before the change they describe (see operation-log.ts).
import { constants } from 'node:fs';
import { access, cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
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
}

/** Appends text to a file and flushes it to the disk before returning (see WriteOptions.sync). */
export async function appendFileDurable(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a');
  try {
    await handle.appendFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
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
