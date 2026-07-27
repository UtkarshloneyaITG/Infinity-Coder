import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Skills — reusable instruction files that shape how the agent works.
 *
 * A skill is a plain markdown file with YAML frontmatter, the same format Claude
 * Code uses, so an existing library of them works here unchanged:
 *
 *     ---
 *     name: ponytail
 *     description: Lazy senior dev mode for any coding task...
 *     ---
 *     <instructions>
 *
 * Two tiers, and deliberately NO model judgement in either:
 *
 *   always — small behaviour skills (house style, review checklist). Injected on
 *            every request. Perfectly reliable because nothing decides anything.
 *   auto   — large reference skills (a 3.5k-token API guide). Scored against the
 *            user's message and loaded only when they clearly apply, because
 *            always-on would spend a quarter of the context budget before the
 *            user has said anything.
 *
 * There is no "let the model pick a skill" tool on purpose: that is the least
 * reliable link in the chain with mid-tier models, and keyword scoring does the
 * same job deterministically.
 */

export type SkillMode = 'off' | 'auto' | 'always';

export interface SkillMeta {
  name: string;
  description: string;
  file: string;
  bytes: number;
  /** Rough token cost, for the budget shown in the Skills tab. */
  tokens: number;
  /**
   * Optional `prompt:` frontmatter — what /<skill> should ask for when invoked
   * with nothing after it. The skill author knows what their skill needs to
   * operate on; a generic "run this skill" leaves the model guessing.
   */
  prompt: string;
}

/**
 * Why a skill is in this request.
 *   always  — configured to apply to everything
 *   auto    — scored against the message
 *   command — the user typed /<skill>, which overrides the configured mode
 */
export type SkillReason = 'always' | 'auto' | 'command';

export interface LoadedSkill {
  name: string;
  body: string;
  reason: SkillReason;
}

/** One skill can never dominate the prompt. */
const MAX_SKILL_CHARS = 20_000;
/** How deep to look for SKILL.md — plugin caches nest several levels. */
const MAX_SCAN_DEPTH = 7;

// Auto-selection tuning. Exported so the self-check pins them.
export const MAX_AUTO_SKILLS = 2;
export const AUTO_SCORE_THRESHOLD = 3;
/** Runners-up must be within this fraction of the best score to also load. */
export const AUTO_RELATIVE_CUTOFF = 0.75;

const NAME_TERM_WEIGHT = 3;
const MAX_DESCRIPTION_POINTS = 4;

// Words too common to signal anything. Skill descriptions are written as "Use
// when the user asks to…", so that phrasing has to be stripped or every skill
// matches every message.
const STOPWORDS = new Set([
  'use', 'when', 'user', 'users', 'ask', 'asks', 'asked', 'asking', 'the', 'this', 'that',
  'these', 'those', 'with', 'without', 'from', 'into', 'over', 'your', 'you', 'and', 'for',
  'not', 'any', 'are', 'its', 'it', 'is', 'be', 'been', 'being', 'was', 'were', 'has', 'have',
  'had', 'can', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'also', 'just',
  'only', 'more', 'most', 'other', 'others', 'than', 'then', 'them', 'they', 'their', 'there',
  'here', 'what', 'which', 'who', 'how', 'why', 'all', 'each', 'every', 'some', 'such', 'like',
  'want', 'wants', 'need', 'needs', 'make', 'makes', 'making', 'work', 'works', 'working',
  'using', 'used', 'via', 'per', 'out', 'off', 'new', 'get', 'got', 'set', 'add', 'adds',
  'about', 'after', 'before', 'during', 'while', 'does', 'doing', 'done',
]);

export function expandHome(target: string): string {
  const trimmed = (target || '').trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return trimmed;
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Parse the leading `---` block. Deliberately not a YAML parser: skills only use
 * a handful of scalar keys, and folded scalars (`description: >-`) are the one
 * multi-line form that shows up in practice.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: normalized.trim() };
  }

  const data: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const keyed = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!keyed) {
      continue;
    }
    const key = keyed[1];
    let value = keyed[2].trim();

    // Folded / literal scalar: the value is the indented block that follows.
    if (value === '' || value === '>' || value === '>-' || value === '|' || value === '|-') {
      const gathered: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        gathered.push(lines[++i].trim());
      }
      value = gathered.join(' ');
    }
    data[key] = value.replace(/^["']|["']$/g, '').trim();
  }

  return { data, body: match[2].trim() };
}

// ── Discovery ───────────────────────────────────────────────────────────────

function* findSkillFiles(root: string, depth = 0): Generator<string> {
  if (depth > MAX_SCAN_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      yield* findSkillFiles(full, depth + 1);
    } else if (entry.name.toLowerCase() === 'skill.md') {
      yield full;
    }
  }
}

/**
 * Every skill under `roots`, first definition of a name winning so an earlier
 * root can shadow a later one.
 */
