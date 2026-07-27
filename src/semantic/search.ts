import { Chunk, EmbeddingProvider, SearchOptions, SearchResult, VectorStore } from './types';
import { estimateTokens } from './chunker';

/**
 * Search and context assembly.
 *
 * Pure vector similarity alone retrieves things that are *about* the query but
 * not the thing you asked for — a comment discussing auth outranks the auth
 * middleware itself. The hybrid score below re-weights the vector hit with
 * signals the embedding cannot see: whether the symbol is exported, whether the
 * file is an entry point, whether the query's literal words appear, and how
 * recently the file changed.
 *
 * No `vscode` import: ranking is arithmetic and stays unit-testable.
 */

export interface RankingWeights {
  similarity: number;
  keyword: number;
  exported: number;
  entryPoint: number;
  config: number;
  recency: number;
  symbolKind: number;
  openFile: number;
}

/**
 * Similarity dominates by design — the boosts break ties and rescue exact-name
 * matches, they do not decide the result set. Raising `keyword` far enough to
 * outrank similarity turns this back into grep.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  similarity: 1,
  keyword: 0.35,
  exported: 0.08,
  entryPoint: 0.06,
  config: 0.04,
  recency: 0.05,
  symbolKind: 0.05,
  openFile: 0.07,
};

/** Files that are how a codebase is entered, and therefore usually the answer. */
const ENTRY_POINT = /(?:^|\/)(?:index|main|app|server|bootstrap|entry|route|routes|router|middleware)\.\w+$/i;
const CONFIG_FILE = /(?:^|\/)(?:package\.json|tsconfig\.json|.*\.config\.\w+|Dockerfile|docker-compose\.ya?ml|\.env\..*|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle)$/i;

/** Some kinds are more likely to be "the implementation" than others. */
const KIND_WEIGHT: Record<string, number> = {
  class: 1, component: 1, function: 0.9, method: 0.85, hook: 0.9,
  interface: 0.7, type: 0.6, enum: 0.6, namespace: 0.5,
  config: 0.5, section: 0.5, variable: 0.4, file: 0.3,
};

export interface RankContext {
  /** Workspace-relative paths the user has open. Injected by the vscode layer. */
  openFiles?: Set<string>;
  weights?: Partial<RankingWeights>;
  now?: number;
}

export function tokenizeQuery(query: string): string[] {
  return query
    // Split camelCase BEFORE lowercasing — lowercasing first destroys the very
    // boundary this is looking for, and "jwtService" would never match "jwt".
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'where', 'what', 'how', 'why', 'does', 'this', 'that',
  'with', 'from', 'into', 'are', 'was', 'you', 'your', 'can', 'find', 'show',
  'implemented', 'implementation', 'code', 'file', 'files', 'function', 'add',
]);

/**
 * Literal overlap between the query and a chunk. Weighted towards the symbol
 * name and path: a query word appearing in the *name* of a thing is a far
 * stronger signal than the same word buried in its body.
 */
export function keywordScore(terms: string[], chunk: Chunk): number {
  if (terms.length === 0) {
    return 0;
  }
  const symbol = chunk.symbol.toLowerCase();
  const symbolWords = tokenizeQuery(chunk.symbol).join(' ');
  const relPath = chunk.relPath.toLowerCase();
  const body = chunk.text.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (symbol === term || symbolWords.split(' ').includes(term)) {
      score += 1;
    } else if (symbol.includes(term)) {
      score += 0.6;
    } else if (relPath.includes(term)) {
      score += 0.45;
    } else if (body.includes(term)) {
      // Sub-linear in the body: a file mentioning "auth" 50 times is not 50x
      // more relevant than one mentioning it twice.
      score += 0.2;
    }
  }
  return Math.min(1, score / terms.length);
}

/** Newer files are likelier to be what the user is working on. Halves ~monthly. */
function recencyScore(updatedAt: number, now: number): number {
  const days = Math.max(0, (now - updatedAt) / 86_400_000);
  return Math.exp(-days / 30);
}

/**
 * Apply the hybrid weighting. Returns a new array; the store's raw similarity is
 * preserved on each result so the UI can explain a placement.
 */
