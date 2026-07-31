/**
 * SemanticContextSource — ContextSource implementation for RAG / Semantic Retrieval.
 *
 * Plugs semantic search directly into the ContextManager pipeline.
 *
 * When semantic search is enabled, ContextManager calls `fetch(userQuery, budget)`
 * during `prepare()`. The results are wrapped in a typed `ContextSourceResult`
 * with `ContextClass.SemanticContext` priority (protected from compaction).
 */

import type { ContextSource, ContextSourceResult } from './ContextSource';
import { ContextClass } from './PriorityResolver';
import type { ITokenEstimator } from './ITokenEstimator';

export interface SemanticEngineLike {
  buildContext(
    query: string,
    opts: { maxTokens: number; maxChunks: number },
  ): Promise<{ text: string; tokens: number; chunks: Array<{ relPath: string }> }>;
}

export interface SemanticSourceConfig {
  enabled: boolean;
  autoContext: boolean;
  contextTokens: number;
  topK: number;
}

export class SemanticContextSource implements ContextSource {
  readonly id = 'semantic';

  constructor(
    private readonly getEngine: () => SemanticEngineLike | undefined,
    private readonly getConfig: () => SemanticSourceConfig,
    private readonly estimator: ITokenEstimator,
  ) {}

  async fetch(query: string, budget: number): Promise<ContextSourceResult[]> {
    const config = this.getConfig();
    const engine = this.getEngine();

    if (!config.enabled || !config.autoContext || !engine) {
      return [];
    }

    // Skip short messages ("yes", "ok", etc.)
    if (query.trim().length < 12) {
      return [];
    }

    const tokenCap = Math.min(config.contextTokens, Math.max(500, budget));

    try {
      const built = await engine.buildContext(query, {
        maxTokens: tokenCap,
        maxChunks: config.topK,
      });

      if (built.chunks.length === 0 || !built.text.trim()) {
        return [];
      }

      const files = [...new Set(built.chunks.map(c => c.relPath))];
      const content = built.text;
      const tokens = this.estimator.estimate(content);

      return [
        {
          content,
          tokenEstimate: tokens,
          label: `Semantic RAG (${files.length} file${files.length === 1 ? '' : 's'})`,
          priority: ContextClass.SemanticContext,
          metadata: {
            files,
            tokens,
            chunkCount: built.chunks.length,
          },
        },
      ];
    } catch {
      return [];
    }
  }
}
