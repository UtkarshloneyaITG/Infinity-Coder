/**
 * IRequestPipeline — interface for the unified provider execution layer.
 *
 * Replaces the ad-hoc continuation + tool-loop logic that was scattered
 * inside Engine.chat(). One implementation handles:
 *   - calling runWithFailover
 *   - auto-continuing when finishReason=length
 *   - dispatching tool calls and looping back
 *   - enforcing MAX_TOOL_ROUNDS
 *
 * Alternative implementations (stub, test double, multi-brain, etc.) can be
 * swapped in without touching the caller.
 */

import type { ChatStreamEvent } from '../types';
import type { Msg } from './agent';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RoundUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface PipelineResult {
  /** Final assistant text (all rounds concatenated). */
  content: string;
  /** finishReason from the last round: 'stop' | 'tool_calls' | 'length' | … */
  finishReason: string | null;
  /** Token usage from the last provider call (may be undefined if not reported). */
  usage?: RoundUsage;
  /** Total tool rounds executed. */
  toolRounds: number;
  /** Total continuation rounds (finishReason=length) consumed. */
  continuationRounds: number;
}

export interface PipelineOpts {
  /** Abort signal — honours user cancel mid-stream. */
  signal: AbortSignal;
  /** Streaming event emitter forwarded from Engine.chat(). */
  onEvent: (event: ChatStreamEvent) => void;
  /**
   * When true, the pipeline does not offer tool schemas to the model.
   * Used for finalization / summary calls that must not start new work.
   */
  suppressTools?: boolean;
  /**
   * Hard cap on automatic length-continuations.
   * Defaults to 3 if not specified.
   */
  maxContinuations?: number;
}

export interface IRequestPipeline {
  /**
   * Execute a completion against the messages array.
   *
   * The pipeline mutates `messages` in-place (appending tool results and
   * continuation prompts) so the caller can inspect the full turn history
   * after the call completes.
   */
  execute(messages: Msg[], opts: PipelineOpts): Promise<PipelineResult>;
}
