/**
 * ApproxTokenEstimator — a fast, cached estimator using the chars/4 heuristic.
 *
 * Accuracy: within ~10% for English prose and code. Good enough for budget
 * decisions; the model's real usage field corrects the meter after the fact.
 *
 * WeakMap caching: once a Msg object is estimated its cost is never recomputed
 * as long as the object lives. The agent appends new messages without mutating
 * old ones, so this is safe and eliminates redundant scanning of long histories.
 */

import type { ITokenEstimator, TokenBreakdown } from './ITokenEstimator';
import type { Msg } from '../agent';

/** chars per token for the approximation. */
const CHARS_PER_TOKEN = 4;

/** Per-message fixed overhead (role field, JSON wrapping, etc.). */
const MSG_OVERHEAD = 4;

/** Approximate tokens in a string. */
function approx(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MSG_OVERHEAD;
}

/** Flatten all string content from a message (handles array content blocks). */
function msgText(msg: Msg): string {
  const c = msg.content;
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    return c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  }
  // Tool call arguments also consume tokens.
  if (msg.tool_calls) {
    return msg.tool_calls
      .map((tc: any) => (tc?.function?.arguments ?? '') + (tc?.function?.name ?? ''))
      .join('');
  }
  return '';
}

export class ApproxTokenEstimator implements ITokenEstimator {
  readonly modelId = 'approx';

  /** WeakMap so estimates are GC-d when messages are dropped from history. */
  private readonly cache = new WeakMap<object, number>();

  estimate(text: string): number {
    return approx(text);
  }

  estimateMsg(msg: Msg): number {
    const cached = this.cache.get(msg);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = approx(msgText(msg));
    this.cache.set(msg, tokens);
    return tokens;
  }

  estimateMsgs(msgs: Msg[]): TokenBreakdown {
    const breakdown: TokenBreakdown = {
      total: 0,
      system: 0,
      user: 0,
      assistant: 0,
      tool: 0,
      other: 0,
    };
    for (const msg of msgs) {
      const t = this.estimateMsg(msg);
      breakdown.total += t;
      switch (msg.role) {
        case 'system':    breakdown.system    += t; break;
        case 'user':      breakdown.user      += t; break;
        case 'assistant': breakdown.assistant += t; break;
        case 'tool':      breakdown.tool      += t; break;
        default:          breakdown.other     += t; break;
      }
    }
    return breakdown;
  }
}

/**
 * Registry for exact estimators (e.g. tiktoken-backed) keyed by model id.
 * Register before constructing any ContextManager that uses that model.
 */
const exactRegistry = new Map<string, ITokenEstimator>();

export function registerExactEstimator(estimator: ITokenEstimator): void {
  exactRegistry.set(estimator.modelId, estimator);
}

/** Shared approx instance — stateless except for the WeakMap cache. */
const SHARED_APPROX = new ApproxTokenEstimator();

/**
 * Return the best available estimator for `modelId`.
 * Falls back to the shared ApproxTokenEstimator if no exact one is registered.
 */
export function TokenEstimatorFactory(modelId: string): ITokenEstimator {
  return exactRegistry.get(modelId) ?? SHARED_APPROX;
}
