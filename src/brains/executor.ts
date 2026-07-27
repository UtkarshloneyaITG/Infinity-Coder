import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileChange } from './types';

/**
 * The Execution Engine — the only code in this folder that writes to disk.
 *
 * It runs once, after review, consensus, conflict resolution and the user's
 * approval. Two safety properties matter more than anything else here:
 *
 *   - a file whose on-disk content no longer matches what the brain edited is
 *     SKIPPED, not overwritten. Between staging and approval the user may have
 *     saved that file themselves, and silently discarding their edit is the one
 *     unrecoverable failure in this whole pipeline.
 *   - deletes go to the Recycle Bin / Trash, never to oblivion.
 */

export interface ApplyOutcome {
  applied: FileChange[];
  skipped: Array<{ change: FileChange; reason: string }>;
  failed: Array<{ change: FileChange; reason: string }>;
}

export type ChangeApprover = (change: FileChange) => Promise<{ approved: boolean; feedback?: string }>;

export class Executor {
  /** No approver means the caller already has approval for the whole set. */
  constructor(private readonly approve?: ChangeApprover) {}

  public async apply(changes: FileChange[], signal?: AbortSignal): Promise<ApplyOutcome> {
    const outcome: ApplyOutcome = { applied: [], skipped: [], failed: [] };

    for (const change of changes) {
      if (signal?.aborted) {
        outcome.skipped.push({ change, reason: 'Cancelled before this file was written.' });
        continue;
      }

      const drift = this.checkDrift(change);
      if (drift) {
        outcome.skipped.push({ change, reason: drift });
        continue;
      }

      if (this.approve) {
        const verdict = await this.approve(change);
        if (!verdict.approved) {
          outcome.skipped.push({ change, reason: verdict.feedback || 'Rejected by the user.' });
          continue;
        }
      }

      try {
        await this.write(change);
        outcome.applied.push(change);
      } catch (e: any) {
        outcome.failed.push({ change, reason: e?.message || String(e) });
      }
    }

    return outcome;
  }

  /**
   * Has the file moved under us since the brain read it? Compared on content,
   * not mtime — a formatter that rewrites a file byte-identically is not drift,
   * and a touch that changes nothing should not block an apply.
   */
  private checkDrift(change: FileChange): string | null {
    let current: string | null = null;
    try {
      current = fs.existsSync(change.path) && fs.statSync(change.path).isFile()
        ? fs.readFileSync(change.path, 'utf8')
        : null;
    } catch (e: any) {
      return `Couldn't read ${change.relPath} to check it: ${e?.message || e}`;
    }

    if (current === change.before) {
      return null;
    }
    if (current === change.after) {
      return null; // already in the target state — nothing to do, not a failure
    }
    if (change.before === null && current !== null) {
      return `${change.relPath} was created by something else while this run was waiting for approval, so it was left alone.`;
    }
    return `${change.relPath} changed on disk after the brain read it, so it was skipped rather than overwritten. Re-run the task to pick up your version.`;
  }

  private async write(change: FileChange): Promise<void> {
    if (change.kind === 'delete' || change.after === null) {
      // Recoverable delete, matching what the single-agent file tools do.
      await vscode.workspace.fs.delete(vscode.Uri.file(change.path), {
        recursive: true,
        useTrash: true,
      });
      return;
    }

    const parent = path.dirname(change.path);
    if (parent) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(change.path, change.after, 'utf8');
  }
}

/** Total added/removed lines across a change set, for the approval header. */
export function changeSetStat(changes: FileChange[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const before = change.before === null ? [] : change.before.split(/\r?\n/);
    const after = change.after === null ? [] : change.after.split(/\r?\n/);
    const counts = new Map<string, number>();
    for (const line of before) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    for (const line of after) {
      const seen = counts.get(line) ?? 0;
      if (seen > 0) {
        counts.set(line, seen - 1);
      } else {
        added++;
      }
    }
    for (const left of counts.values()) {
      removed += left;
    }
  }
  return { files: changes.length, added, removed };
}
