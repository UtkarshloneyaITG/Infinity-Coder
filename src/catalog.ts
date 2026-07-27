/**
 * Model catalog — the curated NVIDIA-hosted list, plus failover ordering.
 *
 * Ported from the Python backend's brain/catalog.py. This is the OFFLINE
 * default: the Models tab merges it with whatever `GET /models` returns live
 * for each provider that has a working key, so a provider whose ids we don't
 * hardcode (any custom endpoint) still gets a populated dropdown.
 */

export type Tier = 'heavy' | 'medium' | 'low';

export interface CatalogModel {
  id: string;
  name: string;
  publisher: string;
  tier: Tier;
  /** Function-calling support. When false the engine omits the `tools` param. */
  tools: boolean;
  /**
   * Which configured provider serves it. Not cosmetic: `openai/gpt-oss-120b`
   * and `minimaxai/minimax-m2.7` are served by BOTH NVIDIA and Groq, so without
   * this a Groq-only user would be offered the whole NVIDIA list.
   */
  providerId: string;
}

/**
 * NVIDIA NIM. Verified against GET https://integrate.api.nvidia.com/v1/models —
 * seven ids previously listed here are not served at all, including the two
 * that were the shipped defaults, so a fresh install failed on its first
 * message. Anything added here must appear in that live list.
 */
