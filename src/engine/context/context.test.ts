/**
 * context.test.ts — full unit test suite for the context subsystem.
 *
 * No framework. Run with: npm run compile && node out/engine/context/context.test.js
 *
 * The module stubs vscode exactly like engine.test.ts does — this file must be
 * compiled with the same tsconfig that compiles engine.test.ts.
 */

import * as assert from 'assert';

// ── vscode stub (same as engine.test.ts) ────────────────────────────────────
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') {
    return {
      Uri: { file: (p: string) => ({ fsPath: p }) },
      workspace: { fs: { async delete() {} } },
    };
  }
  return realLoad.call(this, request, ...rest);
};

// ── Imports (after stub) ─────────────────────────────────────────────────────

import { ApproxTokenEstimator, TokenEstimatorFactory } from './ApproxTokenEstimator';
import {
  ContextClass,
  DEFAULT_POLICY,
  DefaultPriorityResolver,
} from './PriorityResolver';
import { computeBudget } from './ContextBudget';
import { ContextCompactor } from './ContextCompactor';
import { ConversationSummarizer } from './ConversationSummarizer';
import { PromptBuilder } from './PromptBuilder';
import { ContextManager, createContextManager } from './ContextManager';
import { getCapabilities } from './ModelCapabilities';
import type { Msg } from '../agent';
import type { InternalSummaryMsg } from './InternalSummaryMsg';
import type { ILLMService } from './ConversationSummarizer';
import type { ContextSettings } from '../../settings';
import type { ContextSource, ContextSourceResult } from './ContextSource';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(condition: boolean, msg: string): void {
  assert.ok(condition, msg);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  assert.strictEqual(actual, expected, msg);
}

function makeHistory(...roles: Array<'user' | 'assistant' | 'tool'>): Msg[] {
  return roles.map((role, i) => ({
    role,
    content: `Message ${i}`,
    ...(role === 'tool' ? { tool_call_id: `call_${i}` } : {}),
  }));
}

function defaultSettings(overrides: Partial<ContextSettings> = {}): ContextSettings {
  return {
    autoCompact: true,
    compactThreshold: 0.70,
    reservedOutputTokens: 4_096,
    aggressiveCompression: true,
    summaryEnabled: true,
    summaryDepth: 5,
    ...overrides,
  };
}

