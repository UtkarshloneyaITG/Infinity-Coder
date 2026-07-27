import * as vscode from 'vscode';
import { InfinityCoderSidebarProvider } from './sidebarProvider';
import { procRegistry } from './engine/tools';
import { registerApprovalProvider } from './approval';
import { SemanticIndexManager } from './semantic/indexManager';
import { registerSemanticCommands } from './semantic/commands';

let sidebarProviderInstance: InfinityCoderSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Infinity Coder extension is now active!');

  registerApprovalProvider(context);
  sidebarProviderInstance = new InfinityCoderSidebarProvider(context);

  // The index owns its own state machine; activation only starts it. It is a
  // no-op — no scan, no network — until the user enables it in Settings.
  const semantic = new SemanticIndexManager(context, sidebarProviderInstance.settingsStore);
  context.subscriptions.push(semantic);
  registerSemanticCommands(context, semantic);
  sidebarProviderInstance.attachSemanticIndex(semantic);
  void semantic.activate();

  // Ask each keyed provider what it serves, so the model dropdown is populated
  // before the user opens it. Backgrounded — it must never delay activation.
  void sidebarProviderInstance.discoverModels();


  // Register Webview View Provider with retainContextWhenHidden: true (just like Claude extension)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      InfinityCoderSidebarProvider.viewType,
      sidebarProviderInstance,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Command: Start AI Assistant & focus sidebar
  const startCommand = vscode.commands.registerCommand('infinityCoder.start', async () => {
    await vscode.commands.executeCommand('infinityCoder.chatView.focus');
    vscode.window.showInformationMessage('Infinity Coder Active!');
  });

  // Command: Open Chat View (Shortcut: Ctrl+Alt+B)
  const openChatCommand = vscode.commands.registerCommand('infinityCoder.openChat', async () => {
    await vscode.commands.executeCommand('infinityCoder.chatView.focus');
  });

  // Command: Explain Code Selection
  const explainCodeCommand = vscode.commands.registerCommand('infinityCoder.explainCode', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found.');
      return;
    }
    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('Please select code to explain.');
      return;
    }

    sidebarProviderInstance?.sendCodePrompt('explain', selection);
  });

  // Command: Fix / Refactor Code Selection
  const fixCodeCommand = vscode.commands.registerCommand('infinityCoder.fixCode', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found.');
      return;
    }
    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('Please select code to fix/refactor.');
      return;
    }

    sidebarProviderInstance?.sendCodePrompt('fix', selection);
  });

  // Command: Ask Selection
  const askSelectionCommand = vscode.commands.registerCommand('infinityCoder.askSelection', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found.');
      return;
    }
    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('Please select code first.');
      return;
    }

    sidebarProviderInstance?.sendCodePrompt('ask', selection);
  });

  // Command: Reset / New Chat Conversation
  const resetChatCommand = vscode.commands.registerCommand('infinityCoder.resetChat', () => {
    sidebarProviderInstance?.createNewSession();
    vscode.commands.executeCommand('infinityCoder.chatView.focus');
  });

  // Command: run the whole brain team on a goal. Same path the Team toggle in
  // the chat input takes — one implementation, two entry points.
  const runTeamCommand = vscode.commands.registerCommand('infinityCoder.runTeam', async (goal?: string) => {
    const text =
      goal ||
      (await vscode.window.showInputBox({
        title: 'Infinity Coder — Run AI Team',
        prompt: 'What should the team build?',
        placeHolder: 'Build authentication',
        ignoreFocusOut: true,
      }));
    if (text?.trim()) {
      await vscode.commands.executeCommand('infinityCoder.chatView.focus');
      await sidebarProviderInstance?.sendTeamPrompt(text);
    }
  });

  context.subscriptions.push(
    startCommand,
    openChatCommand,
    explainCodeCommand,
    fixCodeCommand,
    askSelectionCommand,
    resetChatCommand,
    runTeamCommand
  );
}

export async function deactivate() {
  // Dev servers started with run_command are detached, so they would outlive the
  // window unless we take them down here.
  await procRegistry.stopAll();
}
