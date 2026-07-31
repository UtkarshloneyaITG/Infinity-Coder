import { SettingsStore } from '../settings';
import { fallbackChain, get as catalogGet } from '../catalog';
import { ChatStreamEvent } from '../types';
import { systemPrompt } from './persona';
import { ToolContext } from './tools';
import {
  TokenEstimatorFactory,
  DefaultPriorityResolver,
  ConversationSummarizer,
  createContextManager,
  getCapabilities,
} from './context';
import type { InternalSummaryMsg } from './context/InternalSummaryMsg';
import { RequestPipeline } from './RequestPipeline';


/**
 * The agent loop — ported from backend/brain/openai_brain.py and resilient.py.
 *
 * One "round" is one streamed completion. If the model asks for tools we run
 * them, append the results, and go round again; otherwise the round's text is the
 * answer. A provider failure BEFORE a round emits anything is retried on the next
 * key, then the next provider, then a lighter model. A failure AFTER emission is
 * not retried — we cannot cleanly restart mid-output — so it surfaces as an error.
 */

export type Msg = Record<string, any>;

export interface ChatOptions {
  userText: string;
  /** OpenAI-format messages, mutated in place so the session keeps its history. */
  history: Msg[];
  workspaceRoot: string;
  logDir: string;
  isTrusted: boolean;
  /** Skill instructions to apply to this turn, already selected and read. */
  skills?: Array<{ name: string; body: string; reason: 'always' | 'auto' | 'command' }>;
  /** Omitted in auto-approve mode; see ToolContext.approve. */
  approve?: ToolContext['approve'];
  /** Absolute files included in semantic context for this turn. */
  ragFiles?: string[];
  /** Plan mode: read-only tools only, and the prompt asks for a plan. */
  planMode?: boolean;
  signal: AbortSignal;
  modelOverride?: string;
  onEvent: (event: ChatStreamEvent) => void;

  // ── Multi-brain orchestration hooks ───────────────────────────────────────
  // A brain is this same loop with a different prompt, a narrower tool set, a
  // staged filesystem and its own provider. Injecting those four things is
  // cheaper and far less risky than a second engine that would drift from this
  // one's failover, streaming and context handling.

  /** Replace the persona entirely. Skills and plan mode are then the caller's job. */
  systemOverride?: string;
  /** Restrict which tools are offered AND dispatched. Return false to withhold. */
  toolFilter?: (name: string) => boolean;
  /** Handle tool calls instead of the default dispatcher (used to stage writes). */
  dispatchOverride?: (name: string, args: any, ctx: ToolContext) => Promise<string>;
  /** Provider ids to try, in order. Empty or omitted means "all enabled providers". */
  providerOrder?: string[];
  /** Per-call sampling overrides, so one brain can run hot and another cold. */
  temperature?: number;
  maxTokens?: number;
}

/** Nothing to call with — the settings modal has no usable provider yet. */
export class NoCredentialsError extends Error {}


interface Candidate {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}


/** Absolute ceiling on turns kept, independent of the token budget. */
const MAX_HISTORY_TURNS = 40;
/**
 * Leave headroom below the context limit for the system prompt, the tool schemas,
 * and the reply itself — filling the window exactly is how a turn 400s.
 */
const HISTORY_BUDGET_FRACTION = 0.6;


/**
 * Identical consecutive tool calls mean the model is stuck, not working. Three
 * in a row is well past coincidence — a legitimate repeat (re-reading a file it
 * just wrote) does not happen with byte-identical arguments three times.
 */
const MAX_REPEATED_CALLS = 3;

type StopReason = 'rounds' | 'loop' | 'context';

/**
 * What we tell the model when we cut it off. The turn has usually done real work
 * by this point, so the goal is a useful handover — never a bare failure.
 */
const FINALIZE_PROMPT: Record<StopReason, string> = {
  rounds:
    'You have used all the tool steps allowed for this turn. Do NOT call any more ' +
    'tools. Reply directly to the user: what you created or changed (list the ' +
    'files), what you verified, and exactly what is still left to do so they can ' +
    'ask you to continue.',
  loop:
    'You have repeated the same tool call with identical arguments several times ' +
    'without making progress. Do NOT call any more tools. Tell the user what you ' +
    'were trying to do, why it kept failing, and what you need from them to get ' +
    'past it. Also summarise anything you did successfully change.',
  context:
    'This conversation is close to the context limit. Do NOT call any more tools. ' +
    'Summarise what you created or changed (list the files) and exactly what is ' +
    'left to do, so the user can continue in a fresh chat.',
};

