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
