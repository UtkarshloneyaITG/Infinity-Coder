import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { walk, looksBinary } from '../engine/tools/common';
import { SettingsStore } from '../settings';
import { OpenAICompatibleEmbeddings } from './embeddings';
import { FlatFileVectorStore, IndexFullError } from './store';
import { chunkFile, languageFor, sha1, SymbolNode } from './chunker';
import { SemanticSearchEngine } from './search';
import {
  ALWAYS_EXCLUDED, Chunk, EmbeddingProvider, IndexProgress, IndexState, IndexStats, SymbolKind,
} from './types';

/**
 * Owns the index lifecycle: scan, chunk, embed, store, and keep it current.
 *
 * Two rules shape everything here.
 *
 * 1. Never re-embed unchanged work. Embeddings cost money and latency, so the
 *    file hash is checked before a file is read and the chunk hash before a
 *    chunk is sent. A no-op save costs one stat and one sha1.
 * 2. Never block the extension host. Every loop is chunked and every phase
 *    checks the cancellation token, so a 100k-file build stays interruptible.
 */

const MAX_FILE_BYTES = 1024 * 1024; // a 1MB source file is generated, not written
const EMBED_CONCURRENCY = 4;

export interface IndexManagerEvents {
  onState: (state: IndexState, detail?: string) => void;
  onProgress: (progress: IndexProgress) => void;
}

export class SemanticIndexManager implements vscode.Disposable {
  private store?: FlatFileVectorStore;
  private provider?: EmbeddingProvider;
  private engine?: SemanticSearchEngine;
  private watcher?: vscode.FileSystemWatcher;
  private state: IndexState = 'disabled';
  private lastError?: string;

  /** Coalesces a burst of saves into one update pass. */
  private pending = new Set<string>();
  private pendingTimer?: NodeJS.Timeout;
  private running?: vscode.CancellationTokenSource;