const STOP_NOTICE: Record<StopReason, string> = {
  rounds: 'Reached the tool-step limit for this turn — wrapping up with a summary. Raise it in Settings → Tools.',
  loop: 'The model kept repeating the same tool call — stopping and summarising instead of looping.',
  context: 'Approaching the context limit — wrapping up with a summary so nothing is lost.',
};

/** Stable identity for a set of tool calls, for spotting an exact repeat. */
function callSignature(calls: Array<{ name: string; args: string }>): string {
  return calls.map(c => `${c.name}:${c.args}`).sort().join('|');
}

/**
 * Stop before the prompt actually hits the window, so the turn ends with a
 * summary we asked for rather than a provider error we didn't.
 */
const CONTEXT_STOP_FRACTION = 0.85;

/** Exported for the self-check only. */
export const _internals = { callSignature, MAX_REPEATED_CALLS, CONTEXT_STOP_FRACTION, FINALIZE_PROMPT };


export class Engine {
  constructor(private readonly settings: SettingsStore) {}

  /**
   * Every (provider, key, model) worth trying, in failover order: all keys of all
   * enabled providers on the chosen model first, then the same again on each
   * progressively lighter model. Key failover before model downgrade, so a spare
   * key is always preferred to a weaker model.
   */
  private async candidates(modelOverride?: string, providerOrder?: string[]): Promise<Candidate[]> {
    const settings = this.settings.get();
    const primary = modelOverride || settings.activeModel;

    // Only downgrade through the catalog chain when the active model is IN the
    // catalog. For an off-catalog id (a custom-endpoint model) the chain
    // would suggest unrelated NVIDIA models that no provider here would host.
    const models = catalogGet(primary) ? [primary, ...fallbackChain(primary)] : [primary];

    // A brain's preferred providers come first; the rest stay as a last resort,
    // because a task failing outright is worse than one answered by the user's
    // second-choice provider.
    const ordered = providerOrder?.length
      ? [
          ...providerOrder
            .map(id => settings.providers.find(p => p.id === id))
            .filter((p): p is (typeof settings.providers)[number] => !!p),
          ...settings.providers.filter(p => !providerOrder.includes(p.id)),
        ]
      : settings.providers;

    const out: Candidate[] = [];
    for (const model of models) {
      for (const provider of ordered) {
        if (!provider.enabled || provider.keys.length === 0) {
          continue;
        }
        for (const meta of provider.keys) {
          const apiKey = await this.settings.getKey(meta.id);
          if (!apiKey) {
            continue; // metadata row with no secret behind it — skip, don't fail
          }
          out.push({
            providerId: provider.id,
            providerName: provider.name,
            baseUrl: provider.baseUrl.replace(/\/+$/, ''),
            apiKey,
            model,
          });
        }
      }
    }
    return out;
  }