export function rank(results: SearchResult[], query: string, context: RankContext = {}): SearchResult[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(context.weights || {}) };
  const terms = tokenizeQuery(query);
  const now = context.now ?? Date.now();

  return results
    .map(result => {
      const chunk = result.chunk;
      const reasons: string[] = [];
      let score = result.similarity * weights.similarity;

      const keyword = keywordScore(terms, chunk);
      if (keyword > 0) {
        score += keyword * weights.keyword;
        if (keyword > 0.5) { reasons.push('name matches the query'); }
      }
      if (chunk.exported) {
        score += weights.exported;
        reasons.push('exported symbol');
      }
      if (ENTRY_POINT.test(chunk.relPath)) {
        score += weights.entryPoint;
        reasons.push('entry point');
      }
      if (CONFIG_FILE.test(chunk.relPath)) {
        score += weights.config;
        reasons.push('configuration');
      }
      if (context.openFiles?.has(chunk.relPath)) {
        score += weights.openFile;
        reasons.push('open in the editor');
      }
      score += recencyScore(chunk.updatedAt, now) * weights.recency;
      score += (KIND_WEIGHT[chunk.symbolKind] ?? 0.5) * weights.symbolKind;

      return { ...result, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

export interface ContextBudget {
  /** Hard ceiling in tokens for everything the builder emits. */
  maxTokens: number;
  /** Never emit more than this many chunks however small they are. */
  maxChunks?: number;
}

export interface BuiltContext {
  text: string;
  chunks: Chunk[];
  tokens: number;
  /** Dropped for budget, so the caller can say so rather than silently truncate. */
  omitted: number;
}

/**
 * Turn ranked chunks into prompt text.
 *
 * Three passes, in this order for a reason: dedupe first so a duplicate never
 * consumes budget, merge adjacent regions second so the model sees whole
 * functions rather than two halves with a seam, and only then spend the budget
 * best-first.
 */
export function buildContext(results: SearchResult[], budget: ContextBudget): BuiltContext {
  const deduped = dedupe(results);
  const merged = mergeAdjacent(deduped);

  const chosen: Chunk[] = [];
  let tokens = 0;
  let omitted = 0;

  for (const result of merged) {
    const cost = result.chunk.tokenCount;
    if (chosen.length >= (budget.maxChunks ?? Infinity) || tokens + cost > budget.maxTokens) {
      omitted++;
      continue; // keep scanning: a later, smaller chunk may still fit
    }
    chosen.push(result.chunk);
    tokens += cost;
  }

  // Group by file so the model reads one coherent excerpt per file rather than
  // the same path repeated in rank order.
  const byFile = new Map<string, Chunk[]>();
  for (const chunk of chosen) {
    const list = byFile.get(chunk.relPath);
    if (list) { list.push(chunk); } else { byFile.set(chunk.relPath, [chunk]); }
  }

  const blocks: string[] = [];
  for (const [relPath, chunks] of byFile) {
    chunks.sort((a, b) => a.startLine - b.startLine);
    const body = chunks
      .map(c => `// lines ${c.startLine}-${c.endLine}${c.symbol ? ` — ${c.symbol}` : ''}\n${c.text}`)
      .join('\n\n// …\n\n');
    blocks.push(`--- ${relPath} ---\n${body}`);
  }

  return { text: blocks.join('\n\n'), chunks: chosen, tokens, omitted };
}

/** Same id, or a region already covered by a higher-ranked chunk of the same file. */
function dedupe(results: SearchResult[]): SearchResult[] {
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const covered = new Map<string, Array<[number, number]>>();
  const out: SearchResult[] = [];

  for (const result of results) {
    const { id, chunkHash, relPath, startLine, endLine } = result.chunk;
    if (seenIds.has(id) || seenHashes.has(chunkHash)) {
      continue; // identical text elsewhere in the repo is not new information
    }
    const ranges = covered.get(relPath) || [];
    if (ranges.some(([s, e]) => startLine >= s && endLine <= e)) {
      continue;
    }
    seenIds.add(id);
    seenHashes.add(chunkHash);
    ranges.push([startLine, endLine]);
    covered.set(relPath, ranges);
    out.push(result);
  }
  return out;
}

/**
 * Fuse chunks from the same file that touch or nearly touch. Two halves of one
 * function retrieved separately read as broken code; joined, they read as the
 * function. The merged chunk keeps the better score so ordering survives.
 */
const MERGE_GAP_LINES = 4;

function mergeAdjacent(results: SearchResult[]): SearchResult[] {
  const byFile = new Map<string, SearchResult[]>();
  for (const result of results) {
    const list = byFile.get(result.chunk.relPath);
    if (list) { list.push(result); } else { byFile.set(result.chunk.relPath, [result]); }
  }

  const out: SearchResult[] = [];
  for (const group of byFile.values()) {
    group.sort((a, b) => a.chunk.startLine - b.chunk.startLine);
    let current: SearchResult | undefined;

    for (const result of group) {
      if (!current) {
        current = result;
        continue;
      }
      const gap = result.chunk.startLine - current.chunk.endLine;
      // Only merge chunks whose text we can actually splice — overlapping or
      // adjacent regions. A gap means missing lines, and inventing a join there
      // would hand the model code that does not exist.
      if (gap <= MERGE_GAP_LINES && gap > 0 && result.chunk.text && current.chunk.text) {
        const text = current.chunk.text + '\n' + result.chunk.text;
        current = {
          ...current,
          score: Math.max(current.score, result.score),
          similarity: Math.max(current.similarity, result.similarity),
          reasons: [...new Set([...current.reasons, ...result.reasons])],
          chunk: {
            ...current.chunk,
            endLine: Math.max(current.chunk.endLine, result.chunk.endLine),
            text,
            tokenCount: estimateTokens(text),
            symbol: current.chunk.symbol === result.chunk.symbol
              ? current.chunk.symbol
              : `${current.chunk.symbol}, ${result.chunk.symbol}`,
          },
        };
      } else {
        out.push(current);
        current = result;
      }
    }
    if (current) {
      out.push(current);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface SearchEngineOptions {
  store: VectorStore;
  provider: EmbeddingProvider;
  /** Pulled fresh per query so the vscode layer can supply live editor state. */
  rankContext?: () => RankContext;
}

/**
 * The public search surface. Everything the rest of the extension calls goes
 * through here, so neither the store nor the provider leaks outwards.
 */
export class SemanticSearchEngine {
  constructor(private readonly opts: SearchEngineOptions) {}

  /**
   * Over-fetch from the vector store, then re-rank. The store returns the top
   * `topK` by similarity alone; if we asked it for exactly what we intend to
   * return, a chunk that the boosts would have promoted would already have been
   * cut before ranking ever saw it.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const topK = options.topK ?? 12;
    // 'query', not 'passage': on an asymmetric model these go through
    // different heads, and mismatching them degrades every result silently.
    const vector = await this.opts.provider.embed(query, options.signal, 'query');
    const candidates = await this.opts.store.search(vector, {
      ...options,
      topK: Math.max(topK * 4, 50),
    });
    return rank(candidates, query, this.opts.rankContext?.() ?? {}).slice(0, topK);
  }

  /** Files, best-chunk-first, deduplicated. */
  public async findRelevantFiles(query: string, options: SearchOptions = {}): Promise<string[]> {
    const results = await this.search(query, { ...options, topK: options.topK ?? 40 });
    const seen: string[] = [];
    for (const result of results) {
      if (!seen.includes(result.chunk.relPath)) {
        seen.push(result.chunk.relPath);
      }
    }
    return seen;
  }

  /** Named symbols only — the "auth middleware, jwt service, login controller" answer. */
  public async findRelevantSymbols(
    query: string,
    options: SearchOptions = {},
  ): Promise<Array<{ symbol: string; kind: string; relPath: string; startLine: number; score: number }>> {
    const results = await this.search(query, options);
    return results
      .filter(r => r.chunk.symbol && r.chunk.symbolKind !== 'file')
      .map(r => ({
        symbol: r.chunk.symbol,
        kind: r.chunk.symbolKind,
        relPath: r.chunk.relPath,
        startLine: r.chunk.startLine,
        score: r.score,
      }));
  }

  /** Retrieve and assemble in one call — what the chat turn actually uses. */
  public async buildContext(
    query: string,
    budget: ContextBudget,
    options: SearchOptions = {},
  ): Promise<BuiltContext> {
    const results = await this.search(query, { ...options, topK: options.topK ?? 40 });
    return buildContext(results, budget);
  }
}
