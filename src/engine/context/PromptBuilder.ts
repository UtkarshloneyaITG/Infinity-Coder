/**
 * PromptBuilder — the single place that assembles an OpenAI-format Msg[] from
 * all context sources.
 *
 * It is the only module that writes `{ role, content }` objects. All other
 * modules work with typed InternalSummaryMsg objects, ContextSourceResult
 * arrays, and plain history Msg[] slices. Converting them to OpenAI format
 * happens here, at the last moment.
 *
 * Section order (fixed):
 *   1. System message
 *   2. Source sections (semantic, workspace, memory…) ordered by priority score
 *   3. Summary blocks (converted from InternalSummaryMsg[])
 *   4. Recent conversation history
 *   5. Current user request (always last)
 */

import type { Msg } from '../agent';
import type { InternalSummaryMsg } from './InternalSummaryMsg';
import { summaryContent, isInternalSummaryMsg } from './InternalSummaryMsg';
import type { ContextSourceResult } from './ContextSource';
import type { PriorityResolver } from './PriorityResolver';
import type { ITokenEstimator } from './ITokenEstimator';
import { ContextClass } from './PriorityResolver';

export interface PromptBuildParams {
  /** The fully rendered system prompt string (from persona.ts). */
  system: string;
  /**
   * Compacted history (output of ContextCompactor).
   * Does NOT include the current user request — that is passed separately
   * so PromptBuilder can always place it last regardless of compaction.
   */
  compactedHistory: Msg[];
  /** Summary messages produced by ConversationSummarizer. */
  summaries: InternalSummaryMsg[];
  /** Results from all registered ContextSource implementations. */
  sources: ContextSourceResult[];
  /** The current user's raw text (not yet in history). */
  currentRequest: string;
  /** Used to score sources for ordering. */
  resolver: PriorityResolver;
  /** Used to verify we have not exceeded the usable budget. */
  estimator: ITokenEstimator;
  /** Hard ceiling on the assembled prompt (tokens). Set to usableInput. */
  tokenBudget: number;
}

export interface PromptBuildResult {
  messages: Msg[];
  /** Actual token count of the assembled messages. */
  estimatedTokens: number;
  /** True if any source was truncated to fit the budget. */
  truncated: boolean;
}

export class PromptBuilder {
  build(params: PromptBuildParams): PromptBuildResult {
    const {
      system,
      compactedHistory,
      summaries,
      sources,
      currentRequest,
      resolver,
      estimator,
      tokenBudget,
    } = params;

    const messages: Msg[] = [];
    let usedTokens = 0;
    let truncated = false;

    // ── 1. System message ────────────────────────────────────────────────────
    const systemMsg: Msg = { role: 'system', content: system };
    messages.push(systemMsg);
    usedTokens += estimator.estimateMsg(systemMsg);

    // ── 2. Source sections ordered by priority (highest first) ───────────────
    const sortedSources = [...sources].sort(
      (a, b) => resolver.score(b.priority) - resolver.score(a.priority)
    );

    for (const src of sortedSources) {
      if (usedTokens + src.tokenEstimate > tokenBudget) {
        truncated = true;
        continue; // Skip sources that don't fit.
      }
      const sourceMsg: Msg = {
        role: 'user',
        content: `[Context: ${src.label}]\n${src.content}`,
      };
      messages.push(sourceMsg);
      usedTokens += estimator.estimateMsg(sourceMsg);
    }

    // ── 3. Summary blocks ────────────────────────────────────────────────────
    for (const summary of summaries) {
      const content = summaryContent(summary);
      const summaryMsg: Msg = { role: 'user', content };
      const tokens = estimator.estimateMsg(summaryMsg);
      if (usedTokens + tokens > tokenBudget) {
        truncated = true;
        continue;
      }
      messages.push(summaryMsg);
      usedTokens += tokens;
    }

    // ── 4. Compacted history (excluding summaries injected above) ────────────
    // Filter out any history entry that is itself an InternalSummaryMsg that
    // has already been emitted above; also filter empty content produced by
    // applySummaries().
    for (const msg of compactedHistory) {
      if (isInternalSummaryMsg(msg)) {
        continue; // Already handled in section 3.
      }
      if (msg.role !== 'tool' && !msg.content && !msg.tool_calls) {
        continue; // Empty placeholder from applySummaries() collapse.
      }
      const tokens = estimator.estimateMsg(msg);
      if (usedTokens + tokens > tokenBudget) {
        // For the history section we skip individual messages that don't fit
        // but keep going — a recent message might be small enough.
        truncated = true;
        continue;
      }
      messages.push(msg);
      usedTokens += tokens;
    }

    // ── 5. Current user request — always last ────────────────────────────────
    const requestMsg: Msg = { role: 'user', content: currentRequest };
    const requestTokens = estimator.estimateMsg(requestMsg);
    if (usedTokens + requestTokens > tokenBudget) {
      // The current request MUST be included, even if it breaks the budget.
      // This is a last-resort situation — ContextManager should have prevented it.
      truncated = true;
    }
    messages.push(requestMsg);
    usedTokens += requestTokens;

    return { messages, estimatedTokens: usedTokens, truncated };
  }
}
