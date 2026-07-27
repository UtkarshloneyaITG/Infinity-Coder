import { Conflict, FileChange, Proposal } from './types';
import { StagingWorkspace } from './staging';

/**
 * The Conflict Resolver.
 *
 * Two brains editing one file is normal in a parallel run and only sometimes a
 * problem. The four cases, cheapest first:
 *
 *   identical    — both produced the same content. Nothing to resolve.
 *   fast-forward — the second brain edited the FIRST one's output, because it
 *                  read through the staging overlay. This is the common case and
 *                  needs no merge at all.
 *   auto-merged  — both edited the same base but in disjoint line ranges.
 *   unresolved   — genuinely overlapping edits. One is picked, and the conflict
 *                  is surfaced so the user decides with the facts in front of
 *                  them rather than discovering it after the apply.
 */

export interface CommitResult {
  committed: FileChange[];
  conflicts: Conflict[];
}

export class ConflictResolver {
  /**
   * Fold a winning proposal's changes into the shared staging workspace.
   * Everything that needs a human is returned rather than thrown.
   */
  public commit(staging: StagingWorkspace, proposal: Proposal, taskId: string): CommitResult {
    const committed: FileChange[] = [];
    const conflicts: Conflict[] = [];

    for (const change of proposal.changes) {
      const owner = staging.ownerOf(change.relPath);

      if (!owner || owner.brainId === proposal.brainId) {
        staging.commit(change, proposal.brainId, taskId, proposal.confidence);
        committed.push(change);
        continue;
      }

      const current = staging.read(change.relPath);
      const theirs = current === undefined ? change.before : current;

      if (theirs === change.after) {
        conflicts.push({
          relPath: change.relPath,
          contenders: [owner.brainId, proposal.brainId],
          resolution: 'identical',
          chosen: change,
          detail: `${owner.brainId} and ${proposal.brainId} produced identical content.`,
        });
        staging.commit(change, proposal.brainId, taskId, proposal.confidence);
        committed.push(change);
        continue;
      }

      // The brain read the staged version and edited it — a normal sequential
      // handoff, not a conflict.
      if (change.before === theirs) {
        staging.commit(change, proposal.brainId, taskId, proposal.confidence);
        committed.push(change);
        continue;
      }

      const merged = mergeDisjoint(change.before, theirs, change.after);
      if (merged !== null) {
        const mergedChange: FileChange = { ...change, before: theirs, after: merged };
        staging.commit(mergedChange, proposal.brainId, taskId, Math.max(proposal.confidence, owner.confidence));
        committed.push(mergedChange);
        conflicts.push({
          relPath: change.relPath,
          contenders: [owner.brainId, proposal.brainId],
          resolution: 'auto-merged',
          chosen: mergedChange,
          detail: `${owner.brainId} and ${proposal.brainId} edited different parts of the file; both edits were kept.`,
        });
        continue;
      }

      // Genuinely overlapping. Keep the more confident brain's version, and say
      // so loudly — this is the case that must reach the user.
      const keepIncoming = proposal.confidence > owner.confidence;
      const chosen = keepIncoming ? { ...change, before: theirs } : owner.change;
      if (keepIncoming) {
        staging.commit(chosen, proposal.brainId, taskId, proposal.confidence);
        committed.push(chosen);
      }
      conflicts.push({
        relPath: change.relPath,
        contenders: [owner.brainId, proposal.brainId],
        resolution: 'unresolved',
        chosen,
        detail:
          `${owner.brainId} and ${proposal.brainId} both rewrote overlapping parts of ${change.relPath}. ` +
          `Kept ${keepIncoming ? proposal.brainId : owner.brainId}'s version — review this file before approving.`,
      });
    }

    return { committed, conflicts };
  }
}

/**
 * Three-way merge for the case that actually matters: both sides changed the
 * same base file, in line ranges that do not touch.
 *
 * ponytail: common-prefix/suffix, not a real diff3. It merges two brains editing
 * different functions of one file — which is the realistic parallel-edit case —
 * and returns null the moment the ranges overlap, so the fallback is "ask the
 * user", never "silently produce a plausible mess". Swap in a proper diff3 only
 * if unresolved conflicts turn out to be common in practice.
 */
export function mergeDisjoint(base: string | null, theirs: string | null, mine: string | null): string | null {
  if (base === null || theirs === null || mine === null) {
    return null; // a create or a delete on one side — no sensible line merge
  }
  if (theirs === base) {
    return mine;
  }
  if (mine === base) {
    return theirs;
  }

  const baseLines = base.split('\n');
  const theirRange = changedRange(baseLines, theirs.split('\n'));
  const myRange = changedRange(baseLines, mine.split('\n'));
  if (!theirRange || !myRange) {
    return null;
  }

  // Overlapping (or adjacent) base ranges cannot be spliced independently.
  if (theirRange.end >= myRange.start && myRange.end >= theirRange.start) {
    return null;
  }

  const first = theirRange.start < myRange.start ? theirRange : myRange;
  const second = first === theirRange ? myRange : theirRange;

  return [
    ...baseLines.slice(0, first.start),
    ...first.lines,
    ...baseLines.slice(first.end, second.start),
    ...second.lines,
    ...baseLines.slice(second.end),
  ].join('\n');
}

/**
 * The single contiguous span of base lines a side replaced, found by trimming
 * the common head and tail. `end` is exclusive, in base coordinates.
 */
function changedRange(
  baseLines: string[],
  nextLines: string[]
): { start: number; end: number; lines: string[] } | null {
  let start = 0;
  const maxStart = Math.min(baseLines.length, nextLines.length);
  while (start < maxStart && baseLines[start] === nextLines[start]) {
    start++;
  }

  let tail = 0;
  while (
    tail < maxStart - start &&
    baseLines[baseLines.length - 1 - tail] === nextLines[nextLines.length - 1 - tail]
  ) {
    tail++;
  }

  const end = baseLines.length - tail;
  if (end < start) {
    return null;
  }
  return { start, end, lines: nextLines.slice(start, nextLines.length - tail) };
}
