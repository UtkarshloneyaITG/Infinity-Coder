export type Role = 'user' | 'assistant' | 'system';

export interface ToolEvent {
  type: 'tool_call' | 'tool_result';
  name: string;
  input?: Record<string, unknown>;
  result?: string;
}

export interface MessageBlock {
  type: 'reasoning' | 'tool' | 'text' | 'approval';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string;
  done?: boolean;
  /** Approval blocks only — an inline request to change a file. */
  approval?: ApprovalBlock;
}

export interface ApprovalBlock {
  id: string;
  kind: 'write' | 'edit' | 'delete';
  path: string;
  relPath: string;
  /** Approximate line counts, for the "+12 −3" badge. */
  added: number;
  removed: number;
  /**
   * 'expired' is a card that outlived the turn that created it — the window was
   * reloaded, or the session was closed, while it was still waiting. Nothing can
   * answer it any more, so it must stop looking clickable.
   */
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  /** What the user typed when rejecting, if anything. */
  feedback?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  toolEvents?: ToolEvent[];
  reasoning?: string;
  blocks?: MessageBlock[];
  notices?: string[];
  usage?: UsageInfo;
  streaming?: boolean;
  error?: boolean;
  /**
   * This reply is a plan produced in plan mode, so it gets the Approve / Edit
   * bar. Cleared once answered, which is what stops an old plan in the scrolled-
   * back history from still looking actionable.
   */
  plan?: 'pending' | 'approved' | 'dismissed';
}

export interface UsageInfo {
  /** Tokens the provider billed for the prompt on the last round of the turn. */
  promptTokens: number;
  /** Completion tokens summed across every round of the turn. */
  completionTokens: number;
  /** The configured context budget, for the "used / limit" meter. */
  contextLimit: number;
  /** True when the numbers are estimated because the provider reported none. */
  estimated: boolean;
}

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'notice'; text: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'context_metrics'; metrics: ContextMetrics }
  | { type: 'compaction'; saved: number; summarized: number; compressed: number }
  | { type: 'done'; content: string }
  | { type: 'error'; message: string };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: string;
  tools: boolean;
  contextWindow: number;
  description?: string;
}

export interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  enabled: boolean;
}

/** Engine readiness pushed to the webview. `connected` = a usable API key exists. */
export interface EngineStatus {
  connected: boolean;
  engine: string;
  model: string;
  engineReady: boolean;
  responseLanguage: string;
}

/**
 * Live context metrics emitted as a `context_metrics` ChatStreamEvent every
 * agent round. The webview uses this to render an accurate, real-time context bar.
 */
export interface ContextMetrics {
  /** The active model's actual context window in tokens. */
  contextWindow: number;
  /** Tokens reserved for the model's reply. */
  reservedOutput: number;
  /** contextWindow - reservedOutput */
  usableInput: number;
  /** Estimated total tokens sent this round. */
  currentUsage: number;
  /** usableInput - currentUsage (can be negative if context is over-full). */
  remaining: number;
  /** 0–100. currentUsage / usableInput × 100. */
  utilizationPct: number;
  /** Tokens in tool result messages. */
  toolTokens: number;
  /** Tokens contributed by context sources (semantic, workspace, etc.). */
  semanticTokens: number;
  /** Tokens in the system prompt. */
  systemTokens: number;
  /** Tokens in all history messages (excluding sources). */
  historyTokens: number;
  /** Active compaction tier for this round. */
  compactionTier: 'none' | 'tool' | 'summarize' | 'aggressive' | 'warn';
  /** Whether compaction actually ran this round. */
  compactionOccurred: boolean;
  /** Tokens removed by compacting large tool outputs. */
  compressionSaved: number;
  /** Tokens replaced by summaries. */
  summarizedTokens: number;
  /** Tokens saved by aggressive truncation. */
  aggressiveSaved: number;
  /** Number of active InternalSummaryMsg objects in this session. */
  activeSummaries: number;
}
