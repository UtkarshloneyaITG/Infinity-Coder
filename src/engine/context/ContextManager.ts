/**
 * ContextManager — the orchestrator.
 *
 * Called once per agent round (before runWithFailover). It:
 * 1. Fetches context sources (semantic, workspace…)
 * 2. Estimates the current token usage
 * 3. Resolves the compaction tier from the budget
 * 4. If needed: clones history and runs compaction / summarization on the copy
 * 5. Builds the final Msg[] via PromptBuilder
 * 6. Returns an OptimizedContext (immutable — the original history is never touched)
 *
 * The original `history[]` is treated as `readonly`. Any modifications
 * (compaction, summaries) are applied to a deep clone.
 */

import type { Msg } from '../agent';
import type { ITokenEstimator } from './ITokenEstimator';
import type { PriorityResolver } from './PriorityResolver';
import type { ContextSource } from './ContextSource';
import type { InternalSummaryMsg } from './InternalSummaryMsg';
import type { ContextMetrics } from './ContextMetrics';
import type { ModelCapabilities } from './ModelCapabilities';
import type { ContextSettings } from '../../settings';
import { computeBudget } from './ContextBudget';
import { ContextCompactor } from './ContextCompactor';
import { ConversationSummarizer } from './ConversationSummarizer';
import { PromptBuilder } from './PromptBuilder';
import { EMPTY_METRICS } from './ContextMetrics';

// ── Public types ──────────────────────────────────────────────────────────────

export interface OptimizedContext {
  /**
   * The fully assembled, ready-to-send Msg[] for the provider call.
   * Built by PromptBuilder from the (possibly compacted) history.
   */
  messages: Msg[];

  /** Metrics snapshot for the `context_metrics` event and the UI panel. */
  metrics: ContextMetrics;

  /**
   * New InternalSummaryMsg objects produced this round.
   * The caller (Engine) should merge these into the live session state so they
   * survive across rounds without being re-generated.
   */
  newSummaries: InternalSummaryMsg[];
}

export interface ContextManagerOptions {
  estimator: ITokenEstimator;
  resolver: PriorityResolver;
  compactor: ContextCompactor;
  builder: PromptBuilder;
  summarizer: ConversationSummarizer;
  sources: ContextSource[];
  settings: ContextSettings;
  capabilities: ModelCapabilities;
}

// ── ContextManager ─────────────────────────────────────────────────────────────

export class ContextManager {
  private readonly estimator: ITokenEstimator;
  private readonly resolver: PriorityResolver;
  private readonly compactor: ContextCompactor;
  private readonly builder: PromptBuilder;
  private readonly summarizer: ConversationSummarizer;
  private readonly sources: ContextSource[];
  private readonly settings: ContextSettings;
  private readonly capabilities: ModelCapabilities;

  constructor(opts: ContextManagerOptions) {
    this.estimator = opts.estimator;
    this.resolver = opts.resolver;
    this.compactor = opts.compactor;
    this.builder = opts.builder;
    this.summarizer = opts.summarizer;
    this.sources = opts.sources;
    this.settings = opts.settings;
    this.capabilities = opts.capabilities;
  }

