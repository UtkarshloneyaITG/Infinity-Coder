import { SettingsStore } from '../settings';
import { fallbackChain, displayName, isToolCapable, get as catalogGet } from '../catalog';
import { ChatStreamEvent } from '../types';
import { systemPrompt } from './persona';
import { toolSchemas, dispatch, ToolContext } from './tools';

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

/** A provider-side failure, carrying whether the round had already emitted. */
class ProviderError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly emitted: boolean) {
    super(message);
  }
}

interface Candidate {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface RoundResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Absolute ceiling on turns kept, independent of the token budget. */
const MAX_HISTORY_TURNS = 40;
/**
 * Leave headroom below the context limit for the system prompt, the tool schemas,
 * and the reply itself — filling the window exactly is how a turn 400s.
 */
const HISTORY_BUDGET_FRACTION = 0.6;

/**
 * Stop before the prompt actually hits the window, so the turn ends with a
 * summary we asked for rather than a provider error we didn't.
 */
const CONTEXT_STOP_FRACTION = 0.85;

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

/** Exported for the self-check only. */
export const _internals = { callSignature, MAX_REPEATED_CALLS, CONTEXT_STOP_FRACTION, FINALIZE_PROMPT };

/**
 * A status worth trying somewhere else: bad/expired key, rate limit, model not
 * present on this endpoint, or a provider-side fault. Anything else (a malformed
 * request) would fail identically everywhere, so it surfaces immediately.
 */
function isRetriable(status: number | undefined): boolean {
  if (status === undefined) {
    return true; // network error or timeout
  }
  return [401, 403, 404, 408, 409, 429].includes(status) || status >= 500;
}

function friendlyMessage(status: number | undefined, detail: string): string {
  if (status === 401 || status === 403) {
    return 'The AI service rejected the API key. Check it in Settings → Providers.';
  }
  if (status === 429) {
    return 'The AI service is rate-limiting requests. Wait a few seconds, or add a fallback key in Settings.';
  }
  if (status === 404) {
    return 'That model is not available on this provider. Pick another in Settings → Models.';
  }
  if (status !== undefined && status >= 500) {
    return `The AI service returned an error (${status}). Please try again in a moment.`;
  }
  if (status === undefined) {
    return `I couldn't reach the AI service. Check your connection. (${detail})`;
  }
  return `The AI service returned an error (${status}): ${detail}`;
}

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
    };
    const skills = opts.skills || [];
    const system = opts.systemOverride ?? systemPrompt(opts.workspaceRoot, skills, opts.planMode);
    if (skills.length > 0) {
      // Say which skills are shaping this answer — silent behaviour changes are
      // impossible to debug when a reply comes out unexpectedly different.
      opts.onEvent({
        type: 'notice',
        text: 'Using skill' + (skills.length > 1 ? 's' : '') + ': ' +
          skills.map(s => {
            const why = s.reason === 'auto' ? ' (matched)' : s.reason === 'command' ? ' (/command)' : '';
            return s.name + why;
          }).join(', '),
      });
    }
    opts.history.push({ role: 'user', content: opts.userText });

    // A turn is several rounds: sum what we generated, and take the last round's
    // prompt size as "what the context currently costs".
    let completionTokens = 0;
    let promptTokens = 0;
    let sawRealUsage = false;

    const reportUsage = (messages: Msg[]) => {
      if (!sawRealUsage) {
        promptTokens =
          estimateTokens({ content: system }) + messages.reduce((n, m) => n + estimateTokens(m), 0);
      }
      opts.onEvent({
        type: 'usage',
        usage: {
          promptTokens,
          completionTokens,
          contextLimit: settings.maxContextTokens,
          estimated: !sawRealUsage,
        },
      });
    };

    const maxRounds = Math.max(1, settings.maxToolRounds || 100);
    const contextCeiling = settings.maxContextTokens * CONTEXT_STOP_FRACTION;
    let lastSignature = '';
    let repeats = 0;

    for (let round = 0; round < maxRounds; round++) {
      const messages = [{ role: 'system', content: system }, ...opts.history];

      // Stop on the resource that actually runs out. Checked before the call so
      // we end with our own summary rather than a provider 400.
      const promptEstimate =
        estimateTokens({ content: system }) + opts.history.reduce((n, m) => n + estimateTokens(m), 0);
      if (round > 0 && promptEstimate > contextCeiling) {
        return await this.finalize('context', candidates, settings, opts, system, reportUsage);
      }

      const { result, used } = await this.runWithFailover(candidates, messages, settings, opts);

      if (result.usage) {
        sawRealUsage = true;
        completionTokens += result.usage.completion_tokens || 0;
        promptTokens = result.usage.prompt_tokens || promptTokens;
      }

      if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0) {
        // A model that asks for the identical thing over and over is stuck, and
        // will stay stuck for every remaining round. Cut it off early.
        const signature = callSignature(result.toolCalls);
        repeats = signature === lastSignature ? repeats + 1 : 0;
        lastSignature = signature;
        if (repeats >= MAX_REPEATED_CALLS - 1) {
          return await this.finalize('loop', candidates, settings, opts, system, reportUsage);
        }

        opts.history.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        });

        for (const call of result.toolCalls) {
          let args: any = {};
          try {
            args = JSON.parse(call.args || '{}');
          } catch {
            args = {};
          }
          opts.onEvent({ type: 'tool_call', name: call.name, input: args });
          const output = opts.toolFilter && !opts.toolFilter(call.name)
            ? `The tool '${call.name}' is not available on this turn.`
            : await (opts.dispatchOverride || dispatch)(call.name, args, ctx);
          opts.onEvent({ type: 'tool_result', name: call.name, result: output });
          opts.history.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
        continue; // let the model use the results
      }

      opts.history.push({ role: 'assistant', content: result.content });
      reportUsage(messages);
      trimHistory(opts.history, settings.maxContextTokens);
      void used;
      return result.content;
    }

    return await this.finalize('rounds', candidates, settings, opts, system, reportUsage);
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
    reportUsage: (messages: Msg[]) => void
  ): Promise<string> {
    opts.onEvent({ type: 'notice', text: STOP_NOTICE[reason] });

    // The directive is passed for this call only, never stored in history.
    const messages = [
      { role: 'system', content: system },
      ...opts.history,
      { role: 'user', content: FINALIZE_PROMPT[reason] },
    ];

    let summary: string;
    try {
      const { result } = await this.runWithFailover(candidates, messages, settings, opts, true);
      summary = result.content.trim();
    } catch {
      summary = '';
    }
    if (!summary) {
      // Even the summary call failed — say what happened rather than nothing.
      summary =
        reason === 'loop'
          ? 'I got stuck repeating the same step and stopped. Check the tool results above for what was done.'
          : 'I stopped before finishing. Check the tool results above for what was already changed, then ask me to continue.';
    }

    opts.history.push({ role: 'assistant', content: summary });
    reportUsage([{ role: 'system', content: system }, ...opts.history]);
    trimHistory(opts.history, settings.maxContextTokens);
    return summary;
  }

  /** Run one round, walking the candidate list on a retriable pre-emission failure. */
  private async runWithFailover(
    candidates: Candidate[],
    messages: Msg[],
    settings: ReturnType<SettingsStore['get']>,
    opts: ChatOptions,
    suppressTools = false
  ): Promise<{ result: RoundResult; used: Candidate }> {
    let lastError: ProviderError | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const result = await this.runRound(candidate, messages, settings, opts, suppressTools);
        return { result, used: candidate };
      } catch (e) {
        if (opts.signal.aborted) {
          throw e; // the user pressed stop — not a failover situation
        }
        if (!(e instanceof ProviderError) || e.emitted || !isRetriable(e.status)) {
          throw e instanceof ProviderError ? new Error(friendlyMessage(e.status, e.message)) : e;
        }
        lastError = e;
        const next = candidates[i + 1];
        if (next) {
          opts.onEvent({ type: 'notice', text: failoverNotice(candidate, next, e.status) });
        }
      }
    }

    throw new Error(
      lastError
        ? friendlyMessage(lastError.status, lastError.message)
        : 'Every configured provider failed. Check your keys in Settings.'
    );
  }

  private async runRound(
    candidate: Candidate,
    messages: Msg[],
    settings: ReturnType<SettingsStore['get']>,
    opts: ChatOptions,
    suppressTools = false
  ): Promise<RoundResult> {
    const body: any = {
      model: candidate.model,
      messages,
      temperature: opts.temperature ?? settings.temperature,
      max_tokens: opts.maxTokens ?? settings.maxTokens,
      stream: true,
      // Ask for the usage record in the final chunk. Providers that don't know
      // this option ignore it; those that do give us real token counts.
      stream_options: { include_usage: true },
    };
    // A pure-chat model rejects the `tools` param outright, so omit it there.
    // Withholding tools is also how the wrap-up round is stopped from starting
    // the work over: it cannot call what it is not given.
    if (!suppressTools && isToolCapable(candidate.model)) {
      let tools = toolSchemas(settings.toolGroups, opts.isTrusted, opts.planMode);
      if (opts.toolFilter) {
        // Withholding the schema is the real gate for a brain's tool policy;
        // the dispatch check above only catches a model calling what it was
        // never offered.
        const keep = opts.toolFilter;
        tools = tools.filter((t: any) => keep(t.function?.name));
      }
      if (tools.length > 0) {
        body.tools = tools;
      }
    }

    let res: Response;
    try {
      res = await fetch(`${candidate.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${candidate.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e: any) {
      if (opts.signal.aborted) {
        throw e;
      }
      throw new ProviderError(e?.message || 'network error', undefined, false);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(detail || res.statusText, res.status, false);
    }
    if (!res.body) {
      throw new ProviderError('empty response body', undefined, false);
    }

    const content: string[] = [];
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let emitted = false;
    let usage: RoundResult['usage'];

    try {
      for await (const chunk of sseEvents(res.body, opts.signal)) {
        // The usage record rides in a final chunk that carries no choices, so it
        // has to be read before the choices guard below.
        if (chunk?.usage) {
          usage = chunk.usage;
        }
        const choice = chunk?.choices?.[0];
        if (!choice) {
          continue;
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta || {};

        // Reasoning models stream private thinking separately; it is shown in the
        // thinking panel but is NOT part of the reply.
        if (delta.reasoning_content) {
          emitted = true;
          opts.onEvent({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          emitted = true;
          content.push(delta.content);
          opts.onEvent({ type: 'token', text: delta.content });
        }
        if (delta.tool_calls) {
          emitted = true;
          for (let i = 0; i < delta.tool_calls.length; i++) {
            const tc = delta.tool_calls[i];
            const index = tc.index ?? i;
            const slot = acc.get(index) || { id: '', name: '', args: '' };
            if (tc.id) {
              slot.id = tc.id;
            }
            if (tc.function?.name) {
              slot.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              slot.args += tc.function.arguments;
            }
            acc.set(index, slot);
          }
        }
      }
    } catch (e: any) {
      if (opts.signal.aborted) {
        throw e;
      }
      throw new ProviderError(e?.message || 'stream failed', undefined, emitted);
    }

    const toolCalls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    // Some providers stream tool calls without ever setting finish_reason.
    if (!finishReason && toolCalls.length > 0) {
      finishReason = 'tool_calls';
    }

    return { content: content.join(''), toolCalls, finishReason, usage };
  }
}

function failoverNotice(from: Candidate, to: Candidate, status: number | undefined): string {
  const why =
    status === 429 ? 'rate-limited'
    : status === 401 || status === 403 ? 'rejected the key'
    : status === 404 ? "doesn't have that model"
    : 'unavailable';

  if (from.model !== to.model) {
    return `${displayName(from.model)} ${why} — retrying on ${displayName(to.model)}.`;
  }
  if (from.providerId !== to.providerId) {
    return `${from.providerName} ${why} — retrying on ${to.providerName}.`;
  }
  return `${from.providerName} ${why} — retrying with the next key.`;
}

/** Parse an OpenAI-style `data:` SSE stream into JSON objects. */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) {
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) {
          continue; // comment, event name, or keepalive
        }
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          return;
        }
        try {
          yield JSON.parse(payload);
        } catch {
          // A partial or non-JSON frame; the next chunk usually completes it.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
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
  if (keepFrom === 0) {
    return;
  }

  // Advance to the next plain user turn so we never cut mid tool-call sequence.
  while (keepFrom < history.length) {
    const msg = history[keepFrom];
    if (msg.role === 'user' && typeof msg.content === 'string') {
      break;
    }
    keepFrom++;
  }
  // Never empty the history entirely — one oversized turn is better than none.
  if (keepFrom >= history.length) {
    return;
  }
  history.splice(0, keepFrom);
}
