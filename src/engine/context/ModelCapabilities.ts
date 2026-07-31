/**
 * ModelCapabilities — static per-model capability table + resolver.
 *
 * Context window sizes sourced from official provider docs.
 * Unknown / custom models fall back to the user's maxContextTokens setting.
 */

export interface ModelCapabilities {
  /** Full context window in tokens (input + output combined). */
  contextWindow: number;
  /** Recommended max output tokens for this model. */
  recommendedOutput: number;
  /**
   * Hard minimum output reservation.  Even if the user sets a lower value we
   * hold at least this many tokens back so the model can complete a sentence.
   */
  minimumReservedOutput: number;
  /** Whether this model exposes a reasoning/thinking trace. */
  supportsReasoning: boolean;
  /** Whether this model supports function / tool calling. */
  supportsToolCalls: boolean;
  /** Whether this model accepts image input. */
  supportsVision: boolean;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  recommendedOutput: 4_096,
  minimumReservedOutput: 512,
  supportsReasoning: false,
  supportsToolCalls: true,
  supportsVision: false,
};

/**
 * Static capability overrides for known model ids.
 * Models not listed here receive DEFAULT_CAPABILITIES.
 *
 * Context window sizes:
 *   NVIDIA NIM: https://docs.api.nvidia.com/nim/reference/
 *   Groq:       https://console.groq.com/docs/models
 */
const CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  // ── NVIDIA NIM — Heavy ────────────────────────────────────────────────────
  'nvidia/nemotron-3-super-120b-a12b':        { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'nvidia/nemotron-3-ultra-550b-a55b':        { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'deepseek-ai/deepseek-v4-flash':            { contextWindow: 128_000, recommendedOutput: 8_192, supportsReasoning: true, supportsToolCalls: true },
  'moonshotai/kimi-k2.6':                     { contextWindow: 131_072, recommendedOutput: 8_192, supportsToolCalls: true  },
  'openai/gpt-oss-120b':                      { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'minimaxai/minimax-m3':                     { contextWindow: 1_000_192, recommendedOutput: 8_192, supportsToolCalls: true },
  'mistralai/mistral-large-2-instruct':       { contextWindow: 131_072, recommendedOutput: 4_096, supportsToolCalls: true  },

  // ── NVIDIA NIM — Medium ───────────────────────────────────────────────────
  'mistralai/mistral-medium-3.5-128b':        { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': { contextWindow: 131_072, recommendedOutput: 4_096, supportsToolCalls: true  },
  'meta/llama-3.3-70b-instruct':              { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'mistralai/mistral-nemotron':               { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'meta/llama-3.1-70b-instruct':              { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },

  // ── NVIDIA NIM — Low ──────────────────────────────────────────────────────
  'nvidia/nvidia-nemotron-nano-9b-v2':        { contextWindow:  32_768, recommendedOutput: 2_048, supportsToolCalls: true  },
  'meta/llama-3.1-8b-instruct':               { contextWindow: 128_000, recommendedOutput: 2_048, supportsToolCalls: true  },
  'nv-mistralai/mistral-nemo-12b-instruct':   { contextWindow: 128_000, recommendedOutput: 4_096, supportsToolCalls: true  },
  'nvidia/nemotron-mini-4b-instruct':         { contextWindow:   4_096, recommendedOutput:   512, supportsToolCalls: true  },
  'google/gemma-3-12b-it':                    { contextWindow: 131_072, recommendedOutput: 4_096, supportsToolCalls: false },

  // ── Groq — Heavy ─────────────────────────────────────────────────────────
  'moonshotai/kimi-k2-instruct-0905':         { contextWindow: 131_072, recommendedOutput: 8_192, supportsToolCalls: true  },

  // ── Groq — Medium ────────────────────────────────────────────────────────
  'llama-3.3-70b-versatile':                  { contextWindow: 128_000, recommendedOutput: 32_768, supportsToolCalls: true  },
  'openai/gpt-oss-20b':                       { contextWindow: 128_000, recommendedOutput:  4_096, supportsToolCalls: true  },
  'qwen/qwen3.6-27b':                         { contextWindow: 131_072, recommendedOutput:  8_192, supportsToolCalls: true  },
  'minimaxai/minimax-m2.7':                   { contextWindow: 1_000_192, recommendedOutput: 8_192, supportsToolCalls: true },
  'groq/compound':                            { contextWindow: 128_000, recommendedOutput:  8_192, supportsToolCalls: true  },
  'groq/compound-mini':                       { contextWindow: 128_000, recommendedOutput:  4_096, supportsToolCalls: true  },

  // ── Groq — Low ────────────────────────────────────────────────────────────
  'llama-3.1-8b-instant':                     { contextWindow: 128_000, recommendedOutput: 8_192, supportsToolCalls: true  },
};

/**
 * Return capability metadata for a model.
 *
 * @param modelId              The active model id (may be unknown/custom).
 * @param fallbackContextTokens The user's `maxContextTokens` setting — used
 *                             as the context window for unrecognised models.
 */
export function getCapabilities(
  modelId: string,
  fallbackContextTokens: number,
): ModelCapabilities {
  const override = CAPABILITIES[modelId];
  if (!override) {
    return { ...DEFAULT_CAPABILITIES, contextWindow: fallbackContextTokens };
  }
  return { ...DEFAULT_CAPABILITIES, ...override };
}
