/**
 * ContextSource — interface that any context-retrieval backend implements.
 *
 * Current implementations: SemanticContextSource, WorkspaceContextSource.
 * Future implementations can plug in (VectorDB, ProjectMemory, etc.) without
 * touching ContextManager.
 */

import { ContextClass } from './PriorityResolver';

// ── Result ───────────────────────────────────────────────────────────────────

export interface ContextSourceResult {
  /** The content to inject into the prompt. */
  content: string;

  /** Estimated token cost of this result. */
  tokenEstimate: number;

  /**
   * Short label shown in the context panel UI.
   * e.g. "Semantic · 1,240 tokens"  or  "Workspace · 320 tokens"
   */
  label: string;

  /**
   * Priority class. PromptBuilder orders source sections by this.
   * Semantic context is typically SemanticContext (protected).
   */
  priority: ContextClass;

  /** Source-specific metadata — passed to the UI for tooltip display. */
  metadata?: Record<string, unknown>;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ContextSource {
  /**
   * Stable id, e.g. 'semantic', 'project-memory', 'workspace'.
   * Used as a key in the context metrics breakdown.
   */
  readonly id: string;

  /**
   * Called once per ContextManager.prepare() invocation.
   * Implementations decide internally whether to re-fetch or return cached
   * results (e.g. if the query and workspace haven't changed).
   *
   * @param query   The current user query (for embedding / keyword search).
   * @param budget  Remaining token budget the source may consume. Sources
   *                should truncate their results to fit within this.
   */
  fetch(query: string, budget: number): Promise<ContextSourceResult[]>;
}
