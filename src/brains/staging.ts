import * as fs from 'fs';
import * as path from 'path';
import { BrainDef, FileChange } from './types';
import { matchAny, toRelative } from './glob';

/**
 * Staging — where brain file writes actually go.
 *
 * Nothing a brain does reaches the disk. Every write, edit and delete is
 * captured here as a FileChange, and reads fall through overlay -> workspace ->
 * disk. Three things fall out of that, none of which are possible if brains
 * write directly:
 *
 *   - two brains touching one file is a detectable conflict, not a race
 *   - the user approves one reviewed change set, not forty separate prompts
 *   - a cancelled or failed run leaves the working tree exactly as it was
 *
 * The Executor (executor.ts) is the only code in this folder that writes files.
 */

/** Accumulated, conflict-resolved state of the run so far. */
export class StagingWorkspace {
  /** relPath -> content, or null for "staged as deleted". */
  private readonly files = new Map<string, string | null>();
  /** relPath -> who produced it, for provenance and conflict arbitration. */
  private readonly origin = new Map<
    string,
    { brainId: string; taskId: string; change: FileChange; confidence: number }
  >();

  constructor(public readonly root: string) {}

  public has(relPath: string): boolean {
    return this.files.has(norm(relPath));
  }

  public read(relPath: string): string | null | undefined {
    return this.files.get(norm(relPath));
  }

  public ownerOf(
    relPath: string
  ): { brainId: string; taskId: string; change: FileChange; confidence: number } | undefined {
    return this.origin.get(norm(relPath));
  }

  public commit(change: FileChange, brainId: string, taskId: string, confidence = 0.5): void {
    const rel = norm(change.relPath);
    this.files.set(rel, change.after);
    this.origin.set(rel, { brainId, taskId, change, confidence });
  }

  public changedPaths(): string[] {
    return [...this.files.keys()];
  }

  /**
   * The change set to apply, with each file's `before` re-read from disk at
   * commit time so the preview shows the true diff even when several tasks
   * edited the same file in sequence.
   */
  public changes(): FileChange[] {
    return [...this.origin.entries()].map(([rel, entry]) => {
      const abs = path.join(this.root, rel);
      let before: string | null = null;
      try {
        before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      } catch {
        before = null;
      }
      const after = this.files.get(rel) ?? null;
      return {
        kind: after === null ? 'delete' : before === null ? 'write' : 'edit',
        path: abs,
        relPath: rel,
        before,
        after,
      } as FileChange;
    });
  }
}

/** One brain's scratch layer for one task. Discarded if the task fails. */
export class BrainStage {
  private readonly writes = new Map<string, FileChange>();

  constructor(
    private readonly base: StagingWorkspace,
    public readonly brainId: string,
    public readonly taskId: string
  ) {}

  public get root(): string {
    return this.base.root;
  }

  /** Overlay -> committed workspace -> disk. `undefined` means "not staged". */
  public read(relPath: string): string | null | undefined {
    const rel = norm(relPath);
    const mine = this.writes.get(rel);
    if (mine) {
      return mine.after;
    }
    return this.base.read(rel);
  }

  public record(change: FileChange): void {
    const rel = norm(change.relPath);
    const first = this.writes.get(rel);
    // `before` must always mean "what was there when the run started", however
    // many times the brain edits the file afterwards. The Executor compares it
    // against disk to detect that the user changed the file in the meantime, and
    // that check is worthless if a second edit resets the baseline to its own
    // staged input.
    this.writes.set(rel, first ? { ...change, before: first.before, kind: first.kind } : change);
  }

  public changes(): FileChange[] {
    return [...this.writes.values()];
  }

  public touched(): string[] {
    return [...this.writes.keys()];
  }
}

