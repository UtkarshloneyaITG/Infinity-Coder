// Type-only: this module touches no vscode runtime API, so it stays loadable
// (and testable) outside the extension host.
import type * as vscode from 'vscode';

/**
 * Infinity Coder settings — providers, keys, models, tools.
 *
 * Everything except the API keys lives in globalState. The keys themselves live
 * in context.secrets (OS keychain); globalState only ever holds an id and the
 * last 4 characters, so the webview can render a masked row without the secret
 * ever reaching the DOM.
 */

export interface ProviderKey {
  /** Secret id — the raw key is stored under `infinityCoder.key.<id>`. */
  id: string;
  /** Last 4 chars, for the masked display row. Never the whole key. */
  last4: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /** Ordered: [0] is primary, the rest are fallbacks tried in order. */
  keys: ProviderKey[];
}

export interface InfinityCoderSettings {
  /** Ordered — this is the provider failover order. */
  providers: Provider[];
  activeModel: string;
  boostModel: string;
  /** Adaptive context manager settings. */
  context: ContextSettings;
  /**
   * Model ids the user added by hand. Always offered in the picker regardless of
   * which providers have keys: they were typed deliberately, and may be an id
   * newer than any list we ship.
   */
  customModels: string[];
  /**
   * Model ids hidden from the picker. Kept rather than deleted so a hidden model
   * can be brought back — and so hiding a catalog entry survives an update that
   * would otherwise just re-add it.
   */
  hiddenModels: string[];
  temperature: number;
  maxTokens: number;
  /**
   * Context budget used to trim history and to draw the usage meter. Not fetched
   * per model: providers do not reliably report a context length, and guessing
   * one per model id would be fiction. Set it to match the model you run.
   */
  maxContextTokens: number;
  /**
   * Tool rounds allowed in one turn. Real agentic work runs long — scaffolding a
   * project is one round per file — so this is generous. It is a runaway
   * backstop, not the working limit: the context budget and the repeat detector
   * stop a turn long before this in practice.
   */
  maxToolRounds: number;
  /** Folders scanned for SKILL.md files. Global only — see the Skills tab note. */
  skillRoots: string[];
  /** Per-skill mode, keyed by skill name. Absent means 'auto'. */
  skillModes: Record<string, 'off' | 'auto' | 'always'>;
  toolGroups: Record<string, boolean>;
  /**
   * 'ask' shows a diff and waits for approval before any file write, edit or
   * delete. 'auto' lets the agent change files unattended.
   */
  approvalMode: 'ask' | 'auto';
  semantic: SemanticSettings;
}

/**
 * Semantic index configuration. Off by default: it costs embedding calls, and
 * an extension that starts spending a user's API quota the moment it installs
 * has made that decision for them.
 */
export interface SemanticSettings {
  enabled: boolean;
  /** Provider id from `providers`, or '' to use the first one with a key. */
  providerId: string;
  /** Embedding model. Must match the provider — widths differ per model. */
  model: string;
  /** Target chunk size in characters. */
  chunkChars: number;
  /** Results returned by a search. */
  topK: number;
  /** Extra folder names to skip, on top of ALWAYS_EXCLUDED. */
  excluded: string[];
  /** Stop scanning after this many files. */
  maxFiles: number;
  /** Hard ceiling on stored chunks, so a huge repo cannot exhaust memory. */
  maxChunks: number;
  /** Re-index on file save/create/delete. */
  autoUpdate: boolean;
  /** Retrieve context automatically for every chat message. */
  autoContext: boolean;
  /** Token budget for automatically retrieved context. */
  contextTokens: number;
}

/**
 * Adaptive context management settings.
 *
 * The Context Manager reads these on every prepare() call, so changes take
 * effect on the very next message without restarting the extension.
 */
export interface ContextSettings {
  /** Enable automatic context compaction. Default: true. */
  autoCompact: boolean;
  /**
   * Utilization fraction (0.0–1.0) at which compaction starts.
   * e.g. 0.70 means "start compacting when 70% of the usable input window is full".
   */
  compactThreshold: number;
  /** Tokens reserved for the model's reply. Must be >= model's minimumReservedOutput. */
  reservedOutputTokens: number;
  /** When true, tier='aggressive' is used above 95% utilization. */
  aggressiveCompression: boolean;
  /**
   * When true (and autoCompact is true), the ConversationSummarizer will call
   * the LLM to produce structured summaries for old conversation segments.
   * When false, only tool-output compaction runs (no extra API calls).
   */
  summaryEnabled: boolean;
  /** Number of most-recent turn pairs to keep verbatim (not summarized). */
  summaryDepth: number;
}