  private readonly emitter = new vscode.EventEmitter<IndexState>();
  public readonly onDidChangeState = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsStore,
    private readonly events: Partial<IndexManagerEvents> = {},
  ) {}

  public get currentState(): IndexState { return this.state; }
  public get error(): string | undefined { return this.lastError; }

  private setState(state: IndexState, detail?: string) {
    this.state = state;
    this.lastError = state === 'error' ? detail : undefined;
    this.events.onState?.(state, detail);
    this.emitter.fire(state);
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Index directory, one per workspace. Keyed by a hash of the absolute path so
   * two checkouts of the same repo never share (or corrupt) one index.
   */
  private get indexDir(): string {
    const root = this.workspaceRoot || 'no-workspace';
    return path.join(
      this.context.globalStorageUri.fsPath,
      'semantic-index',
      `${path.basename(root)}-${sha1(root).slice(0, 12)}`,
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────

  public async activate(): Promise<void> {
    const config = this.settings.get().semantic;
    if (!config.enabled) {
      this.setState('disabled');
      return;
    }
    try {
      await this.open();
      const stats = await this.store!.stats();
      this.setState(stats.chunks > 0 ? 'ready' : 'empty');
      if (config.autoUpdate) {
        this.startWatching();
      }
    } catch (e: any) {
      this.setState('error', e.message);
    }
  }

  /** Build the provider and store. Cheap and idempotent; no scanning happens here. */
  private async open(): Promise<void> {
    if (this.store && this.provider) {
      return;
    }
    const provider = await this.buildProvider();
    // The store needs a width before the first embedding exists. One probe call
    // settles it, and it doubles as an early check that the key actually works.
    if (provider.dimensions === 0) {
      await provider.embed('probe');
    }
    const store = new FlatFileVectorStore({
      directory: this.indexDir,
      dimensions: provider.dimensions,
      model: provider.model,
      maxChunks: this.settings.get().semantic.maxChunks,
    });
    await store.load();

    this.provider = provider;
    this.store = store;
    this.engine = new SemanticSearchEngine({
      store,
      provider,
      rankContext: () => ({ openFiles: this.openFiles() }),
    });
  }

  /**
   * An embedding provider from the user's configured credentials. Deliberately
   * the same providers and keys the chat uses — a second credential system for
   * embeddings would be a second thing to configure and a second thing to leak.
   */
  private async buildProvider(): Promise<EmbeddingProvider> {
    const settings = this.settings.get();
    const wanted = settings.semantic.providerId;
    const candidates = settings.providers.filter(
      p => p.enabled && p.keys.length > 0 && (!wanted || p.id === wanted),
    );
    for (const provider of candidates) {
      for (const meta of provider.keys) {
        const apiKey = await this.settings.getKey(meta.id);
        if (apiKey) {
          return new OpenAICompatibleEmbeddings({
            id: provider.id,
            baseUrl: provider.baseUrl,
            apiKey,
            model: settings.semantic.model,
          });
        }
      }
    }
    throw new Error(
      'Semantic indexing needs an API key. Add one under Settings → Keys, ' +
      'then run "Infinity: Build Semantic Index".',
    );
  }

  private openFiles(): Set<string> {
    const root = this.workspaceRoot;
    if (!root) {
      return new Set();
    }
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = (tab.input as any)?.uri as vscode.Uri | undefined;
        if (uri?.fsPath.startsWith(root)) {
          open.add(toRelative(root, uri.fsPath));
        }
      }
    }
    return open;
  }

  public get search(): SemanticSearchEngine | undefined { return this.engine; }

  // ── building ─────────────────────────────────────────────────────

  /**
   * Full build. `force` re-embeds everything; without it, files whose hash is
   * unchanged are skipped, which is what makes this safe to run repeatedly.
   */
  public async build(force = false): Promise<IndexStats | undefined> {
    const root = this.workspaceRoot;
    if (!root) {
      vscode.window.showWarningMessage('Open a folder before building the semantic index.');
      return undefined;
    }
    if (this.running) {
      vscode.window.showInformationMessage('The semantic index is already building.');
      return undefined;
    }

    this.running = new vscode.CancellationTokenSource();
    const token = this.running.token;

    try {
      await this.open();
      if (force) {
        await this.store!.clear();
      }
      this.setState('building');

      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Infinity Coder: building semantic index',
          cancellable: true,
        },
        async (progress, uiToken) => {
          uiToken.onCancellationRequested(() => this.running?.cancel());
          const stats = await this.run(root, token, (p) => {
            this.events.onProgress?.(p);
            const pct = p.filesTotal ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
            const eta = p.etaMs ? ` · ~${formatDuration(p.etaMs)} left` : '';
            progress.report({ message: `${p.filesDone}/${p.filesTotal} files · ${p.chunksDone} chunks · ${pct}%${eta}` });
          });
          return stats;
        },
      );
    } catch (e: any) {
      if (e instanceof IndexFullError) {
        this.setState('error', e.message);
        vscode.window.showWarningMessage(e.message);
      } else {
        this.setState('error', e.message);
        vscode.window.showErrorMessage(`Semantic index failed: ${e.message}`);
      }
      return undefined;
    } finally {
      this.running?.dispose();
      this.running = undefined;
    }
  }

  private async run(
    root: string,
    token: vscode.CancellationToken,
    report: (progress: IndexProgress) => void,
  ): Promise<IndexStats> {
    const config = this.settings.get().semantic;
    report({ phase: 'scanning', filesDone: 0, filesTotal: 0, chunksDone: 0 });

    const files = this.scan(root, config.excluded, config.maxFiles);
    // A file that vanished since the last build must leave the index, or a
    // deleted secret stays searchable forever.
    const gone = this.store!.indexedFiles().filter(rel => !files.some(f => f.rel === rel));
    if (gone.length > 0) {
      await this.store!.delete(gone);
    }

    const started = Date.now();
    let filesDone = 0;
    let chunksDone = 0;

    // Files are processed a few at a time: enough to keep the provider busy,
    // not so many that a huge repo holds thousands of file bodies in memory.
    const queue = [...files];
    const workers = Array.from({ length: EMBED_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        if (token.isCancellationRequested) {
          return;
        }
        const file = queue.pop()!;
        try {
          chunksDone += await this.indexFile(root, file.abs, file.rel, file.hash);
        } catch (e: any) {
          if (e instanceof IndexFullError) {
            throw e;
          }
          // One unreadable or un-embeddable file must not abort a 100k-file run.
          console.warn(`[semantic] skipped ${file.rel}: ${e.message}`);
        }
        filesDone++;
        const elapsed = Date.now() - started;
        report({
          phase: 'embedding',
          filesDone,
          filesTotal: files.length,
          chunksDone,
          current: file.rel,
          etaMs: filesDone > 20 ? (elapsed / filesDone) * (files.length - filesDone) : undefined,
        });
      }
    });

    await Promise.all(workers);
    await this.store!.flush();

    const stats = await this.store!.stats();
    if (token.isCancellationRequested) {
      // A cancelled build is still a usable index — it is just smaller. Saying
      // "ready" would imply completeness it does not have.
      this.setState(stats.chunks > 0 ? 'ready' : 'empty', 'cancelled');
    } else {
      this.setState(stats.chunks > 0 ? 'ready' : 'empty');
      report({ phase: 'done', filesDone, filesTotal: files.length, chunksDone });
    }
    return stats;
  }

  /** Walk the workspace, keeping only indexable files that actually changed. */
  private scan(root: string, excluded: string[], maxFiles: number): Array<{ abs: string; rel: string; hash: string }> {
    const skip = new Set([...ALWAYS_EXCLUDED, ...excluded].map(s => s.toLowerCase()));
    const out: Array<{ abs: string; rel: string; hash: string }> = [];

    for (const entry of walk(root, Number.MAX_SAFE_INTEGER)) {
      if (out.length >= maxFiles) {
        break;
      }
      if (entry.isDir) {
        continue;
      }
      const rel = toRelative(root, entry.fullPath);
      if (rel.split('/').some(part => skip.has(part.toLowerCase()))) {
        continue;
      }
      if (!languageFor(rel)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(entry.fullPath);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(entry.fullPath);
      } catch {
        continue;
      }
      if (looksBinary(buf)) {
        continue;
      }
      const hash = sha1(buf.toString('utf8'));
      // The incremental gate. Unchanged file, no read, no chunk, no embedding.
      if (this.store!.fileHash(rel) === hash) {
        continue;
      }
      out.push({ abs: entry.fullPath, rel, hash });
    }
    return out;
  }

  /** Chunk, embed and store one file. Returns how many chunks it produced. */
  private async indexFile(root: string, abs: string, rel: string, hash: string): Promise<number> {
    const text = fs.readFileSync(abs, 'utf8');
    const language = languageFor(rel);
    if (!language) {
      return 0;
    }

    const chunks = chunkFile({
      workspace: root,
      relPath: rel,
      language,
      text,
      fileHash: hash,
      symbols: await this.symbolsFor(abs),
      options: { maxChars: this.settings.get().semantic.chunkChars },
    });
    if (chunks.length === 0) {
      return 0;
    }

    const vectors = await this.provider!.embedBatch(chunks.map(embedText));
    await this.store!.update(rel, chunks, vectors);
    return chunks.length;
  }

  /**
   * Symbols from whichever language server owns the file. Returns undefined when
   * nobody answers — an unopened document, a language with no extension
   * installed — and the chunker falls back to its structural heuristics.
   */
  private async symbolsFor(abs: string): Promise<SymbolNode[] | undefined> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        vscode.Uri.file(abs),
      );
      if (!Array.isArray(symbols) || symbols.length === 0) {
        return undefined;
      }
      return symbols.map(toSymbolNode);
    } catch {
      return undefined;
    }
  }

  // ── incremental updates ──────────────────────────────────────────

  public startWatching(): void {
    if (this.watcher) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(uri => this.queue(uri));
    watcher.onDidChange(uri => this.queue(uri));
    watcher.onDidDelete(uri => this.queue(uri, true));
    this.watcher = watcher;
    this.context.subscriptions.push(watcher);
  }

  public stopWatching(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  /**
   * Debounced. A branch switch or a formatter can fire hundreds of events in a
   * second, and re-embedding per event would spend real money on intermediate
   * states nobody will ever search for.
   */
  private queue(uri: vscode.Uri, deleted = false): void {
    const root = this.workspaceRoot;
    if (!root || !uri.fsPath.startsWith(root)) {
      return;
    }
    const rel = toRelative(root, uri.fsPath);
    if (!languageFor(rel)) {
      return;
    }
    const config = this.settings.get().semantic;
    const skip = new Set([...ALWAYS_EXCLUDED, ...config.excluded].map(s => s.toLowerCase()));
    if (rel.split('/').some(part => skip.has(part.toLowerCase()))) {
      return;
    }

    this.pending.add(deleted ? `-${rel}` : rel);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => void this.drain(), 2000);
  }

  private async drain(): Promise<void> {
    const batch = [...this.pending];
    this.pending.clear();
    if (batch.length === 0 || !this.settings.get().semantic.enabled) {
      return;
    }

    const root = this.workspaceRoot;
    if (!root) {
      return;
    }

    try {
      await this.open();
      this.setState('updating');

      const removed = batch.filter(p => p.startsWith('-')).map(p => p.slice(1));
      if (removed.length > 0) {
        await this.store!.delete(removed);
      }

      for (const rel of batch.filter(p => !p.startsWith('-'))) {
        const abs = path.join(root, rel);
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          // Created then deleted before the debounce fired.
          await this.store!.delete([rel]);
          continue;
        }
        if (looksBinary(buf) || buf.length > MAX_FILE_BYTES) {
          continue;
        }
        const hash = sha1(buf.toString('utf8'));
        if (this.store!.fileHash(rel) === hash) {
          continue; // a save that changed nothing, or our own write coming back
        }
        await this.indexFile(root, abs, rel, hash);
      }

      await this.store!.flush();
      const stats = await this.store!.stats();
      this.setState(stats.chunks > 0 ? 'ready' : 'empty');
    } catch (e: any) {
      this.setState('error', e.message);
    }
  }

  // ── commands ─────────────────────────────────────────────────────

  public async clear(): Promise<void> {
    await this.open().catch(() => undefined);
    await this.store?.clear();
    this.setState('empty');
  }

  public async stats(): Promise<IndexStats | undefined> {
    try {
      await this.open();
      return await this.store!.stats();
    } catch {
      return undefined;
    }
  }

  public cancel(): void {
    this.running?.cancel();
  }

  public dispose(): void {
    this.cancel();
    this.stopWatching();
    clearTimeout(this.pendingTimer);
    this.emitter.dispose();
  }
}

