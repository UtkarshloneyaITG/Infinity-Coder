import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Change approval plumbing.
 *
 * The prompt itself is rendered inline in the chat sidebar (see sidebarProvider)
 * rather than as a native modal — a modal steals focus from the panel you are
 * reading and cannot carry a "do this instead" reply back to the model. What
 * lives here is the part that needs the editor: a virtual document provider so a
 * proposed change can be shown as a real diff without ever touching disk.
 */

const SCHEME = 'infinity-coder-diff';

export interface ApprovalRequest {
  kind: 'write' | 'edit' | 'delete';
  /** Absolute path of the file the agent wants to change. */
  path: string;
  /** Current content, or null when the file does not exist yet. */
  before: string | null;
  /** Proposed content, or null for a delete. */
  after: string | null;
}

export interface ApprovalResult {
  approved: boolean;
  /** Applies to the rest of this turn. */
  all?: boolean;
  /** Free text the user typed instead of a plain rejection. */
  feedback?: string;
}

const contents = new Map<string, string>();
let counter = 0;

export function registerApprovalProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: uri => contents.get(uri.path) ?? '',
    })
  );
}

function stash(label: string, text: string): vscode.Uri {
  // Keep the real file name in the virtual path so the diff gets the right
  // syntax highlighting from its extension.
  const key = `/${++counter}/${label}`;
  contents.set(key, text);
  return vscode.Uri.from({ scheme: SCHEME, path: key });
}

/** Open the proposed change as a diff tab. Nothing is written to disk. */
export async function showDiff(request: ApprovalRequest): Promise<void> {
  const name = path.basename(request.path);

  if (request.kind === 'delete') {
    // Nothing to compare — just show what would go.
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(request.path));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`Could not open ${request.path}.`);
    }
    return;
  }

  const isNew = request.before === null;
  const left = isNew ? stash(name, '') : vscode.Uri.file(request.path);
  const right = stash(name, request.after ?? '');

  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${name} — ${isNew ? 'new file' : 'proposed changes'}`,
    { preview: true }
  );
}

/**
 * Approximate added/removed line counts for the inline badge.
 *
 * ponytail: a multiset difference, not a real diff. It gets the common cases
 * right (append, replace a block, new file) and costs ten lines instead of an
 * LCS implementation. The exact per-line view is the diff tab, one click away.
 */
export function diffStat(before: string | null, after: string | null): { added: number; removed: number } {
  const beforeLines = before === null ? [] : before.split(/\r?\n/);
  const afterLines = after === null ? [] : after.split(/\r?\n/);

  const counts = new Map<string, number>();
  for (const line of beforeLines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of afterLines) {
    const seen = counts.get(line) ?? 0;
    if (seen > 0) {
      counts.set(line, seen - 1);
    } else {
      added++;
    }
  }
  let removed = 0;
  for (const remaining of counts.values()) {
    removed += remaining;
  }
  return { added, removed };
}
