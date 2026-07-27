import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatMessage, MessageBlock, ModelInfo, ToolInfo } from './types';
import { SessionManager, ChatSession } from './sessionManager';
import { SettingsStore, testKey, TOOL_GROUP_LABELS } from './settings';
import { MODELS } from './catalog';
import { Engine, Msg, NoCredentialsError, trimHistory } from './engine/agent';
import { ALL_TOOLS } from './engine/tools';
import { rebuildEngineHistory } from './engine/history';
import { SkillRegistry, selectSkills, loadSkillBodies } from './engine/skills';

/** Stamp an approval block with its outcome. */
function markApproval(
  block: MessageBlock,
  status: 'applied' | 'rejected' | 'expired',
  feedback?: string
) {
  if (block.approval) {
    block.approval.status = status;
    block.approval.feedback = feedback;
  }
}
import { ApprovalRequest, ApprovalResult, showDiff, diffStat } from './approval';

export class InfinityCoderSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'infinityCoder.chatView';
  private _view?: vscode.WebviewView;
  private engine: Engine;
  /** OpenAI-format history per session — tool calls and all. In memory only. */
  private engineHistories = new Map<string, Msg[]>();
  private sessionManager: SessionManager;
  private currentSession: ChatSession;
  private models: ModelInfo[] = [];
  private activeModel: string = '';
  private tools: ToolInfo[] = [];
  private activeAbortController: AbortController | null = null;
  private settings: SettingsStore;
  private skillRegistry = new SkillRegistry();
  /** providerId -> model ids returned by a successful key Test. */
  private discoveredModels = new Map<string, string[]>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.settings = new SettingsStore(context);
    this.engine = new Engine(this.settings);
    this.sessionManager = new SessionManager(context);

    const activeId = this.sessionManager.getActiveSessionId();
    let loaded = activeId ? this.sessionManager.getSession(activeId) : undefined;
    if (!loaded) {
      const sessions = this.sessionManager.getSessions();
      loaded = sessions.length > 0 ? sessions[0] : this.sessionManager.createSession('New Chat');
    }
    // Loaded from disk, so it may carry live state from a turn the previous
    // window was in the middle of.
    this.currentSession = this.reviveSession(loaded);

    vscode.window.onDidChangeActiveTextEditor(() => this.sendWorkspaceContextToWebview());
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.sendWorkspaceContextToWebview());
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    this.refreshBackendState();
    this.sendWorkspaceContextToWebview();
    this.sendSessionsToWebview();
    // Sent up front, not just when Settings opens: the slash menu is built from
    // this, so /<skill> has to work on the first message.
    this.sendSkillsToWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage': {
          await this.handleUserMessage(data.text, data.model, data.attachments, data.skills, data.planMode);
          break;
        }
        case 'searchFiles': {
          await this.sendFileResults(data.query);
          break;
        }
        case 'approvalResponse': {
          this.resolveApproval(data.id, {
            approved: data.choice === 'apply' || data.choice === 'applyAll',
            all: data.choice === 'applyAll',
            feedback: (data.feedback || '').trim() || undefined,
          });
          break;
        }
        case 'planResponse': {
          await this.handlePlanResponse(data.id, data.choice);
          break;
        }
        case 'viewDiff': {
          const request = this.approvalRequests.get(data.id);
          if (request) {
            await showDiff(request);
          }
          break;
        }
        case 'stopGeneration': {
          this.stopCurrentGeneration();
          break;
        }
        case 'selectModel': {
          await this.handleModelChange(data.modelId);
          break;
        }
        case 'newSession': {
          this.createNewSession();
          break;
        }
        case 'switchSession': {
          this.switchSession(data.sessionId);
          break;
        }
        case 'deleteSession': {
          this.deleteSession(data.sessionId);
          break;
        }
        case 'settings': {
          await this.handleSettingsAction(data);
          break;
        }
        case 'openFile': {
          await this.openFileInEditor(data.path);
          break;
        }
        case 'clearChat': {
          this.createNewSession();
          break;
        }
        case 'refresh': {
          this.sendSkillsToWebview();
          this.refreshBackendState();
          this.sendWorkspaceContextToWebview();
          this.sendSessionsToWebview();
          break;
        }
        case 'insertCode': {
          this.insertCodeToEditor(data.code, 'insert');
          break;
        }
        case 'replaceCode': {
          this.insertCodeToEditor(data.code, 'replace');
          break;
        }
        case 'copyText': {
          vscode.env.clipboard.writeText(data.text);
          vscode.window.showInformationMessage('Copied code block to clipboard!');
          break;
        }
      }
    });
  }

  public stopCurrentGeneration() {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    // An unanswered approval card would leave the agent awaiting a promise that
    // can never settle, so stopping has to settle them.
    this.rejectPendingApprovals();

    const streamingMsg = this.currentSession.messages.find(m => m.streaming);
    if (streamingMsg) {
      streamingMsg.streaming = false;
      this.sessionManager.saveSession(this.currentSession);
      this.sendSessionsToWebview();
    }
  }

  /**
   * Is this path already anchored, or is it relative to the project root?
   *
   * Not path.isAbsolute: on Windows that calls "/src/app.tsx" absolute, and a
   * model writing a workspace path with a leading slash is extremely common.
   */
  private isAnchoredPath(p: string): boolean {
    if (process.platform === 'win32') {
      return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
    }
    return p.startsWith('/');
  }

  /**
   * Open a path from a tool card. The system prompt tells the model to use paths
   * relative to the project root, so most of these arrive relative — and
   * Uri.file('components/X.tsx') would resolve to '/components/X.tsx'.
   *
   * When the path still doesn't resolve, fall back to finding the file by name:
   * a model that reported a path relative to the wrong folder still gives us a
   * correct basename, and the user only wants the file opened.
   */
  private async openFileInEditor(rawPath: string) {
    if (!rawPath) {
      return;
    }
    const given = rawPath.trim().replace(/^["']|["']$/g, '');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let candidate: string;
    if (this.isAnchoredPath(given)) {
      candidate = given;
    } else {
      // Drop a leading slash before resolving: "/src/app.tsx" from a model means
      // "relative to the project", not the filesystem root.
      const relative = given.replace(/^[\\/]+/, '');
      candidate = root ? path.resolve(root, relative) : path.resolve(relative);
    }

    let target: string | undefined =
      fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : undefined;

    if (!target) {
      const base = path.basename(given);
      const matches = await vscode.workspace.findFiles(
        `**/${base}`,
        '**/{node_modules,.git,dist,build,out,.venv,__pycache__}/**',
        20
      );
      if (matches.length === 1) {
        target = matches[0].fsPath;
      } else if (matches.length > 1) {
        const picked = await vscode.window.showQuickPick(
          matches.map(m => ({ label: vscode.workspace.asRelativePath(m), fsPath: m.fsPath })),
          { title: `Several files named ${base}`, placeHolder: 'Which one did you mean?' }
        );
        if (!picked) {
          return;
        }
        target = picked.fsPath;
      }
    }

    if (!target) {
      vscode.window.showWarningMessage(`Could not find ${given} in this workspace.`);
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e: any) {
      vscode.window.showWarningMessage(`Could not open ${target}: ${e.message}`);
    }
  }

  public createNewSession() {
    this.stopCurrentGeneration();
    this.currentSession = this.sessionManager.createSession('New Chat');
    this.sendSessionsToWebview();
  }

  public switchSession(sessionId: string) {
    this.stopCurrentGeneration();
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      this.currentSession = this.reviveSession(session);
      this.sessionManager.setActiveSessionId(sessionId);
      this.sendSessionsToWebview();
    }
  }

  public deleteSession(sessionId: string) {
    this.stopCurrentGeneration();
    this.engineHistories.delete(sessionId);
    this.sessionManager.deleteSession(sessionId);
    const activeId = this.sessionManager.getActiveSessionId();
    let next = activeId ? this.sessionManager.getSession(activeId) : undefined;
    if (!next) {
      next = this.sessionManager.createSession('New Chat');
    }
    this.currentSession = this.reviveSession(next);
    this.sendSessionsToWebview();
  }

  /**
   * Answer a plan. Unlike an approval card this settles no promise — the turn
   * that wrote the plan is long over — so a plan stays answerable across a
   * reload, and approving is simply the next message with plan mode off.
   */
  private async handlePlanResponse(messageId: string, choice: 'approve' | 'dismiss') {
    const msg = this.currentSession.messages.find(m => m.id === messageId);
    if (!msg || msg.plan !== 'pending') {
      return; // already answered, or answered in another window
    }
    msg.plan = choice === 'approve' ? 'approved' : 'dismissed';
    this.sessionManager.saveSession(this.currentSession);
    this.sendSessionsToWebview();

    if (choice === 'approve') {
      await this.handleUserMessage(
        'Implement the plan above. Follow it step by step, and tell me if you have ' +
        'to depart from it.',
        this.activeModel
      );
    }
  }

  /**
   * Coalesce streaming updates. Without this, every token wrote the session to
   * globalState and posted every session with every message — a payload that
   * grows with the conversation, once per token.
   *
   * The webview gets the active thread at ~15fps; the disk write is rarer still,
   * and both are forced once the turn ends so nothing is lost.
   */
  private streamFlushTimer: NodeJS.Timeout | undefined;
  private lastPersistAt = 0;

  private scheduleStreamUpdate() {
    if (this.streamFlushTimer) {
      return;
    }
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = undefined;
      this.postToWebview({ type: 'updateMessages', messages: this.currentSession.messages });
      // Persist at most once a second, so a crash mid-turn loses little.
      if (Date.now() - this.lastPersistAt > 1000) {
        this.lastPersistAt = Date.now();
        this.sessionManager.saveSession(this.currentSession);
      }
    }, 66);
  }

  private flushStreamUpdate() {
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
    this.lastPersistAt = 0;
    this.sessionManager.saveSession(this.currentSession);
    this.sendSessionsToWebview();
  }

  public sendSessionsToWebview() {
    const sessions = this.sessionManager.getSessions();
    this.postToWebview({
      type: 'sessionsUpdate',
      sessions,
      activeSessionId: this.currentSession.id,
      messages: this.currentSession.messages,
    });
  }

  /** Workspace file search behind the @-mention popover. */
  private async sendFileResults(rawQuery: string) {
    // Strip glob metacharacters — the query is a substring, not a pattern.
    const query = String(rawQuery || '').replace(/[*?{}[\]()!]/g, '').trim();
    const pattern = query ? `**/*${query}*` : '**/*';

    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        pattern,
        '**/{node_modules,.git,dist,build,out,.venv,venv,__pycache__,.next,coverage}/**',
        50
      );
    } catch {
      uris = [];
    }

    const files = uris
      .map(uri => ({ path: uri.fsPath, label: vscode.workspace.asRelativePath(uri) }))
      // Shallower, shorter paths are almost always the intended match.
      .sort((a, b) => a.label.length - b.label.length)
      .slice(0, 12);

    this.postToWebview({ type: 'fileResults', query: rawQuery, files });
  }

  /**
   * Read @-mentioned files into the prompt. Bounded per file and in total so a
   * handful of large attachments cannot blow the context window on its own.
   */
  private readAttachments(paths: string[]): string[] {
    const PER_FILE = 20_000;
    const TOTAL = 60_000;
    const out: string[] = [];
    let budget = TOTAL;

    for (const p of paths) {
      if (budget <= 0) {
        out.push(`- (further attachments omitted — total size limit reached)`);
        break;
      }
      try {
        const raw = fs.readFileSync(p);
        if (raw.includes(0)) {
          out.push(`- ${p}: binary file, not included`);
          continue;
        }
        let text = raw.toString('utf8');
        const cap = Math.min(PER_FILE, budget);
        const truncated = text.length > cap;
        if (truncated) {
          text = text.slice(0, cap);
        }
        budget -= text.length;
        const rel = vscode.workspace.asRelativePath(p);
        out.push(
          `- Attached file "${rel}" (${p}):\n\`\`\`\n${text}\n\`\`\`` +
            (truncated ? '\n(truncated — use read_file for the rest)' : '')
        );
      } catch (e: any) {
        out.push(`- ${p}: could not be read (${e.message})`);
      }
    }
    return out;
  }

  public sendWorkspaceContextToWebview() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = workspaceFolder ? workspaceFolder.name : null;
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : null;

    const activeEditor = vscode.window.activeTextEditor;
    let activeFileRelative = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : null;
    const activeFilePath = activeEditor ? activeEditor.document.uri.fsPath : null;

    let displayFileName = activeFileRelative;
    if (activeFileRelative) {
      const parts = activeFileRelative.replace(/\\/g, '/').split('/');
      displayFileName = parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
    }

    this.postToWebview({
      type: 'contextUpdate',
      workspaceName,
      workspacePath,
      activeFileRelative: displayFileName,
      activeFilePath,
    });
  }

  /**
   * Push the current engine state to the webview. Everything is local now —
   * "ready" means at least one enabled provider has a key, not that a server is up.
   */
  public refreshBackendState() {
    const settings = this.settings.get();
    const ready = settings.providers.some(p => p.enabled && p.keys.length > 0);

    // The static catalog, plus any model a successful key Test discovered.
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    for (const m of MODELS) {
      seen.add(m.id);
      models.push({
        id: m.id, name: m.name, provider: m.publisher,
        tier: m.tier, tools: m.tools, contextWindow: 0,
      });
    }
    for (const [providerId, ids] of this.discoveredModels) {
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          models.push({ id, name: id, provider: providerId, tier: 'medium', tools: true, contextWindow: 0 });
        }
      }
    }
    // The active model may be a hand-typed id not in either list — show it anyway,
    // or the dropdown would silently select something the engine isn't using.
    if (settings.activeModel && !seen.has(settings.activeModel)) {
      models.unshift({
        id: settings.activeModel, name: settings.activeModel,
        provider: 'custom', tier: 'medium', tools: true, contextWindow: 0,
      });
    }

    this.models = models;
    this.activeModel = settings.activeModel;
    this.tools = ALL_TOOLS.filter(t => settings.toolGroups[t.group] !== false).map(t => ({
      name: t.name,
      displayName: t.name.replace(/_/g, ' '),
      description: t.description,
      category: t.group,
      icon: '',
      enabled: true,
    }));

    this.postToWebview({
      type: 'stateUpdate',
      status: {
        connected: ready,
        engine: 'local',
        model: settings.activeModel,
        engineReady: ready,
        responseLanguage: 'english',
      },
      models: this.models,
      activeModel: this.activeModel,
      tools: this.tools,
    });
  }

  public sendCodePrompt(action: string, code: string) {
    if (this._view) {
      this._view.show(true);
      let promptText = '';
      if (action === 'explain') {
        promptText = `Please explain the following code:\n\`\`\`\n${code}\n\`\`\``;
      } else if (action === 'fix') {
        promptText = `Please review and fix/refactor the following code:\n\`\`\`\n${code}\n\`\`\``;
      } else {
        promptText = `Code context:\n\`\`\`\n${code}\n\`\`\`\n`;
      }
      this.handleUserMessage(promptText, this.activeModel);
    }
  }

  private async handleModelChange(modelId: string) {
    await this.settings.patch({ activeModel: modelId });
    this.activeModel = modelId;
    this.refreshBackendState();
  }

  /**
   * The engine's message history for a session. Rebuilt from the saved chat on a
   * cold start so a reopened session still has context — tool calls are not
   * persisted, so only the user/assistant turns come back.
   */
  private getEngineHistory(session: ChatSession): Msg[] {
    let history = this.engineHistories.get(session.id);
    if (!history) {
      // Rebuilt from the saved blocks, tool calls and results included, so a
      // session reopened after a reload can actually continue its work.
      history = rebuildEngineHistory(session.messages);
      // The rebuild covers the whole session, while the live history was being
      // trimmed as it grew — so trim it back before the first message, or a long
      // reopened chat starts over the context limit.
      trimHistory(history, this.settings.get().maxContextTokens);
      this.engineHistories.set(session.id, history);
    }
    return history;
  }

  private async handleUserMessage(
    userText: string,
    modelOverride?: string,
    attachments?: string[],
    forcedSkills?: string[],
    planMode?: boolean
  ) {
    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `asst-${Date.now()}`;

    if (this.currentSession.messages.length === 0 && this.currentSession.title === 'New Chat') {
      const cleanTitle = userText.trim().slice(0, 30);
      this.currentSession.title = cleanTitle || 'Chat Session';
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : null;
    const activeEditor = vscode.window.activeTextEditor;
    const activeFilePath = activeEditor ? activeEditor.document.uri.fsPath : null;
    const activeFileRelative = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : null;
    const selectedText = activeEditor ? activeEditor.document.getText(activeEditor.selection) : '';

    let enrichedPrompt = userText;
    const contextHeaderLines: string[] = [];

    if (workspacePath) {
      contextHeaderLines.push(`- Workspace Folder: "${workspacePath}"`);
    }
    if (activeFileRelative) {
      contextHeaderLines.push(`- Active Open File: "${activeFileRelative}" (${activeFilePath})`);
    }
    if (selectedText.trim() && !userText.includes(selectedText)) {
      contextHeaderLines.push(`- Active Selected Code:\n\`\`\`\n${selectedText.trim()}\n\`\`\``);
    }
    if (attachments && attachments.length > 0) {
      contextHeaderLines.push(...this.readAttachments(attachments));
    }

    if (contextHeaderLines.length > 0) {
      enrichedPrompt = `[VS Code Context Auto-Injected]\n${contextHeaderLines.join('\n')}\n\n[User Message]\n${userText}`;
    }

    const userMessage: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      createdAt: Date.now()
    };

    const assistantMessage: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      blocks: [],
      toolEvents: [],
      reasoning: '',
      notices: [],
      streaming: true
    };

    this.currentSession.messages.push(userMessage, assistantMessage);
    this.sessionManager.saveSession(this.currentSession);
    this.sendSessionsToWebview();

    this.activeAbortController = new AbortController();
    const session = this.currentSession;

    // "Apply All" holds only for the current turn, so an unattended scaffold is
    // one click but the next message starts asking again.
    let approveAll = false;
    const approve = async (request: ApprovalRequest) => {
      if (approveAll) {
        return { approved: true };
      }
      const result = await this.askApproval(request, assistantMsgId);
      if (result.all) {
        approveAll = true;
      }
      return { approved: result.approved, feedback: result.feedback };
    };

    try {
      const answer = await this.engine.chat({
        userText: enrichedPrompt,
        history: this.getEngineHistory(session),
        workspaceRoot: workspacePath || '',
        logDir: path.join(this.context.globalStorageUri.fsPath, 'procs'),
        isTrusted: vscode.workspace.isTrusted,
        // Selected from the user's raw message, not the context-enriched prompt:
        // the injected workspace header would otherwise skew every score.
        skills: this.selectSkillsFor(userText, forcedSkills),
        planMode,
        approve: this.settings.get().approvalMode === 'auto' ? undefined : approve,
        signal: this.activeAbortController.signal,
        modelOverride: modelOverride || undefined,
        onEvent: (event) => {
          const msg = this.currentSession.messages.find(m => m.id === assistantMsgId);
          if (!msg) { return; }

          msg.blocks = msg.blocks || [];

          switch (event.type) {
            case 'token': {
              msg.content += event.text;
              const last = msg.blocks[msg.blocks.length - 1];
              if (last && last.type === 'text') {
                last.text = (last.text || '') + event.text;
              } else {
                msg.blocks.push({ type: 'text', text: event.text });
              }
              break;
            }
            case 'reasoning': {
              msg.reasoning = (msg.reasoning || '') + event.text;
              const last = msg.blocks[msg.blocks.length - 1];
              if (last && last.type === 'reasoning') {
                last.text = (last.text || '') + event.text;
              } else {
                msg.blocks.push({ type: 'reasoning', text: event.text });
              }
              break;
            }
            case 'tool_call': {
              msg.toolEvents = msg.toolEvents || [];
              msg.toolEvents.push({ type: 'tool_call', name: event.name, input: event.input });
              msg.blocks.push({ type: 'tool', name: event.name, input: event.input, done: false });
              break;
            }
            case 'tool_result': {
              msg.toolEvents = msg.toolEvents || [];
              msg.toolEvents.push({ type: 'tool_result', name: event.name, result: event.result });
              const pendingTool = msg.blocks.slice().reverse().find(b => b.type === 'tool' && b.name === event.name && !b.done);
              if (pendingTool) {
                pendingTool.result = event.result;
                pendingTool.done = true;
              } else {
                msg.blocks.push({ type: 'tool', name: event.name, result: event.result, done: true });
              }
              break;
            }
            case 'notice': {
              msg.notices = msg.notices || [];
              msg.notices.push(event.text);
              break;
            }
            case 'usage': {
              msg.usage = event.usage;
              break;
            }
            case 'done': {
              msg.streaming = false;
              if (event.content && !msg.content) {
                msg.content = event.content;
                const textBlock = msg.blocks.find(b => b.type === 'text');
                if (!textBlock) {
                  msg.blocks.push({ type: 'text', text: event.content });
                }
              }
              break;
            }
            case 'error': {
              msg.streaming = false;
              msg.error = true;
              msg.content += `\n\nError: ${event.message}`;
              msg.blocks.push({ type: 'text', text: `\n\nError: ${event.message}` });
              break;
            }
          }

          this.scheduleStreamUpdate();
        },
      });

      const msg = this.currentSession.messages.find(m => m.id === assistantMsgId);
      if (msg) {
        msg.streaming = false;
        // Only a plan that actually says something is answerable — an aborted or
        // empty turn must not leave an Approve button with nothing behind it.
        if (planMode && !msg.error && (msg.content || answer)) {
          msg.plan = 'pending';
        }
        // A turn can end with tool calls and no streamed text (some models emit
        // the summary only in the final round); fall back to the returned answer.
        if (answer && !msg.content) {
          msg.content = answer;
          msg.blocks = msg.blocks || [];
          msg.blocks.push({ type: 'text', text: answer });
        }
        this.flushStreamUpdate();
      }
    } catch (err: any) {
      const msg = this.currentSession.messages.find(m => m.id === assistantMsgId);
      if (!msg) {
        return;
      }
      msg.streaming = false;

      if (err.name === 'AbortError' || this.activeAbortController?.signal.aborted) {
        this.flushStreamUpdate();
        return;
      }

      const hint = err instanceof NoCredentialsError
        ? err.message
        : `Error: ${err.message}`;
      msg.error = true;
      msg.content += `\n\n${hint}`;
      msg.blocks = msg.blocks || [];
      msg.blocks.push({ type: 'text', text: `\n\n${hint}` });
      this.flushStreamUpdate();
    } finally {
      this.activeAbortController = null;
    }
  }

  private insertCodeToEditor(code: string, mode: 'insert' | 'replace') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active text document open in editor.');
      return;
    }

    editor.edit(editBuilder => {
      if (mode === 'replace') {
        if (!editor.selection.isEmpty) {
          editBuilder.replace(editor.selection, code);
        } else {
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
          );
          editBuilder.replace(fullRange, code);
        }
      } else {
        // Insert mode: cleanly insert on a new line below current cursor/line
        if (!editor.selection.isEmpty) {
          editBuilder.insert(editor.selection.end, '\n' + code);
        } else {
          const position = editor.selection.active;
          const line = editor.document.lineAt(position.line);
          if (line.isEmptyOrWhitespace) {
            editBuilder.insert(position, code);
          } else {
            editBuilder.insert(line.range.end, '\n' + code);
          }
        }
      }
    }).then(success => {
      if (success) {
        vscode.window.showInformationMessage(
          mode === 'replace' ? 'Replaced code in active file.' : 'Inserted code into active file.'
        );
      }
    });
  }

  private postToWebview(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  /**
   * Skills for this message: anything invoked with /<skill>, every 'always'
   * skill, then scored matches.
   */
  private selectSkillsFor(userText: string, forced?: string[]) {
    const settings = this.settings.get();
    const metas = this.skillRegistry.list(settings.skillRoots);
    const selected = selectSkills(userText, metas, settings.skillModes, { forced });
    return loadSkillBodies(selected);
  }

  private sendSkillsToWebview() {
    const settings = this.settings.get();
    const metas = this.skillRegistry.list(settings.skillRoots);
    this.postToWebview({
      type: 'skillsUpdate',
      roots: settings.skillRoots,
      skills: metas.map(m => ({
        name: m.name,
        description: m.description,
        file: m.file,
        tokens: m.tokens,
        prompt: m.prompt,
        mode: settings.skillModes[m.name] ?? 'auto',
      })),
    });
  }

  // ── Inline change approval ────────────────────────────────────────────────

  /**
   * Cards awaiting a click, each holding a DIRECT reference to its block.
   *
   * Resolving used to search `currentSession` for the block by id. If that graph
   * was ever not the one holding the card — a session reloaded from storage is a
   * fresh set of objects — the search found nothing and the status silently
   * stayed 'pending', while the resolver still fired and the turn walked on.
   * A held reference cannot miss.
   */
  private pendingApprovals = new Map<
    string,
    { resolve: (result: ApprovalResult) => void; block: MessageBlock }
  >();
  /** The request behind each card, so "View diff" can reopen it. */
  private approvalRequests = new Map<string, ApprovalRequest>();
  private approvalCounter = 0;

  /**
   * Render an approval card into the running assistant message and wait for the
   * user to answer it. The card lives in the message blocks, so it renders inline
   * in the thread and stays there afterwards as a record of what was decided.
   */
  private askApproval(request: ApprovalRequest, assistantMsgId: string): Promise<ApprovalResult> {
    const id = `ap-${++this.approvalCounter}`;
    const { added, removed } = diffStat(request.before, request.after);

    const msg = this.currentSession.messages.find(m => m.id === assistantMsgId);
    if (!msg) {
      // The message vanished (session switched); nothing can answer, so reject.
      return Promise.resolve({ approved: false });
    }

    const block: MessageBlock = {
      type: 'approval',
      approval: {
        id,
        kind: request.kind,
        path: request.path,
        relPath: vscode.workspace.asRelativePath(request.path),
        added,
        removed,
        status: 'pending',
      },
    };
    msg.blocks = msg.blocks || [];
    msg.blocks.push(block);
    this.approvalRequests.set(id, request);
    this.flushStreamUpdate();

    return new Promise<ApprovalResult>(resolve => {
      this.pendingApprovals.set(id, { resolve, block });
    });
  }

  private resolveApproval(id: string, result: ApprovalResult) {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      // A card from a turn that is already over — nothing is waiting on it. Mark
      // it so it stops rendering as clickable, rather than silently doing
      // nothing every time it is clicked.
      this.expireApprovalBlock(id);
      this.flushStreamUpdate();
      return;
    }
    this.pendingApprovals.delete(id);
    this.approvalRequests.delete(id);

    const status = result.approved ? 'applied' : 'rejected';

    // Update BOTH the held block and whatever copy of it lives in the session
    // being rendered. They can be different objects — a session reloaded from
    // storage is a fresh graph — and the webview only ever sees the latter, so
    // updating just one leaves the card looking unanswered.
    markApproval(pending.block, status, result.feedback);
    for (const message of this.currentSession.messages) {
      const copy = (message.blocks || []).find(b => b.approval?.id === id);
      if (copy) {
        markApproval(copy, status, result.feedback);
        break;
      }
    }

    this.flushStreamUpdate();
    pending.resolve(result);
  }

  /** Mark an approval block dead wherever it lives in the current session. */
  private expireApprovalBlock(id: string) {
    for (const message of this.currentSession.messages) {
      const block = (message.blocks || []).find(b => b.approval?.id === id);
      if (block?.approval) {
        if (block.approval.status === 'pending') {
          block.approval.status = 'expired';
        }
        return;
      }
    }
  }

  /**
   * Clear live state that cannot survive a restart.
   *
   * The session is persisted mid-turn, so a reload brings back a message still
   * flagged as streaming, tool cards still spinning, and approval cards still
   * pending — none of which anything is driving any more. The pending card is the
   * worst: it renders as clickable but no promise is waiting, so every click is
   * silently dropped.
   */
  private reviveSession(session: ChatSession): ChatSession {
    let changed = false;
    for (const message of session.messages) {
      if (message.streaming) {
        message.streaming = false;
        changed = true;
      }
      for (const block of message.blocks || []) {
        if (block.type === 'tool' && !block.done) {
          block.done = true;
          block.result = block.result ?? '(interrupted — the window was closed)';
          changed = true;
        }
        if (block.approval?.status === 'pending') {
          block.approval.status = 'expired';
          changed = true;
        }
      }
    }
    if (changed) {
      this.sessionManager.saveSession(session);
    }
    return session;
  }

  /**
   * Nothing can answer a card once the turn is over, so anything still pending is
   * rejected — otherwise the agent would hang forever on a dead promise.
   */
  private rejectPendingApprovals() {
    for (const id of [...this.pendingApprovals.keys()]) {
      this.resolveApproval(id, { approved: false });
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /**
   * Every settings mutation the webview can request. Each one ends by pushing
   * the (key-free) settings back, so the modal always redraws from stored
   * truth rather than from its own optimistic guess.
   */
  private async handleSettingsAction(data: any) {
    const store = this.settings;
    try {
      switch (data.action) {
        case 'load':
          break;
        case 'save':
          await store.patch(data.patch);
          break;
        case 'addKey':
          await store.addKey(data.providerId, data.key);
          break;
        case 'removeKey':
          if (await this.confirmDestructive('Delete this API key?')) {
            await store.removeKey(data.providerId, data.keyId);
          }
          break;
        case 'moveKey':
          await store.moveKey(data.providerId, data.keyId, data.delta);
          break;
        case 'updateProvider':
          await store.updateProvider(data.providerId, data.patch);
          break;
        case 'moveProvider':
          await store.moveProvider(data.providerId, data.delta);
          break;
        case 'removeProvider':
          if (await this.confirmDestructive('Remove this provider and all of its keys?')) {
            this.discoveredModels.delete(data.providerId);
            await store.removeProvider(data.providerId);
          }
          break;
        case 'addProviderPrompt':
          // Webviews can't use prompt(), so the input boxes live out here.
          await this.promptAddProvider();
          break;
        case 'testKey':
          await this.handleTestKey(data.providerId, data.keyId);
          break;
        case 'setSkillMode': {
          const modes = { ...store.get().skillModes, [data.name]: data.mode };
          await store.patch({ skillModes: modes });
          break;
        }
        case 'rescanSkills':
          this.skillRegistry.refresh(store.get().skillRoots);
          break;
        case 'addSkillRoot': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: 'Choose a folder containing skills',
            openLabel: 'Add skill folder',
          });
          if (picked && picked[0]) {
            const roots = [...store.get().skillRoots, picked[0].fsPath];
            await store.patch({ skillRoots: roots });
            this.skillRegistry.refresh(roots);
          }
          break;
        }
        case 'removeSkillRoot': {
          const roots = store.get().skillRoots.filter(r => r !== data.root);
          await store.patch({ skillRoots: roots });
          this.skillRegistry.refresh(roots);
          break;
        }
        case 'openSkillFile':
          await this.openFileInEditor(data.file);
          break;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Infinity Coder settings: ${e.message}`);
    }
    this.sendSettingsToWebview();
    this.sendSkillsToWebview();
    // Keys, model and tool toggles all feed the header state, so refresh it too.
    this.refreshBackendState();
  }

  private async handleTestKey(providerId: string, keyId: string) {
    const provider = this.settings.get().providers.find(p => p.id === providerId);
    const raw = await this.settings.getKey(keyId);

    let result: { ok: boolean; message: string; models: string[] };
    if (!provider || !raw) {
      result = { ok: false, message: 'Key not found in the keychain.', models: [] };
    } else {
      result = await testKey(provider.baseUrl, raw);
    }

    if (result.ok && result.models.length > 0) {
      this.discoveredModels.set(providerId, result.models);
    }
    this.postToWebview({
      type: 'settingsTestResult',
      providerId,
      keyId,
      ok: result.ok,
      message: result.message,
    });
  }

  private async promptAddProvider() {
    const name = await vscode.window.showInputBox({
      prompt: 'Provider name',
      placeHolder: 'e.g. Together AI',
      ignoreFocusOut: true,
    });
    if (!name) {
      return;
    }
    const baseUrl = await vscode.window.showInputBox({
      prompt: 'OpenAI-compatible base URL',
      placeHolder: 'https://api.example.com/v1',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/.+/.test(v.trim()) ? null : 'Must be an http(s) URL'),
    });
    if (!baseUrl) {
      return;
    }
    await this.settings.addProvider(name, baseUrl);
  }

  private async confirmDestructive(message: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Delete');
    return choice === 'Delete';
  }

  private sendSettingsToWebview() {
    this.postToWebview({
      type: 'settingsUpdate',
      settings: this.settings.get(),
      catalog: MODELS,
      discovered: Object.fromEntries(this.discoveredModels),
      toolGroupLabels: TOOL_GROUP_LABELS,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const asset = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    // A fresh nonce per load: the only script allowed to run is ours.
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Nothing loads from the network: highlight.js and marked are vendored in
       media/, and only nonce'd scripts may execute. 'unsafe-inline' is needed for
       styles because the markup carries style attributes. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>Infinity Coder</title>
  <link rel="stylesheet" href="${asset('highlight.css')}">
  <script nonce="${nonce}" src="${asset('highlight.js')}"></script>
  <script nonce="${nonce}" src="${asset('marked.js')}"></script>

  <style>
    /* Palette. Neutral dark, tuned to sit beside VS Code's own dark themes. */
    :root {
      --bg: #181818;
      --panel-bg: #1e1e1e;
      --card-bg: #252526;
      --card-light: #ffffff;
      --input-bg: #252526;
      --border: rgba(255, 255, 255, 0.1);
      --border-bright: #007fd4;
      --text: #cccccc;
      --text-dim: #999999;
      --accent-bg: #0e639c;      /* filled buttons */
      --accent-fg: #ffffff;
      --accent: #3794ff;         /* links, focus, meters */
      --accent-strong: #4ec9b0;  /* success, active state */
      --danger: #d74b4b;         /* destructive, errors */
      --hover-bg: rgba(255, 255, 255, 0.06);
      --link-color: #3794ff;
      --code-header-bg: #2d2d2d;
      --inline-code-bg: rgba(78, 201, 176, 0.15);
      --inline-code-fg: #4ec9b0;
      --heading-color: #ffffff;
      --banner-text: #cccccc;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--text);
      background-color: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    svg {
      vertical-align: middle;
      display: inline-block;
    }

    @keyframes spin {
      100% { transform: rotate(360deg); }
    }

    .spin {
      animation: spin 1s linear infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }

    .pulse-loader {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: 6px;
    }

    .pulse-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background-color: var(--accent-strong);
      animation: pulse 1.4s infinite ease-in-out;
    }

    .pulse-dot:nth-child(2) { animation-delay: 0.2s; }
    .pulse-dot:nth-child(3) { animation-delay: 0.4s; }

    .thinking-loader {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text-dim);
      font-size: 0.78rem;
      padding: 6px 0;
    }

    /* Active Session Control Bar */
    .session-bar {
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-bg);
      flex-shrink: 0;
    }

    .session-info {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
      flex: 1;
    }

    .session-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--text-dim);
      display: inline-block;
      flex-shrink: 0;
      transition: background-color 0.2s ease;
    }

    .status-dot.online {
      background-color: var(--accent-strong);
      box-shadow: 0 0 6px rgba(78, 201, 176, 0.4);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .btn-icon {
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .btn-icon:hover {
      background: var(--hover-bg);
      color: var(--text);
    }

    /* History Sessions Menu Popover */
    .history-menu {
      position: absolute;
      top: 44px;
      right: 14px;
      width: 240px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
      z-index: 100;
      display: none;
      flex-direction: column;
      max-height: 220px;
      overflow-y: auto;
    }

    .history-item {
      padding: 7px 10px;
      font-size: 0.75rem;
      color: var(--text);
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
    }

    .history-item:hover {
      background: var(--hover-bg);
    }

    .history-item.active {
      font-weight: 600;
      color: var(--accent-strong);
    }

    /* Banner */
    .banner-offline {
      background: rgba(192, 73, 46, 0.15);
      border-bottom: 1px solid rgba(192, 73, 46, 0.3);
      color: var(--banner-text);
      padding: 6px 14px;
      font-size: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }

    .banner-offline button {
      background: var(--danger);
      color: #ffffff;
      border: none;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }

    .banner-offline button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    /* Main Container & Empty Session Landing View */
    .main-content {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .landing-view {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      gap: 16px;
    }

    .landing-brand {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--accent-strong);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .landing-art {
      width: 48px;
      height: 48px;
      color: var(--accent);
      opacity: 0.9;
    }

    .landing-info {
      font-size: 0.82rem;
      color: var(--text-dim);
      max-width: 280px;
      line-height: 1.5;
    }

    /* Message Thread Spacing */
    .thread {
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .msg {
      display: flex;
      flex-direction: column;
      gap: 6px;
      line-height: 1.6;
      font-size: 0.85rem;
      word-break: break-word;
    }

    .msg.user {
      align-self: flex-end;
      max-width: 90%;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 12px 12px 2px 12px;
    }

    .msg.assistant {
      align-self: flex-start;
      width: 100%;
      padding: 2px 0;
    }

    .msg-author {
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--accent-strong);
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Markdown Element Spacing & Formatting */
    .msg p {
      margin-bottom: 8px;
    }

    .msg p:last-child {
      margin-bottom: 0;
    }

    .msg ul, .msg ol {
      margin: 6px 0 10px 22px;
      padding-left: 0;
    }

    .msg li {
      margin-bottom: 4px;
      line-height: 1.55;
    }

    .msg h1, .msg h2, .msg h3, .msg h4 {
      margin: 12px 0 6px 0;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--heading-color);
    }

    .msg blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 10px;
      margin: 8px 0;
      color: var(--text-dim);
      font-style: italic;
    }

    /* Thinking Details Spacing */
    details.thinking {
      border-left: 2px solid var(--border);
      padding-left: 10px;
      margin: 6px 0 10px 2px;
      color: var(--text-dim);
      font-size: 0.78rem;
    }

    details.thinking summary {
      cursor: pointer;
      font-size: 0.75rem;
      color: var(--text-dim);
      user-select: none;
    }

    details.thinking summary:hover {
      color: var(--text);
    }

    details.thinking .thinking-body {
      margin-top: 4px;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.75rem;
      opacity: 0.85;
    }

    /* Minimalist Single-Line Tool Call Badge */
    .tool-indicator {
      border-left: 2px solid var(--border);
      padding-left: 10px;
      margin: 6px 0 6px 2px;
      color: var(--text-dim);
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      gap: 6px;
      line-height: 1.4;
      transition: border-color 0.2s ease;
    }

    .tool-indicator.running {
      border-left-color: var(--accent);
    }

    .tool-indicator.done {
      border-left-color: var(--accent-strong);
    }

    .file-jump-link {
      color: var(--link-color);
      text-decoration: underline;
      cursor: pointer;
      font-weight: 500;
    }

    .file-jump-link:hover {
      opacity: 0.8;
    }

    /* Code Blocks Formatting & Terminal Output Box */
    pre {
      background: var(--panel-bg) !important;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 10px 0;
      overflow-x: auto;
    }

    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--code-header-bg);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 0.72rem;
      color: var(--text-dim);
    }

    .code-actions {
      display: flex;
      gap: 6px;
    }

    .btn-code {
      background: transparent;
      color: var(--text-dim);
      border: none;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.7rem;
      cursor: pointer;
      transition: color 0.15s ease, background 0.15s ease;
    }

    .btn-code:hover {
      background: var(--hover-bg);
      color: var(--accent-strong);
    }

    code {
      font-family: var(--vscode-editor-font-family, consolas, monospace);
      font-size: 0.8rem;
    }

    pre code {
      display: block;
      padding: 10px 12px;
      line-height: 1.5;
      overflow-x: auto;
      color: var(--text);
    }

    :not(pre) > code {
      background: var(--inline-code-bg);
      color: var(--inline-code-fg);
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 0.82em;
    }

    /* Slash Command Autocomplete Popover */
    .slash-popover {
      position: absolute;
      bottom: 84px;
      left: 14px;
      right: 14px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.7);
      z-index: 200;
      display: none;
      flex-direction: column;
      overflow: hidden;
      /* Fixed ceiling: the list holds every built-in command plus every skill,
         so without this it grows off the top of the panel. */
      max-height: 260px;
    }

    .slash-header {
      padding: 6px 10px;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
      flex-shrink: 0;
    }

    .slash-list {
      overflow-y: auto;
      overflow-x: hidden;
      flex: 1;
      min-height: 0;
    }

    .slash-list::-webkit-scrollbar { width: 8px; }
    .slash-list::-webkit-scrollbar-track { background: transparent; }
    .slash-list::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }
    .slash-list::-webkit-scrollbar-thumb:hover { background: var(--border-bright); }

    /* Stacked, not side by side: skill descriptions are full sentences and would
       crush the name out of view on a narrow sidebar. */
    .slash-item {
      padding: 6px 10px;
      font-size: 0.78rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      width: 100%;
    }

    .slash-item:hover, .slash-item.selected {
      background: var(--hover-bg);
      color: var(--text);
    }

    .slash-item .cmd-name {
      font-weight: 600;
      color: var(--accent-strong);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .slash-item .cmd-desc {
      font-size: 0.7rem;
      color: var(--text-dim);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Floating Input Card */
    .footer-input {
      padding: 12px 14px;
      background: var(--bg);
      position: relative;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    .input-card {
      background: var(--panel-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: border-color 0.2s ease;
    }

    .input-card:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 8px rgba(78, 201, 176, 0.2);
    }

    textarea {
      background: transparent;
      color: var(--text);
      border: none;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 0.85rem;
      resize: none;
      min-height: 44px;
      max-height: 140px;
      outline: none;
      width: 100%;
    }

    textarea::placeholder {
      color: var(--text-dim);
    }

    .input-card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-top: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.15);
    }

    .input-card-left {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
      flex: 1;
      margin-right: 8px;
    }

    .input-card-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .slash-trigger-btn {
      background: var(--hover-bg);
      color: var(--accent-strong);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 0.72rem;
      font-family: monospace;
      cursor: pointer;
      flex-shrink: 0;
    }

    .slash-trigger-btn:hover {
      background: var(--hover-bg);
      color: var(--text);
    }

    .active-file-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 0.73rem;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .active-file-chip:hover {
      background: var(--hover-bg);
      color: var(--accent-strong);
    }

    .plan-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--bg);
      color: var(--text-dim);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 0.73rem;
      font-family: inherit;
      cursor: pointer;
    }

    .plan-toggle:hover { border-color: var(--border-bright); }

    .plan-toggle-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-dim);
      opacity: 0.5;
    }

    /* On is a state the user must not lose track of — every following message is
       read-only until they turn it off, so it stays loud rather than subtle. */
    .plan-toggle.on {
      color: var(--accent-strong);
      border-color: var(--accent-strong);
      background: color-mix(in srgb, var(--accent-strong) 12%, transparent);
    }

    .plan-toggle.on .plan-toggle-dot {
      background: var(--accent-strong);
      opacity: 1;
    }

    .plan-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 10px 0 2px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }

    .plan-btn {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 5px 10px;
      font-size: 0.7rem;
      font-family: inherit;
      cursor: pointer;
    }

    .plan-btn:hover {
      background: var(--hover-bg);
      border-color: var(--border-bright);
    }

    .plan-btn.primary {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: var(--accent-fg);
    }

    .plan-answered {
      margin: 10px 0 2px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      font-size: 0.68rem;
      color: var(--text-dim);
    }

    .model-select-inline {
      background: var(--bg);
      color: var(--text-dim);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 0.73rem;
      outline: none;
      cursor: pointer;
      max-width: 130px;
    }

    .model-select-inline option {
      background: var(--bg);
      color: var(--text);
    }

    .btn-send-inline {
      background: var(--accent-strong);
      color: var(--accent-fg);
      border: none;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s ease, opacity 0.15s ease;
    }

    .btn-send-inline:hover {
      opacity: 0.9;
    }

    .btn-send-inline.stop-mode {
      background: var(--danger);
      color: #ffffff;
      border-radius: 6px;
    }

    .btn-send-inline.stop-mode:hover {
      opacity: 0.9;
    }

    /* A skill pinned to the next message via /<skill> */
    .skill-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.66rem;
      padding: 2px 7px;
      margin-right: 4px;
      border-radius: 10px;
      background: var(--inline-code-bg);
      color: var(--inline-code-fg);
      border: 1px solid var(--border);
      cursor: pointer;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .skill-chip:hover {
      border-color: var(--danger);
      color: var(--danger);
    }

    /* Skills tab */
    .skill-budget {
      font-size: 0.66rem;
      color: var(--text-dim);
      margin-bottom: 8px;
    }

    .skill-budget.hot { color: var(--danger); }

    .skill-row {
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 7px 8px;
      margin-bottom: 6px;
      background: var(--card-bg);
    }

    .skill-row.off { opacity: 0.5; }

    .skill-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
    }

    .skill-name {
      flex: 1;
      min-width: 0;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .skill-cost {
      font-size: 0.62rem;
      color: var(--text-dim);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .skill-mode {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-size: 0.63rem;
      font-family: inherit;
      padding: 2px 4px;
      flex-shrink: 0;
    }

    .skill-desc {
      font-size: 0.65rem;
      color: var(--text-dim);
      line-height: 1.42;
    }

    .skill-root {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.66rem;
      color: var(--text-dim);
      padding: 3px 0;
      border-bottom: 1px solid var(--border);
      word-break: break-all;
    }

    .skill-empty {
      font-size: 0.68rem;
      color: var(--text-dim);
      line-height: 1.5;
      padding: 8px 0;
    }

    /* Inline change-approval card, rendered in the thread instead of a modal */
    .approval {
      border: 1px solid var(--border-bright);
      border-radius: 6px;
      background: var(--card-bg);
      padding: 9px 10px;
      margin: 8px 0;
      font-size: 0.72rem;
    }

    .approval.resolved {
      border-color: var(--border);
      opacity: 0.75;
    }

    .approval-title {
      font-weight: 600;
      color: var(--heading-color);
      margin-bottom: 3px;
    }

    .approval-path {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.68rem;
      color: var(--text-dim);
      margin-bottom: 8px;
      word-break: break-all;
    }

    .approval-stat {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.66rem;
      flex-shrink: 0;
      white-space: nowrap;
    }

    .approval-stat .add { color: #4ec9b0; }
    .approval-stat .del { color: var(--danger); }

    .approval-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .approval-opt {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      text-align: left;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 6px 8px;
      font-size: 0.7rem;
      font-family: inherit;
      cursor: pointer;
    }

    .approval-opt:hover {
      background: var(--hover-bg);
      border-color: var(--border-bright);
    }

    .approval-opt .key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 3px;
      background: var(--border);
      color: var(--text-dim);
      font-size: 0.62rem;
      flex-shrink: 0;
    }

    .approval-feedback {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 6px 8px;
      font-size: 0.7rem;
      font-family: inherit;
      margin-top: 4px;
    }

    .approval-feedback:focus {
      outline: none;
      border-color: var(--border-bright);
    }

    .approval-verdict {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
    }

    .approval-verdict.applied { color: var(--accent-strong); }
    .approval-verdict.rejected { color: var(--danger); }
    .approval-verdict.expired { color: var(--text-dim); font-style: italic; }

    .approval-quote {
      margin-top: 5px;
      padding-left: 8px;
      border-left: 2px solid var(--border);
      color: var(--text-dim);
      font-size: 0.68rem;
      line-height: 1.45;
    }

    .approval-link {
      background: none;
      border: none;
      color: var(--link-color);
      font-size: 0.68rem;
      cursor: pointer;
      padding: 0;
      font-family: inherit;
      flex-shrink: 0;
    }

    .approval-link:hover { text-decoration: underline; }

    /* Live activity strip, pinned above the input while a turn is running */
    .stream-status {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 10px;
      margin-bottom: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.7rem;
      color: var(--text);
    }

    .stream-status-icon {
      display: inline-flex;
      flex-shrink: 0;
      color: var(--accent-strong);
    }

    .stream-status-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stream-status-time {
      font-size: 0.65rem;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }

    .stream-status-stop {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 0.65rem;
      cursor: pointer;
      font-family: inherit;
      flex-shrink: 0;
    }

    .stream-status-stop:hover {
      color: var(--danger);
      border-color: var(--danger);
    }

    /* Three dots that keep moving, so a long silent tool call still looks alive */
    .stream-status-dots {
      display: inline-flex;
      gap: 2px;
      flex-shrink: 0;
    }

    .stream-status-dots i {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--accent-strong);
      animation: statusDot 1.2s infinite ease-in-out;
    }

    .stream-status-dots i:nth-child(2) { animation-delay: 0.15s; }
    .stream-status-dots i:nth-child(3) { animation-delay: 0.3s; }

    @keyframes statusDot {
      0%, 60%, 100% { opacity: 0.25; }
      30% { opacity: 1; }
    }

    /* Failover / system notices inside an assistant message */
    .msg-notice {
      font-size: 0.7rem;
      color: var(--text-dim);
      border-left: 2px solid var(--accent);
      padding: 3px 0 3px 8px;
      margin: 5px 0;
      line-height: 1.45;
    }

    /* Token usage footer */
    .usage-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      font-size: 0.64rem;
      color: var(--text-dim);
      cursor: default;
    }

    .usage-meter {
      width: 46px;
      height: 3px;
      border-radius: 2px;
      background: var(--border);
      overflow: hidden;
      flex-shrink: 0;
    }

    .usage-meter > span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .usage-bar.hot { color: var(--danger); }
    .usage-bar.hot .usage-meter > span { background: var(--danger); }

    /* ── Settings Modal ─────────────────────────────────────────────── */
    /* Sized for the VS Code sidebar (~300px), not a desktop dialog:
       everything stacks, nothing sits side by side. */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      z-index: 200;
      display: none;
      flex-direction: column;
    }

    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--panel-bg);
      border: 1px solid var(--border);
      margin: 8px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
    }

    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .modal-title {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--heading-color);
    }

    .modal-tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .modal-tab {
      flex: 1;
      padding: 7px 4px;
      font-size: 0.68rem;
      text-align: center;
      color: var(--text-dim);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-family: inherit;
    }

    .modal-tab:hover { background: var(--hover-bg); }

    .modal-tab.active {
      color: var(--accent-strong);
      border-bottom-color: var(--accent);
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      min-height: 0;
    }

    .modal-pane { display: none; }
    .modal-pane.active { display: block; }

    .modal-foot {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* Fields */
    .field { margin-bottom: 11px; }

    .field label {
      display: block;
      font-size: 0.68rem;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .field input[type="text"],
    .field input[type="password"],
    .field input[type="number"],
    .field select {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 5px 7px;
      font-size: 0.72rem;
      font-family: inherit;
    }

    .field input:focus, .field select:focus {
      outline: none;
      border-color: var(--border-bright);
    }

    .field-hint {
      font-size: 0.64rem;
      color: var(--text-dim);
      margin-top: 3px;
      line-height: 1.4;
    }

    /* Provider cards */
    .prov-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
      background: var(--card-bg);
    }

    .prov-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }

    .prov-name {
      flex: 1;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .prov-card.disabled { opacity: 0.5; }

    .key-row {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 0;
      font-size: 0.7rem;
      border-top: 1px solid var(--border);
    }

    .key-mask {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .key-tag {
      font-size: 0.6rem;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--inline-code-bg);
      color: var(--inline-code-fg);
      flex-shrink: 0;
    }

    .key-status {
      font-size: 0.62rem;
      flex-shrink: 0;
    }

    .key-status.ok { color: var(--accent-strong); }
    .key-status.bad { color: var(--danger); }

    /* Buttons */
    .btn-sm {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      border-radius: 4px;
      padding: 3px 7px;
      font-size: 0.65rem;
      cursor: pointer;
      font-family: inherit;
      flex-shrink: 0;
    }

    .btn-sm:hover {
      background: var(--hover-bg);
      color: var(--text);
      border-color: var(--border-bright);
    }

    .btn-sm.danger:hover {
      color: var(--danger);
      border-color: var(--danger);
    }

    .btn-primary {
      background: var(--accent-bg);
      color: var(--accent-fg);
      border: none;
      border-radius: 4px;
      padding: 5px 14px;
      font-size: 0.7rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-primary:hover { opacity: 0.88; }

    .btn-link {
      background: none;
      border: none;
      color: var(--link-color);
      font-size: 0.68rem;
      cursor: pointer;
      padding: 4px 0;
      font-family: inherit;
    }

    .btn-link:hover { text-decoration: underline; }

    /* Toggle */
    .toggle {
      appearance: none;
      width: 28px;
      height: 16px;
      border-radius: 8px;
      background: var(--border);
      position: relative;
      cursor: pointer;
      flex-shrink: 0;
      border: none;
    }

    .toggle:checked { background: var(--accent); }

    .toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--text);
      transition: transform 0.15s;
    }

    .toggle:checked::after { transform: translateX(12px); }

    .check-row {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      padding: 6px 0;
      font-size: 0.7rem;
      color: var(--text);
      line-height: 1.4;
    }

    .check-row input { margin-top: 2px; flex-shrink: 0; }

    .section-label {
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-dim);
      margin: 4px 0 8px;
    }
  </style>
</head>
<body>
  <!-- Session Control Bar -->
  <div class="session-bar">
    <div class="session-info">
      <span class="status-dot" id="statusDot" title="Backend Status"></span>
      <span class="session-title" id="sessionTitle">New Chat</span>
    </div>
    <div class="header-actions">
      <button class="btn-icon" id="historyBtn" title="Saved Chat Sessions"></button>
      <button class="btn-icon" id="newSessionBtn" title="New Chat Session"></button>
      <button class="btn-icon" id="settingsBtn" title="Settings"></button>
    </div>
  </div>

  <!-- History Sessions Menu Popover -->
  <div class="history-menu" id="historyMenu"></div>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="settingsModal">
    <div class="modal">
      <div class="modal-head">
        <span class="modal-title">Infinity Coder Settings</span>
        <button class="btn-sm" id="settingsCloseBtn">Close</button>
      </div>

      <div class="modal-tabs">
        <button class="modal-tab active" data-pane="providers">Keys</button>
        <button class="modal-tab" data-pane="models">Models</button>
        <button class="modal-tab" data-pane="tools">Tools</button>
        <button class="modal-tab" data-pane="skills">Skills</button>
      </div>

      <div class="modal-body">
        <!-- Providers -->
        <div class="modal-pane active" id="pane-providers">
          <div class="section-label">Providers &amp; API keys</div>
          <div id="providerList"></div>
          <button class="btn-link" id="addProviderBtn">+ Add custom OpenAI-compatible provider</button>
          <div class="field-hint" style="margin-top:8px">
            Keys are stored in your OS keychain, never in settings.json.
            Order sets failover: a key that hits 401 or 429 falls through to the
            next key, then the next enabled provider.
          </div>
        </div>

        <!-- Models -->
        <div class="modal-pane" id="pane-models">
          <div class="field">
            <label for="activeModelInput">Active model</label>
            <input type="text" id="activeModelInput" list="modelOptions" spellcheck="false">
            <datalist id="modelOptions"></datalist>
            <div class="field-hint" id="modelDiscoverHint"></div>
          </div>
          <div class="field">
            <label for="boostModelInput">Boost model (heavy escalation)</label>
            <input type="text" id="boostModelInput" list="modelOptions" spellcheck="false">
          </div>
          <div class="field">
            <label for="temperatureInput">Temperature</label>
            <input type="number" id="temperatureInput" min="0" max="2" step="0.1">
          </div>
          <div class="field">
            <label for="maxTokensInput">Max tokens per reply</label>
            <input type="number" id="maxTokensInput" min="256" max="128000" step="256">
          </div>
          <div class="field">
            <label for="maxContextInput">Context budget (tokens)</label>
            <input type="number" id="maxContextInput" min="4000" max="2000000" step="1000">
            <div class="field-hint">
              Your model's context window. Older turns are dropped to stay under it,
              and it sets the scale of the usage meter. Providers don't reliably
              report this, so set it to match the model you run.
            </div>
          </div>
        </div>

        <!-- Tools -->
        <div class="modal-pane" id="pane-tools">
          <div class="field">
            <label for="approvalSelect">File changes</label>
            <select id="approvalSelect">
              <option value="ask">Ask me — show a diff before each change</option>
              <option value="auto">Auto-apply — change files without asking</option>
            </select>
            <div class="field-hint">
              In ask mode a diff opens for every write, edit and delete. "Apply All"
              in that prompt approves the rest of that one turn only.
            </div>
          </div>

          <div class="field">
            <label for="maxRoundsInput">Tool steps per message</label>
            <input type="number" id="maxRoundsInput" min="5" max="500" step="5">
            <div class="field-hint">
              How many tool calls one message may make. Scaffolding a project is
              roughly one step per file, so raise this for big tasks. Hitting it
              ends the turn with a summary of what was done, not a failure.
            </div>
          </div>

          <div class="section-label">Tools the assistant may use</div>
          <div id="toolGroupList"></div>
          <div class="field-hint" style="margin-top:8px">
            Disabled groups are not offered to the model at all, so it cannot
            call them even if it tries. Shell tools are always withheld in an
            untrusted workspace.
          </div>
        </div>

        <!-- Skills -->
        <div class="modal-pane" id="pane-skills">
          <div class="section-label">Skills</div>
          <div class="field-hint" style="margin-bottom:10px">
            Markdown instruction files (SKILL.md). <b>Always</b> applies on every
            message — use it for small behaviour skills. <b>Auto</b> loads only
            when your message matches the skill, which is how large reference
            skills stay affordable.
          </div>

          <div id="skillBudget" class="skill-budget"></div>
          <div id="skillList"></div>

          <div class="section-label" style="margin-top:14px">Folders scanned</div>
          <div id="skillRootList"></div>
          <div style="display:flex; gap:8px; margin-top:6px">
            <button class="btn-link" id="addSkillRootBtn">+ Add folder</button>
            <button class="btn-link" id="rescanSkillsBtn">Rescan</button>
          </div>
          <div class="field-hint" style="margin-top:8px">
            Only these global folders are scanned. Skills are never read from the
            open project: a SKILL.md inside a repo you cloned would be untrusted
            text turning into instructions for a model that can run commands.
          </div>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-sm" id="settingsCancelBtn">Cancel</button>
        <button class="btn-primary" id="settingsSaveBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Banner: shown until a provider key is configured -->
  <div class="banner-offline" id="offlineBanner" style="display: none;">
    <span>No API key configured</span>
    <button id="openSettingsBtn">Add Key</button>
  </div>

  <!-- Main Content Area -->
  <div class="main-content" id="mainContent">
    <!-- Centered Empty Session Landing View -->
    <div class="landing-view" id="landingView">
      <div class="landing-brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9Z"></path>
        </svg>
        Infinity Coder
      </div>

      <!-- Pixel Vector Art Icon -->
      <svg class="landing-art" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="7" width="14" height="10" rx="2"></rect>
        <circle cx="9" cy="11" r="1" fill="currentColor"></circle>
        <circle cx="15" cy="11" r="1" fill="currentColor"></circle>
        <path d="M9 14h6" stroke-linecap="round"></path>
      </svg>

      <div class="landing-info">
        Your voice & text AI assistant for VS Code.<br>
        Type a prompt or press <strong>/</strong> for commands.
      </div>
    </div>

    <!-- Messages Thread -->
    <div class="thread" id="messagesContainer" style="display: none;"></div>
  </div>

  <!-- Slash Command Autocomplete Popover -->
  <div class="slash-popover" id="slashPopover">
    <div class="slash-header">Commands &amp; skills</div>
    <div class="slash-list" id="slashList"></div>
  </div>

  <!-- @-mention File Picker -->
  <div class="slash-popover" id="filePopover">
    <div class="slash-header">Attach a workspace file</div>
    <div class="slash-list" id="fileList"></div>
  </div>

  <!-- Unified Input Card -->
  <div class="footer-input">
    <!-- Pinned above the input so it stays visible however far the thread scrolls -->
    <div class="stream-status" id="streamStatus" style="display: none;">
      <span class="stream-status-icon" id="streamStatusIcon"></span>
      <span class="stream-status-label" id="streamStatusLabel">Thinking</span>
      <span class="stream-status-dots"><i></i><i></i><i></i></span>
      <span class="stream-status-time" id="streamStatusTime"></span>
      <button class="stream-status-stop" id="streamStatusStop" title="Stop generating">Stop</button>
    </div>

    <div class="input-card">
      <textarea id="promptInput" placeholder="ctrl esc to focus or ask Infinity Coder..."></textarea>
      <div class="input-card-footer">
        <div class="input-card-left">
          <button class="slash-trigger-btn" id="slashBtn" title="Type / for commands">/</button>
          <span class="active-file-chip" id="activeFileChip" style="display: none;"></span>
          <span id="skillChips"></span>
          <span id="attachChips"></span>
        </div>
        <div class="input-card-right">
          <button class="plan-toggle" id="planToggle" title="Plan mode — investigate and propose a plan, change nothing">
            <span class="plan-toggle-dot"></span>Plan
          </button>
          <select class="model-select-inline" id="modelSelect" title="Select Model">
            <option value="">Connecting...</option>
          </select>
          <button class="btn-send-inline" id="sendBtn" title="Send Message"></button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusDot = document.getElementById('statusDot');
    const sessionTitle = document.getElementById('sessionTitle');
    const modelSelect = document.getElementById('modelSelect');
    const historyBtn = document.getElementById('historyBtn');
    const historyMenu = document.getElementById('historyMenu');
    const offlineBanner = document.getElementById('offlineBanner');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const mainContent = document.getElementById('mainContent');
    const landingView = document.getElementById('landingView');
    const messagesContainer = document.getElementById('messagesContainer');
    const promptInput = document.getElementById('promptInput');
    const planToggle = document.getElementById('planToggle');
    const sendBtn = document.getElementById('sendBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const slashBtn = document.getElementById('slashBtn');
    const activeFileChip = document.getElementById('activeFileChip');
    const slashPopover = document.getElementById('slashPopover');
    const slashList = document.getElementById('slashList');
    const filePopover = document.getElementById('filePopover');
    const fileList = document.getElementById('fileList');
    const attachChips = document.getElementById('attachChips');

    const SVG_ICONS = {
      plus: \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>\`,
      history: \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>\`,
      settings: \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>\`,
      arrowUp: \`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>\`,
      stop: \`<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>\`,
      file: \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>\`,
      tool: \`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>\`,
      check: \`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>\`,
      spinner: \`<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-strong)" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>\`
    };

    newSessionBtn.innerHTML = SVG_ICONS.plus;
    historyBtn.innerHTML = SVG_ICONS.history;
    settingsBtn.innerHTML = SVG_ICONS.settings;
    sendBtn.innerHTML = SVG_ICONS.arrowUp;

    const SLASH_COMMANDS = [
      { cmd: "/explain", desc: "Read & explain active code or workspace" },
      { cmd: "/fix", desc: "Review and fix bugs in code" },
      { cmd: "/tests", desc: "Generate comprehensive unit tests" },
      { cmd: "/refactor", desc: "Refactor code for performance" },
      { cmd: "/clear", desc: "Start a fresh new chat session" },
      { cmd: "/help", desc: "List all commands & shortcuts" }
    ];

    let activeFilePath = null;
    let isCurrentlyStreaming = false;


    // Plain-English label for every tool, in both tenses. Every tool the engine
    // ships has an entry, so the "Used <tool_name>" fallback should never show.
    const TOOL_VERBS = {
      read_file:       ['Reading',                 'Read'],
      write_file:      ['Writing',                 'Wrote'],
      edit_file:       ['Editing',                 'Edited'],
      create_item:     ['Creating',                'Created'],
      delete_item:     ['Deleting',                'Deleted'],
      list_folder:     ['Listing folder',          'Listed folder'],
      find_files:      ['Looking for files named', 'Found files named'],
      search_in_files: ['Searching code in',       'Searched code in'],
      run_command:     ['Running command',         'Ran command'],
      list_processes:  ['Listing processes',       'Listed processes'],
      stop_process:    ['Stopping process',        'Stopped process'],
      web_search:      ['Searching the web for',   'Searched the web for'],
      read_page:       ['Reading page',            'Read page'],
      extract_links:   ['Reading links from',      'Read links from']
    };

    // What to show after the verb. Most tools are about a path, but a search is
    // about its query and a web call is about its URL — showing "in <folder>"
    // for a query, or nothing at all, reads as though the tool did less.
    const TOOL_SUBJECT = {
      find_files:     ['query'],
      web_search:     ['query'],
      read_page:      ['url'],
      extract_links:  ['url'],
      run_command:    ['command'],
      stop_process:   ['id', 'match'],
      list_processes: []
    };
    const DEFAULT_SUBJECT = ['path', 'file', 'target_file', 'filepath', 'target'];

    function formatToolInfo(name, input, done) {
      const keys = TOOL_SUBJECT[name] || DEFAULT_SUBJECT;
      let raw = '';
      for (const key of keys) {
        if (input && input[key]) { raw = String(input[key]); break; }
      }

      // A path only becomes a clickable jump link when it really is a path.
      const filePath = (TOOL_SUBJECT[name] ? '' : raw);
      let displayPath = raw;

      if (filePath) {
        const parts = filePath.replace(/\\\\/g, '/').split('/');
        displayPath = parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
      } else if (raw) {
        // A bare host reads better than a truncated URL.
        const asUrl = raw.match(/^https?:\\/\\/([^/]+)/);
        displayPath = asUrl ? asUrl[1] : raw.slice(0, 48);
      }

      const pair = TOOL_VERBS[name];
      const verb = pair ? (done ? pair[1] : pair[0])
        : (done ? 'Used' : 'Running') + ' ' + name.replace(/_/g, ' ');

      // Only create clickable jump links for actual files (not folder operations)
      const isFileTool = ["read_file", "edit_file", "write_file", "create_item", "delete_item"].includes(name) || (filePath && filePath.includes('.'));
      const isFolderTool = ["list_folder", "find_files", "search_in_files"].includes(name);

      if (displayPath) {
        if (isFileTool && !isFolderTool) {
          return {
            verb,
            fileLabel: displayPath,
            fullPath: filePath,
            isClickable: true
          };
        } else {
          return {
            verb: \`\${verb} \${displayPath}\`,
            fileLabel: null,
            fullPath: null,
            isClickable: false
          };
        }
      }

      return {
        verb,
        fileLabel: null,
        fullPath: null,
        isClickable: false
      };
    }

    // marked dropped the "highlight" option in v5 — a custom renderer is the
    // supported way now. Renderer methods take a token object in modern marked
    // and positional args in old versions, so accept both shapes.
    const codeRenderer = new marked.Renderer();
    codeRenderer.code = function(tokenOrCode, maybeLang) {
      const isToken = tokenOrCode && typeof tokenOrCode === 'object';
      const source = isToken ? (tokenOrCode.text || '') : String(tokenOrCode || '');
      const requested = (isToken ? tokenOrCode.lang : maybeLang) || '';
      const lang = requested.split(/\\s+/)[0];

      let highlighted;
      let cssLang;
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(source, { language: lang }).value;
          cssLang = lang;
        } else {
          const auto = hljs.highlightAuto(source);
          highlighted = auto.value;
          cssLang = auto.language || 'plaintext';
        }
      } catch (e) {
        // Never let a highlighter failure swallow the code itself.
        highlighted = escapeHtml(source);
        cssLang = 'plaintext';
      }
      return '<pre><code class="hljs language-' + escapeHtml(cssLang) + '">' + highlighted + '</code></pre>';
    };
    marked.setOptions({ renderer: codeRenderer });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'stateUpdate') {
        const connected = msg.status.connected;
        statusDot.className = 'status-dot ' + (connected ? 'online' : '');
        offlineBanner.style.display = connected ? 'none' : 'flex';

        if (msg.models && msg.models.length > 0) {
          modelSelect.innerHTML = '';
          msg.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === msg.activeModel) opt.selected = true;
            modelSelect.appendChild(opt);
          });
        }
      } else if (msg.type === 'sessionsUpdate') {
        // A different thread means plan mode starts off again. This fires on
        // every stream flush too, so it has to key off the id actually changing.
        if (msg.activeSessionId !== shownSessionId) {
          shownSessionId = msg.activeSessionId;
          setPlanMode(false);
        }
        renderHistoryMenu(msg.sessions || [], msg.activeSessionId);
        renderMessages(msg.messages || []);
      } else if (msg.type === 'contextUpdate') {
        if (msg.activeFileRelative) {
          activeFilePath = msg.activeFilePath;
          activeFileChip.style.display = 'inline-flex';
          activeFileChip.innerHTML = SVG_ICONS.file + ' <span>' + escapeHtml(msg.activeFileRelative) + '</span>';
        } else {
          activeFileChip.style.display = 'none';
          activeFilePath = null;
        }
      } else if (msg.type === 'updateMessages') {
        renderMessages(msg.messages);
      } else if (msg.type === 'settingsUpdate') {
        settingsState = msg;
        renderSettings();
        renderSkills();
      } else if (msg.type === 'skillsUpdate') {
        skillsState = msg;
        rebuildSkillCommands(msg.skills);
        renderSkills();
      } else if (msg.type === 'fileResults') {
        // Ignore a stale reply: the user may have typed on while it was in flight.
        if (mentionToken !== null && msg.query === mentionToken) {
          renderFileMenu(msg.files);
        }
      } else if (msg.type === 'settingsTestResult') {
        testResults[msg.keyId] = { ok: msg.ok, message: msg.message };
        renderProviders();
      }
    });

    function renderHistoryMenu(sessions, activeId) {
      historyMenu.innerHTML = '';
      const active = sessions.find(s => s.id === activeId);
      if (active) {
        sessionTitle.textContent = active.title || 'Untitled';
      } else {
        sessionTitle.textContent = 'New Chat';
      }

      sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'history-item ' + (s.id === activeId ? 'active' : '');
        item.innerHTML = \`
          <span>\${escapeHtml(s.title || 'Untitled')}</span>
          <span style="font-size:0.68rem; opacity:0.6">\${new Date(s.updatedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
        \`;
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'switchSession', sessionId: s.id });
          historyMenu.style.display = 'none';
        });
        historyMenu.appendChild(item);
      });
    }

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      historyMenu.style.display = historyMenu.style.display === 'flex' ? 'none' : 'flex';
    });

    document.addEventListener('click', (e) => {
      if (!historyBtn.contains(e.target) && !historyMenu.contains(e.target)) {
        historyMenu.style.display = 'none';
      }
      if (!slashPopover.contains(e.target) && !slashBtn.contains(e.target)) {
        hideSlashMenu();
      }
      if (!filePopover.contains(e.target) && e.target !== promptInput) {
        hideFileMenu();
      }
    });

    modelSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        vscode.postMessage({ type: 'selectModel', modelId: e.target.value });
      }
    });

    newSessionBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    settingsBtn.addEventListener('click', () => {
      settingsAction('load');
      settingsModal.classList.add('open');
    });

    openSettingsBtn.addEventListener('click', () => {
      settingsAction('load');
      settingsModal.classList.add('open');
      document.querySelector('.modal-tab[data-pane="providers"]').click();
    });

    activeFileChip.addEventListener('click', () => {
      if (activeFilePath) {
        vscode.postMessage({ type: 'openFile', path: activeFilePath });
      }
    });

    sendBtn.addEventListener('click', () => {
      if (isCurrentlyStreaming) {
        vscode.postMessage({ type: 'stopGeneration' });
      } else {
        sendMessage();
      }
    });

    function updateSendBtnState(streaming) {
      isCurrentlyStreaming = streaming;
      if (streaming) {
        sendBtn.innerHTML = SVG_ICONS.stop;
        sendBtn.classList.add('stop-mode');
        sendBtn.title = 'Stop Generation';
      } else {
        sendBtn.innerHTML = SVG_ICONS.arrowUp;
        sendBtn.classList.remove('stop-mode');
        sendBtn.title = 'Send Message';
      }
    }

    // Slash Commands Handling
    slashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slashPopover.style.display === 'flex') {
        hideSlashMenu();
        if (promptInput.value === '/') {
          promptInput.value = '';
        }
      } else {
        promptInput.value = '/';
        promptInput.focus();
        showSlashMenu('');
      }
    });

    // ── @-mention file attachments ──────────────────────────────────
    let attachedFiles = [];   // [{ path, label }]
    let mentionToken = null;  // the "@query" currently being typed, if any

    function currentMention() {
      // Only the @-token immediately before the caret counts, so an email
      // address earlier in the message doesn't reopen the picker.
      const upToCaret = promptInput.value.slice(0, promptInput.selectionStart);
      const match = upToCaret.match(/(?:^|\\s)@([^\\s@]*)$/);
      return match ? match[1] : null;
    }

    function renderAttachChips() {
      attachChips.innerHTML = '';
      attachedFiles.forEach(file => {
        const chip = document.createElement('span');
        chip.className = 'active-file-chip';
        chip.style.display = 'inline-flex';
        chip.title = 'Attached: ' + file.path + ' (click to remove)';
        chip.innerHTML = SVG_ICONS.file + ' <span></span>';
        chip.querySelector('span').textContent = file.label;
        chip.addEventListener('click', () => {
          attachedFiles = attachedFiles.filter(f => f.path !== file.path);
          renderAttachChips();
        });
        attachChips.appendChild(chip);
      });
    }

    function hideFileMenu() {
      filePopover.style.display = 'none';
      mentionToken = null;
    }

    function renderFileMenu(files) {
      fileList.innerHTML = '';
      if (!files || files.length === 0) {
        hideFileMenu();
        return;
      }
      files.forEach((file, idx) => {
        const item = document.createElement('div');
        item.className = 'slash-item ' + (idx === 0 ? 'selected' : '');
        const name = document.createElement('span');
        name.className = 'cmd-name';
        name.textContent = file.label.split(/[\\\\/]/).pop();
        const desc = document.createElement('span');
        desc.className = 'cmd-desc';
        desc.textContent = file.label;
        item.appendChild(name);
        item.appendChild(desc);
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          attachFile(file);
        });
        fileList.appendChild(item);
      });
      filePopover.style.display = 'flex';
    }

    function attachFile(file) {
      // Drop the "@query" the user was typing — the chip replaces it.
      const caret = promptInput.selectionStart;
      const before = promptInput.value.slice(0, caret).replace(/(^|\\s)@[^\\s@]*$/, '$1');
      const after = promptInput.value.slice(caret);
      promptInput.value = before + after;
      promptInput.selectionStart = promptInput.selectionEnd = before.length;

      if (!attachedFiles.some(f => f.path === file.path)) {
        attachedFiles.push(file);
        renderAttachChips();
      }
      hideFileMenu();
      promptInput.focus();
    }

    promptInput.addEventListener('input', (e) => {
      const val = promptInput.value;
      if (val.startsWith('/')) {
        hideFileMenu();
        showSlashMenu(val.slice(1).toLowerCase());
        return;
      }
      hideSlashMenu();

      const mention = currentMention();
      if (mention === null) {
        hideFileMenu();
      } else {
        mentionToken = mention;
        vscode.postMessage({ type: 'searchFiles', query: mention });
      }
    });

    promptInput.addEventListener('keydown', (e) => {
      if (filePopover.style.display === 'flex') {
        const items = fileList.querySelectorAll('.slash-item');
        let selectedIdx = -1;
        items.forEach((item, idx) => {
          if (item.classList.contains('selected')) selectedIdx = idx;
        });

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const nextIdx = (selectedIdx + step + items.length) % items.length;
          items.forEach(i => i.classList.remove('selected'));
          items[nextIdx]?.classList.add('selected');
          items[nextIdx]?.scrollIntoView({ block: 'nearest' });
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const active = fileList.querySelector('.slash-item.selected') || items[0];
          if (active) {
            active.click();
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideFileMenu();
          return;
        }
      }

      if (slashPopover.style.display === 'flex') {
        const items = slashList.querySelectorAll('.slash-item');
        let selectedIdx = -1;
        items.forEach((item, idx) => {
          if (item.classList.contains('selected')) selectedIdx = idx;
        });

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const nextIdx = (selectedIdx + 1) % items.length;
          items.forEach(i => i.classList.remove('selected'));
          items[nextIdx]?.classList.add('selected');
          items[nextIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prevIdx = (selectedIdx - 1 + items.length) % items.length;
          items.forEach(i => i.classList.remove('selected'));
          items[prevIdx]?.classList.add('selected');
          items[prevIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const activeItem = slashList.querySelector('.slash-item.selected') || items[0];
          if (activeItem) {
            const cmd = activeItem.getAttribute('data-cmd');
            executeSlashCmd(cmd);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideSlashMenu();
          if (promptInput.value === '/') {
            promptInput.value = '';
          }
        }
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isCurrentlyStreaming) {
          sendMessage();
        }
      }
    });

    // Every discovered skill is also a slash command, so /<skill> pins it to the
    // next message whatever its configured mode is.
    const skillChips = document.getElementById('skillChips');
    let pinnedSkills = [];
    let skillCommands = [];

    function rebuildSkillCommands(skills) {
      skillCommands = (skills || []).map(s => ({
        cmd: '/' + s.name,
        desc: s.description || 'Skill',
        skill: s.name,
        prompt: s.prompt || ''
      }));
    }

    function skillPromptFor(name) {
      const hit = skillCommands.find(c => c.skill === name);
      return hit ? hit.prompt : '';
    }

    function renderSkillChips() {
      skillChips.innerHTML = '';
      pinnedSkills.forEach(name => {
        const chip = document.createElement('span');
        chip.className = 'skill-chip';
        chip.title = 'Skill "' + name + '" will be applied (click to remove)';
        chip.textContent = '/' + name;
        chip.addEventListener('click', () => {
          pinnedSkills = pinnedSkills.filter(n => n !== name);
          renderSkillChips();
        });
        skillChips.appendChild(chip);
      });
    }

    function pinSkill(name) {
      if (!pinnedSkills.includes(name)) {
        pinnedSkills.push(name);
        renderSkillChips();
      }
    }

    function skillCommandFor(token) {
      const wanted = token.toLowerCase();
      const hit = skillCommands.find(c => c.cmd.toLowerCase() === wanted);
      return hit ? hit.skill : null;
    }

    function showSlashMenu(filter) {
      slashList.innerHTML = '';
      const all = SLASH_COMMANDS.concat(skillCommands);
      const matched = all.filter(c => c.cmd.slice(1).toLowerCase().includes(filter));

      if (matched.length === 0) {
        hideSlashMenu();
        return;
      }

      matched.forEach((c, idx) => {
        const item = document.createElement('div');
        item.className = 'slash-item ' + (idx === 0 ? 'selected' : '');
        item.setAttribute('data-cmd', c.cmd);
        item.title = c.cmd + ' — ' + c.desc;

        // textContent, not innerHTML: skill names and descriptions come from
        // files on disk and must never be parsed as markup in the webview.
        const name = document.createElement('span');
        name.className = 'cmd-name';
        name.textContent = c.cmd;
        const desc = document.createElement('span');
        desc.className = 'cmd-desc';
        desc.textContent = c.desc;
        item.appendChild(name);
        item.appendChild(desc);

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          executeSlashCmd(c.cmd);
        });
        slashList.appendChild(item);
      });

      slashPopover.style.display = 'flex';
    }

    function hideSlashMenu() {
      slashPopover.style.display = 'none';
    }

    function executeSlashCmd(cmd) {
      hideSlashMenu();

      // Picking a skill runs it right away, like the built-in commands. Anything
      // already typed after the command travels with it as the request.
      const skill = skillCommandFor(cmd);
      if (skill) {
        pinSkill(skill);
        promptInput.value = promptInput.value.replace(/^\\s*\\/[^\\s]*\\s?/, '');
        sendMessage();
        return;
      }

      promptInput.value = '';

      if (cmd === '/clear') {
        vscode.postMessage({ type: 'newSession' });
      } else if (cmd === '/help') {
        promptInput.value = 'What commands and tools are available in Infinity Coder?';
        sendMessage();
      } else if (cmd === '/explain') {
        promptInput.value = 'Read and explain the open code file or workspace in detail.';
        sendMessage();
      } else if (cmd === '/fix') {
        promptInput.value = 'Review the open code for potential bugs, security issues, and suggest fixes.';
        sendMessage();
      } else if (cmd === '/tests') {
        promptInput.value = 'Generate comprehensive unit tests for the current code.';
        sendMessage();
      } else if (cmd === '/refactor') {
        promptInput.value = 'Refactor the current code for better performance, readability, and modern standards.';
        sendMessage();
      }
    }

    function sendMessage() {
      let text = promptInput.value.trim();

      // "/ponytail fix this bug" — pin the skill, send the rest. Typed directly,
      // without ever opening the menu.
      while (text.startsWith('/')) {
        const firstWord = text.split(/\\s/)[0];
        const skill = skillCommandFor(firstWord);
        if (!skill) { break; }
        pinSkill(skill);
        text = text.slice(firstWord.length).trim();
      }

      // A skill invoked on its own still runs. A bare "run this skill" leaves the
      // model with no target though — a review skill will sit there wondering
      // what to review — so the request has to say where to get its input.
      // A skill can declare that itself with a "prompt:" in its frontmatter;
      // otherwise the fallback tells the model to go and find it.
      if (!text && pinnedSkills.length > 0) {
        const declared = pinnedSkills.map(skillPromptFor).filter(p => p);
        if (declared.length > 0) {
          text = declared.join(' ');
        } else {
          const names = pinnedSkills.map(n => '"' + n + '"');
          text = 'Apply the ' + names.join(' and ') + ' skill' +
            (pinnedSkills.length > 1 ? 's' : '') + ' now, following the instructions ' +
            'exactly. Work out what to apply them to yourself — the uncommitted ' +
            'changes, the file I have open, or the project — using your tools to ' +
            'gather whatever they need. Do not ask me what to look at; decide and go.';
        }
      }

      if (!text) return;

      if (text.startsWith('/')) {
        executeSlashCmd(text.split(' ')[0]);
        return;
      }

      vscode.postMessage({
        type: 'sendMessage',
        text,
        model: modelSelect.value,
        attachments: attachedFiles.map(f => f.path),
        skills: pinnedSkills.slice(),
        planMode
      });
      promptInput.value = '';
      attachedFiles = [];
      pinnedSkills = [];
      renderAttachChips();
      renderSkillChips();
      hideFileMenu();
    }

    function renderMessages(messages) {
      if (!messages || messages.length === 0) {
        landingView.style.display = 'flex';
        messagesContainer.style.display = 'none';
        messagesContainer.innerHTML = '';
        updateSendBtnState(false);
        updateStreamStatus([]);
        return;
      }

      landingView.style.display = 'none';
      messagesContainer.style.display = 'flex';
      messagesContainer.innerHTML = '';

      let hasActiveStream = false;

      messages.forEach(m => {
        if (m.streaming) {
          hasActiveStream = true;
        }

        const div = document.createElement('div');
        div.className = 'msg ' + m.role;

        // Render author label ONLY for assistant messages
        if (m.role === 'assistant') {
          const author = document.createElement('div');
          author.className = 'msg-author';
          let authorHtml = 'Infinity Coder';
          if (m.streaming) {
            authorHtml += \` <span class="pulse-loader"><span class="pulse-dot"></span><span class="pulse-dot"></span><span class="pulse-dot"></span></span>\`;
          }
          author.innerHTML = authorHtml;
          div.appendChild(author);
        }

        // Render Chronological Message Blocks if available
        if (m.blocks && m.blocks.length > 0) {
          m.blocks.forEach(block => {
            if (block.type === 'reasoning' && block.text) {
              const details = document.createElement('details');
              details.className = 'thinking';
              details.innerHTML = \`<summary>Thinking Process</summary><div class="thinking-body">\${escapeHtml(block.text)}</div>\`;
              div.appendChild(details);
            } else if (block.type === 'tool') {
              const toolItem = document.createElement('div');
              toolItem.className = 'tool-indicator ' + (block.done ? 'done' : 'running');
              const iconHtml = block.done ? SVG_ICONS.check : SVG_ICONS.spinner;
              const info = formatToolInfo(block.name, block.input, block.done);

              let labelHtml = escapeHtml(info.verb) + (block.done ? '' : '...');
              if (info.fileLabel && info.isClickable) {
                labelHtml += \` <span class="file-jump-link" data-path="\${escapeHtml(info.fullPath)}">\${escapeHtml(info.fileLabel)}</span>\`;
              }

              toolItem.innerHTML = iconHtml + '<span>' + labelHtml + '</span>';

              toolItem.querySelectorAll('.file-jump-link').forEach(link => {
                link.addEventListener('click', (e) => {
                  e.stopPropagation();
                  const path = link.getAttribute('data-path');
                  if (path) {
                    vscode.postMessage({ type: 'openFile', path });
                  }
                });
              });

              div.appendChild(toolItem);
            } else if (block.type === 'approval' && block.approval) {
              div.appendChild(renderApproval(block.approval));
            } else if (block.type === 'text' && block.text) {
              const bodyDiv = document.createElement('div');
              bodyDiv.className = 'text-block';
              bodyDiv.innerHTML = marked.parse(block.text || '');

              bodyDiv.querySelectorAll('pre code').forEach(codeBlock => {
                const pre = codeBlock.parentElement;
                const codeText = codeBlock.textContent;
                const lang = codeBlock.className.replace('language-', '') || 'code';

                const header = document.createElement('div');
                header.className = 'code-header';
                header.innerHTML = \`
                  <span>\${escapeHtml(lang)}</span>
                  <div class="code-actions">
                    <button class="btn-code copy-btn">Copy</button>
                    <button class="btn-code insert-btn">Insert</button>
                    <button class="btn-code replace-btn">Replace</button>
                  </div>
                \`;

                header.querySelector('.copy-btn').addEventListener('click', (e) => {
                  const btn = e.target;
                  vscode.postMessage({ type: 'copyText', text: codeText });
                  btn.textContent = 'Copied!';
                  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
                });
                header.querySelector('.insert-btn').addEventListener('click', (e) => {
                  const btn = e.target;
                  vscode.postMessage({ type: 'insertCode', code: codeText });
                  btn.textContent = 'Inserted!';
                  setTimeout(() => { btn.textContent = 'Insert'; }, 1500);
                });
                header.querySelector('.replace-btn').addEventListener('click', (e) => {
                  const btn = e.target;
                  vscode.postMessage({ type: 'replaceCode', code: codeText });
                  btn.textContent = 'Replaced!';
                  setTimeout(() => { btn.textContent = 'Replace'; }, 1500);
                });

                pre.insertBefore(header, codeBlock);
              });

              div.appendChild(bodyDiv);
            }
          });
        } else {
          // Fallback for legacy messages without blocks array
          if (m.reasoning) {
            const details = document.createElement('details');
            details.className = 'thinking';
            details.innerHTML = \`<summary>Thinking Process</summary><div class="thinking-body">\${escapeHtml(m.reasoning)}</div>\`;
            div.appendChild(details);
          }

          if (m.toolEvents && m.toolEvents.length > 0) {
            const toolGroups = [];
            m.toolEvents.forEach(te => {
              if (te.type === 'tool_call') {
                toolGroups.push({ name: te.name, input: te.input, result: null, done: false });
              } else if (te.type === 'tool_result') {
                const pending = toolGroups.slice().reverse().find(g => g.name === te.name && !g.done);
                if (pending) {
                  pending.result = te.result;
                  pending.done = true;
                } else {
                  toolGroups.push({ name: te.name, input: null, result: te.result, done: true });
                }
              }
            });

            toolGroups.forEach(tg => {
              const toolItem = document.createElement('div');
              toolItem.className = 'tool-indicator ' + (tg.done ? 'done' : 'running');
              const iconHtml = tg.done ? SVG_ICONS.check : SVG_ICONS.spinner;
              const info = formatToolInfo(tg.name, tg.input, tg.done);

              let labelHtml = escapeHtml(info.verb) + (tg.done ? '' : '...');
              if (info.fileLabel && info.isClickable) {
                labelHtml += \` <span class="file-jump-link" data-path="\${escapeHtml(info.fullPath)}">\${escapeHtml(info.fileLabel)}</span>\`;
              }

              toolItem.innerHTML = iconHtml + '<span>' + labelHtml + '</span>';

              toolItem.querySelectorAll('.file-jump-link').forEach(link => {
                link.addEventListener('click', (e) => {
                  e.stopPropagation();
                  const path = link.getAttribute('data-path');
                  if (path) {
                    vscode.postMessage({ type: 'openFile', path });
                  }
                });
              });

              div.appendChild(toolItem);
            });
          }

          if (m.content) {
            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'text-block';
            bodyDiv.innerHTML = marked.parse(m.content || '');

            bodyDiv.querySelectorAll('pre code').forEach(codeBlock => {
              const pre = codeBlock.parentElement;
              const codeText = codeBlock.textContent;
              const lang = codeBlock.className.replace('language-', '') || 'code';

              const header = document.createElement('div');
              header.className = 'code-header';
              header.innerHTML = \`
                <span>\${escapeHtml(lang)}</span>
                <div class="code-actions">
                  <button class="btn-code copy-btn">Copy</button>
                  <button class="btn-code insert-btn">Insert</button>
                  <button class="btn-code replace-btn">Replace</button>
                </div>
              \`;

              header.querySelector('.copy-btn').addEventListener('click', (e) => {
                const btn = e.target;
                vscode.postMessage({ type: 'copyText', text: codeText });
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
              });
              header.querySelector('.insert-btn').addEventListener('click', (e) => {
                const btn = e.target;
                vscode.postMessage({ type: 'insertCode', code: codeText });
                btn.textContent = 'Inserted!';
                setTimeout(() => { btn.textContent = 'Insert'; }, 1500);
              });
              header.querySelector('.replace-btn').addEventListener('click', (e) => {
                const btn = e.target;
                vscode.postMessage({ type: 'replaceCode', code: codeText });
                btn.textContent = 'Replaced!';
                setTimeout(() => { btn.textContent = 'Replace'; }, 1500);
              });

              pre.insertBefore(header, codeBlock);
            });

            div.appendChild(bodyDiv);
          }
        }

        // Failover notices ("X rate-limited — retrying on Y"). These were being
        // captured and then never shown.
        (m.notices || []).forEach(text => {
          const note = document.createElement('div');
          note.className = 'msg-notice';
          note.textContent = text;
          div.appendChild(note);
        });

        // If streaming and no text/tool blocks are present yet, render thinking loader
        if (m.streaming && (!m.blocks || m.blocks.length === 0)) {
          const loader = document.createElement('div');
          loader.className = 'thinking-loader';
          loader.innerHTML = SVG_ICONS.spinner + ' <span>Thinking...</span>';
          div.appendChild(loader);
        }

        if (m.plan && !m.streaming) {
          div.appendChild(renderPlanActions(m));
        }

        if (m.usage && !m.streaming) {
          div.appendChild(renderUsage(m.usage));
        }

        messagesContainer.appendChild(div);
      });

      updateSendBtnState(hasActiveStream);
      updateStreamStatus(messages);
      mainContent.scrollTop = mainContent.scrollHeight;
    }

    // ── Plan mode ────────────────────────────────────────────────────
    // On until the user turns it off or approves a plan, and reset whenever the
    // thread changes: carrying it into a different chat silently would make the
    // next message do nothing anyone asked for.
    let planMode = false;
    let shownSessionId = null;

    function setPlanMode(on) {
      planMode = !!on;
      planToggle.classList.toggle('on', planMode);
      planToggle.setAttribute('aria-pressed', planMode ? 'true' : 'false');
      promptInput.placeholder = planMode
        ? 'Plan mode — describe the task, nothing will be changed...'
        : 'ctrl esc to focus or ask Infinity Coder...';
    }

    planToggle.addEventListener('click', () => setPlanMode(!planMode));

    // Answered locally the moment it is clicked, for the same reason approvals
    // are: the buttons must stop looking clickable without waiting for a
    // round-trip, and approving starts a whole turn.
    const answeredPlans = {};

    function renderPlanActions(m) {
      const status = answeredPlans[m.id] || m.plan;

      if (status !== 'pending') {
        const done = document.createElement('div');
        done.className = 'plan-answered';
        done.textContent = status === 'approved' ? 'Plan approved.' : 'Plan dismissed.';
        return done;
      }

      const bar = document.createElement('div');
      bar.className = 'plan-actions';

      const answer = (choice) => {
        answeredPlans[m.id] = choice === 'approve' ? 'approved' : 'dismissed';
        bar.querySelectorAll('button').forEach(b => { b.disabled = true; });
        if (choice === 'approve') { setPlanMode(false); }
        vscode.postMessage({ type: 'planResponse', id: m.id, choice });
      };

      const approve = document.createElement('button');
      approve.className = 'plan-btn primary';
      approve.textContent = 'Approve & build';
      approve.addEventListener('click', () => answer('approve'));
      bar.appendChild(approve);

      // Not a rejection: it hands the plan back to the input so the user can say
      // what to change, with plan mode still on so the revision is also a plan.
      const edit = document.createElement('button');
      edit.className = 'plan-btn';
      edit.textContent = 'Change something';
      edit.addEventListener('click', () => {
        promptInput.value = 'Revise the plan: ';
        promptInput.focus();
        promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
      });
      bar.appendChild(edit);

      const dismiss = document.createElement('button');
      dismiss.className = 'plan-btn';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => answer('dismiss'));
      bar.appendChild(dismiss);

      return bar;
    }

    // ── Inline change approval ───────────────────────────────────────
    // Rendered in the thread rather than as a native modal: a modal takes focus
    // away from the panel you are reading, and it cannot carry a "do this
    // instead" reply back to the model.
    // What the user answered, remembered here in the webview. The extension is
    // still the source of truth, but the card must never sit there looking
    // clickable after a click — if the round-trip is lost or slow for any
    // reason, this local record still resolves it.
    const answeredApprovals = {};

    function renderApproval(a) {
      const status = answeredApprovals[a.id] || a.status;
      const feedbackShown = a.feedback || (answeredApprovals[a.id + ':note'] || '');

      const card = document.createElement('div');
      card.className = 'approval' + (status === 'pending' ? '' : ' resolved');

      const title = document.createElement('div');
      title.className = 'approval-title';
      const verbs = { write: 'change', edit: 'change', delete: 'delete' };
      title.textContent = 'Infinity Coder wants to ' + (verbs[a.kind] || 'change') + ' ' +
        a.relPath.split(/[\\\\/]/).pop();
      card.appendChild(title);

      const pathRow = document.createElement('div');
      pathRow.className = 'approval-path';
      const pathText = document.createElement('span');
      pathText.style.flex = '1';
      pathText.style.minWidth = '0';
      pathText.textContent = a.relPath;
      pathRow.appendChild(pathText);

      if (a.kind !== 'delete') {
        const stat = document.createElement('span');
        stat.className = 'approval-stat';
        stat.innerHTML = '<span class="add">+' + a.added + '</span> <span class="del">-' + a.removed + '</span>';
        pathRow.appendChild(stat);

        const view = document.createElement('button');
        view.className = 'approval-link';
        view.textContent = 'View diff';
        view.addEventListener('click', () => vscode.postMessage({ type: 'viewDiff', id: a.id }));
        pathRow.appendChild(view);
      }
      card.appendChild(pathRow);

      if (status !== 'pending') {
        const verdict = document.createElement('div');
        verdict.className = 'approval-verdict ' + status;
        verdict.innerHTML = (status === 'applied' ? SVG_ICONS.check : '') +
          '<span></span>';
        verdict.querySelector('span').textContent =
          status === 'applied' ? 'Applied'
          : status === 'expired' ? 'Not answered — the turn had already ended'
          : 'Rejected';
        card.appendChild(verdict);

        if (feedbackShown) {
          const quote = document.createElement('div');
          quote.className = 'approval-quote';
          quote.textContent = feedbackShown;
          card.appendChild(quote);
        }
        return card;
      }

      const actions = document.createElement('div');
      actions.className = 'approval-actions';

      const feedback = document.createElement('input');
      feedback.type = 'text';
      feedback.className = 'approval-feedback';
      feedback.placeholder = 'Tell Infinity Coder what to do instead…';

      const respond = (choice) => {
        // Record and redraw FIRST, so the card acknowledges the click whatever
        // happens to the message. A second click on a card already answered is
        // ignored rather than sent again.
        if (answeredApprovals[a.id]) { return; }
        const note = choice === 'reject' ? feedback.value : '';
        answeredApprovals[a.id] = choice === 'reject' ? 'rejected' : 'applied';
        if (note) { answeredApprovals[a.id + ':note'] = note; }

        const settled = renderApproval(a);
        if (card.parentNode) {
          card.parentNode.replaceChild(settled, card);
        }

        vscode.postMessage({
          type: 'approvalResponse',
          id: a.id,
          choice,
          feedback: note
        });
      };

      [
        ['1', 'Yes', 'apply'],
        ['2', 'Yes, and don\\'t ask again this turn', 'applyAll'],
        ['3', 'No', 'reject']
      ].forEach(([key, label, choice]) => {
        const btn = document.createElement('button');
        btn.className = 'approval-opt';
        btn.innerHTML = '<span class="key"></span><span></span>';
        btn.querySelector('.key').textContent = key;
        btn.querySelectorAll('span')[1].textContent = label;
        btn.addEventListener('click', () => respond(choice));
        actions.appendChild(btn);
      });

      // Typing an instruction and pressing Enter is a reject that redirects.
      feedback.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          respond('reject');
        }
      });
      actions.appendChild(feedback);
      card.appendChild(actions);
      return card;
    }

    // ── Live activity strip ──────────────────────────────────────────
    // The per-message loader only appears before the first block arrives, and the
    // pulse beside the author name scrolls out of view on a long turn. This stays
    // pinned above the input for as long as the turn is running.
    const streamStatus = document.getElementById('streamStatus');
    const streamStatusIcon = document.getElementById('streamStatusIcon');
    const streamStatusLabel = document.getElementById('streamStatusLabel');
    const streamStatusTime = document.getElementById('streamStatusTime');
    streamStatusIcon.innerHTML = SVG_ICONS.spinner;

    let streamStartedAt = null;
    let streamTicker = null;

    document.getElementById('streamStatusStop').addEventListener('click', () => {
      vscode.postMessage({ type: 'stopGeneration' });
    });

    function streamActivity(m) {
      const blocks = m.blocks || [];
      const last = blocks[blocks.length - 1];
      if (!last) {
        return 'Thinking';
      }
      if (last.type === 'tool') {
        if (last.done) {
          return 'Thinking';
        }
        const info = formatToolInfo(last.name, last.input, false);
        return info.fileLabel ? info.verb + ' ' + info.fileLabel : info.verb;
      }
      if (last.type === 'text' && (last.text || '').trim()) {
        return 'Writing response';
      }
      return 'Thinking';
    }

    function paintStreamTime() {
      if (streamStartedAt === null) {
        streamStatusTime.textContent = '';
        return;
      }
      const secs = Math.floor((Date.now() - streamStartedAt) / 1000);
      streamStatusTime.textContent =
        secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    }

    function updateStreamStatus(messages) {
      const active = (messages || []).find(m => m.streaming);

      if (!active) {
        streamStatus.style.display = 'none';
        streamStartedAt = null;
        if (streamTicker) {
          clearInterval(streamTicker);
          streamTicker = null;
        }
        return;
      }

      if (streamStartedAt === null) {
        // Count from when this turn started, not from when the panel re-rendered.
        streamStartedAt = active.createdAt || Date.now();
        streamTicker = setInterval(paintStreamTime, 1000);
      }
      streamStatus.style.display = 'flex';
      streamStatusLabel.textContent = streamActivity(active);
      paintStreamTime();
    }

    function renderUsage(usage) {
      const used = usage.promptTokens + usage.completionTokens;
      const limit = usage.contextLimit || 0;
      const pct = limit > 0 ? Math.min(100, Math.round((usage.promptTokens / limit) * 100)) : 0;

      const wrap = document.createElement('div');
      wrap.className = 'usage-bar' + (pct >= 80 ? ' hot' : '');
      wrap.title =
        (usage.estimated ? 'Estimated — this provider did not report usage.\\n' : '') +
        'Prompt: ' + usage.promptTokens.toLocaleString() + ' tokens\\n' +
        'Reply: ' + usage.completionTokens.toLocaleString() + ' tokens\\n' +
        'Context budget: ' + limit.toLocaleString() + ' (set in Settings > Models)';

      const meter = document.createElement('span');
      meter.className = 'usage-meter';
      const fill = document.createElement('span');
      fill.style.width = pct + '%';
      meter.appendChild(fill);

      const label = document.createElement('span');
      const prefix = usage.estimated ? '≈' : '';
      label.textContent =
        prefix + used.toLocaleString() + ' tokens' + (limit > 0 ? ' · context ' + pct + '%' : '');

      wrap.appendChild(meter);
      wrap.appendChild(label);
      return wrap;
    }

    // ── Settings Modal ───────────────────────────────────────────────
    const settingsModal = document.getElementById('settingsModal');
    const providerList = document.getElementById('providerList');
    const toolGroupList = document.getElementById('toolGroupList');
    const modelOptions = document.getElementById('modelOptions');
    const modelDiscoverHint = document.getElementById('modelDiscoverHint');
    const activeModelInput = document.getElementById('activeModelInput');
    const boostModelInput = document.getElementById('boostModelInput');
    const temperatureInput = document.getElementById('temperatureInput');
    const maxTokensInput = document.getElementById('maxTokensInput');
    const maxContextInput = document.getElementById('maxContextInput');
    const maxRoundsInput = document.getElementById('maxRoundsInput');
    const approvalSelect = document.getElementById('approvalSelect');

    let settingsState = null;
    const testResults = {};   // keyId -> { ok, message }

    function settingsAction(action, payload) {
      vscode.postMessage(Object.assign({ type: 'settings', action: action }, payload || {}));
    }

    function closeSettings() {
      settingsModal.classList.remove('open');
    }

    function smallBtn(label, onClick, extra) {
      const b = document.createElement('button');
      b.className = 'btn-sm' + (extra ? ' ' + extra : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    function iconBtn(glyph, title, onClick, extra) {
      const b = smallBtn(glyph, onClick, extra);
      b.title = title;
      b.style.padding = '3px 5px';
      return b;
    }

    document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);

    document.getElementById('settingsCancelBtn').addEventListener('click', () => {
      settingsAction('load');   // discard unsaved form edits
      closeSettings();
    });

    document.getElementById('settingsSaveBtn').addEventListener('click', () => {
      settingsAction('save', {
        patch: {
          activeModel: activeModelInput.value.trim(),
          boostModel: boostModelInput.value.trim(),
          temperature: parseFloat(temperatureInput.value) || 0.7,
          maxTokens: parseInt(maxTokensInput.value, 10) || 4096,
          maxContextTokens: parseInt(maxContextInput.value, 10) || 128000,
          maxToolRounds: parseInt(maxRoundsInput.value, 10) || 100,
          toolGroups: readToolGroups(),
          approvalMode: approvalSelect.value
        }
      });
      closeSettings();
    });

    document.querySelectorAll('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.modal-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('pane-' + tab.dataset.pane).classList.add('active');
      });
    });

    document.getElementById('addProviderBtn').addEventListener('click', () => {
      settingsAction('addProviderPrompt');   // extension side shows the input boxes
    });

    function renderProviders() {
      providerList.innerHTML = '';
      const providers = settingsState.settings.providers;

      providers.forEach((p, idx) => {
        const card = document.createElement('div');
        card.className = 'prov-card' + (p.enabled ? '' : ' disabled');

        const head = document.createElement('div');
        head.className = 'prov-head';

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'toggle';
        toggle.checked = p.enabled;
        toggle.title = 'Enable this provider';
        toggle.addEventListener('change', () => {
          settingsAction('updateProvider', { providerId: p.id, patch: { enabled: toggle.checked } });
        });

        const name = document.createElement('span');
        name.className = 'prov-name';
        name.textContent = p.name;

        head.appendChild(toggle);
        head.appendChild(name);
        if (idx > 0) {
          head.appendChild(iconBtn('↑', 'Move up (earlier in failover)', () => {
            settingsAction('moveProvider', { providerId: p.id, delta: -1 });
          }));
        }
        if (idx < providers.length - 1) {
          head.appendChild(iconBtn('↓', 'Move down', () => {
            settingsAction('moveProvider', { providerId: p.id, delta: 1 });
          }));
        }
        if (p.id.indexOf('custom-') === 0) {
          head.appendChild(iconBtn('✕', 'Remove provider', () => {
            settingsAction('removeProvider', { providerId: p.id });
          }, 'danger'));
        }
        card.appendChild(head);

        const urlField = document.createElement('div');
        urlField.className = 'field';
        const urlLabel = document.createElement('label');
        urlLabel.textContent = 'Base URL';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.value = p.baseUrl;
        urlInput.spellcheck = false;
        urlInput.addEventListener('change', () => {
          settingsAction('updateProvider', { providerId: p.id, patch: { baseUrl: urlInput.value.trim() } });
        });
        urlField.appendChild(urlLabel);
        urlField.appendChild(urlInput);
        card.appendChild(urlField);

        p.keys.forEach((k, ki) => {
          const row = document.createElement('div');
          row.className = 'key-row';

          const mask = document.createElement('span');
          mask.className = 'key-mask';
          mask.textContent = '••••••••' + k.last4;
          row.appendChild(mask);

          const tag = document.createElement('span');
          tag.className = 'key-tag';
          tag.textContent = ki === 0 ? 'primary' : 'fallback';
          row.appendChild(tag);

          const res = testResults[k.id];
          if (res) {
            const st = document.createElement('span');
            st.className = 'key-status ' + (res.ok ? 'ok' : 'bad');
            st.textContent = res.ok ? '✓' : '✗';
            st.title = res.message;
            row.appendChild(st);
          }

          row.appendChild(smallBtn('Test', () => {
            delete testResults[k.id];
            settingsAction('testKey', { providerId: p.id, keyId: k.id });
          }));
          if (ki > 0) {
            row.appendChild(iconBtn('↑', 'Try this key earlier', () => {
              settingsAction('moveKey', { providerId: p.id, keyId: k.id, delta: -1 });
            }));
          }
          row.appendChild(iconBtn('✕', 'Delete key', () => {
            settingsAction('removeKey', { providerId: p.id, keyId: k.id });
          }, 'danger'));

          card.appendChild(row);
        });

        const addRow = document.createElement('div');
        addRow.className = 'key-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.spellcheck = false;
        keyInput.placeholder = p.keys.length ? 'Paste a fallback key' : 'Paste API key';
        keyInput.style.cssText = 'flex:1;min-width:0;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 6px;font-size:0.68rem;font-family:inherit';
        const submitKey = () => {
          const value = keyInput.value.trim();
          if (!value) { return; }
          keyInput.value = '';
          settingsAction('addKey', { providerId: p.id, key: value });
        };
        keyInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); submitKey(); }
        });
        addRow.appendChild(keyInput);
        addRow.appendChild(smallBtn('Add', submitKey));
        card.appendChild(addRow);

        providerList.appendChild(card);
      });
    }

    function renderModelOptions() {
      // Static catalog plus anything a successful key Test discovered live, so
      // providers whose ids we don't hardcode still populate the dropdown.
      const seen = {};
      const entries = [];
      settingsState.catalog.forEach(m => {
        if (seen[m.id]) { return; }
        seen[m.id] = true;
        entries.push({ id: m.id, label: m.name + ' — ' + m.publisher });
      });
      let discoveredCount = 0;
      Object.keys(settingsState.discovered || {}).forEach(pid => {
        settingsState.discovered[pid].forEach(id => {
          if (seen[id]) { return; }
          seen[id] = true;
          discoveredCount++;
          entries.push({ id: id, label: pid });
        });
      });

      modelOptions.innerHTML = '';
      entries.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.label = e.label;
        modelOptions.appendChild(opt);
      });

      modelDiscoverHint.textContent = discoveredCount
        ? 'Type or pick. ' + discoveredCount + ' extra models discovered from your providers.'
        : 'Type or pick. Test a key in Providers to discover that endpoint’s models.';
    }

    function renderToolGroups() {
      toolGroupList.innerHTML = '';
      const labels = settingsState.toolGroupLabels || {};
      Object.keys(labels).forEach(group => {
        const row = document.createElement('label');
        row.className = 'check-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.group = group;
        box.checked = settingsState.settings.toolGroups[group] !== false;
        const text = document.createElement('span');
        text.textContent = labels[group];
        row.appendChild(box);
        row.appendChild(text);
        toolGroupList.appendChild(row);
      });
    }

    function readToolGroups() {
      const out = {};
      toolGroupList.querySelectorAll('input[type="checkbox"]').forEach(box => {
        out[box.dataset.group] = box.checked;
      });
      return out;
    }

    // ── Skills tab ───────────────────────────────────────────────────
    const skillList = document.getElementById('skillList');
    const skillRootList = document.getElementById('skillRootList');
    const skillBudget = document.getElementById('skillBudget');
    let skillsState = null;

    document.getElementById('addSkillRootBtn').addEventListener('click', () => {
      settingsAction('addSkillRoot');
    });
    document.getElementById('rescanSkillsBtn').addEventListener('click', () => {
      settingsAction('rescanSkills');
    });

    function renderSkills() {
      if (!skillsState) { return; }
      const skills = skillsState.skills || [];

      skillList.innerHTML = '';
      if (skills.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'skill-empty';
        empty.textContent =
          'No skills found. Create a folder with a SKILL.md inside one of the ' +
          'folders below, or add a folder that already has some.';
        skillList.appendChild(empty);
      }

      let alwaysCost = 0;
      skills.forEach(skill => {
        if (skill.mode === 'always') { alwaysCost += skill.tokens; }

        const row = document.createElement('div');
        row.className = 'skill-row' + (skill.mode === 'off' ? ' off' : '');

        const head = document.createElement('div');
        head.className = 'skill-head';

        const name = document.createElement('span');
        name.className = 'skill-name';
        name.textContent = skill.name;
        name.title = skill.file + ' (click to open)';
        name.style.cursor = 'pointer';
        name.addEventListener('click', () => {
          settingsAction('openSkillFile', { file: skill.file });
        });

        const cost = document.createElement('span');
        cost.className = 'skill-cost';
        cost.textContent = '~' + skill.tokens.toLocaleString() + ' tok';

        const mode = document.createElement('select');
        mode.className = 'skill-mode';
        [['always', 'Always'], ['auto', 'Auto'], ['off', 'Off']].forEach(pair => {
          const opt = document.createElement('option');
          opt.value = pair[0];
          opt.textContent = pair[1];
          if (pair[0] === skill.mode) { opt.selected = true; }
          mode.appendChild(opt);
        });
        mode.addEventListener('change', () => {
          settingsAction('setSkillMode', { name: skill.name, mode: mode.value });
        });

        head.appendChild(name);
        head.appendChild(cost);
        head.appendChild(mode);
        row.appendChild(head);

        if (skill.description) {
          const desc = document.createElement('div');
          desc.className = 'skill-desc';
          desc.textContent = skill.description;
          row.appendChild(desc);
        }
        skillList.appendChild(row);
      });

      // Always-on skills are paid for on every single request, so show the bill.
      const limit = settingsState ? settingsState.settings.maxContextTokens : 128000;
      const pct = limit > 0 ? Math.round((alwaysCost / limit) * 100) : 0;
      skillBudget.className = 'skill-budget' + (pct >= 10 ? ' hot' : '');
      skillBudget.textContent = alwaysCost === 0
        ? 'No always-on skills. Auto skills cost nothing until they match.'
        : 'Always-on: ~' + alwaysCost.toLocaleString() + ' tokens on every message (' + pct + '% of context).';

      skillRootList.innerHTML = '';
      (skillsState.roots || []).forEach(root => {
        const row = document.createElement('div');
        row.className = 'skill-root';
        const text = document.createElement('span');
        text.style.flex = '1';
        text.style.minWidth = '0';
        text.textContent = root;
        row.appendChild(text);
        row.appendChild(iconBtn('✕', 'Stop scanning this folder', () => {
          settingsAction('removeSkillRoot', { root: root });
        }, 'danger'));
        skillRootList.appendChild(row);
      });
    }

    function renderSettings() {
      if (!settingsState) { return; }
      const s = settingsState.settings;
      renderProviders();
      renderModelOptions();
      renderToolGroups();
      activeModelInput.value = s.activeModel || '';
      boostModelInput.value = s.boostModel || '';
      temperatureInput.value = s.temperature;
      maxTokensInput.value = s.maxTokens;
      maxContextInput.value = s.maxContextTokens;
      maxRoundsInput.value = s.maxToolRounds;
      approvalSelect.value = s.approvalMode || 'ask';
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}