  public async chat(opts: ChatOptions): Promise<string> {
    const settings = this.settings.get();
    const candidates = await this.candidates(opts.modelOverride, opts.providerOrder);
    if (candidates.length === 0) {
      throw new NoCredentialsError(
        'No API key configured. Open Settings (the gear icon) and add a key under Providers.'
      );
    }

    const ctx: ToolContext = {
      workspaceRoot: opts.workspaceRoot,
      logDir: opts.logDir,
      isTrusted: opts.isTrusted,
      planMode: opts.planMode,
      approve: opts.approve,
      ragFiles: opts.ragFiles?.length ? new Set(opts.ragFiles) : undefined,
      readRanges: new Map(),
      pendingEditVerifications: new Map(),
    };
    const skills = opts.skills || [];
    const system = opts.systemOverride ?? systemPrompt(opts.workspaceRoot, skills, opts.planMode);
    if (skills.length > 0) {
      opts.onEvent({
        type: 'notice',
        text: 'Using skill' + (skills.length > 1 ? 's' : '') + ': ' +
          skills.map(s => {
            const why = s.reason === 'auto' ? ' (matched)' : s.reason === 'command' ? ' (/command)' : '';
            return s.name + why;
          }).join(', '),
      });
    }

    // ── Context Manager setup ─────────────────────────────────────────────────
    const activeModel = opts.modelOverride || settings.activeModel;
    const estimator = TokenEstimatorFactory(activeModel);
    const caps = getCapabilities(activeModel, settings.maxContextTokens);
    const resolver = new DefaultPriorityResolver();

    // Per-session summarizer: tracks lastSummarizedIndex across rounds.
    const pipeline = new RequestPipeline({
      candidates,
      toolContext: ctx,
      settings: {
        temperature: opts.temperature ?? settings.temperature,
        maxTokens: opts.maxTokens ?? settings.maxTokens,
        toolGroups: settings.toolGroups,
        maxToolRounds: settings.maxToolRounds,
        isTrusted: opts.isTrusted,
        planMode: opts.planMode,
      },
      toolFilter: opts.toolFilter,
      dispatchOverride: opts.dispatchOverride,
    });

    const summarizer = new ConversationSummarizer(pipeline, estimator);
    const manager = createContextManager(
      settings.context,
      caps,
      estimator,
      resolver,
      summarizer,
      [],  // ContextSource array — semantic source wired up in a later PR
    );

    // Summary messages accumulated across all rounds of this turn.
    const sessionSummaries: InternalSummaryMsg[] = [];

    // ── Multi-round agent loop ────────────────────────────────────────────────
    const maxRounds = Math.max(1, settings.maxToolRounds || 100);
    let lastSignature = '';
    let repeats = 0;
    let completionTokens = 0;
    let promptTokens = 0;
    let sawRealUsage = false;

    const reportUsage = (usedPrompt: number, usedCompletion: number, estimated: boolean) => {
      opts.onEvent({
        type: 'usage',
        usage: {
          promptTokens: usedPrompt,
          completionTokens: usedCompletion,
          contextLimit: caps.contextWindow,
          estimated,
        },
      });
    };

    for (let round = 0; round < maxRounds; round++) {
      // ── Build optimized context ──────────────────────────────────────────
      const optimized = await manager.prepare(
        opts.history,
        system,
        opts.userText,
        sessionSummaries,
        opts.signal,
      );

      // Emit context metrics so the UI can update its panel.
      opts.onEvent({ type: 'context_metrics', metrics: optimized.metrics });

      // Emit compaction notice if something was actually removed.
      if (optimized.metrics.compactionOccurred) {
        const { compressionSaved, summarizedTokens, aggressiveSaved } = optimized.metrics;
        opts.onEvent({
          type: 'compaction',
          saved: compressionSaved,
          summarized: summarizedTokens,
          compressed: aggressiveSaved,
        });
        if (compressionSaved + summarizedTokens + aggressiveSaved > 0) {
          opts.onEvent({
            type: 'notice',
            text: `Context optimized: ${compressionSaved + summarizedTokens + aggressiveSaved} tokens freed` +
              (summarizedTokens > 0 ? ` (${summarizedTokens} summarized)` : '') + '.',
          });
        }
      }

      // Merge new summaries produced this round into the running list.
      sessionSummaries.push(...optimized.newSummaries);

      // Warn tier: context over-full, emit notice and attempt finalization.
      if (optimized.metrics.compactionTier === 'warn') {
        return await this.finalize('context', candidates, settings, opts, system, promptTokens, completionTokens, sawRealUsage, caps.contextWindow);
      }

      // ── Execute one pipeline round ───────────────────────────────────────
      const pipelineResult = await pipeline.execute(optimized.messages, {
        signal: opts.signal,
        onEvent: opts.onEvent,
        suppressTools: false,
        maxContinuations: 3,
      });

      if (pipelineResult.usage) {
        sawRealUsage = true;
        completionTokens += pipelineResult.usage.completion_tokens || 0;
        promptTokens = pipelineResult.usage.prompt_tokens || promptTokens;
      } else if (!sawRealUsage) {
        promptTokens = optimized.metrics.currentUsage;
      }

      reportUsage(promptTokens, completionTokens, !sawRealUsage);

      // Loop detected by pipeline.
      if (pipelineResult.finishReason === 'loop_detected') {
        // Append what was emitted before the loop was detected.
        opts.history.push({ role: 'assistant', content: pipelineResult.content });
        return await this.finalize('loop', candidates, settings, opts, system, promptTokens, completionTokens, sawRealUsage, caps.contextWindow);
      }

      // Rounds exhausted — pipeline returned after maxToolRounds.
      if (pipelineResult.toolRounds >= settings.maxToolRounds && pipelineResult.finishReason !== 'stop') {
        opts.history.push({ role: 'assistant', content: pipelineResult.content });
        return await this.finalize('rounds', candidates, settings, opts, system, promptTokens, completionTokens, sawRealUsage, caps.contextWindow);
      }

      // Normal stop — record the turn and return.
      opts.history.push({ role: 'user', content: opts.userText });
      opts.history.push({ role: 'assistant', content: pipelineResult.content });
      trimHistory(opts.history, settings.maxContextTokens);
      return pipelineResult.content;
    }

    return await this.finalize('rounds', candidates, settings, opts, system, promptTokens, completionTokens, sawRealUsage, caps.contextWindow);
  }