export function discoverSkills(roots: string[]): SkillMeta[] {
  const found = new Map<string, SkillMeta>();

  for (const raw of roots) {
    const root = expandHome(raw);
    if (!root || !fs.existsSync(root)) {
      continue;
    }
    for (const file of findSkillFiles(root)) {
      let text: string;
      let bytes: number;
      try {
        bytes = fs.statSync(file).size;
        text = fs.readFileSync(file, 'utf8').slice(0, MAX_SKILL_CHARS * 2);
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(text);
      // Fall back to the containing folder, which is the convention anyway.
      const name = (data.name || path.basename(path.dirname(file))).trim();
      if (!name || found.has(name)) {
        continue;
      }
      found.set(name, {
        name,
        description: data.description || '',
        file,
        bytes,
        tokens: Math.round(Math.min(bytes, MAX_SKILL_CHARS) / 4),
        prompt: data.prompt || '',
      });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Crude singularisation so "shader" matches a skill named "shaders". */
const singular = (term: string): string =>
  term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;

/**
 * How strongly a skill applies to a message.
 *
 * Name terms are the real signal — a skill called "threejs-shaders" is about
 * shaders — so they are weighted heavily. Description words are corroboration
 * and capped, so a long description cannot out-vote a direct name hit.
 */
export function scoreSkill(message: string, meta: SkillMeta, triggers?: string): number {
  const tokens = new Set(tokenize(message).map(singular));
  const squashed = squash(message);

  const strong = new Set<string>();
  for (const part of meta.name.split(/[-_\s]+/)) {
    if (part) {
      strong.add(part.toLowerCase());
    }
  }
  strong.add(squash(meta.name));
  for (const trigger of (triggers || '').split(',')) {
    const clean = trigger.trim().toLowerCase();
    if (clean) {
      strong.add(clean);
    }
  }

  let score = 0;
  for (const term of strong) {
    if (!term || STOPWORDS.has(term)) {
      continue;
    }
    // Compact forms matter: "three.js" in a message squashes to "threejs",
    // which no word-level tokenizer would ever match against the skill name.
    const compact = squash(term);
    if (tokens.has(singular(term)) || (compact.length >= 5 && squashed.includes(compact))) {
      score += NAME_TERM_WEIGHT;
    }
  }

  let corroboration = 0;
  const seen = new Set<string>();
  for (const word of tokenize(meta.description)) {
    if (word.length < 4 || STOPWORDS.has(word) || seen.has(word)) {
      continue;
    }
    seen.add(word);
    if (tokens.has(singular(word))) {
      corroboration++;
    }
  }

  return score + Math.min(corroboration, MAX_DESCRIPTION_POINTS);
}

/**
 * Which skills apply to this message. `always` skills are unconditional; `auto`
 * skills must score, and only the clear winners load — a runner-up well below
 * the best match is noise, and each one costs thousands of tokens.
 */
export interface SelectOptions {
  /**
   * Skill names the user invoked with /<skill>. An explicit command beats the
   * configured mode — including 'off' — because the user just asked for it by
   * name, and silently ignoring that would be baffling.
   */
  forced?: string[];
  triggersFor?: (meta: SkillMeta) => string | undefined;
}

export function selectSkills(
  message: string,
  metas: SkillMeta[],
  modes: Record<string, SkillMode>,
  options: SelectOptions = {}
): Array<{ meta: SkillMeta; reason: SkillReason; score: number }> {
  const triggersFor = options.triggersFor || (() => undefined);
  const forced = new Set(options.forced || []);
  const chosen: Array<{ meta: SkillMeta; reason: SkillReason; score: number }> = [];
  const taken = new Set<string>();

  const take = (meta: SkillMeta, reason: SkillReason, score: number) => {
    if (taken.has(meta.name)) {
      return;
    }
    taken.add(meta.name);
    chosen.push({ meta, reason, score });
  };

  for (const meta of metas) {
    if (forced.has(meta.name)) {
      take(meta, 'command', Infinity);
    }
  }
  for (const meta of metas) {
    if ((modes[meta.name] ?? 'auto') === 'always') {
      take(meta, 'always', Infinity);
    }
  }

  // Score EVERY skill, whatever its mode, so the relative cutoff is measured
  // against what the message is genuinely most about. Scoring only the eligible
  // ones means switching the best match off — or pinning it with a command —
  // silently promotes its weaker siblings past the cutoff, which is how a shader
  // question ends up loading the materials and post-processing guides instead.
  const scored = metas
    .map(meta => ({ meta, score: scoreSkill(message, meta, triggersFor(meta)) }))
    .filter(entry => entry.score >= AUTO_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0].score;
    let added = 0;
    for (const entry of scored) {
      if (added >= MAX_AUTO_SKILLS || entry.score < best * AUTO_RELATIVE_CUTOFF) {
        break;
      }
      // Ineligible skills still set the bar above; they just cannot be loaded.
      if (taken.has(entry.meta.name) || (modes[entry.meta.name] ?? 'auto') !== 'auto') {
        continue;
      }
      take(entry.meta, 'auto', entry.score);
      added++;
    }
  }

  return chosen;
}

/** Read the instruction bodies for the selected skills, bounded. */
export function loadSkillBodies(
  selected: Array<{ meta: SkillMeta; reason: SkillReason }>
): LoadedSkill[] {
  const out: LoadedSkill[] = [];
  for (const { meta, reason } of selected) {
    try {
      const { body } = parseFrontmatter(fs.readFileSync(meta.file, 'utf8'));
      if (!body) {
        continue;
      }
      out.push({
        name: meta.name,
        body: body.length > MAX_SKILL_CHARS ? body.slice(0, MAX_SKILL_CHARS) + '\n…(skill truncated)' : body,
        reason,
      });
    } catch {
      // A skill that cannot be read is skipped, never fatal to the turn.
    }
  }
  return out;
}

/**
 * In-memory catalogue. Scanning is cheap but not free, and it would otherwise
 * happen on every keystroke-triggered settings render.
 */
export class SkillRegistry {
  private cache: SkillMeta[] = [];
  private scannedRoots = '';

  public list(roots: string[]): SkillMeta[] {
    const key = roots.join('|');
    if (key !== this.scannedRoots) {
      this.refresh(roots);
    }
    return this.cache;
  }

  public refresh(roots: string[]): SkillMeta[] {
    this.scannedRoots = roots.join('|');
    this.cache = discoverSkills(roots);
    return this.cache;
  }
}
