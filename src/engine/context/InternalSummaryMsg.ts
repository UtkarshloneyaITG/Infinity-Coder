/**
 * A typed summary message — an internal-only representation of a compacted
 * conversation segment.
 *
 * Unlike injecting a fake `role: 'user'` message into the raw history,
 * InternalSummaryMsg is a first-class typed object. The PromptBuilder converts
 * it to an OpenAI-format message at the last possible moment, keeping the
 * session history clean and rollback-friendly.
 */

export interface InternalSummaryMsg {
  /** Discriminant so callers can distinguish summaries from OpenAI messages. */
  readonly _type: 'summary';

  /**
   * Human-readable topic label shown in the context panel.
   * e.g. "Authentication", "Database schema", "File structure"
   */
  readonly topic: string;

  /**
   * The summary text produced by the ConversationSummarizer.
   * Injected verbatim into the prompt wrapped with a header prefix.
   */
  readonly content: string;

  /**
   * Zero-based indices into the original `history[]` array that this summary
   * replaces. Stored so a future tool can re-expand a summary into its
   * original messages for debugging or export.
   */
  readonly covering: readonly number[];

  /** Unix epoch ms when this summary was produced. */
  readonly createdAt: number;

  /**
   * Approximate token count of the ORIGINAL messages this summary replaced.
   * Lets the UI show "saved N tokens".
   */
  readonly originalTokens: number;

  /** Approximate token count of the summary itself. */
  readonly summaryTokens: number;
}

/**
 * The prefix PromptBuilder prepends when converting an InternalSummaryMsg
 * to an OpenAI-format user message.  Models read it as meta-context, not a
 * real user turn.
 */
export const SUMMARY_PREFIX = '[Conversation Summary';

/**
 * Build the OpenAI-compatible content string for a summary message.
 * Keeps the format consistent across the codebase.
 */
export function summaryContent(msg: InternalSummaryMsg): string {
  return `${SUMMARY_PREFIX} — ${msg.topic}]: ${msg.content}`;
}

/** Type guard. */
export function isInternalSummaryMsg(v: unknown): v is InternalSummaryMsg {
  return typeof v === 'object' && v !== null && (v as any)._type === 'summary';
}
