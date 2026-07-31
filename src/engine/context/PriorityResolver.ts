/**
 * ContextClass — named enum for every category of context content.
 * PriorityResolver — maps messages to ContextClass and scores them.
 *
 * Using a named enum instead of raw numeric priorities means:
 * - code reads "this message is CurrentRequest" not "priority=100"
 * - policy overrides are structural, not magic-number patches
 * - new classes can be added without renumbering everything else
 */

import type { Msg } from '../agent';
import type { InternalSummaryMsg } from './InternalSummaryMsg';
import { isInternalSummaryMsg } from './InternalSummaryMsg';

// ── ContextClass ─────────────────────────────────────────────────────────────

export enum ContextClass {
  CurrentRequest     = 'current_request',
  AttachedFile       = 'attached_file',
  ActiveToolResult   = 'active_tool_result',
  SemanticContext    = 'semantic_context',
  ActivePlan         = 'active_plan',
  RecentConversation = 'recent_conversation',
  Summary            = 'summary',
  OldConversation    = 'old_conversation',
  Greeting           = 'greeting',
}

// ── Policy ───────────────────────────────────────────────────────────────────

export interface ClassPolicy {
  /** Numeric score — higher means preserved first during compaction. */
  score: number;
  /** Protected classes are NEVER removed or compacted, regardless of budget. */
  protected: boolean;
}

export type ContextPolicy = Record<ContextClass, ClassPolicy>;

export const DEFAULT_POLICY: ContextPolicy = {
  [ContextClass.CurrentRequest]:     { score: 100, protected: true  },
  [ContextClass.AttachedFile]:       { score:  95, protected: true  },
  [ContextClass.ActiveToolResult]:   { score:  90, protected: true  },
  [ContextClass.SemanticContext]:    { score:  85, protected: true  },
  [ContextClass.ActivePlan]:        { score:  80, protected: true  },
  [ContextClass.RecentConversation]: { score:  70, protected: false },
  [ContextClass.Summary]:            { score:  50, protected: false },
  [ContextClass.OldConversation]:    { score:  30, protected: false },
  [ContextClass.Greeting]:           { score:  10, protected: false },
};

// ── PriorityResolver ─────────────────────────────────────────────────────────

export interface PriorityResolver {
  /**
   * Classify a message by inspecting its role, content, and position in the
   * history (index and total length).
   */
  classify(
    msg: Msg | InternalSummaryMsg,
    index: number,
    totalMessages: number,
  ): ContextClass;

  /** Numeric score for a class, from the injected policy. */
  score(cls: ContextClass): number;

  /** Whether a class is protected under the current policy. */
  isProtected(cls: ContextClass): boolean;
}

// How many recent assistant/user pairs are "recent" vs "old".
const DEFAULT_RECENT_DEPTH = 10;

/**
 * Minimal greeting patterns.  A "Hello" or "Hi, can you help?" at the start
 * of a session adds context noise once the conversation is deep; scoring it
 * low lets compaction drop it first.
 */
const GREETING_RE = /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening)|thanks?|thank\s+you)[.!,\s]*$/i;

function looksLikeGreeting(content: string): boolean {
  return GREETING_RE.test(content.trim()) && content.trim().length < 60;
}

function isAttachedFile(msg: Msg): boolean {
  // The sidebar injects @-mention files as user messages with a specific header.
  return msg.role === 'user' && typeof msg.content === 'string' &&
    (msg.content.startsWith('```') && msg.content.includes('\n')) ||
    (msg.content as string).startsWith('[File:');
}

function isActivePlan(msg: Msg): boolean {
  return msg.role === 'assistant' && typeof msg.content === 'string' &&
    (msg.content as string).includes('[PLAN MODE]');
}

/**
 * DefaultPriorityResolver — production implementation.
 *
 * To override for a specific brain or skill:
 * ```ts
 * new DefaultPriorityResolver({
 *   ...DEFAULT_POLICY,
 *   [ContextClass.RecentConversation]: { score: 80, protected: true },
 * }, recentDepth: 15)
 * ```
 */
export class DefaultPriorityResolver implements PriorityResolver {
  constructor(
    private readonly policy: ContextPolicy = DEFAULT_POLICY,
    private readonly recentDepth: number = DEFAULT_RECENT_DEPTH,
  ) {}

  classify(
    msg: Msg | InternalSummaryMsg,
    index: number,
    totalMessages: number,
  ): ContextClass {
    // InternalSummaryMsg is always classified as Summary.
    if (isInternalSummaryMsg(msg)) {
      return ContextClass.Summary;
    }

    const m = msg as Msg;

    // The very last message (current user request).
    if (index === totalMessages - 1 && m.role === 'user') {
      return ContextClass.CurrentRequest;
    }

    // @-mention / pasted file blocks.
    if (isAttachedFile(m)) {
      return ContextClass.AttachedFile;
    }

    // Tool results: active (last 2 tool rounds) vs older.
    if (m.role === 'tool') {
      const distanceFromEnd = totalMessages - 1 - index;
      return distanceFromEnd <= 4 ? ContextClass.ActiveToolResult : ContextClass.OldConversation;
    }

    // Assistant messages with plan-mode content.
    if (isActivePlan(m)) {
      return ContextClass.ActivePlan;
    }

    // Recent conversation (last N turns from the end, excluding the current request).
    const distanceFromEnd = totalMessages - 1 - index;
    if (distanceFromEnd <= this.recentDepth * 2) {
      return ContextClass.RecentConversation;
    }

    // Greetings at the very beginning of the session.
    if (index < 4 && m.role === 'user' && looksLikeGreeting(String(m.content ?? ''))) {
      return ContextClass.Greeting;
    }

    return ContextClass.OldConversation;
  }

  score(cls: ContextClass): number {
    return this.policy[cls]?.score ?? 0;
  }

  isProtected(cls: ContextClass): boolean {
    return this.policy[cls]?.protected ?? false;
  }
}
