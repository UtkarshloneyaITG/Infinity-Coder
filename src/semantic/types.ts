/**
 * Contracts for the semantic index.
 *
 * This file is deliberately free of `vscode` and `fs` imports: everything below
 * is data or an interface, so the engine can be unit-tested outside the
 * extension host and a future store or provider can be dropped in without the
 * rest of the system knowing.
 */

/** Index format version. Bumping it invalidates on-disk data — see MIGRATIONS. */
export const INDEX_VERSION = 1;

export type SymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'enum' | 'namespace'
  | 'component' | 'hook' | 'variable' | 'type' | 'section' | 'config' | 'file';

/**
 * One indexed unit: a syntactic region of a file, not an arbitrary window.
 * `text` is what gets embedded and what reaches the model's context.
 */
export interface Chunk {
  /** Stable across re-indexing: `<relPath>#<symbolPath>@<startLine>`. */
  id: string;
  workspace: string;
  /** Workspace-relative, forward slashes, so ids are stable across machines. */
  relPath: string;
  language: string;
  /** sha1 of the whole file — the incremental gate. */
  fileHash: string;
  /** sha1 of this chunk's text — survives a file edit that missed this region. */
  chunkHash: string;
  /** 1-based, inclusive, matching what an editor shows. */
  startLine: number;
  endLine: number;
  updatedAt: number;
  symbol: string;
  symbolKind: SymbolKind;
  /** Enclosing symbol, e.g. the class a method belongs to. */
  parentSymbol?: string;
  imports: string[];
  exports: string[];
  /** Module specifiers this chunk's file depends on. */
  dependencies: string[];
  /** Exported symbols rank higher: they are the surface other code calls. */
  exported: boolean;
  tokenCount: number;
  text: string;
}

/** A chunk plus why it was returned. */
export interface SearchResult {
  chunk: Chunk;
  /** Final rank score after hybrid weighting. */
  score: number;
  /** Cosine similarity alone, before boosts — kept for explainability. */
  similarity: number;
  /** Which signals fired, for the "why this result" line in the UI. */
  reasons: string[];
}

export interface SearchOptions {
  topK?: number;
  /** Discard anything below this cosine similarity. */
  minSimilarity?: number;
  /** Restrict to files under these workspace-relative prefixes. */
  pathPrefixes?: string[];
  languages?: string[];
  signal?: AbortSignal;
}

export interface IndexStats {
  version: number;
  files: number;
  chunks: number;
  vectors: number;
  dimensions: number;
  /** Bytes on disk, vectors + metadata. */
  bytes: number;
  lastBuiltAt: number;
  lastUpdatedAt: number;
  model: string;
}

/**
 * Embeddings. The only thing the rest of the system knows about a provider.
 *
 * `dimensions` is discovered from the first response rather than configured:
 * the same model id can return different widths across providers, and a wrong
 * guess corrupts every vector silently.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** Largest batch the provider accepts in one call. */
  readonly batchSize: number;
  embed(text: string, signal?: AbortSignal, kind?: EmbeddingKind): Promise<Float32Array>;
  embedBatch(texts: string[], signal?: AbortSignal, kind?: EmbeddingKind): Promise<Float32Array[]>;
}

/**
 * Asymmetric embedding models — NVIDIA's nv-embedqa family and others — encode a
 * short question and a long passage through different heads, and require the
 * caller to say which it is sending. Getting it backwards does not error, it
 * just retrieves badly, so the distinction belongs in the interface rather than
 * buried in one provider.
 */
export type EmbeddingKind = 'query' | 'passage';

/**
 * Vector storage. Implementations own their persistence; callers only ever see
 * chunks and scores.
 *
 * `search` takes an already-embedded query so the store never needs a provider,
 * which is what lets the memory store exist for tests with no network at all.
 */
export interface VectorStore {
  readonly dimensions: number;
  insert(chunks: Chunk[], vectors: Float32Array[]): Promise<void>;
  /** Replace every chunk belonging to these files. The incremental unit. */
  update(relPath: string, chunks: Chunk[], vectors: Float32Array[]): Promise<void>;
  delete(relPaths: string[]): Promise<void>;
  search(query: Float32Array, options?: SearchOptions): Promise<SearchResult[]>;
  clear(): Promise<void>;
  stats(): Promise<IndexStats>;
  /** Persist anything buffered. Safe to call repeatedly. */
  flush(): Promise<void>;
  /** File hash for the incremental check, or undefined if never indexed. */
  fileHash(relPath: string): string | undefined;
  /** Every relative path currently in the index. */
  indexedFiles(): string[];
}

export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'embedding' | 'writing' | 'done';
  filesDone: number;
  filesTotal: number;
  chunksDone: number;
  /** Milliseconds, or undefined until there is enough data to extrapolate. */
  etaMs?: number;
  current?: string;
}

export type IndexState = 'disabled' | 'empty' | 'building' | 'updating' | 'ready' | 'error';

/** Languages we index, keyed by extension (no leading dot). */
export const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', vue: 'vue', svelte: 'svelte',
  py: 'python', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shellscript',
};

/**
 * Never walked. Kept separate from the user's exclude list so a user edit can
 * never accidentally pull node_modules into a 100k-file scan.
 */
export const ALWAYS_EXCLUDED = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'bin', 'obj',
  '.gradle', '.idea', '.vscode-test', 'Pods', 'DerivedData',
];
