/**
 * ContextCompactor — performs in-place compaction on a COPY of history.
 *
 * The original history passed to ContextManager is never mutated.
 * All three operations work on the mutable copy returned by ContextManager.prepare().
 */

import type { Msg } from '../agent';
import type { ITokenEstimator } from './ITokenEstimator';
import type { PriorityResolver } from './PriorityResolver';
import type { BudgetResult } from './ContextBudget';

/** Token threshold: tool outputs larger than this are candidates for compaction. */
const TOOL_COMPACT_THRESHOLD = 1_000;

/** Aggressive mode: hard-cap any single tool result to this many tokens. */
const AGGRESSIVE_MAX_TOOL_TOKENS = 500;

/** Chars per token — used for truncation (approx, intentionally conservative). */
const CHARS_PER_TOKEN = 4;

export interface CompactionResult {
  history: Msg[];
  compressionSaved: number;
  aggressiveSaved: number;
}

export class ContextCompactor {
  constructor(
    private readonly estimator: ITokenEstimator,
    private readonly resolver: PriorityResolver,
  ) {}

  /**
   * Compact tool outputs that exceed TOOL_COMPACT_THRESHOLD tokens.
   * Protected messages are never touched.
   *
   * @returns Tokens saved by this pass.
   */
  compactToolOutputs(history: Msg[]): number {
    let saved = 0;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== 'tool') {
        continue;
      }
      const cls = this.resolver.classify(msg, i, history.length);
      if (this.resolver.isProtected(cls)) {
        continue;
      }
      const tokens = this.estimator.estimateMsg(msg);
      if (tokens <= TOOL_COMPACT_THRESHOLD) {
        continue;
      }

      // Find the original tool name from the preceding assistant message.
      const toolName = this.findToolName(history, i);
      const stub = `[Compacted: ${toolName} returned ~${tokens} tokens — content removed to save context]`;

      history[i] = { ...msg, content: stub };
      saved += tokens - this.estimator.estimate(stub);
    }
    return saved;
  }

  /**
   * Replace old conversation turns with summary stubs.
   *
   * Only replaces messages whose indices are listed in `coveringIndices`.
   * Does not remove messages — replaces with a minimal placeholder so that
   * tool_call_id references (which providers validate) are never broken.
   *
   * @returns Tokens saved by this pass.
   */
  applySummaries(
    history: Msg[],
    coveringIndices: number[],
    summaryText: string,
    topic: string,
  ): number {
    let saved = 0;
    const covered = new Set(coveringIndices);
    let inserted = false;

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (!covered.has(i)) {
        continue;
      }

      // The first covered index gets the summary stub;
      // subsequent ones are collapsed to minimal content.
      const original = this.estimator.estimateMsg(msg);
      if (!inserted && (msg.role === 'user' || msg.role === 'assistant')) {
        history[i] = {
          role: 'user',
          content: `[Conversation Summary — ${topic}]: ${summaryText}`,
        };
        inserted = true;
        saved += original - this.estimator.estimateMsg(history[i]);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        history[i] = { role: msg.role, content: '' };
        saved += original;
      } else {
        // Tool messages and their call pairs must stay structurally intact.
        // Replace with a compact stub only.
        const stub = '[Summarized]';
        history[i] = { ...msg, content: stub };
        saved += original - this.estimator.estimate(stub);
      }
    }
    return Math.max(0, saved);
  }

  /**
   * Aggressive mode: truncate every remaining large tool result to
   * AGGRESSIVE_MAX_TOOL_TOKENS tokens.  Only runs when tier='aggressive'.
   *
   * @returns Tokens saved by this pass.
   */
  aggressiveCompress(history: Msg[]): number {
    let saved = 0;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== 'tool' || typeof msg.content !== 'string') {
        continue;
      }
      const tokens = this.estimator.estimateMsg(msg);
      if (tokens <= AGGRESSIVE_MAX_TOOL_TOKENS) {
        continue;
      }

      const maxChars = AGGRESSIVE_MAX_TOOL_TOKENS * CHARS_PER_TOKEN;
      const truncated = (msg.content as string).slice(0, maxChars) +
        `\n…[truncated — ${tokens - AGGRESSIVE_MAX_TOOL_TOKENS} tokens removed]`;

      history[i] = { ...msg, content: truncated };
      saved += tokens - this.estimator.estimateMsg(history[i]);
    }
    return Math.max(0, saved);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private findToolName(history: Msg[], toolIndex: number): string {
    // Look backward for the assistant message with tool_calls that includes
    // this tool result's tool_call_id.
    const toolMsg = history[toolIndex];
    const callId = toolMsg.tool_call_id as string | undefined;
    if (!callId) {
      return 'tool';
    }
    for (let j = toolIndex - 1; j >= 0; j--) {
      const m = history[j];
      if (m.role === 'assistant' && m.tool_calls) {
        const match = (m.tool_calls as any[]).find((tc: any) => tc.id === callId);
        if (match) {
          return match.function?.name ?? 'tool';
        }
      }
    }
    return 'tool';
  }

  /**
   * Compute the budget-driven compaction result on a mutable copy.
   * Called by ContextManager after cloning history.
   */
  runTier(
    history: Msg[],
    budget: BudgetResult,
    tier: 'tool' | 'summarize' | 'aggressive',
    coveringIndices: number[] = [],
    summaryText = '',
    summaryTopic = '',
  ): { compressionSaved: number; aggressiveSaved: number } {
    let compressionSaved = 0;
    let aggressiveSaved = 0;

    // Tool compaction always runs for tier >= tool.
    compressionSaved += this.compactToolOutputs(history);

    if (tier === 'summarize' || tier === 'aggressive') {
      if (coveringIndices.length > 0 && summaryText) {
        compressionSaved += this.applySummaries(history, coveringIndices, summaryText, summaryTopic);
      }
    }

    if (tier === 'aggressive') {
      aggressiveSaved += this.aggressiveCompress(history);
    }

    void budget; // Budget is used upstream by ContextManager for metrics.
    return { compressionSaved, aggressiveSaved };
  }
}
