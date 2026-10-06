// Where copies made by this tool came from.
//
// Every copy, update and import adds a link "source conversation -> target
// conversation" to <dataDir>/lineage.json. The links are how the tool knows,
// on a later run, which conversation on account B is the copy of which one on
// account A (inventory.ts, assessSync): the conversations themselves are never
// compared to decide that, because content says nothing reliable about it (a
// fork starts with its parent's lines). The ccas stamp on a copied record
// carries the same link, but the desktop app drops it the first time it saves
// the record, so this file is the lasting record. Deleting it makes the next
// run treat every earlier copy as unrelated and copy again.
//
// A link whose target never came to be (an operation cut short after the link
// was written but before the record) names a record that does not exist, and
// pairing ignores it.
//
// Moves write links too (since 2026-10-05): the record keeps its id, so both
// ends name the same record id under different accounts. Pairing does not
// need such a link (the record id already pairs a moved record with whatever
// still refers to it), but the e-mail votes do: a moved transcript carries
// the source account's session_context lines, and the link's sourceLineCount
// is the lasting copy point past which sightings count for the new account
// (inventory.ts, voteEmail). Before that, a move relied on the ccas stamp
// alone, and once the app had saved the record and dropped the stamp, the
// source account's e-mail voted for the target account.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';

export interface LineageEndpoint {
  /** Undefined for transcripts that have no record on any account. */
  accountId?: string | undefined;
  orgId?: string | undefined;
  sessionId?: string | undefined;
  cliSessionId: string;
}

export interface LineageLink {
  rootUuid: string;
  /** Epoch milliseconds. */
  at: number;
  journalId: string;
  mode: 'copy' | 'move' | 'import';
  /**
   * created: a fresh copy; updated: an older copy brought up to date; moved:
   * the record changed accounts with its ids (the link only marks the copy
   * point for the e-mail votes, see the header).
   */
  action: 'created' | 'updated' | 'moved';
  /** Non-blank line count of the source transcript at that moment (see CcasStamp). */
  sourceLineCount: number;
  source: LineageEndpoint;
  target: LineageEndpoint;
}

export const LINEAGE_FILE_NAME = 'lineage.json';

export class LineageStore {
  private readonly file: string;
  private readonly links: LineageLink[];

  private constructor(file: string, links: LineageLink[]) {
    this.file = file;
    this.links = links;
  }

  /**
   * A missing file means no copies yet. An unreadable one is an error: the
   * links decide which conversations are already copied, and starting from
   * nothing would copy all of them again.
   */
  static async load(dataDir: string): Promise<LineageStore> {
    const file = path.join(dataDir, LINEAGE_FILE_NAME);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new LineageStore(file, []);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not valid JSON (${(error as Error).message}); it records which conversations were copied where, so fix it or restore it from a backup before running ccas`);
    }
    const links = (parsed as { links?: unknown } | null)?.links;
    if (!Array.isArray(links)) {
      throw new Error(`${file} has no "links" list; it records which conversations were copied where, so fix it or restore it from a backup before running ccas`);
    }
    return new LineageStore(file, links as LineageLink[]);
  }

  /** Adds a link and flushes the file to the disk before returning, like the journal. */
  async add(link: LineageLink): Promise<void> {
    this.links.push(link);
    await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, links: this.links }, null, 2)}\n`, { sync: true });
  }

  byRoot(rootUuid: string): LineageLink[] {
    return this.links.filter((link) => link.rootUuid === rootUuid);
  }

  all(): readonly LineageLink[] {
    return this.links;
  }
}
