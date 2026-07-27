/**
 * Model catalog — the curated NVIDIA-hosted list, plus failover ordering.
 *
 * Ported from the Python backend's brain/catalog.py. This is the OFFLINE
 * default: the Models tab merges it with whatever `GET /models` returns live
 * for each provider that has a working key, so a provider whose ids we don't
 * hardcode (xAI, custom endpoints) still gets a populated dropdown.
 */

export type Tier = 'heavy' | 'medium' | 'low';

export interface CatalogModel {
  id: string;
  name: string;
  publisher: string;
  tier: Tier;
  /** Function-calling support. When false the engine omits the `tools` param. */
  tools: boolean;
}

export const MODELS: CatalogModel[] = [
  // ── Heavy: slowest, smartest ──────────────────────────────────────
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', publisher: 'NVIDIA', tier: 'heavy', tools: true },
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash', publisher: 'DeepSeek', tier: 'heavy', tools: true },
  { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 (397B)', publisher: 'Qwen', tier: 'heavy', tools: true },
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3 (675B)', publisher: 'Mistral AI', tier: 'heavy', tools: true },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', publisher: 'Moonshot AI', tier: 'heavy', tools: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra (550B)', publisher: 'NVIDIA', tier: 'heavy', tools: true },
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', publisher: 'OpenAI', tier: 'heavy', tools: true },
  { id: 'minimaxai/minimax-m3', name: 'MiniMax M3', publisher: 'MiniMax', tier: 'heavy', tools: true },
  // ── Medium: balanced ──────────────────────────────────────────────
  { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7', publisher: 'MiniMax', tier: 'medium', tools: true },
  { id: 'mistralai/mistral-medium-3.5-128b', name: 'Mistral Medium 3.5', publisher: 'Mistral AI', tier: 'medium', tools: true },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B', publisher: 'NVIDIA', tier: 'medium', tools: true },
  { id: 'qwen/qwen3-next-80b-a3b-instruct', name: 'Qwen3-Next 80B', publisher: 'Qwen', tier: 'medium', tools: true },
  { id: 'mistralai/mistral-small-4-119b-2603', name: 'Mistral Small 4', publisher: 'Mistral AI', tier: 'medium', tools: true },
  // ── Low: fast, light ──────────────────────────────────────────────
  { id: 'nvidia/nvidia-nemotron-nano-9b-v2', name: 'Nemotron Nano 9B', publisher: 'NVIDIA', tier: 'low', tools: true },
  { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', publisher: 'Meta', tier: 'low', tools: true },
  { id: 'mistralai/ministral-14b-instruct-2512', name: 'Ministral 14B', publisher: 'Mistral AI', tier: 'low', tools: true },
  { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B', publisher: 'NVIDIA', tier: 'low', tools: true },
  { id: 'google/gemma-2-2b-it', name: 'Gemma 2 2B', publisher: 'Google', tier: 'low', tools: false },
];

const BY_ID = new Map(MODELS.map(m => [m.id, m]));

export function get(modelId: string): CatalogModel | undefined {
  return BY_ID.get(modelId);
}

/**
 * Whether a model can call tools. Unknown (off-catalog, e.g. live-discovered)
 * models default to true, so a Grok or custom-endpoint model isn't crippled
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
