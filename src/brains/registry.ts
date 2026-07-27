import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrainDef, OrchestrationSettings } from './types';
import { DEFAULT_BRAINS } from './defaults';

/**
 * The Brain Registry — the single source of truth for "which brains exist".
 *
 * Three layers, later winning over earlier:
 *   1. the built-in team (defaults.ts)
 *   2. installed brain packs found on disk under the configured brain roots
 *   3. the user's per-brain overrides from settings
 *
 * A pack is a folder. Nothing is compiled and nothing is imported, so installing
 * a brain is copying a directory and calling reload() — that is the whole
 * "marketplace", and it is deliberately not a plugin API with executable code:
 * a brain is a prompt and a policy, and letting it be code would make installing
 * one equivalent to running arbitrary JavaScript in the extension host.
 *
 *   <root>/<id>/brain.json         required — identity, model, weights
 *   <root>/<id>/prompt.md          required — the system prompt
 *   <root>/<id>/capabilities.json  optional — tools + contextRules
 *   <root>/<id>/settings.json      optional — temperature, maxTokens, priority…
 *   <root>/<id>/icon.svg           optional — unused by the tree view, kept for packs
 */

export interface RegistryProblem {
  source: string;
  message: string;
}

export class BrainRegistry {
  private brains = new Map<string, BrainDef>();
  private problems: RegistryProblem[] = [];
  private loadedRoots: string[] = [];

  constructor(private readonly readSettings: () => OrchestrationSettings) {
    this.reload();
  }

  /** Re-scan disk and re-apply overrides. Safe to call at any time. */
  public reload(): void {
    const settings = this.readSettings();
    this.brains.clear();
    this.problems = [];
    this.loadedRoots = [];

    for (const brain of DEFAULT_BRAINS) {
      this.brains.set(brain.id, structuredClone(brain));
    }

    for (const root of settings.brainRoots || []) {
      this.loadRoot(expandHome(root));
    }

    for (const [id, override] of Object.entries(settings.overrides || {})) {
      const base = this.brains.get(id);
      if (!base) {
        // An override for a pack the user has since deleted. Not an error worth
        // surfacing — it becomes live again if they reinstall the pack.
        continue;
      }
      this.brains.set(id, mergeOverride(base, override));
    }
  }

