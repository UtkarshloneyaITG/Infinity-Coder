/**
 * ITokenEstimator — interface for token counting + factory for selecting the
 * best available implementation per model.
 *
 * Ships with ApproxTokenEstimator (chars/4). A future ExactTokenEstimator
 * using tiktoken or a model-specific BPE can be swapped in by registering it
 * with TokenEstimatorFactory — all callers stay unchanged.
 */

import type { Msg } from '../agent';

/** Total and per-section breakdown returned by estimateMsgs. */
export interface TokenBreakdown {
  total: number;
  system: number;
  user: number;
  assistant: number;
  tool: number;
  other: number;
}

export interface ITokenEstimator {
  /** The model id this estimator is calibrated for, or 'approx' for the generic one. */
  readonly modelId: string;

  /** Estimate tokens for a raw string. */
  estimate(text: string): number;

  /** Estimate tokens for a single OpenAI-format message object. */
  estimateMsg(msg: Msg): number;

  /**
   * Estimate total tokens and return a per-role breakdown.
   * Useful for the context panel's "toolTokens / semanticTokens" metrics.
   */
  estimateMsgs(msgs: Msg[]): TokenBreakdown;
}
