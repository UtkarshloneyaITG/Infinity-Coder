/**
 * The multi-brain orchestration contract.
 *
 * Every module in this folder talks in these shapes and nothing else, which is
 * what lets them be swapped independently: the Scheduler knows Task and
 * Proposal, never the Engine; the Consensus engine knows Proposal and Score,
 * never a provider.
 */

export type BrainRole =
  | 'planner'
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'database'
  | 'security'
  | 'performance'
  | 'testing'
  | 'documentation'
  | 'reviewer'
  | 'consensus'
  | 'custom';

/**
 * Which tools a brain may call. `allow: ['*']` means every tool the user has
 * enabled globally; `deny` always wins. The Planner's "never edits files" is
 * this, not a prompt instruction — a prompt is a request, this is a gate.
 */
export interface ToolPolicy {
  allow: string[];
  deny: string[];
}

/**
 * How the Context Builder decides what this brain sees. Brains never receive the
 * whole repository: a Security brain reviewing a diff and a Frontend brain
 * writing a component need almost disjoint slices, and sending both everything
 * is how you pay for a 200k-token prompt to get a 40-line answer.
 */
export interface ContextRules {
  /** Glob patterns, relative to the workspace root. */
  include: string[];
  exclude: string[];
  /**
   * 'globs'   — files matching include/exclude.
   * 'changed' — only paths staged by earlier tasks this run.
   * 'summary' — the project tree digest only, no file bodies.
   * 'none'    — no workspace context at all.
   */
  mode: 'globs' | 'changed' | 'summary' | 'none';
  maxFiles: number;
  maxBytes: number;
}

export interface MemoryPolicy {
  /** Keeps notes only this brain can read, carried across tasks in a run. */
  private: boolean;
  /** Reads the shared blackboard every brain writes to. */
  readsShared: boolean;
  /** May publish to the shared blackboard. */
  writesShared: boolean;
  /** Reads and writes notes that persist across runs in this workspace. */
  workspace: boolean;
}

export interface BrainDef {
  id: string;
  name: string;
  description: string;
  role: BrainRole;
  systemPrompt: string;
  /** Preferred provider id, matched against SettingsStore providers. */
  provider?: string;
  /** Tried in order when the preferred provider has no usable key. */
  fallbackProviders: string[];
  /** Preferred model id. Empty means "whatever the user's active model is". */
  model?: string;
  fallbackModels: string[];
  temperature: number;
  maxTokens: number;
  tools: ToolPolicy;
  memory: MemoryPolicy;
  contextRules: ContextRules;
  /** Higher runs first when several tasks are ready and slots are scarce. */
  priority: number;
  /** 0–1. How much the consensus engine penalises this brain's spend. */
  costWeight: number;
  /** 0–1. How much the consensus engine trusts this brain's self-reported confidence. */
  confidenceWeight: number;
  /** May share a concurrency slot with other brains. */
  parallelExecution: boolean;
  enabled: boolean;
  /** Where this brain came from, for the UI. */
  source: 'builtin' | 'installed' | 'user';
  icon?: string;
}

/** A single staged file mutation. Nothing here has touched disk yet. */
export interface FileChange {
  kind: 'write' | 'edit' | 'delete';
  /** Absolute path. */
  path: string;
  /** Workspace-relative, for display. */
  relPath: string;
  before: string | null;
  after: string | null;
}

export interface Task {
  id: string;
  title: string;
  /** What this brain is being asked to do, in full sentences. */
  instruction: string;
  brainId: string;
  /** Task ids that must complete before this one starts. */
  dependsOn: string[];
  /** How the reviewer should judge it. */
  acceptance?: string;
  /** A failure here does not fail the run. */
  optional?: boolean;
  /**
   * Run this task on N brains independently and let consensus pick. 1 = normal.
   */
  debate?: number;
}

export interface Plan {
  goal: string;
  tasks: Task[];
  notes?: string;
}

export type TaskState = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface TaskStatus {
  taskId: string;
  state: TaskState;
  brainId: string;
  /** Populated while running and kept afterwards, for the UI. */
  provider?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  confidence?: number;
  note?: string;
}

/**
 * One brain's answer to one task. The narrative fields are a SUMMARY the brain
 * writes for other brains and for the user — never a raw chain of thought, which
 * is deliberately not collected anywhere in this pipeline.
 */
export interface Proposal {
  key: string;
  taskId: string;
  brainId: string;
  provider: string;
  model: string;
  summary: string;
  reasoning: string;
  pros: string[];
  cons: string[];
  risks: string[];
  evidence: string[];
  complexity: 'low' | 'medium' | 'high';
  /** 0–1, self-reported and then weighted by the brain's confidenceWeight. */
  confidence: number;
  changes: FileChange[];
  /**
   * The brain's full reply text. Kept because some consumers need more than the
   * report block — the Planner returns a task list and the Reviewer returns
   * per-proposal scores in the same JSON object.
   */
  raw: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error?: string;
}