/** Tool group -> tool names. Used to build the `tools` param for a turn. */
export const TOOL_GROUPS: Record<string, string[]> = {
  files: ['read_file', 'write_file', 'edit_file', 'create_item', 'delete_item', 'list_folder'],
  search: ['find_files', 'search_in_files'],
  shell: ['run_command', 'list_processes', 'stop_process'],
  web: ['web_search', 'read_page', 'extract_links'],
};

export const TOOL_GROUP_LABELS: Record<string, string> = {
  files: 'Files — read, write, edit, create, delete',
  search: 'Search — find files by name, grep contents',
  shell: 'Shell — run commands, manage background processes',
  web: 'Web — search, read pages, extract links',
};

const DEFAULTS: InfinityCoderSettings = {
  providers: [
    {
      id: 'nvidia',
      name: 'NVIDIA NIM',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      enabled: true,
      keys: [],
    },
    {
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      enabled: true,
      keys: [],
    },
  ],
  // Both must exist in catalog.ts, which is verified against NIM's live model
  // list. The previous defaults were ids NIM does not serve, so a fresh install
  // failed on its first message.
  customModels: [],
  hiddenModels: [],
  activeModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  boostModel: 'nvidia/nemotron-3-super-120b-a12b',
  temperature: 0.7,
  maxTokens: 4096,
  maxContextTokens: 128_000,
  maxToolRounds: 100,
  // Global folders only. A SKILL.md discovered inside a workspace would be
  // untrusted text turning into instructions for a model that can run commands,
  // so cloned repos are deliberately not scanned.
  skillRoots: ['~/.infinity-coder/skills', '~/.claude/skills'],
  skillModes: {},
  toolGroups: { files: true, search: true, shell: true, web: true },
  // Default to asking: the first time this agent edits a real repo should not be
  // a surprise. Users who want unattended runs can switch it off in one click.
  approvalMode: 'ask',
  context: {
    autoCompact: true,
    compactThreshold: 0.70,
    reservedOutputTokens: 4_096,
    aggressiveCompression: true,
    summaryEnabled: true,
    summaryDepth: 5,
  },
  semantic: {
    enabled: false,
    providerId: '',
    // A widely available default. NVIDIA NIM and OpenAI both serve an embedding
    // model under a different id, so this is the one thing a user must set.
    model: 'nvidia/nv-embedqa-e5-v5',
    chunkChars: 4000,
    topK: 12,
    excluded: [],
    maxFiles: 100_000,
    maxChunks: 400_000,
    autoUpdate: true,
    autoContext: true,
    contextTokens: 24_000,
  },
};

const STORAGE_KEY = 'infinityCoder.settings';
const SECRET_PREFIX = 'infinityCoder.key.';

