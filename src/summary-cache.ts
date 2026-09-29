// Cache of transcript summaries.
//
// Summarising means reading a transcript end to end, and a machine that has
// used Claude Code for a while holds hundreds of them, some tens of megabytes.
// The summary of a file only changes when the file does, so it is cached by
// path, size and modification time in <dataDir>/summary-cache.json. A stale
// or corrupt cache costs nothing but a re-read.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';
import type { TranscriptSummary } from './transcripts.ts';

export const SUMMARY_CACHE_FILE_NAME = 'summary-cache.json';
const CACHE_VERSION = 3;

interface CacheEntry {
  sizeBytes: number;
  mtimeMs: number;
  summary: TranscriptSummary;
}

export class SummaryCache {
  private readonly file: string;
  private readonly entries: Map<string, CacheEntry>;
  private dirty = false;

  private constructor(file: string, entries: Map<string, CacheEntry>) {
    this.file = file;
    this.entries = entries;
  }

  static async load(dataDir: string): Promise<SummaryCache> {
    const file = path.join(dataDir, SUMMARY_CACHE_FILE_NAME);
    const entries = new Map<string, CacheEntry>();
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown; entries?: Record<string, CacheEntry> };
      if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [key, entry] of Object.entries(parsed.entries)) entries.set(key, entry);
      }
    } catch {
      // No cache yet, or an unreadable one: every transcript is read once.
    }
    return new SummaryCache(file, entries);
  }

  get(filePath: string, sizeBytes: number, mtimeMs: number): TranscriptSummary | undefined {
    const entry = this.entries.get(filePath);
    return entry && entry.sizeBytes === sizeBytes && entry.mtimeMs === mtimeMs ? entry.summary : undefined;
  }

  set(filePath: string, sizeBytes: number, mtimeMs: number, summary: TranscriptSummary): void {
    this.entries.set(filePath, { sizeBytes, mtimeMs, summary });
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const data = { version: CACHE_VERSION, entries: Object.fromEntries(this.entries) };
    await writeFileAtomic(this.file, JSON.stringify(data));
    this.dirty = false;
  }
}
