import * as fs from 'fs';
import * as path from 'path';
import type { InfinityCoderSettings } from '../settings';
import { get as catalogGet, MODELS } from '../catalog';
import { BrainDef, OrchestrationSettings } from './types';

/**
 * The Provider Router — which provider and model a given brain runs on.
 *
 * It does NOT talk to providers. Failover, key rotation and model downgrade on
 * error already live in the Engine; duplicating them here would mean two places
 * to fix the next time a provider changes its error codes. This module answers
 * one narrower question: given a brain's preferences, the user's configured
 * providers and the remaining budget, which candidates should the Engine be
 * allowed to consider, and which model should it start from.
 */

/**
 * USD per 1M tokens, matched by substring against the model id. Deliberately
 * coarse: this drives a budget guard and a relative cost score, not an invoice.
 * A model that matches nothing is treated as free, which is correct for Ollama
 * and LM Studio and merely optimistic for anything else.
 */
const PRICES: Array<{ match: string; in: number; out: number }> = [
  { match: 'gpt-4o-mini', in: 0.15, out: 0.6 },
  { match: 'gpt-4o', in: 2.5, out: 10 },
  { match: 'gpt-5', in: 1.25, out: 10 },
  { match: 'gpt-oss', in: 0.15, out: 0.6 },
  { match: 'claude-haiku', in: 1, out: 5 },
  { match: 'claude-sonnet', in: 3, out: 15 },
  { match: 'claude-opus', in: 15, out: 75 },
  { match: 'gemini-flash', in: 0.3, out: 2.5 },
  { match: 'gemini', in: 1.25, out: 10 },
  { match: 'deepseek', in: 0.28, out: 0.42 },
  { match: 'qwen', in: 0.4, out: 1.2 },
  { match: 'kimi', in: 0.6, out: 2.5 },
  { match: 'minimax', in: 0.3, out: 1.2 },
  { match: 'mistral-large', in: 2, out: 6 },
  { match: 'mistral', in: 0.4, out: 2 },
  { match: 'nemotron-ultra', in: 1.2, out: 4 },
  { match: 'nemotron', in: 0.3, out: 0.9 },
  { match: 'llama-3.1-8b', in: 0.05, out: 0.08 },
  { match: 'llama', in: 0.3, out: 0.6 },
  { match: 'gemma', in: 0.05, out: 0.1 },
];

export function priceOf(model: string): { in: number; out: number } {
  const id = (model || '').toLowerCase();
  // Matched on a token boundary, not a bare substring: "my-local-ollama-model"
  // contains "llama" and would otherwise be billed as a hosted Llama.
  return PRICES.find(p => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(p.match)}`).test(id)) || { in: 0, out: 0 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const price = priceOf(model);
  return (tokensIn / 1e6) * price.in + (tokensOut / 1e6) * price.out;
}

/** Cheapest tool-capable model in the catalog — where a blown budget lands. */
export function cheapestModel(): string {
  const usable = MODELS.filter(m => m.tools);
  return usable
    .slice()
    .sort((a, b) => {
      const pa = priceOf(a.id);
      const pb = priceOf(b.id);
      return pa.in + pa.out - (pb.in + pb.out);
    })[0]?.id || usable[0]?.id || '';
}

interface Ledger {
  /** 'YYYY-MM'. A new month resets the total. */
  month: string;
  usd: number;
}

/** Monthly spend, persisted next to the extension's storage. */
export class CostTracker {
  private ledger: Ledger;

  constructor(private readonly file: string) {
    this.ledger = this.load();
  }

  private load(): Ledger {
    const month = currentMonth();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Ledger;
      return parsed.month === month ? parsed : { month, usd: 0 };
    } catch {
      return { month, usd: 0 };
    }
  }

  public add(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) {
      return;
    }
    if (this.ledger.month !== currentMonth()) {
      this.ledger = { month: currentMonth(), usd: 0 };
    }
    this.ledger.usd += usd;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.ledger), 'utf8');
    } catch {
      // Accounting must never fail a run.
    }
  }

  public monthToDate(): number {
    return this.ledger.month === currentMonth() ? this.ledger.usd : 0;
  }
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface Route {
  model: string;
  /** Provider ids the Engine may use, in preference order. Empty means "any". */
  providers: string[];
  temperature: number;
  maxTokens: number;
  /** Set when the budget forced a cheaper model than the brain asked for. */
  downgradedFrom?: string;
}

export class ProviderRouter {
  constructor(
    private readonly readSettings: () => InfinityCoderSettings,
    private readonly readOrchestration: () => OrchestrationSettings,
    private readonly costs: CostTracker
  ) {}

  /** Provider ids that actually have a usable key configured. */
  private usableProviders(): string[] {
    return this.readSettings()
      .providers.filter(p => p.enabled && p.keys.length > 0)
      .map(p => p.id);
  }

  public route(brain: BrainDef, spentThisRun: number): Route {
    const settings = this.readSettings();
    const orchestration = this.readOrchestration();
    const usable = this.usableProviders();

    // Preference order, filtered to what is actually configured. If none of the
    // brain's preferred providers have a key, fall through to every provider —
    // a brain that names a provider the user never set up should still run
    // rather than fail the whole task.
    const preferred = [brain.provider, ...brain.fallbackProviders]
      .filter((id): id is string => !!id)
      .filter(id => usable.includes(id));
    const providers = preferred.length > 0 ? preferred : [];

    let model = brain.model || settings.activeModel;
    // A brain naming a model that isn't tool-capable would be silently stripped
    // of its tools by the Engine, so prefer the user's active model instead.
    if (brain.model && catalogGet(brain.model)?.tools === false) {
      model = settings.activeModel;
    }

    const route: Route = {
      model,
      providers,
      temperature: brain.temperature,
      maxTokens: brain.maxTokens,
    };

    if (this.overBudget(orchestration, spentThisRun)) {
      const cheap = cheapestModel();
      if (cheap && cheap !== model) {
        route.downgradedFrom = model;
        route.model = cheap;
      }
    }
    return route;
  }

  public overBudget(orchestration: OrchestrationSettings, spentThisRun: number): boolean {
    if (orchestration.runBudgetUsd > 0 && spentThisRun >= orchestration.runBudgetUsd) {
      return true;
    }
    if (orchestration.monthlyBudgetUsd > 0 && this.costs.monthToDate() >= orchestration.monthlyBudgetUsd) {
      return true;
    }
    return false;
  }

  /** For the settings UI: what a brain would cost for a typical turn. */
  public compare(tokensIn = 8000, tokensOut = 1500): Array<{ model: string; usd: number }> {
    return MODELS.filter(m => m.tools)
      .map(m => ({ model: m.id, usd: estimateCost(m.id, tokensIn, tokensOut) }))
      .sort((a, b) => a.usd - b.usd);
  }

  public recordSpend(usd: number): void {
    this.costs.add(usd);
  }
}