export class SettingsStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public get(): InfinityCoderSettings {
    const saved = this.context.globalState.get<Partial<InfinityCoderSettings>>(STORAGE_KEY);
    if (!saved) {
      return structuredClone(DEFAULTS);
    }
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      // A provider list saved by an older version may be missing newer defaults,
      // so keep any default provider the user hasn't got.
      providers: this.mergeProviders(saved.providers),
      toolGroups: { ...DEFAULTS.toolGroups, ...(saved.toolGroups || {}) },
      // Same reason as toolGroups: a settings blob written before a field
      // existed must gain its default rather than leave it undefined.
      semantic: { ...DEFAULTS.semantic, ...(saved.semantic || {}) },
      context: { ...DEFAULTS.context, ...(saved.context || {}) },
      customModels: saved.customModels || [],
      hiddenModels: saved.hiddenModels || [],
    };
  }

  private mergeProviders(saved?: Provider[]): Provider[] {
    if (!saved || saved.length === 0) {
      return structuredClone(DEFAULTS.providers);
    }
    const out = structuredClone(saved);
    for (const def of DEFAULTS.providers) {
      if (!out.some(p => p.id === def.id)) {
        out.push(structuredClone(def));
      }
    }
    return out;
  }

  public async save(settings: InfinityCoderSettings): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, settings);
  }

  /**
   * Patch the non-secret fields. The webview sends these on Save; it can never
   * send key material this way because it never has any.
   */
  public async patch(patch: Partial<InfinityCoderSettings>): Promise<InfinityCoderSettings> {
    const next = { ...this.get(), ...patch };
    await this.save(next);
    return next;
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  public async addKey(providerId: string, rawKey: string): Promise<InfinityCoderSettings> {
    const key = rawKey.trim();
    if (!key) {
      throw new Error('Key is empty.');
    }
    const settings = this.get();
    const provider = settings.providers.find(p => p.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    // Random suffix, not just the timestamp: two keys added in the same
    // millisecond would otherwise share an id and clobber each other's secret.
    const id = `${providerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.context.secrets.store(SECRET_PREFIX + id, key);
    provider.keys.push({ id, last4: key.slice(-4) });
    await this.save(settings);
    return settings;
  }

  public async removeKey(providerId: string, keyId: string): Promise<InfinityCoderSettings> {
    const settings = this.get();
    const provider = settings.providers.find(p => p.id === providerId);
    if (provider) {
      provider.keys = provider.keys.filter(k => k.id !== keyId);
      await this.save(settings);
    }
    await this.context.secrets.delete(SECRET_PREFIX + keyId);
    return settings;
  }

  /** Move a key up/down in the fallback order. */
  public async moveKey(providerId: string, keyId: string, delta: number): Promise<InfinityCoderSettings> {
    const settings = this.get();
    const provider = settings.providers.find(p => p.id === providerId);
    if (provider) {
      move(provider.keys, provider.keys.findIndex(k => k.id === keyId), delta);
      await this.save(settings);
    }
    return settings;
  }

  public async getKey(keyId: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + keyId);
  }

  /** Raw keys for a provider, in fallback order. For the engine, not the webview. */
  public async keysFor(providerId: string): Promise<string[]> {
    const provider = this.get().providers.find(p => p.id === providerId);
    if (!provider) {
      return [];
    }
    const keys = await Promise.all(provider.keys.map(k => this.getKey(k.id)));
    return keys.filter((k): k is string => !!k);
  }

  // ── Providers ───────────────────────────────────────────────────────────

  public async addProvider(name: string, baseUrl: string): Promise<InfinityCoderSettings> {
    const settings = this.get();
    const id = `custom-${Date.now().toString(36)}`;
    settings.providers.push({ id, name: name.trim() || 'Custom', baseUrl: baseUrl.trim(), enabled: true, keys: [] });
    await this.save(settings);
    return settings;
  }

  public async removeProvider(providerId: string): Promise<InfinityCoderSettings> {
    const settings = this.get();
    const provider = settings.providers.find(p => p.id === providerId);
    for (const k of provider?.keys || []) {
      await this.context.secrets.delete(SECRET_PREFIX + k.id);
    }
    settings.providers = settings.providers.filter(p => p.id !== providerId);
    await this.save(settings);
    return settings;
  }

  public async updateProvider(providerId: string, patch: Partial<Provider>): Promise<InfinityCoderSettings> {
    const settings = this.get();
    const provider = settings.providers.find(p => p.id === providerId);
    if (provider) {
      Object.assign(provider, patch, { id: provider.id, keys: provider.keys });
      await this.save(settings);
    }
    return settings;
  }

  public async moveProvider(providerId: string, delta: number): Promise<InfinityCoderSettings> {
    const settings = this.get();
    move(settings.providers, settings.providers.findIndex(p => p.id === providerId), delta);
    await this.save(settings);
    return settings;
  }
}

export function move<T>(list: T[], index: number, delta: number): void {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) {
    return;
  }
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
}

/**
 * Verify a key by listing models on its endpoint. Doubles as model discovery —
 * the Models tab uses the returned ids so we never hardcode a provider's
 * catalog and get it wrong.
 */
/**
 * Does this provider actually serve this model id?
 *
 * A real one-token completion, not a `/models` lookup: plenty of endpoints list
 * models the account cannot call, and being told a model works and then having
 * every message fail is worse than not offering the check at all.
 */
export async function testModel(
  baseUrl: string,
  rawKey: string,
  modelId: string
): Promise<{ ok: boolean; message: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true, message: `OK - replied in ${Date.now() - started}ms` };
    }

    const detail = await res.text().catch(() => '');
    // The distinction that matters: a wrong id is permanent, a 429 is not.
    if (res.status === 404 || /model.*(not found|does not exist|unknown)/i.test(detail)) {
      return { ok: false, message: 'Not available on this provider' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Key rejected for this model' };
    }
    if (res.status === 429) {
      return { ok: false, message: 'Rate limited - the model exists, try again shortly' };
    }
    const short = detail.replace(/\s+/g, ' ').slice(0, 120);
    return { ok: false, message: `HTTP ${res.status}${short ? ' - ' + short : ''}` };
  } catch (e: any) {
    return { ok: false, message: e?.name === 'AbortError' ? 'Timed out' : e?.message || 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function testKey(
  baseUrl: string,
  rawKey: string
): Promise<{ ok: boolean; message: string; models: string[] }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${rawKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = res.status === 401 || res.status === 403 ? 'key rejected' : res.statusText;
      return { ok: false, message: `HTTP ${res.status} — ${detail}`, models: [] };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data || []).map(m => m.id).filter((id): id is string => !!id);
    return { ok: true, message: `OK — ${models.length} models`, models };
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timed out' : e?.message || 'unreachable';
    return { ok: false, message: reason, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