export const NVIDIA_MODELS: CatalogModel[] = [
  // ── Heavy: slowest, smartest ──────────────────────────────────────
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', publisher: 'NVIDIA', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra (550B)', publisher: 'NVIDIA', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash', publisher: 'DeepSeek', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', publisher: 'Moonshot AI', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', publisher: 'OpenAI', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'minimaxai/minimax-m3', name: 'MiniMax M3', publisher: 'MiniMax', tier: 'heavy', tools: true, providerId: 'nvidia' },
  { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2', publisher: 'Mistral AI', tier: 'heavy', tools: true, providerId: 'nvidia' },

  // ── Medium: balanced ──────────────────────────────────────────────
  { id: 'mistralai/mistral-medium-3.5-128b', name: 'Mistral Medium 3.5', publisher: 'Mistral AI', tier: 'medium', tools: true, providerId: 'nvidia' },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B', publisher: 'NVIDIA', tier: 'medium', tools: true, providerId: 'nvidia' },
  { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', publisher: 'Meta', tier: 'medium', tools: true, providerId: 'nvidia' },
  { id: 'mistralai/mistral-nemotron', name: 'Mistral Nemotron', publisher: 'Mistral AI', tier: 'medium', tools: true, providerId: 'nvidia' },
  { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', publisher: 'Meta', tier: 'medium', tools: true, providerId: 'nvidia' },

  // ── Low: fast, light ──────────────────────────────────────────────
  { id: 'nvidia/nvidia-nemotron-nano-9b-v2', name: 'Nemotron Nano 9B', publisher: 'NVIDIA', tier: 'low', tools: true, providerId: 'nvidia' },
  { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', publisher: 'Meta', tier: 'low', tools: true, providerId: 'nvidia' },
  { id: 'nv-mistralai/mistral-nemo-12b-instruct', name: 'Mistral NeMo 12B', publisher: 'Mistral AI', tier: 'low', tools: true, providerId: 'nvidia' },
  { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B', publisher: 'NVIDIA', tier: 'low', tools: true, providerId: 'nvidia' },
  // Gemma has no function-calling API, so the engine drops the tools param.
  { id: 'google/gemma-3-12b-it', name: 'Gemma 3 12B', publisher: 'Google', tier: 'low', tools: false, providerId: 'nvidia' },
];

/**
 * Groq. Taken from console.groq.com/docs/models — its /models endpoint needs a
 * key, so unlike NVIDIA this list cannot be machine-verified here. Live
 * discovery corrects it as soon as a key is added.
 *
 * Text models only: Groq also serves Whisper (speech), Orpheus (TTS) and the
 * prompt-guard / safeguard classifiers, none of which can hold a conversation.
 * Listing them would put entries in the model picker that fail on every message.
 */
export const GROQ_MODELS: CatalogModel[] = [
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', publisher: 'OpenAI', tier: 'heavy', tools: true, providerId: 'groq' },
  { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct', publisher: 'Moonshot AI', tier: 'heavy', tools: true, providerId: 'groq' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', publisher: 'Meta', tier: 'medium', tools: true, providerId: 'groq' },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', publisher: 'OpenAI', tier: 'medium', tools: true, providerId: 'groq' },
  { id: 'qwen/qwen3.6-27b', name: 'Qwen 3.6 27B', publisher: 'Qwen', tier: 'medium', tools: true, providerId: 'groq' },
  { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7', publisher: 'MiniMax', tier: 'medium', tools: true, providerId: 'groq' },
  // Compound is an agentic system with server-side tools of its own.
  { id: 'groq/compound', name: 'Compound', publisher: 'Groq', tier: 'medium', tools: true, providerId: 'groq' },
  { id: 'groq/compound-mini', name: 'Compound Mini', publisher: 'Groq', tier: 'low', tools: true, providerId: 'groq' },
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', publisher: 'Meta', tier: 'low', tools: true, providerId: 'groq' },
];

export const MODELS: CatalogModel[] = [...NVIDIA_MODELS, ...GROQ_MODELS];

/**
 * The catalog above is the NVIDIA NIM hosted list, so it is only reachable with
 * an NVIDIA key. Every other provider's models are discovered live from its own
 * `GET /models`.
 */
export const CATALOG_PROVIDER_ID = 'nvidia';

/** Just enough of a Provider to decide reachability, so this stays testable. */
export interface ProviderLike {
  id: string;
  name: string;
  enabled: boolean;
  keys: unknown[];
}

/**
 * Models the user can actually reach right now.
 *
 * A provider with no key contributes nothing: offering its models would produce
 * a dropdown where most entries fail on send with a credentials error, and the
 * user has no way to tell which is which. Reachability is the filter.
 */
export interface AvailableModel {
  id: string;
  name: string;
  /** Display name of the provider that serves it. */
  provider: string;
  providerId: string;
  tier: Tier;
  tools: boolean;
  /**
   * Hidden by the user. Still returned, because Settings has to list it in order
   * to offer an unhide — callers that build a picker filter it out.
   */
  hidden: boolean;
}

export function availableModels(
  providers: ProviderLike[],
  discovered: Map<string, string[]> | Record<string, string[]>,
  customModels: string[] = [],
  hiddenModels: string[] = [],
): AvailableModel[] {
  const hidden = new Set(hiddenModels);
  const usable = providers.filter(p => p.enabled && p.keys.length > 0);
  const lookup = discovered instanceof Map ? discovered : new Map(Object.entries(discovered));

  const seen = new Set<string>();
  const out: AvailableModel[] = [];

  // Models the user typed in themselves come first and are never filtered: they
  // asked for them explicitly, and they may be a brand-new id no list knows yet.
  for (const id of customModels) {
    const trimmed = id.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push({
        id: trimmed, name: BY_ID.get(trimmed)?.name ?? trimmed, provider: 'custom',
        providerId: 'custom', tier: BY_ID.get(trimmed)?.tier ?? 'medium',
        tools: BY_ID.get(trimmed)?.tools ?? true, hidden: hidden.has(trimmed),
      });
    }
  }

  for (const provider of usable) {
    // The hardcoded catalog carries real names and tiers, so prefer it over the
    // bare ids that live discovery returns for the same models.
    for (const model of MODELS) {
      if (model.providerId === provider.id && !seen.has(model.id)) {
        seen.add(model.id);
        out.push({
          id: model.id, name: model.name, provider: provider.name,
          providerId: provider.id, tier: model.tier, tools: model.tools,
          hidden: hidden.has(model.id),
        });
      }
    }
    for (const id of lookup.get(provider.id) || []) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push({
          id, name: BY_ID.get(id)?.name ?? id, provider: provider.name,
          providerId: provider.id, tier: BY_ID.get(id)?.tier ?? 'medium',
          tools: BY_ID.get(id)?.tools ?? true, hidden: hidden.has(id),
        });
      }
    }
  }
  return out;
}

const BY_ID = new Map<string, CatalogModel>();
for (const model of MODELS) {
  if (!BY_ID.has(model.id)) {
    BY_ID.set(model.id, model);
  }
}

export function get(modelId: string): CatalogModel | undefined {
  return BY_ID.get(modelId);
}

/**
 * Whether a model can call tools. Unknown (off-catalog, e.g. live-discovered)
 * models default to true, so a custom-endpoint model isn't crippled
 * just because it isn't in the static list.
 */
export function isToolCapable(modelId: string): boolean {
  return BY_ID.get(modelId)?.tools ?? true;
}

export function displayName(modelId: string): string {
  return BY_ID.get(modelId)?.name ?? modelId;
}

// Curated, tool-capable representatives a failing turn retries on. Lighter
// models ease the rate-limit / capacity errors that trigger failover.
const FAILOVER_MEDIUM = 'mistralai/mistral-medium-3.5-128b';
const FAILOVER_LOW = 'meta/llama-3.1-8b-instruct';
const LOW_ALT = 'nvidia/nvidia-nemotron-nano-9b-v2';

/** Progressively lighter, tool-capable models to retry a failed turn on. */
export function fallbackChain(modelId: string): string[] {
  const tier = BY_ID.get(modelId)?.tier ?? 'medium';
  const candidates =
    tier === 'heavy' ? [FAILOVER_MEDIUM, FAILOVER_LOW]
    : tier === 'medium' ? [FAILOVER_LOW, LOW_ALT]
    : [LOW_ALT, FAILOVER_LOW];

  const out: string[] = [];
  for (const m of candidates) {
    if (m !== modelId && !out.includes(m) && BY_ID.get(m)?.tools) {
      out.push(m);
    }
  }
  return out;
}
