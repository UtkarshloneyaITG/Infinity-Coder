/**
 * ContextBudget — computes the available token budget and decides which
 * compaction tier applies for the current round.
 */

import type { ITokenEstimator } from './ITokenEstimator';
import type { ModelCapabilities } from './ModelCapabilities';
import type { ContextSettings } from '../../settings';
import type { Msg } from '../agent';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CompactionTier = 'none' | 'tool' | 'summarize' | 'aggressive' | 'warn';

export interface BudgetResult {
  contextWindow: number;
  reservedOutput: number;
  usableInput: number;
  systemTokens: number;
  historyTokens: number;
  currentUsage: number;
  remaining: number;
  utilizationPct: number;
  compactionTier: CompactionTier;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Compute the budget for one prepare() round.
 *
 * @param system     The assembled system prompt string.
 * @param history    The current history (may include pending user message).
 * @param caps       Model capabilities (drives contextWindow).
 * @param settings   User context settings (drives thresholds + reservation).
 * @param estimator  Token estimator to use.
 */
export function computeBudget(
  system: string,
  history: readonly Msg[],
  caps: ModelCapabilities,
  settings: ContextSettings,
  estimator: ITokenEstimator,
): BudgetResult {
  const reservedOutput = Math.max(
    caps.minimumReservedOutput,
    settings.reservedOutputTokens,
  );

  const contextWindow = caps.contextWindow;
  const usableInput = Math.max(0, contextWindow - reservedOutput);

  const systemTokens = estimator.estimate(system);
  const historyBreakdown = estimator.estimateMsgs([...history]);
  const historyTokens = historyBreakdown.total;
  const currentUsage = systemTokens + historyTokens;
  const remaining = usableInput - currentUsage;
  const utilizationPct = usableInput > 0
    ? Math.min(100, (currentUsage / usableInput) * 100)
    : 100;

  const compactionTier = resolveCompactionTier(utilizationPct, settings);

  return {
    contextWindow,
    reservedOutput,
    usableInput,
    systemTokens,
    historyTokens,
    currentUsage,
    remaining,
    utilizationPct,
    compactionTier,
  };
}

/**
 * Map utilization percentage to a compaction tier.
 *
 * Thresholds:
 *   < compactThreshold*100    → none
 *   < 85%                     → tool
 *   < 95%                     → summarize
 *   < 98%                     → aggressive
 *   >= 98%                    → warn
 */
function resolveCompactionTier(
  utilizationPct: number,
  settings: ContextSettings,
): CompactionTier {
  if (!settings.autoCompact) {
    return 'none';
  }
  const threshold = (settings.compactThreshold ?? 0.70) * 100;
  if (utilizationPct < threshold) {
    return 'none';
  }
  if (utilizationPct < 85) {
    return 'tool';
  }
  if (utilizationPct < 95) {
    return settings.summaryEnabled ? 'summarize' : 'tool';
  }
  if (utilizationPct < 98) {
    return settings.aggressiveCompression ? 'aggressive' : 'summarize';
  }
  return 'warn';
}
