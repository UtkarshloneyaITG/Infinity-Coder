/**
 * ContextMetrics — typed snapshot of context state for one prepare() call.
 *
 * Emitted as a `context_metrics` ChatStreamEvent so the webview can render
 * an accurate, live context bar without polling.
 */

export interface ContextMetrics {
  // ── Window ────────────────────────────────────────────────────────────────

  /** The actual context window for the active model (from ModelCapabilities). */
  contextWindow: number;

  /** Tokens reserved for the model's reply. */
  reservedOutput: number;

  /** contextWindow - reservedOutput */
  usableInput: number;

  // ── Usage ─────────────────────────────────────────────────────────────────

  /** Estimated total tokens sent this round (system + history + sources). */
  currentUsage: number;

  /** usableInput - currentUsage (can be negative if context is over-full). */
  remaining: number;

  /** 0–100. currentUsage / usableInput × 100. */
  utilizationPct: number;

  // ── Breakdown ─────────────────────────────────────────────────────────────

  /** Tokens in tool result messages. */
  toolTokens: number;

  /** Tokens contributed by ContextSource results (semantic, workspace, etc.). */
  semanticTokens: number;

  /** Tokens in the system prompt. */
  systemTokens: number;

  /** Tokens in all history messages (excluding sources). */
  historyTokens: number;

  // ── Compaction ────────────────────────────────────────────────────────────

  /** Active compaction tier for this round. */
  compactionTier: 'none' | 'tool' | 'summarize' | 'aggressive' | 'warn';

  /** Whether compaction actually ran this round. */
  compactionOccurred: boolean;

  /** Total tokens removed by compacting large tool outputs. */
  compressionSaved: number;

  /** Tokens in original messages replaced by summaries. */
  summarizedTokens: number;

  /** Tokens saved by aggressive truncation. */
  aggressiveSaved: number;

  // ── Summaries ─────────────────────────────────────────────────────────────

  /** Number of InternalSummaryMsg objects currently active in this session. */
  activeSummaries: number;
}

/** Zero-value baseline for initializing before any computation. */
export const EMPTY_METRICS: ContextMetrics = {
  contextWindow: 0,
  reservedOutput: 0,
  usableInput: 0,
  currentUsage: 0,
  remaining: 0,
  utilizationPct: 0,
  toolTokens: 0,
  semanticTokens: 0,
  systemTokens: 0,
  historyTokens: 0,
  compactionTier: 'none',
  compactionOccurred: false,
  compressionSaved: 0,
  summarizedTokens: 0,
  aggressiveSaved: 0,
  activeSummaries: 0,
};
