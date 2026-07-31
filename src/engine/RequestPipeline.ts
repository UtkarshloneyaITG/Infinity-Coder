/**
 * RequestPipeline — the default IRequestPipeline implementation.
 *
 * Absorbs all three execution concerns that were previously scattered in
 * Engine.chat():
 *
 *   1. Provider failover  (runWithFailover)
 *   2. Auto-continuation  (finishReason === 'length')
 *   3. Tool call loop     (finishReason === 'tool_calls')
 *
 * Engine.chat() becomes a thin orchestrator that builds candidates + context
 * and then delegates all round logic here.
 *
 * ConversationSummarizer's ILLMService is also satisfied by this class — when
 * suppressTools=true it makes a short, non-streaming completion.
 */

import type { IRequestPipeline, PipelineResult, PipelineOpts, RoundUsage } from './IRequestPipeline';
import type { Msg } from './agent';
import type { ChatStreamEvent } from '../types';
import type { ToolContext } from './tools/common';
import type { ILLMService } from './context/ConversationSummarizer';
import { toolSchemas, dispatch } from './tools';
import { isToolCapable, displayName } from '../catalog';

// ── Types re-used from agent.ts ───────────────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REPEATED_CALLS = 3;
const DEFAULT_MAX_CONTINUATIONS = 3;
const CONTINUATION_PROMPT =
  'Your previous response hit the output token limit mid-way. ' +
  'Please continue directly from where you stopped without repeating yourself.';

// ── Helpers ───────────────────────────────────────────────────────────────────

function callSignature(calls: Array<{ name: string; args: string }>): string {
  return calls.map(c => `${c.name}:${c.args}`).sort().join('|');
}

