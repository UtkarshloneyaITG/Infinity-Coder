/**
 * Public export surface for the context subsystem.
 *
 * Import from here rather than individual modules to keep coupling shallow.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type { ITokenEstimator, TokenBreakdown } from './ITokenEstimator';
export type { ContextMetrics } from './ContextMetrics';
export type { ContextSource, ContextSourceResult } from './ContextSource';
export type { PriorityResolver, ContextPolicy, ClassPolicy } from './PriorityResolver';
export type { BudgetResult, CompactionTier } from './ContextBudget';
export type { ModelCapabilities } from './ModelCapabilities';
export type { OptimizedContext, ContextManagerOptions } from './ContextManager';
export type { ILLMService } from './ConversationSummarizer';
export type { PromptBuildParams, PromptBuildResult } from './PromptBuilder';

// ── Enums + Constants ─────────────────────────────────────────────────────────
export { ContextClass, DEFAULT_POLICY } from './PriorityResolver';
export { EMPTY_METRICS } from './ContextMetrics';
export { SUMMARY_PREFIX, summaryContent, isInternalSummaryMsg } from './InternalSummaryMsg';

// ── Classes ───────────────────────────────────────────────────────────────────
export { ApproxTokenEstimator, TokenEstimatorFactory, registerExactEstimator } from './ApproxTokenEstimator';
export { DefaultPriorityResolver } from './PriorityResolver';
export { ContextCompactor } from './ContextCompactor';
export { ConversationSummarizer } from './ConversationSummarizer';
export { PromptBuilder } from './PromptBuilder';
export { ContextManager, createContextManager } from './ContextManager';
export { SemanticContextSource } from './SemanticContextSource';

// ── Functions ─────────────────────────────────────────────────────────────────
export { computeBudget } from './ContextBudget';
export { getCapabilities } from './ModelCapabilities';