export type BrainMessageType =
  | 'task'
  | 'question'
  | 'answer'
  | 'proposal'
  | 'review'
  | 'criticism'
  | 'approval'
  | 'rejection'
  | 'evidence'
  | 'completion'
  | 'status';

/** Everything brains say to each other. Structured, logged, replayable. */
export interface BrainMessage {
  id: string;
  ts: number;
  type: BrainMessageType;
  /** Brain id, or 'orchestrator' / 'user'. */
  from: string;
  /** Omitted for a broadcast. */
  to?: string;
  taskId?: string;
  subject: string;
  body: string;
  data?: Record<string, unknown>;
}

/** The reviewer's judgement of one proposal, on the axes consensus weighs. */
export interface ReviewScore {
  proposalKey: string;
  /** Each 0–1. */
  quality: number;
  security: number;
  performance: number;
  architecture: number;
  tests: number;
  verdict: 'accept' | 'revise' | 'reject';
  comment: string;
}

export interface ConsensusResult {
  winner: Proposal;
  runnersUp: Proposal[];
  scores: Array<{ key: string; total: number; parts: Record<string, number> }>;
  rationale: string;
}

export interface Conflict {
  relPath: string;
  /** Proposal keys that all want to change this path. */
  contenders: string[];
  resolution: 'identical' | 'auto-merged' | 'picked' | 'unresolved';
  /** The change that survived, if any. */
  chosen?: FileChange;
  detail: string;
}

export interface RunSummary {
  runId: string;
  goal: string;
  plan: Plan;
  statuses: TaskStatus[];
  proposals: Proposal[];
  conflicts: Conflict[];
  /** The deduplicated, conflict-resolved change set awaiting approval. */
  changes: FileChange[];
  reviews: ReviewScore[];
  consensus: ConsensusResult[];
  totalCostUsd: number;
  totalTokens: number;
  startedAt: number;
  finishedAt?: number;
  state: 'planning' | 'running' | 'reviewing' | 'awaiting-approval' | 'applied' | 'cancelled' | 'failed';
  error?: string;
}

/** Everything the UI listens to. One event type, so the webview has one switch. */
export type OrchestratorEvent =
  | { type: 'run-started'; runId: string; goal: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'task-state'; status: TaskStatus }
  | { type: 'message'; message: BrainMessage }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'conflict'; conflict: Conflict }
  | { type: 'consensus'; result: ConsensusResult }
  | { type: 'awaiting-approval'; summary: RunSummary }
  | { type: 'applied'; applied: number; failed: number }
  | { type: 'run-finished'; summary: RunSummary }
  | { type: 'log'; text: string };

export interface OrchestratorOptions {
  goal: string;
  workspaceRoot: string;
  logDir: string;
  isTrusted: boolean;
  signal: AbortSignal;
  onEvent: (event: OrchestratorEvent) => void;
}

/** User-tunable orchestration knobs, persisted alongside the rest of settings. */
export interface OrchestrationSettings {
  /** Off hides the Team toggle in the chat input entirely. */
  enabled: boolean;
  maxConcurrentBrains: number;
  debateMode: boolean;
  /** Brains per debate when debateMode is on. */
  debateSize: number;
  consensusMode: 'weighted' | 'reviewer' | 'first';
  /** Milliseconds a single brain may take before it is cancelled. */
  brainTimeoutMs: number;
  retriesPerTask: number;
  /** USD. 0 disables the check. */
  runBudgetUsd: number;
  monthlyBudgetUsd: number;
  approvalPolicy: 'always' | 'on-conflict' | 'never';
  /** Per-brain overrides, keyed by brain id, merged over the definition. */
  overrides: Record<string, Partial<BrainDef>>;
  /** Extra folders scanned for installed brain packs. */
  brainRoots: string[];
  memoryLimitEntries: number;
}

export const ORCHESTRATION_DEFAULTS: OrchestrationSettings = {
  // Off until asked for. A team run costs several times a single turn, so the
  // Team toggle is not put in front of anyone who has not opted in — and a
  // button that is merely *there* gets pressed.
  enabled: false,
  // Four is the point where provider rate limits, not CPU, become the ceiling.
  maxConcurrentBrains: 4,
  debateMode: false,
  debateSize: 3,
  consensusMode: 'weighted',
  brainTimeoutMs: 5 * 60_000,
  retriesPerTask: 1,
  runBudgetUsd: 0,
  monthlyBudgetUsd: 0,
  approvalPolicy: 'always',
  overrides: {},
  brainRoots: ['~/.infinity-coder/brains'],
  memoryLimitEntries: 500,
};
