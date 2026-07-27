import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Shared plumbing for the agent's tools.
 *
 * Every tool returns a plain string — success or failure — and never throws into
 * the agent loop. A failure message is information the model can act on; an
 * exception would just kill the turn.
 */

export interface ToolContext {
  /** Project root. Tools resolve relative paths against it and run commands in it. */
  workspaceRoot: string;
  /** Where background-process logs are written. */
  logDir: string;
  /**
   * VS Code workspace trust. In an untrusted workspace the shell tools are
   * withheld: a prompt injected into a README of a repo you just opened to look
   * at must not be able to reach run_command.
   */
  isTrusted: boolean;
  /**
   * Ask the user to approve a file change. Absent in auto-approve mode (and in
   * tests), which means "go ahead" — so a tool that forgets to call it fails open
   * rather than blocking, and the gate that actually decides is whether the
   * caller supplies this at all.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalVerdict>;
}

export interface ApprovalRequest {
  kind: 'write' | 'edit' | 'delete';
  path: string;
  /** Current content, or null when the file does not exist yet. */
  before: string | null;
  /** Proposed content, or null for a delete. */
  after: string | null;
}

export interface ApprovalVerdict {
  approved: boolean;
  /** What the user typed instead of a plain rejection, passed back to the model. */
  feedback?: string;
}

/** Ask for approval if an approver is present. No approver = proceed. */
export async function approved(ctx: ToolContext, request: ApprovalRequest): Promise<ApprovalVerdict> {
  return ctx.approve ? ctx.approve(request) : { approved: true };
}

/**
 * The message a rejected tool returns. It has to do two things: stop the model
 * retrying the identical change, and relay the user's instruction if they gave
 * one — that redirection is the whole point of rejecting instead of stopping.
 */
export function rejectionMessage(what: string, verdict: ApprovalVerdict): string {
  if (verdict.feedback) {
    return `The user rejected that change to ${what} and said: "${verdict.feedback}". Follow that instruction instead — do not repeat the original change.`;
  }
  return `The user rejected that change, so ${what} is unchanged. Ask what they would like instead — do not retry the same change.`;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema, authored directly in OpenAI `function.parameters` shape. */
  parameters: any;
  /** Tool group, so the Settings > Tools toggles can withhold it. */
  group: 'files' | 'search' | 'shell' | 'web';
  run(args: any, ctx: ToolContext): Promise<string>;
}

/**
 * Clean a model-supplied path: strip surrounding quotes and space, expand ~,
 * normalize separators, and resolve a relative path against the workspace root.
 */
export function normalizePath(raw: string, ctx?: ToolContext): string {
  // Trim again after unquoting: models emit both `"C:\x"` and `" C:\x "`.
  let p = (raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!p) {
    return '';
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = path.normalize(p);
  if (!path.isAbsolute(p) && ctx?.workspaceRoot) {
    p = path.resolve(ctx.workspaceRoot, p);
  }
  return p;
}

/** Directories never worth walking: huge, generated, or VCS internals. */
export const PRUNE_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache',
  'dist', 'build', '.next', '.turbo', 'coverage', '.idea',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'out',
]);

export interface WalkEntry {
  fullPath: string;
  name: string;
  isDir: boolean;
}

/**
 * Walk `root`, pruning noise and hidden directories, stopping at `deadline`.
 * Bounded on purpose — an unbounded walk is how an assistant hangs.
 */
export function* walk(root: string, deadline: number): Generator<WalkEntry> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      return;
    }
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip it, don't abort the walk
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (isDir && (PRUNE_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.'))) {
        continue;
      }
      yield { fullPath: full, name: entry.name, isDir };
      if (isDir) {
        stack.push(full);
      }
    }
  }
}

/** A NUL byte is a reliable "this is binary" signal. */
export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

export function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    return 'permission denied';
  }
  return err?.message || String(e);
}