function isRetriable(status: number | undefined): boolean {
  if (status === undefined) {
    return true;
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

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly emitted: boolean,
  ) {
    super(message);
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

// ── SSE parser ────────────────────────────────────────────────────────────────

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<any> {
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
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          return;
        }
        try {
          yield JSON.parse(payload);
        } catch {
          // Partial frame — next chunk usually completes it.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ── Options passed to RequestPipeline constructor ─────────────────────────────

export interface RequestPipelineConfig {
  candidates: Candidate[];
  toolContext: ToolContext;
  settings: {
    temperature: number;
    maxTokens: number;
    toolGroups: Record<string, boolean>;
    maxToolRounds: number;
    isTrusted?: boolean;
    planMode?: boolean;
  };
  toolFilter?: (name: string) => boolean;
  dispatchOverride?: (name: string, args: any, ctx: ToolContext) => Promise<string>;
}

// ── RequestPipeline ───────────────────────────────────────────────────────────

export class RequestPipeline implements IRequestPipeline, ILLMService {
  constructor(private readonly cfg: RequestPipelineConfig) {}

  /** IRequestPipeline.execute — full agent loop (tool rounds + continuation). */
  async execute(messages: Msg[], opts: PipelineOpts): Promise<PipelineResult> {
    const maxRounds = Math.max(1, this.cfg.settings.maxToolRounds ?? 100);
    const maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;

    let totalContent = '';
    let finalFinishReason: string | null = null;
    let lastUsage: RoundUsage | undefined;
    let toolRounds = 0;
    let continuationRounds = 0;
    let lastSignature = '';
    let repeats = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (opts.signal.aborted) {
        throw new Error('Aborted');
      }

      const result = await this.runWithFailover(messages, opts.signal, opts.onEvent, opts.suppressTools);
      lastUsage = result.usage;
      finalFinishReason = result.finishReason;

      // ── Auto-continuation ────────────────────────────────────────────────
      if (result.finishReason === 'length') {
        if (continuationRounds >= maxContinuations) {
          opts.onEvent({ type: 'notice', text: 'Response truncated: max continuations reached.' });
          totalContent += result.content;
          break;
        }
        continuationRounds++;
        totalContent += result.content;
        messages.push({ role: 'assistant', content: result.content });
        messages.push({ role: 'user', content: CONTINUATION_PROMPT });
        opts.onEvent({
          type: 'notice',
          text: `Response hit max tokens — automatically continuing (${continuationRounds}/${maxContinuations})…`,
        });
        continue;
      }

      // ── Tool call loop ────────────────────────────────────────────────────
      if (result.finishReason === 'tool_calls' && result.toolCalls.length > 0) {
        toolRounds++;

        // Repeat detection: stuck model.
        const signature = callSignature(result.toolCalls);
        repeats = signature === lastSignature ? repeats + 1 : 0;
        lastSignature = signature;
        if (repeats >= MAX_REPEATED_CALLS - 1) {
          // Surface the loop so Engine.chat() can call finalize('loop').
          totalContent += result.content;
          finalFinishReason = 'loop_detected';
          break;
        }

        messages.push({
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
          const output =
            this.cfg.toolFilter && !this.cfg.toolFilter(call.name)
              ? `The tool '${call.name}' is not available on this turn.`
              : await (this.cfg.dispatchOverride || dispatch)(call.name, args, this.cfg.toolContext);
          opts.onEvent({ type: 'tool_result', name: call.name, result: output });
          messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
        continue;
      }

      // ── Normal stop ───────────────────────────────────────────────────────
      totalContent += result.content;
      break;
    }

    return {
      content: totalContent,
      finishReason: finalFinishReason,
      usage: lastUsage,
      toolRounds,
      continuationRounds,
    };
  }

  /**
   * ILLMService.complete — used by ConversationSummarizer.
   * Fires one non-streaming call, suppresses tools, and returns the content.
   */
  async complete(messages: Msg[], signal: AbortSignal): Promise<string> {
    const result = await this.runWithFailover(
      messages,
      signal,
      () => undefined, // no streaming events for summarizer calls
      true,            // suppress tools
    );
    return result.content.trim();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async runWithFailover(
    messages: Msg[],
    signal: AbortSignal,
    onEvent: (e: ChatStreamEvent) => void,
    suppressTools = false,
  ): Promise<RoundResult> {
    let lastError: Error | undefined;

    for (const candidate of this.cfg.candidates) {
      if (signal.aborted) {
        throw new Error('Aborted');
      }
      try {
        return await this.streamOne(candidate, messages, signal, onEvent, suppressTools);
      } catch (err: any) {
        lastError = err;
        if (signal.aborted) {
          throw err;
        }
        if (err instanceof ProviderError && err.emitted) {
          throw err; // mid-output failure — don't retry
        }
        const status = err instanceof ProviderError ? err.status : undefined;
        if (!isRetriable(status)) {
          throw err;
        }
        const next = this.cfg.candidates[this.cfg.candidates.indexOf(candidate) + 1];
        if (next) {
          onEvent({ type: 'notice', text: failoverNotice(candidate, next, status) });
        }
      }
    }

    const status = lastError instanceof ProviderError ? lastError.status : undefined;
    throw new Error(friendlyMessage(status, lastError?.message || 'unknown error'));
  }

  private async streamOne(
    candidate: Candidate,
    messages: Msg[],
    signal: AbortSignal,
    onEvent: (e: ChatStreamEvent) => void,
    suppressTools: boolean,
  ): Promise<RoundResult> {
    const settings = this.cfg.settings;
    const body: any = {
      model: candidate.model,
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (!suppressTools && isToolCapable(candidate.model)) {
      let tools = toolSchemas(
        settings.toolGroups,
        settings.isTrusted ?? true,
        settings.planMode ?? false,
      );
      if (this.cfg.toolFilter) {
        const keep = this.cfg.toolFilter;
        tools = tools.filter((t: any) => keep(t.function?.name));
      }
      if (tools.length > 0) {
        body.tools = tools;
      }
    }

    let res: Response;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 120_000);
    const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

    try {
      res = await fetch(`${candidate.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${candidate.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (signal.aborted) {
        throw e;
      }
      if (timeoutController.signal.aborted) {
        throw new ProviderError('Request timed out after 120 seconds.', 408, false);
      }
      throw new ProviderError(e?.message || 'network error', undefined, false);
    } finally {
      clearTimeout(timeoutId);
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
      for await (const chunk of sseEvents(res.body, signal)) {
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

        if (delta.reasoning_content) {
          emitted = true;
          onEvent({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          emitted = true;
          content.push(delta.content);
          onEvent({ type: 'token', text: delta.content });
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
      if (signal.aborted) {
        throw e;
      }
      throw new ProviderError(e?.message || 'stream failed', undefined, emitted);
    }

    const toolCalls = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (!finishReason && toolCalls.length > 0) {
      finishReason = 'tool_calls';
    }

    return { content: content.join(''), toolCalls, finishReason, usage };
  }
}
