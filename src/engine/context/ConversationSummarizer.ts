/**
 * ConversationSummarizer — produces structured InternalSummaryMsg objects
 * by calling an injected ILLMService.
 *
 * The summarizer is completely provider-agnostic: it only knows about Msg[]
 * and a simple "complete" function it can call. The concrete ILLMService
 * implementation in Engine adapts runWithFailover() to satisfy this interface.
 */

import type { Msg } from '../agent';
import type { InternalSummaryMsg } from './InternalSummaryMsg';
import type { ITokenEstimator } from './ITokenEstimator';

// ── ILLMService ───────────────────────────────────────────────────────────────

/**
 * Minimal interface for calling the LLM.  Injected into ConversationSummarizer
 * so it can be replaced with a stub in tests.
 */
export interface ILLMService {
  /**
   * Send a minimal chat and return the model's text response.
   * Should have tools disabled (suppressTools=true) and a short max_tokens.
   */
  complete(messages: Msg[], signal: AbortSignal): Promise<string>;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a context-compression assistant.
Your job is to produce a dense, factual summary of a conversation excerpt.

Rules:
- Output ONLY a JSON object: { "topic": "...", "summary": "..." }
- topic: 2-4 word label for this conversation segment (e.g. "Auth setup", "DB schema design")
- summary: dense paragraph, no bullet points, no markdown, no more than 150 words
- Preserve every fact that a developer would need to continue the task
- Do NOT include pleasantries or meta-commentary
- Do NOT include the word "summary" in the topic`;

function buildSummaryRequest(turns: Msg[]): Msg[] {
  const excerpt = turns
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => `${m.role.toUpperCase()}: ${String(m.content).slice(0, 800)}`)
    .join('\n\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Summarize this conversation excerpt:\n\n${excerpt}` },
  ];
}

function parseSummaryResponse(raw: string): { topic: string; summary: string } | null {
  const jsonMatch = raw.match(/\{[\s\S]*"topic"[\s\S]*"summary"[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.topic === 'string' && typeof parsed.summary === 'string') {
      return { topic: parsed.topic.slice(0, 60), summary: parsed.summary.slice(0, 1_000) };
    }
  } catch {
    // fall through
  }
  return null;
}

// ── ConversationSummarizer ────────────────────────────────────────────────────

export class ConversationSummarizer {
  /** Index of the last message already covered by a summary. */
  private lastSummarizedIndex = -1;

  constructor(
    private readonly llm: ILLMService,
    private readonly estimator: ITokenEstimator,
  ) {}

  /**
   * Summarize conversation turns that are not yet covered by an existing summary.
   *
   * @param history         The full original history (read-only).
   * @param existingSummaries  Summaries already produced in prior rounds.
   * @param recentDepth     Number of recent turns to leave verbatim.
   * @param signal          AbortSignal from the parent turn.
   * @returns New InternalSummaryMsg objects (empty array if nothing to summarize).
   */
  async summarize(
    history: readonly Msg[],
    existingSummaries: InternalSummaryMsg[],
    recentDepth: number,
    signal: AbortSignal,
  ): Promise<InternalSummaryMsg[]> {
    // Find the coverage boundary from existing summaries.
    const covered = existingSummaries.flatMap(s => [...s.covering]);
    const maxCovered = covered.length > 0 ? Math.max(...covered) : -1;

    // The "recent" window we leave alone.
    const recentStart = Math.max(0, history.length - recentDepth * 2);

    // Collect messages that are: not yet covered, not in the recent window,
    // and are user/assistant turns (tool results are too noisy for summaries).
    const eligible: Array<{ msg: Msg; index: number }> = [];
    for (let i = maxCovered + 1; i < recentStart; i++) {
      const msg = history[i];
      if (!msg) {
        continue;
      }
      if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
        eligible.push({ msg, index: i });
      }
    }

    if (eligible.length < 2) {
      return []; // Not enough material to summarize.
    }

    // Bail early if aborted.
    if (signal.aborted) {
      return [];
    }

    // Count original tokens.
    const originalTokens = eligible.reduce(
      (sum, { msg }) => sum + this.estimator.estimateMsg(msg),
      0,
    );

    // Ask the LLM for a summary.
    const request = buildSummaryRequest(eligible.map(e => e.msg));
    let raw: string;
    try {
      raw = await this.llm.complete(request, signal);
    } catch {
      // Summary failure must never kill the turn.
      return [];
    }

    const parsed = parseSummaryResponse(raw);
    if (!parsed) {
      return [];
    }

    const summaryContent = parsed.summary;
    const summaryTokens = this.estimator.estimate(summaryContent);

    // Only keep the summary if it actually saves tokens.
    if (summaryTokens >= originalTokens) {
      return [];
    }

    const newSummary: InternalSummaryMsg = {
      _type: 'summary',
      topic: parsed.topic,
      content: summaryContent,
      covering: eligible.map(e => e.index),
      createdAt: Date.now(),
      originalTokens,
      summaryTokens,
    };

    this.lastSummarizedIndex = Math.max(...eligible.map(e => e.index));
    return [newSummary];
  }
}
