// Deciding whether two transcripts are the same conversation and which one is
// further along.
//
// A transcript is append-only and every message line carries a uuid, so the
// ordered list of uuids is a fingerprint of the conversation's history. Copies
// made by this tool keep those uuids (only the session id is rewritten), which
// makes the comparison between an original and its copy on another account a
// plain prefix test:
//   - equal chains            -> nothing to do
//   - target is a prefix      -> the source continued the conversation, updating is safe
//   - source is a prefix      -> the target is the newer one
//   - shared prefix, both grew -> the two copies diverged, someone has to choose
//   - no shared prefix        -> different conversations, never overwrite
import type { SessionRecord } from './records.ts';
import type { TranscriptSummary } from './transcripts.ts';

export type Relation = 'identical' | 'target-behind' | 'target-ahead' | 'diverged' | 'unrelated';

export interface ChainComparison {
  relation: Relation;
  /** Number of leading uuids both chains share. */
  commonPrefix: number;
  /** Lines with a uuid the source has beyond the shared prefix. */
  sourceExtra: number;
  /** Lines with a uuid the target has beyond the shared prefix. */
  targetExtra: number;
}

export function compareChains(source: readonly string[], target: readonly string[]): ChainComparison {
  let commonPrefix = 0;
  const limit = Math.min(source.length, target.length);
  while (commonPrefix < limit && source[commonPrefix] === target[commonPrefix]) commonPrefix += 1;
  const sourceExtra = source.length - commonPrefix;
  const targetExtra = target.length - commonPrefix;

  let relation: Relation;
  if (sourceExtra === 0 && targetExtra === 0) relation = 'identical';
  else if (targetExtra === 0) relation = 'target-behind';
  else if (sourceExtra === 0) relation = 'target-ahead';
  else if (commonPrefix > 0) relation = 'diverged';
  else relation = 'unrelated';
  // An empty target chain (a transcript without any uuid yet) is treated as
  // "behind": overwriting it loses nothing that could be compared.
  if (target.length === 0 && source.length > 0) relation = 'target-behind';
  return { relation, commonPrefix, sourceExtra, targetExtra };
}

export interface ConsistencyFacts {
  record?: Pick<SessionRecord, 'cwd' | 'originCwd' | 'createdAt'> | undefined;
  summary?: Pick<TranscriptSummary, 'cwd' | 'firstTimestamp' | 'rootUuid'> | null | undefined;
}

/**
 * Secondary checks that never block an update on their own but are shown
 * next to the decision: a copy of the same conversation should keep its
 * working directory, creation time and first message.
 */
export function consistencyWarnings(source: ConsistencyFacts, target: ConsistencyFacts): string[] {
  const warnings: string[] = [];
  const sourceCwd = source.record?.cwd ?? source.summary?.cwd ?? null;
  const targetCwd = target.record?.cwd ?? target.summary?.cwd ?? null;
  if (sourceCwd && targetCwd && sourceCwd !== targetCwd) {
    warnings.push(`working directory differs: source ${sourceCwd}, target ${targetCwd}`);
  }
  const sourceCreated = source.record?.createdAt;
  const targetCreated = target.record?.createdAt;
  if (
    typeof sourceCreated === 'number' &&
    typeof targetCreated === 'number' &&
    Math.abs(sourceCreated - targetCreated) > 1000
  ) {
    warnings.push(
      `record creation time differs: source ${new Date(sourceCreated).toISOString()}, target ${new Date(targetCreated).toISOString()}`,
    );
  }
  const sourceFirst = source.summary?.firstTimestamp ?? null;
  const targetFirst = target.summary?.firstTimestamp ?? null;
  if (sourceFirst && targetFirst && sourceFirst !== targetFirst) {
    warnings.push(`first transcript line differs in time: source ${sourceFirst}, target ${targetFirst}`);
  }
  const sourceRoot = source.summary?.rootUuid ?? null;
  const targetRoot = target.summary?.rootUuid ?? null;
  if (sourceRoot && targetRoot && sourceRoot !== targetRoot) {
    warnings.push('first message uuid differs: these transcripts do not share an origin');
  }
  return warnings;
}