/**
 * What actually gets embedded. The path and symbol name are prepended to the
 * body because they carry meaning the body often does not: a file at
 * `src/auth/jwt.ts` is about auth even if the word never appears inside it.
 */
export function embedText(chunk: Chunk): string {
  const parent = chunk.parentSymbol ? `${chunk.parentSymbol}.` : '';
  return `${chunk.relPath}\n${chunk.symbolKind} ${parent}${chunk.symbol}\n\n${chunk.text}`;
}

function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** VS Code SymbolKind is a numeric enum; map the ones that mean something here. */
const SYMBOL_KIND_MAP: Record<number, SymbolKind> = {
  4: 'class',       // Class
  5: 'method',      // Method
  6: 'variable',    // Property
  9: 'enum',        // Enum
  10: 'interface',  // Interface
  11: 'function',   // Function
  12: 'variable',   // Variable
  2: 'namespace',   // Module
  3: 'namespace',   // Namespace
  22: 'enum',       // EnumMember
  25: 'type',       // TypeParameter
  23: 'type',       // Struct
};

function toSymbolNode(symbol: vscode.DocumentSymbol): SymbolNode {
  return {
    name: symbol.name,
    kind: SYMBOL_KIND_MAP[symbol.kind as unknown as number] ?? 'function',
    startLine: symbol.range.start.line + 1,
    endLine: symbol.range.end.line + 1,
    children: (symbol.children || []).map(toSymbolNode),
  };
}