  /**
   * End a turn that hit a limit. Instead of discarding everything with a canned
   * failure, ask the model — with tools withheld so it cannot start again — for a
   * summary of what it changed and what is left. By this point the turn has
   * usually written real files; the user needs to know which.
   */
  private async finalize(
    reason: StopReason,
    candidates: Candidate[],
    settings: ReturnType<SettingsStore['get']>,
    opts: ChatOptions,
    system: string,
    promptTokens: number,
    completionTokens: number,
    sawRealUsage: boolean,
    contextLimit: number,
  ): Promise<string> {
    opts.onEvent({ type: 'notice', text: STOP_NOTICE[reason] });

    // The directive is passed for this call only, never stored in history.
    const messages = [
      { role: 'system', content: system },
      ...opts.history,
      { role: 'user', content: FINALIZE_PROMPT[reason] },
    ];

    const pipeline = new RequestPipeline({
      candidates,
      toolContext: {
        workspaceRoot: opts.workspaceRoot,
        logDir: opts.logDir,
        isTrusted: opts.isTrusted,
      },
      settings: {
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        toolGroups: settings.toolGroups,
        maxToolRounds: 1,
      },
    });

    let summary: string;
    try {
      const result = await pipeline.execute(messages, {
        signal: opts.signal,
        onEvent: opts.onEvent,
        suppressTools: true,
        maxContinuations: 0,
      });
      summary = result.content.trim();
    } catch {
      summary = '';
    }
    if (!summary) {
      summary =
        reason === 'loop'
          ? 'I got stuck repeating the same step and stopped. Check the tool results above for what was done.'
          : 'I stopped before finishing. Check the tool results above for what was already changed, then ask me to continue.';
    }

    opts.history.push({ role: 'assistant', content: summary });
    opts.onEvent({
      type: 'usage',
      usage: {
        promptTokens,
        completionTokens,
        contextLimit,
        estimated: !sawRealUsage,
      },
    });
    trimHistory(opts.history, settings.maxContextTokens);
    return summary;
  }
}

/**
 * Rough token count. ~4 characters per token holds well enough for English and
 * code to size a budget; it is not a tokenizer and is not meant to be one.
 *
 * ponytail: swap in a real BPE tokenizer only if the estimate proves to cause
 * real overflows — that means a dependency and per-model vocabularies.
 */
export function estimateTokens(message: Msg): number {
  let chars = (typeof message.content === 'string' ? message.content : '').length;
  for (const call of message.tool_calls || []) {
    chars += (call.function?.name?.length || 0) + (call.function?.arguments?.length || 0);
  }
  return Math.ceil(chars / 4) + 4; // +4 for the per-message role/format overhead
}

/**
 * Keep the history inside the context budget without orphaning a tool message
 * from the assistant message that requested it — we only ever cut at a plain user
 * turn, so the history never starts on a dangling tool result.
 *
 * Bounded by tokens rather than message count: twenty turns of large file reads
 * will overflow a small window long before twenty short turns would.
 */
export function trimHistory(history: Msg[], maxContextTokens = 128_000): void {
  const budget = Math.max(1000, Math.floor(maxContextTokens * HISTORY_BUDGET_FRACTION));

  // Walk backwards, keeping the newest messages until the budget runs out.
  let total = 0;
  let keepFrom = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += estimateTokens(history[i]);
    if (total > budget || history.length - i > MAX_HISTORY_TURNS * 2) {
      keepFrom = i + 1;
      break;
    }
  }

  // Never drop the system prompt if one was placed in position 0.
  if (keepFrom > 0) {
    // Cut back to the nearest plain user turn.
    while (keepFrom < history.length && history[keepFrom].role !== 'user') {
      keepFrom++;
    }
    if (keepFrom > 0 && keepFrom < history.length) {
      history.splice(0, keepFrom);
    }
  }
}