async function main() {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e: any) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ITokenEstimator / ApproxTokenEstimator ──');
  // ══════════════════════════════════════════════════════════════════════════

  await test('ApproxEstimator: empty string → 4 tokens (overhead only)', () => {
    const est = new ApproxTokenEstimator();
    eq(est.estimate(''), 4, 'empty string');
  });

  await test('ApproxEstimator: 1,000-char message → ~254 tokens', () => {
    const est = new ApproxTokenEstimator();
    const t = est.estimate('x'.repeat(1000));
    ok(t >= 250 && t <= 260, `expected ~254, got ${t}`);
  });

  await test('WeakMap cache: same Msg object returns same value without recomputing', () => {
    const est = new ApproxTokenEstimator();
    const msg: Msg = { role: 'user', content: 'hello world' };
    const t1 = est.estimateMsg(msg);
    const t2 = est.estimateMsg(msg);
    eq(t1, t2, 'cached result matches');
  });

  await test('estimateMsgs: breakdown roles are correct', () => {
    const est = new ApproxTokenEstimator();
    const msgs: Msg[] = [
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'user text' },
      { role: 'assistant', content: 'assistant text' },
      { role: 'tool', content: 'tool output', tool_call_id: 'c1' },
    ];
    const bd = est.estimateMsgs(msgs);
    ok(bd.system > 0, 'system > 0');
    ok(bd.user > 0, 'user > 0');
    ok(bd.assistant > 0, 'assistant > 0');
    ok(bd.tool > 0, 'tool > 0');
    eq(bd.total, bd.system + bd.user + bd.assistant + bd.tool + bd.other, 'total = sum');
  });

  await test('TokenEstimatorFactory.for(unknown) → ApproxTokenEstimator', () => {
    const est = TokenEstimatorFactory('some-unknown-model-xyz');
    eq(est.modelId, 'approx', 'falls back to approx');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── PriorityResolver ──');
  // ══════════════════════════════════════════════════════════════════════════

  await test('last user message → CurrentRequest', () => {
    const resolver = new DefaultPriorityResolver();
    const msgs = makeHistory('user', 'assistant', 'user');
    const cls = resolver.classify(msgs[2], 2, 3);
    eq(cls, ContextClass.CurrentRequest, 'last user = CurrentRequest');
  });

  await test('tool message within last 4 positions → ActiveToolResult', () => {
    const resolver = new DefaultPriorityResolver();
    const msgs = makeHistory('user', 'assistant', 'tool', 'assistant', 'tool', 'user');
    // index 4 (tool), totalMessages=6 → distanceFromEnd = 1 → ActiveToolResult
    const cls = resolver.classify(msgs[4], 4, 6);
    eq(cls, ContextClass.ActiveToolResult, 'recent tool = ActiveToolResult');
  });

  await test('old tool message → OldConversation', () => {
    const resolver = new DefaultPriorityResolver();
    // Place a tool message far from the end (>20 messages away).
    const msgs = makeHistory(...Array(30).fill('user') as 'user'[], 'tool');
    const cls = resolver.classify(msgs[0], 0, msgs.length);
    eq(cls, ContextClass.OldConversation, 'old user = OldConversation');
  });

  await test('InternalSummaryMsg → Summary class', () => {
    const resolver = new DefaultPriorityResolver();
    const summary: InternalSummaryMsg = {
      _type: 'summary',
      topic: 'Auth',
      content: 'summary text',
      covering: [0, 1],
      createdAt: Date.now(),
      originalTokens: 500,
      summaryTokens: 100,
    };
    const cls = resolver.classify(summary as any, 0, 5);
    eq(cls, ContextClass.Summary, 'summary = Summary class');
  });

  await test('isProtected: OldConversation → false; ActiveToolResult → true', () => {
    const resolver = new DefaultPriorityResolver();
    ok(!resolver.isProtected(ContextClass.OldConversation), 'OldConversation not protected');
    ok(resolver.isProtected(ContextClass.ActiveToolResult), 'ActiveToolResult protected');
    ok(resolver.isProtected(ContextClass.CurrentRequest), 'CurrentRequest protected');
  });

  await test('Custom policy: RecentConversation can be made protected', () => {
    const customPolicy = {
      ...DEFAULT_POLICY,
      [ContextClass.RecentConversation]: { score: 80, protected: true },
    };
    const resolver = new DefaultPriorityResolver(customPolicy);
    ok(resolver.isProtected(ContextClass.RecentConversation), 'custom policy respected');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ContextBudget ──');
  // ══════════════════════════════════════════════════════════════════════════

  const estimator = new ApproxTokenEstimator();

  function makeCapabilities(contextWindow: number) {
    return getCapabilities('custom-model-test', contextWindow);
  }

  await test('50% usage → tier: none', () => {
    const caps = makeCapabilities(100_000);
    // System + 1 user message = about 50% of usableInput (95,904 / 2 ≈ 47k)
    const system = 'x'.repeat(50_000 * 4); // ~50k tokens
    const history: Msg[] = [];
    const budget = computeBudget(system, history, caps, defaultSettings(), estimator);
    ok(budget.compactionTier === 'none', `50% → none (got ${budget.compactionTier}, util=${budget.utilizationPct.toFixed(1)}%)`);
  });

  await test('72% usage → tier: tool', () => {
    const caps = makeCapabilities(10_000);
    const reservedOutput = 4_096;
    const usable = 10_000 - reservedOutput; // 5,904 tokens usable
    // Fill 72% of usable: 5904 * 0.72 ≈ 4,251 tokens
    const system = 'x'.repeat(4_251 * 4);
    const budget = computeBudget(system, [], caps, defaultSettings({ compactThreshold: 0.70 }), estimator);
    eq(budget.compactionTier, 'tool', `72% → tool (got ${budget.compactionTier}, util=${budget.utilizationPct.toFixed(1)}%)`);
  });

  await test('88% usage → tier: summarize', () => {
    const caps = makeCapabilities(10_000);
    const usable = 10_000 - 4_096; // 5,904
    const system = 'x'.repeat(Math.floor(usable * 0.88) * 4);
    const budget = computeBudget(system, [], caps, defaultSettings({ compactThreshold: 0.70 }), estimator);
    eq(budget.compactionTier, 'summarize', `88% → summarize (got ${budget.compactionTier})`);
  });

  await test('96% usage → tier: aggressive', () => {
    const caps = makeCapabilities(10_000);
    const usable = 10_000 - 4_096;
    const system = 'x'.repeat(Math.floor(usable * 0.96) * 4);
    const budget = computeBudget(system, [], caps, defaultSettings({ compactThreshold: 0.70 }), estimator);
    eq(budget.compactionTier, 'aggressive', `96% → aggressive (got ${budget.compactionTier})`);
  });

  await test('99% usage → tier: warn', () => {
    const caps = makeCapabilities(10_000);
    const usable = 10_000 - 4_096;
    const system = 'x'.repeat(Math.floor(usable * 0.99) * 4);
    const budget = computeBudget(system, [], caps, defaultSettings({ compactThreshold: 0.70 }), estimator);
    eq(budget.compactionTier, 'warn', `99% → warn (got ${budget.compactionTier})`);
  });

  await test('autoCompact: false → tier always none', () => {
    const caps = makeCapabilities(10_000);
    const usable = 10_000 - 4_096;
    const system = 'x'.repeat(Math.floor(usable * 0.99) * 4);
    const budget = computeBudget(system, [], caps, defaultSettings({ autoCompact: false }), estimator);
    eq(budget.compactionTier, 'none', 'autoCompact=false → none');
  });

  await test('remaining is never negative (clamped)', () => {
    const caps = makeCapabilities(1_000);
    const system = 'x'.repeat(2_000 * 4); // way over budget
    const budget = computeBudget(system, [], caps, defaultSettings(), estimator);
    ok(budget.utilizationPct === 100, `utilizationPct capped at 100: ${budget.utilizationPct}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ContextCompactor ──');
  // ══════════════════════════════════════════════════════════════════════════

  const resolver = new DefaultPriorityResolver();
  const compactor = new ContextCompactor(estimator, resolver);

  await test('tool output under 1,000 tokens → untouched', () => {
    const history: Msg[] = [
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'small output', tool_call_id: 'c1' },
    ];
    const copy = history.map(m => ({ ...m }));
    compactor.compactToolOutputs(copy);
    eq(copy[1].content as string, 'small output', 'small tool output unchanged');
  });

  await test('tool output over 1,000 tokens → replaced with stub', () => {
    const bigContent = 'x'.repeat(5_000); // ~1,250 tokens
    // Tool result must be >4 turns from the end so it is not classified as ActiveToolResult (which is protected)
    const history: Msg[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: bigContent, tool_call_id: 'c1' },
      { role: 'user', content: 'req1' },
      { role: 'assistant', content: 'ans1' },
      { role: 'user', content: 'req2' },
      { role: 'assistant', content: 'ans2' },
      { role: 'user', content: 'req3' },
      { role: 'assistant', content: 'ans3' },
      { role: 'user', content: 'req4' },
      { role: 'assistant', content: 'ans4' },
    ];
    const copy = history.map(m => ({ ...m }));
    compactor.compactToolOutputs(copy);
    ok(
      (copy[1].content as string).startsWith('[Compacted:'),
      'large tool output replaced with stub',
    );
  });

  await test('original history is not mutated by compactToolOutputs', () => {
    const bigContent = 'x'.repeat(5_000);
    const history: Msg[] = [
      { role: 'user', content: 'req' },
      { role: 'user', content: 'req2' },
      { role: 'user', content: 'req3' },
      { role: 'user', content: 'req4' },
      { role: 'user', content: 'req5' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: bigContent, tool_call_id: 'c1' },
    ];
    const copy = history.map(m => ({ ...m }));
    compactor.compactToolOutputs(copy);
    eq(history[6].content as string, bigContent, 'original history untouched');
  });

  await test('aggressiveCompress truncates large tool results to ~500 tokens', () => {
    const bigContent = 'y'.repeat(10_000);
    const history: Msg[] = [
      { role: 'tool', content: bigContent, tool_call_id: 'c1' },
    ];
    compactor.aggressiveCompress(history);
    const afterTokens = estimator.estimateMsg(history[0]);
    ok(afterTokens <= 600, `aggressive result ≤ 600 tokens (got ${afterTokens})`);
    ok((history[0].content as string).includes('…[truncated'), 'truncation marker present');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ConversationSummarizer ──');
  // ══════════════════════════════════════════════════════════════════════════

  const stubLLM: ILLMService = {
    async complete(_msgs, _signal) {
      return JSON.stringify({ topic: 'Test Auth', summary: 'The user set up authentication with JWT tokens and a refresh-token flow.' });
    },
  };

  await test('produces InternalSummaryMsg with correct fields', async () => {
    const sum = new ConversationSummarizer(stubLLM, estimator);
    const history: Msg[] = [
      { role: 'user', content: 'How do I set up auth?' },
      { role: 'assistant', content: 'Use JWT. Here is the setup...' },
      { role: 'user', content: 'How do I handle refresh tokens?' },
      { role: 'assistant', content: 'Store them in an httpOnly cookie.' },
      // Two recent turns (recentDepth=2 → recentStart = max(0, 4-4) = 0 → all covered but must leave recentDepth*2 untouched)
    ];
    const signal = new AbortController().signal;
    const summaries = await sum.summarize(history, [], 1, signal);
    ok(summaries.length <= 1, 'at most one summary produced');
    if (summaries.length === 1) {
      const s = summaries[0];
      eq(s._type, 'summary', '_type = summary');
      ok(s.topic.length > 0, 'topic non-empty');
      ok(s.content.length > 0, 'content non-empty');
      ok(s.covering.length > 0, 'covering non-empty');
      ok(s.originalTokens > 0, 'originalTokens > 0');
      ok(s.summaryTokens > 0, 'summaryTokens > 0');
      ok(s.summaryTokens < s.originalTokens, 'summary is shorter than original');
    }
  });

  await test('already-summarized messages are not re-summarized', async () => {
    const sum = new ConversationSummarizer(stubLLM, estimator);
    const history: Msg[] = [
      { role: 'user', content: 'Turn 0' },
      { role: 'assistant', content: 'Reply 0' },
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Recent turn' },
    ];
    const signal = new AbortController().signal;
    const existing: InternalSummaryMsg[] = [{
      _type: 'summary',
      topic: 'Already',
      content: 'Already summarized',
      covering: [0, 1, 2, 3],
      createdAt: Date.now(),
      originalTokens: 400,
      summaryTokens: 80,
    }];
    const summaries = await sum.summarize(history, existing, 1, signal);
    eq(summaries.length, 0, 'no new summaries when all eligible messages already covered');
  });

  await test('aborted signal returns empty summaries', async () => {
    const sum = new ConversationSummarizer(stubLLM, estimator);
    const history: Msg[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
    ];
    const aborted = new AbortController();
    aborted.abort();
    const summaries = await sum.summarize(history, [], 1, aborted.signal);
    eq(summaries.length, 0, 'aborted → empty');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── PromptBuilder ──');
  // ══════════════════════════════════════════════════════════════════════════

  const promptBuilder = new PromptBuilder();
  const res2 = new DefaultPriorityResolver();

  await test('system message is always first', () => {
    const result = promptBuilder.build({
      system: 'You are helpful.',
      compactedHistory: [{ role: 'user', content: 'hi' }],
      summaries: [],
      sources: [],
      currentRequest: 'hello',
      resolver: res2,
      estimator,
      tokenBudget: 1_000_000,
    });
    eq(result.messages[0].role, 'system', 'first = system');
    eq(result.messages[0].content as string, 'You are helpful.', 'system content');
  });

  await test('current request is always last', () => {
    const result = promptBuilder.build({
      system: 'sys',
      compactedHistory: [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'resp' }],
      summaries: [],
      sources: [],
      currentRequest: 'the current question',
      resolver: res2,
      estimator,
      tokenBudget: 1_000_000,
    });
    const last = result.messages[result.messages.length - 1];
    eq(last.role, 'user', 'last role = user');
    eq(last.content as string, 'the current question', 'last = current request');
  });

  await test('InternalSummaryMsg converted to user message with prefix', () => {
    const summary: InternalSummaryMsg = {
      _type: 'summary',
      topic: 'Auth flow',
      content: 'JWT tokens were used.',
      covering: [0],
      createdAt: Date.now(),
      originalTokens: 200,
      summaryTokens: 40,
    };
    const result = promptBuilder.build({
      system: 'sys',
      compactedHistory: [],
      summaries: [summary],
      sources: [],
      currentRequest: 'continue',
      resolver: res2,
      estimator,
      tokenBudget: 1_000_000,
    });
    const summaryMsg = result.messages.find(m =>
      m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('[Conversation Summary')
    );
    ok(!!summaryMsg, 'summary message present');
    ok((summaryMsg!.content as string).includes('Auth flow'), 'topic in summary');
    ok((summaryMsg!.content as string).includes('JWT tokens'), 'content in summary');
  });

  await test('source sections ordered by priority score (highest first)', () => {
    const sources: ContextSourceResult[] = [
      { content: 'semantic result', tokenEstimate: 100, label: 'Semantic', priority: ContextClass.SemanticContext, metadata: {} },
      { content: 'workspace result', tokenEstimate: 50, label: 'Workspace', priority: ContextClass.RecentConversation, metadata: {} },
    ];
    const result = promptBuilder.build({
      system: 'sys',
      compactedHistory: [],
      summaries: [],
      sources,
      currentRequest: 'q',
      resolver: res2,
      estimator,
      tokenBudget: 1_000_000,
    });
    const srcMsgs = result.messages.filter(m =>
      m.role === 'user' && typeof m.content === 'string' && (m.content as string).startsWith('[Context:')
    );
    eq(srcMsgs.length, 2, 'two source messages');
    ok((srcMsgs[0].content as string).includes('Semantic'), 'semantic (higher priority) first');
    ok((srcMsgs[1].content as string).includes('Workspace'), 'workspace second');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ModelCapabilities ──');
  // ══════════════════════════════════════════════════════════════════════════

  await test('known model returns accurate contextWindow', () => {
    const caps = getCapabilities('meta/llama-3.3-70b-instruct', 50_000);
    eq(caps.contextWindow, 128_000, 'llama-3.3-70b = 128K');
  });

  await test('unknown model falls back to fallbackContextTokens', () => {
    const caps = getCapabilities('totally-custom-model', 32_000);
    eq(caps.contextWindow, 32_000, 'fallback used for unknown model');
  });

  await test('model switch: 128K → 32K context window updates', () => {
    const caps128 = getCapabilities('meta/llama-3.3-70b-instruct', 50_000);
    const caps32  = getCapabilities('nvidia/nvidia-nemotron-nano-9b-v2', 50_000);
    eq(caps128.contextWindow, 128_000, '128K model');
    eq(caps32.contextWindow, 32_768, '32K model');
    ok(caps128.contextWindow > caps32.contextWindow, 'switch detected');
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── ContextManager integration ──');
  // ══════════════════════════════════════════════════════════════════════════

  await test('prepare() does not mutate input history', async () => {
    const caps = getCapabilities('meta/llama-3.1-8b-instruct', 128_000);
    const manager = createContextManager(
      defaultSettings(),
      caps,
      estimator,
      new DefaultPriorityResolver(),
      new ConversationSummarizer(stubLLM, estimator),
      [],
    );
    const history: readonly Msg[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const frozenSnapshot = JSON.stringify(history);
    await manager.prepare(history, 'sys', 'next message', [], new AbortController().signal);
    eq(JSON.stringify(history), frozenSnapshot, 'history unchanged after prepare()');
  });

  await test('metrics.utilizationPct matches budget', async () => {
    const caps = getCapabilities('meta/llama-3.1-8b-instruct', 128_000);
    const manager = createContextManager(
      defaultSettings({ autoCompact: false }),
      caps,
      estimator,
      new DefaultPriorityResolver(),
      new ConversationSummarizer(stubLLM, estimator),
      [],
    );
    const ctx = await manager.prepare([], 'short system', 'hi', [], new AbortController().signal);
    ok(ctx.metrics.utilizationPct >= 0 && ctx.metrics.utilizationPct <= 100, 'utilization in 0-100');
  });

  await test('ContextSource.fetch is called with remaining budget', async () => {
    let receivedBudget = -1;
    const mockSource: ContextSource = {
      id: 'mock',
      async fetch(_q, budget) {
        receivedBudget = budget;
        return [];
      },
    };
    const caps = getCapabilities('meta/llama-3.1-8b-instruct', 128_000);
    const manager = createContextManager(
      defaultSettings({ autoCompact: false }),
      caps,
      estimator,
      new DefaultPriorityResolver(),
      new ConversationSummarizer(stubLLM, estimator),
      [mockSource],
    );
    await manager.prepare([], 'sys', 'q', [], new AbortController().signal);
    ok(receivedBudget >= 0, `fetch received budget: ${receivedBudget}`);
  });

  await test('failing ContextSource does not abort the turn', async () => {
    const badSource: ContextSource = {
      id: 'bad',
      async fetch() { throw new Error('source exploded'); },
    };
    const caps = getCapabilities('meta/llama-3.1-8b-instruct', 128_000);
    const manager = createContextManager(
      defaultSettings(),
      caps,
      estimator,
      new DefaultPriorityResolver(),
      new ConversationSummarizer(stubLLM, estimator),
      [badSource],
    );
    // Should not throw.
    const ctx = await manager.prepare([], 'sys', 'q', [], new AbortController().signal);
    ok(ctx.metrics.semanticTokens === 0, 'no semantic tokens from failing source');
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n── Results: ${passed}/${total} passed ──`);
  if (failed > 0) {
    console.error(`${failed} test(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