  private loadRoot(root: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // a root that does not exist yet is normal, not a problem
    }
    this.loadedRoots.push(root);

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const dir = path.join(root, entry.name);
      try {
        const brain = readPack(dir, entry.name);
        this.brains.set(brain.id, brain);
      } catch (e: any) {
        this.problems.push({ source: dir, message: e?.message || String(e) });
      }
    }
  }

  public all(): BrainDef[] {
    return [...this.brains.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }

  public enabled(): BrainDef[] {
    return this.all().filter(b => b.enabled);
  }

  public get(id: string): BrainDef | undefined {
    return this.brains.get(id);
  }

  /**
   * Resolve a brain the planner named. Planners hallucinate ids, so fall back to
   * role and then to a fuzzy name match before giving up — a plan is too
   * expensive to discard over "backend-engineer" vs "backend".
   */
  public resolve(idOrRole: string): BrainDef | undefined {
    const needle = (idOrRole || '').trim().toLowerCase();
    if (!needle) {
      return undefined;
    }
    const direct = this.brains.get(needle);
    if (direct) {
      return direct;
    }
    const candidates = this.enabled();
    return (
      candidates.find(b => b.role === needle) ||
      candidates.find(b => b.name.toLowerCase() === needle) ||
      candidates.find(b => needle.includes(b.id) || b.id.includes(needle)) ||
      candidates.find(b => needle.includes(b.role))
    );
  }

  public byRole(role: BrainDef['role']): BrainDef | undefined {
    return this.enabled().find(b => b.role === role);
  }

  public getProblems(): RegistryProblem[] {
    return [...this.problems];
  }

  public getRoots(): string[] {
    return [...this.loadedRoots];
  }
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readPack(dir: string, folderName: string): BrainDef {
  const manifestPath = path.join(dir, 'brain.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('no brain.json');
  }
  const manifest = readJson(manifestPath);

  const promptPath = path.join(dir, 'prompt.md');
  if (!fs.existsSync(promptPath)) {
    throw new Error('no prompt.md');
  }
  const systemPrompt = fs.readFileSync(promptPath, 'utf8').trim();
  if (!systemPrompt) {
    throw new Error('prompt.md is empty');
  }

  const capabilities = fs.existsSync(path.join(dir, 'capabilities.json'))
    ? readJson(path.join(dir, 'capabilities.json'))
    : {};
  const extra = fs.existsSync(path.join(dir, 'settings.json'))
    ? readJson(path.join(dir, 'settings.json'))
    : {};

  // A pack declares a subset; everything else takes the same defaults the
  // built-in brains use, so a two-field brain.json produces a working brain.
  const template = DEFAULT_BRAINS.find(b => b.role === manifest.role) || DEFAULT_BRAINS[2];
  const merged: BrainDef = {
    ...structuredClone(template),
    id: String(manifest.id || folderName),
    name: String(manifest.name || folderName),
    description: String(manifest.description || ''),
    role: manifest.role || 'custom',
    systemPrompt,
    source: 'installed',
    enabled: manifest.enabled !== false,
  };

  applyNumeric(merged, { ...manifest, ...extra });
  if (typeof manifest.provider === 'string') {
    merged.provider = manifest.provider;
  }
  if (typeof manifest.model === 'string') {
    merged.model = manifest.model;
  }
  if (Array.isArray(manifest.fallbackProviders)) {
    merged.fallbackProviders = manifest.fallbackProviders.map(String);
  }
  if (Array.isArray(manifest.fallbackModels)) {
    merged.fallbackModels = manifest.fallbackModels.map(String);
  }
  if (typeof manifest.icon === 'string') {
    merged.icon = manifest.icon;
  }
  if (capabilities.tools) {
    merged.tools = {
      allow: toStringArray(capabilities.tools.allow, merged.tools.allow),
      deny: toStringArray(capabilities.tools.deny, merged.tools.deny),
    };
  }
  if (capabilities.contextRules) {
    const rules = capabilities.contextRules;
    merged.contextRules = {
      include: toStringArray(rules.include, merged.contextRules.include),
      exclude: toStringArray(rules.exclude, merged.contextRules.exclude),
      mode: ['globs', 'changed', 'summary', 'none'].includes(rules.mode) ? rules.mode : merged.contextRules.mode,
      maxFiles: numberOr(rules.maxFiles, merged.contextRules.maxFiles),
      maxBytes: numberOr(rules.maxBytes, merged.contextRules.maxBytes),
    };
  }
  if (capabilities.memory) {
    merged.memory = { ...merged.memory, ...pickBooleans(capabilities.memory) };
  }
  return merged;
}

function applyNumeric(brain: BrainDef, source: any): void {
  brain.temperature = clamp(numberOr(source.temperature, brain.temperature), 0, 2);
  brain.maxTokens = Math.max(256, numberOr(source.maxTokens, brain.maxTokens));
  brain.priority = numberOr(source.priority, brain.priority);
  brain.costWeight = clamp(numberOr(source.costWeight, brain.costWeight), 0, 1);
  brain.confidenceWeight = clamp(numberOr(source.confidenceWeight, brain.confidenceWeight), 0, 1);
  if (typeof source.parallelExecution === 'boolean') {
    brain.parallelExecution = source.parallelExecution;
  }
}

/**
 * A settings override may name any field, but must not be able to smuggle in a
 * broken shape — the UI writes these and so, eventually, will a sync.
 */
function mergeOverride(base: BrainDef, override: Partial<BrainDef>): BrainDef {
  const next: BrainDef = { ...structuredClone(base), ...structuredClone(override), id: base.id, source: base.source };
  next.tools = { allow: [...(next.tools?.allow || [])], deny: [...(next.tools?.deny || [])] };
  next.memory = { ...base.memory, ...(override.memory || {}) };
  next.contextRules = { ...base.contextRules, ...(override.contextRules || {}) };
  applyNumeric(next, next);
  return next;
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map(String) : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function pickBooleans(source: any): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}