  /**
   * Prepare an optimized prompt for one agent round.
   *
   * @param history       The session history (READ-ONLY — never mutated).
   * @param system        The fully rendered system prompt string.
   * @param userQuery     The current user's text (used for source fetching).
   * @param existingSummaries  Summaries produced in prior rounds.
   * @param signal        AbortSignal from the parent turn.
   */
  async prepare(
    history: readonly Msg[],
    system: string,
    userQuery: string,
    existingSummaries: InternalSummaryMsg[],
    signal: AbortSignal,
  ): Promise<OptimizedContext> {
    // ── 1. Compute initial budget ────────────────────────────────────────────
    const budget = computeBudget(
      system,
      history as Msg[],
      this.capabilities,
      this.settings,
      this.estimator,
    );

    // ── 2. Fetch context sources ─────────────────────────────────────────────
    // Give sources the remaining budget (minus room for compaction results).
    const sourceBudget = Math.max(0, budget.remaining - this.settings.reservedOutputTokens);
    const sourceResults = await this.fetchSources(userQuery, sourceBudget, signal);
    const semanticTokens = sourceResults.reduce((n, r) => n + r.tokenEstimate, 0);

    // ── 3. Decide compaction tier ────────────────────────────────────────────
    const tier = budget.compactionTier;
    let compressionSaved = 0;
    let aggressiveSaved = 0;
    let newSummaries: InternalSummaryMsg[] = [];
    let workingHistory: Msg[];

    if (tier === 'none') {
      // Fast path — no copy, no work.
      workingHistory = history as Msg[];
    } else {
      // Clone history so we can mutate the copy safely.
      workingHistory = history.map(m => ({ ...m }));

      if (tier === 'summarize' || tier === 'aggressive') {
        if (this.settings.summaryEnabled && !signal.aborted) {
          newSummaries = await this.summarizer.summarize(
            history,
            existingSummaries,
            this.settings.summaryDepth,
            signal,
          );
          // Apply new summaries to the working copy.
          for (const s of newSummaries) {
            const saved = this.compactor.applySummaries(
              workingHistory,
              [...s.covering],
              s.content,
              s.topic,
            );
            compressionSaved += saved;
          }
        }
      }

      const compactResult = this.compactor.runTier(
        workingHistory,
        budget,
        tier === 'warn' ? 'aggressive' : tier,
      );
      compressionSaved += compactResult.compressionSaved;
      aggressiveSaved = compactResult.aggressiveSaved;
    }

    // ── 4. Build the final Msg[] ─────────────────────────────────────────────
    const allSummaries = [...existingSummaries, ...newSummaries];
    const promptResult = this.builder.build({
      system,
      compactedHistory: workingHistory,
      summaries: allSummaries,
      sources: sourceResults,
      currentRequest: userQuery,
      resolver: this.resolver,
      estimator: this.estimator,
      tokenBudget: budget.usableInput,
    });

    // ── 5. Compute final metrics ─────────────────────────────────────────────
    const toolTokens = this.estimator.estimateMsgs(workingHistory).tool;
    const summarizedTokens = newSummaries.reduce((n, s) => n + s.originalTokens, 0);

    const metrics: ContextMetrics = {
      ...EMPTY_METRICS,
      contextWindow: budget.contextWindow,
      reservedOutput: budget.reservedOutput,
      usableInput: budget.usableInput,
      currentUsage: promptResult.estimatedTokens,
      remaining: budget.usableInput - promptResult.estimatedTokens,
      utilizationPct: budget.usableInput > 0
        ? Math.min(100, (promptResult.estimatedTokens / budget.usableInput) * 100)
        : 100,
      systemTokens: budget.systemTokens,
      historyTokens: budget.historyTokens,
      toolTokens,
      semanticTokens,
      compactionTier: tier,
      compactionOccurred: tier !== 'none' && (compressionSaved + aggressiveSaved) > 0,
      compressionSaved,
      summarizedTokens,
      aggressiveSaved,
      activeSummaries: allSummaries.length,
    };

    return {
      messages: promptResult.messages,
      metrics,
      newSummaries,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async fetchSources(
    query: string,
    budget: number,
    signal: AbortSignal,
  ): Promise<import('./ContextSource').ContextSourceResult[]> {
    if (signal.aborted) {
      return [];
    }
    const results: import('./ContextSource').ContextSourceResult[] = [];
    let remaining = budget;
    for (const source of this.sources) {
      if (signal.aborted || remaining <= 0) {
        break;
      }
      try {
        const fetched = await source.fetch(query, remaining);
        for (const r of fetched) {
          results.push(r);
          remaining -= r.tokenEstimate;
        }
      } catch {
        // A failing source must never abort the turn.
      }
    }
    return results;
  }
}

/**
 * Build a ContextManager from the user's InfinityCoderSettings and a model id.
 * This factory is called once per `Engine.chat()` call.
 */
export function createContextManager(
  settings: ContextSettings,
  capabilities: ModelCapabilities,
  estimator: ITokenEstimator,
  resolver: PriorityResolver,
  summarizer: ConversationSummarizer,
  sources: ContextSource[],
): ContextManager {
  const compactor = new ContextCompactor(estimator, resolver);
  const builder = new PromptBuilder();

  return new ContextManager({
    estimator,
    resolver,
    compactor,
    builder,
    summarizer,
    sources,
    settings,
    capabilities,
  });
}