function norm(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Is a tool available to this brain? `deny` always beats `allow`. */
export function toolAllowed(brain: BrainDef, name: string): boolean {
  if (brain.tools.deny.includes(name)) {
    return false;
  }
  return brain.tools.allow.includes('*') || brain.tools.allow.includes(name);
}

/**
 * Where a brain may WRITE. Its context includes are the scope: the Backend brain
 * sees and edits `server/**`, the Frontend brain `src/**`. An empty include list
 * (a 'changed'-mode reviewer, say) means it has no write scope at all — which is
 * correct, because those brains are read-only by policy anyway.
 */
export function writeScope(brain: BrainDef): string[] {
  return brain.contextRules.include;
}

export interface DispatchDeps {
  brain: BrainDef;
  stage: BrainStage;
  workspaceRoot: string;
  /** The real tool dispatcher, for everything staging does not intercept. */
  base: (name: string, args: any, ctx: any) => Promise<string>;
  /** Called for every staged mutation, so the UI can show progress live. */
  onStage?: (change: FileChange) => void;
}

const STAGED_READ_MAX_LINES = 1200;

/**
 * The dispatcher a brain gets instead of the global one. It refuses in prose
 * rather than throwing: a refusal a model can read is a redirection, an
 * exception is a dead turn.
 */
export function createBrainDispatch(deps: DispatchDeps) {
  const { brain, stage, workspaceRoot, base, onStage } = deps;
  const scope = writeScope(brain);

  const resolve = (raw: string): { abs: string; rel: string } | null => {
    const cleaned = String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
    if (!cleaned) {
      return null;
    }
    const abs = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(workspaceRoot, cleaned);
    return { abs, rel: toRelative(workspaceRoot, abs) };
  };

  const inScope = (rel: string): boolean => {
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false; // outside the workspace entirely
    }
    return scope.length > 0 && matchAny(rel, scope);
  };

  const outOfScope = (rel: string): string =>
    `You may not change ${rel}. Your write scope is: ${scope.length ? scope.join(', ') : '(none — you are a read-only brain)'}. ` +
    `Another brain owns that file. Note what needs to change there in your summary and let the team handle it.`;

  const diskRead = (abs: string): string | null => {
    try {
      return fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };

  /** Current staged-or-on-disk content. */
  const currentOf = (rel: string, abs: string): string | null => {
    const staged = stage.read(rel);
    return staged === undefined ? diskRead(abs) : staged;
  };

  const stageChange = (change: FileChange): void => {
    stage.record(change);
    onStage?.(change);
  };

  return async function dispatch(name: string, args: any, ctx: any): Promise<string> {
    if (!toolAllowed(brain, name)) {
      return (
        `The tool '${name}' is not available to you as the ${brain.name}. ` +
        `You may use: ${brain.tools.allow.join(', ')}. Work within that, or say in your ` +
        `summary what you would need another brain to do.`
      );
    }

    const target = args?.path ? resolve(args.path) : null;

    // ── reads see the run's staged state, not stale disk ──────────────────
    if (name === 'read_file' && target) {
      const staged = stage.read(target.rel);
      if (staged === null) {
        return `${target.rel} is staged for deletion in this run, so treat it as gone.`;
      }
      if (staged !== undefined) {
        const lines = staged.split(/\r?\n/);
        const shown = lines.slice(0, STAGED_READ_MAX_LINES);
        const more =
          lines.length > shown.length
            ? `\n…(${lines.length - shown.length} more line(s); this file is staged in this run.)`
            : '';
        return `${target.rel} (staged this run, ${lines.length} line(s)):\n${shown.join('\n')}${more}`;
      }
      return base(name, args, ctx);
    }

    // ── mutations are captured, never applied ─────────────────────────────
    if (name === 'write_file' && target) {
      if (!inScope(target.rel)) {
        return outOfScope(target.rel);
      }
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      const before = currentOf(target.rel, target.abs);
      if (before !== null && !args.overwrite) {
        return (
          `${target.rel} already exists (${before.split(/\r?\n/).length} lines). Read it and use ` +
          `edit_file to change part of it, or pass overwrite=true if you really mean to replace the whole file.`
        );
      }
      stageChange({
        kind: before === null ? 'write' : 'edit',
        path: target.abs,
        relPath: target.rel,
        before,
        after: content,
      });
      const verb = before === null ? 'Staged new file' : 'Staged a full rewrite of';
      return `${verb} ${target.rel} (${content.split(/\r?\n/).length} lines). It is not on disk yet — the user approves the whole run at the end.`;
    }

    if (name === 'edit_file' && target) {
      if (!inScope(target.rel)) {
        return outOfScope(target.rel);
      }
      const before = currentOf(target.rel, target.abs);
      if (before === null) {
        return `${target.rel} doesn't exist yet. Use write_file to create it.`;
      }

      let after: string;
      let note: string;
      if (args.append !== undefined && args.append !== null) {
        after = before + String(args.append);
        note = `Staged an append to ${target.rel}`;
      } else if (args.old_text !== undefined && args.old_text !== null) {
        const old = String(args.old_text);
        if (!old) {
          return 'old_text was empty. Give the exact snippet to replace.';
        }
        // Counted without a regex so the model's text needs no escaping.
        let count = 0;
        let at = before.indexOf(old);
        while (at !== -1) {
          count++;
          at = before.indexOf(old, at + old.length);
        }
        if (count === 0) {
          return `Couldn't find that text in ${target.rel}. Read the current version — it may already have been changed by another brain this run.`;
        }
        if (count > 1) {
          return `That text appears ${count} times in ${target.rel}; make it more specific so I change exactly the right one.`;
        }
        const idx = before.indexOf(old);
        after = before.slice(0, idx) + String(args.new_text ?? '') + before.slice(idx + old.length);
        note = `Staged 1 replacement in ${target.rel}`;
      } else {
        return 'Tell me what to change: old_text (and new_text) to replace, or append to add to the end.';
      }

      stageChange({ kind: 'edit', path: target.abs, relPath: target.rel, before, after });
      return `${note}. Not on disk yet — the run is applied as one reviewed change set.`;
    }

    if (name === 'create_item' && target) {
      if (!inScope(target.rel)) {
        return outOfScope(target.rel);
      }
      if (args.type === 'folder') {
        // A folder with no file in it cannot be staged as content, and every
        // staged write creates its parents on apply, so this is a no-op by
        // design rather than an error the model has to work around.
        return `Folders are created automatically when a file is staged inside them, so ${target.rel} needs no separate step. Write the file directly.`;
      }
      if (currentOf(target.rel, target.abs) !== null) {
        return `${target.rel} already exists. Nothing created.`;
      }
      stageChange({ kind: 'write', path: target.abs, relPath: target.rel, before: null, after: '' });
      return `Staged an empty file at ${target.rel}.`;
    }

    if (name === 'delete_item' && target) {
      if (!inScope(target.rel)) {
        return outOfScope(target.rel);
      }
      const before = currentOf(target.rel, target.abs);
      if (before === null) {
        return `${target.rel} doesn't exist (or is already staged for deletion). Nothing to do.`;
      }
      stageChange({ kind: 'delete', path: target.abs, relPath: target.rel, before, after: null });
      return `Staged ${target.rel} for deletion. It is still on disk until the user approves the run.`;
    }

    return base(name, args, ctx);
  };
}
