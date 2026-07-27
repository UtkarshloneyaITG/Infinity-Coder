import * as vscode from 'vscode';
import { SemanticIndexManager } from './indexManager';
import { IndexState } from './types';

/**
 * Commands and the status bar item.
 *
 * Kept out of extension.ts so the whole semantic feature is one folder that can
 * be removed, disabled or replaced without touching activation.
 */

const STATUS: Record<IndexState, { text: string; tooltip: string; warn?: boolean }> = {
  disabled: { text: '$(circle-slash) Index off', tooltip: 'Semantic indexing is disabled. Click to build one.' },
  empty: { text: '$(database) No index', tooltip: 'No semantic index yet. Click to build one.' },
  building: { text: '$(sync~spin) Indexing', tooltip: 'Building the semantic index…' },
  updating: { text: '$(sync~spin) Updating', tooltip: 'Updating the semantic index…' },
  ready: { text: '$(database) Index ready', tooltip: 'Semantic index is ready. Click for stats.' },
  error: { text: '$(warning) Index error', tooltip: 'The semantic index hit an error. Click for details.', warn: true },
};

export function registerSemanticCommands(
  context: vscode.ExtensionContext,
  manager: SemanticIndexManager,
): vscode.StatusBarItem {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'infinityCoder.indexStats';

  const paint = (state: IndexState) => {
    const style = STATUS[state];
    status.text = style.text;
    status.tooltip = state === 'error' && manager.error ? `${style.tooltip}\n${manager.error}` : style.tooltip;
    status.backgroundColor = style.warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    status.show();
  };

  paint(manager.currentState);
  context.subscriptions.push(manager.onDidChangeState(paint));

  context.subscriptions.push(
    status,

    vscode.commands.registerCommand('infinityCoder.buildIndex', async () => {
      const stats = await manager.build(true);
      if (stats) {
        vscode.window.showInformationMessage(
          `Semantic index built: ${stats.chunks.toLocaleString()} chunks across ${stats.files.toLocaleString()} files.`,
        );
      }
    }),

    // Update re-uses build without `force`: the file-hash check makes a full
    // pass over an unchanged repo nearly free, so there is no second code path.
    vscode.commands.registerCommand('infinityCoder.updateIndex', async () => {
      const stats = await manager.build(false);
      if (stats) {
        vscode.window.showInformationMessage(
          `Semantic index updated: ${stats.chunks.toLocaleString()} chunks across ${stats.files.toLocaleString()} files.`,
        );
      }
    }),

    vscode.commands.registerCommand('infinityCoder.clearIndex', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Delete the semantic index for this workspace? Rebuilding it will spend embedding calls again.',
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await manager.clear();
        vscode.window.showInformationMessage('Semantic index cleared.');
      }
    }),

    vscode.commands.registerCommand('infinityCoder.indexStats', async () => {
      const stats = await manager.stats();
      if (!stats) {
        const build = await vscode.window.showInformationMessage(
          manager.error || 'No semantic index for this workspace yet.',
          'Build index',
        );
        if (build) {
          await vscode.commands.executeCommand('infinityCoder.buildIndex');
        }
        return;
      }
      const mb = (stats.bytes / 1024 / 1024).toFixed(1);
      vscode.window.showInformationMessage(
        [
          `Files: ${stats.files.toLocaleString()}`,
          `Chunks: ${stats.chunks.toLocaleString()}`,
          `Vectors: ${stats.vectors.toLocaleString()} × ${stats.dimensions}`,
          `Size: ${mb} MB`,
          `Model: ${stats.model}`,
          stats.lastUpdatedAt ? `Updated: ${new Date(stats.lastUpdatedAt).toLocaleString()}` : '',
        ].filter(Boolean).join('  ·  '),
      );
    }),

    vscode.commands.registerCommand('infinityCoder.searchIndex', async () => {
      const engine = manager.search;
      if (!engine) {
        vscode.window.showWarningMessage('Build the semantic index first.');
        return;
      }
      const query = await vscode.window.showInputBox({
        prompt: 'Search the codebase semantically',
        placeHolder: 'Where is authentication implemented?',
      });
      if (!query) {
        return;
      }

      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Searching…' },
        () => engine.search(query, { topK: 25 }),
      );
      if (results.length === 0) {
        vscode.window.showInformationMessage('No matches. The index may not cover this area yet.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        results.map(result => ({
          label: `$(symbol-${quickPickIcon(result.chunk.symbolKind)}) ${result.chunk.symbol}`,
          description: `${result.chunk.relPath}:${result.chunk.startLine}`,
          detail: `${(result.similarity * 100).toFixed(0)}% match${result.reasons.length ? ' · ' + result.reasons.join(', ') : ''}`,
          result,
        })),
        { matchOnDescription: true, placeHolder: `${results.length} results for "${query}"` },
      );
      if (!picked) {
        return;
      }

      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) {
        return;
      }
      const uri = vscode.Uri.joinPath(root.uri, picked.result.chunk.relPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const line = Math.max(0, picked.result.chunk.startLine - 1);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(line, 0, line, 0);
    }),
  );

  return status;
}

function quickPickIcon(kind: string): string {
  switch (kind) {
    case 'class': case 'component': return 'class';
    case 'interface': return 'interface';
    case 'enum': return 'enum';
    case 'method': return 'method';
    case 'variable': return 'variable';
    case 'type': return 'structure';
    case 'namespace': return 'namespace';
    default: return 'function';
  }
}
