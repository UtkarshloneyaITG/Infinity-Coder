import * as fs from 'fs';
import * as path from 'path';
import { walk, looksBinary } from '../engine/tools/common';
import { BrainDef, FileChange } from './types';
import { matchAny, toRelative } from './glob';
import { StagingWorkspace } from './staging';

/**
 * The Context Builder — what each brain is allowed to see.
 *
 * A brain never receives the repository. It receives the slice its ContextRules
 * describe, capped by file count and byte budget, with the run's staged changes
 * layered on top so a brain reads what the team has produced rather than what
 * was on disk when the run started.
 *
 * This is the single biggest lever on both cost and answer quality: a Security
 * brain given 400 files finds nothing, and a Frontend brain given the whole
 * backend starts editing it.
 */

const WALK_TIMEOUT_MS = 4000;
/** Per-file cap. A 6k-line file contributes its head, not the whole thing. */
const MAX_FILE_CHARS = 24_000;

export interface BuiltContext {
  /** The block appended to the brain's prompt. */
  text: string;
  /** Workspace-relative paths actually included, for the UI and for telemetry-free logging. */
  files: string[];
  approxTokens: number;
}

export class ContextBuilder {
  constructor(private readonly workspaceRoot: string) {}

  public build(brain: BrainDef, staging: StagingWorkspace, goal: string): BuiltContext {
    if (!this.workspaceRoot || brain.contextRules.mode === 'none') {
      return { text: '', files: [], approxTokens: 0 };
    }
    switch (brain.contextRules.mode) {
      case 'summary':
        return this.summary(brain);
      case 'changed':
        return this.changed(brain, staging);
      default:
        return this.globs(brain, staging, goal);
    }
  }

  /** Every workspace-relative file path, pruned and bounded. */
  private listFiles(): string[] {
    const out: string[] = [];
    const deadline = Date.now() + WALK_TIMEOUT_MS;
    for (const entry of walk(this.workspaceRoot, deadline)) {
      if (!entry.isDir) {
        out.push(toRelative(this.workspaceRoot, entry.fullPath));
      }
      if (out.length >= 20_000) {
        break; // a monorepo this size needs semantic search, not a file list
      }
    }
    return out;
  }

  /**
   * The Planner's view: shape, not contents. A directory census plus the
   * manifest files that say what the project actually is.
   */
  private summary(brain: BrainDef): BuiltContext {
    const files = this.listFiles();
    const byDir = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const rel of files) {
      const dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.';
      byDir.set(dir, (byDir.get(dir) || 0) + 1);
      const ext = path.extname(rel).toLowerCase() || '(none)';
      extensions.set(ext, (extensions.get(ext) || 0) + 1);
    }

    const topDirs = [...byDir.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([dir, n]) => `  ${dir}/  — ${n} file(s)`);
    const topExt = [...extensions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([ext, n]) => `${ext} ×${n}`);

    const manifests = [
      'package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml',
      'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pom.xml', 'README.md',
    ].filter(name => files.includes(name));

    const parts = [
      'PROJECT SHAPE',
      `Root: ${this.workspaceRoot}`,
      `${files.length} file(s) after pruning build output and dependencies.`,
      '',
      'Top-level layout:',
      ...topDirs,
      '',
      `File types: ${topExt.join(', ')}`,
    ];

    if (manifests.length > 0) {
      parts.push('', 'Manifests present: ' + manifests.join(', '));
      // The dependency list is the single most informative thing about a
      // project for a planner, and it is small.
      const pkgPath = path.join(this.workspaceRoot, 'package.json');
      if (files.includes('package.json')) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40);
          if (deps.length) {
            parts.push(`Dependencies: ${deps.join(', ')}`);
          }
          if (pkg.scripts) {
            parts.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
          }
        } catch {
          // A malformed package.json is the project's problem, not the run's.
        }
      }
    }

    const text = wrap(brain, parts.join('\n'));
    return { text, files: manifests, approxTokens: Math.ceil(text.length / 4) };
  }

  /** The reviewers' view: only what this run has staged so far. */
  private changed(brain: BrainDef, staging: StagingWorkspace): BuiltContext {
    const changes = staging.changes().slice(0, brain.contextRules.maxFiles);
    if (changes.length === 0) {
      return {
        text: wrap(brain, 'No files have been changed in this run yet. There is nothing to review.'),
        files: [],
        approxTokens: 20,
      };
    }

    let budget = brain.contextRules.maxBytes || 120_000;
    const blocks: string[] = ['CHANGES STAGED IN THIS RUN', ''];
    const included: string[] = [];

    for (const change of changes) {
      if (budget <= 0) {
        blocks.push(`…(${changes.length - included.length} further changed file(s) omitted for size.)`);
        break;
      }
      const body = renderChange(change, Math.min(budget, MAX_FILE_CHARS));
      budget -= body.length;
      blocks.push(body);
      included.push(change.relPath);
    }

    const text = wrap(brain, blocks.join('\n'));
    return { text, files: included, approxTokens: Math.ceil(text.length / 4) };
  }

  /** The engineers' view: their own slice of the tree, staged state included. */
  private globs(brain: BrainDef, staging: StagingWorkspace, goal: string): BuiltContext {
    const rules = brain.contextRules;
    const all = this.listFiles();

    // A staged file that matches this brain's includes belongs in its view even
    // if it does not exist on disk yet — that is how the Frontend brain sees the
    // route the Backend brain just wrote.
    const candidates = new Set<string>();
    for (const rel of all) {
      if (matchAny(rel, rules.include) && !matchAny(rel, rules.exclude)) {
        candidates.add(rel);
      }
    }
    for (const rel of staging.changedPaths()) {
      if (matchAny(rel, rules.include) && !matchAny(rel, rules.exclude)) {
        candidates.add(rel);
      }
    }

    // Rank by relevance to the goal, then by path depth: with a 40-file cap, the
    // ordering decides what the brain actually gets, and an alphabetical cut
    // would hand it whatever starts with 'a'.
    const terms = goalTerms(goal);
    const ranked = [...candidates]
      .map(rel => ({ rel, score: relevance(rel, terms, staging.has(rel)) }))
      .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
      .slice(0, rules.maxFiles)
      .map(r => r.rel);

    let budget = rules.maxBytes || 120_000;
    const blocks: string[] = [
      'YOUR FILES',
      'This is your slice of the project — other brains own the rest. Files marked',
      '(staged) were produced earlier in this run and are not on disk yet.',
      '',
    ];
    const included: string[] = [];

    for (const rel of ranked) {
      if (budget <= 0) {
        break;
      }
      const staged = staging.read(rel);
      if (staged === null) {
        blocks.push(`--- ${rel} (staged for deletion) ---`);
        included.push(rel);
        continue;
      }
      const content = staged !== undefined ? staged : readText(path.join(this.workspaceRoot, rel));
      if (content === null) {
        continue;
      }
      const cap = Math.min(budget, MAX_FILE_CHARS);
      const body = content.length > cap
        ? content.slice(0, cap) + `\n…(truncated — ${content.length - cap} more characters. Use read_file with an offset to see the rest.)`
        : content;
      blocks.push(`--- ${rel}${staged !== undefined ? ' (staged)' : ''} ---\n${body}`);
      budget -= body.length;
      included.push(rel);
    }

    if (included.length === 0) {
      blocks.push('(No existing files match your scope yet — you are working on new ground.)');
    } else if (ranked.length > included.length) {
      blocks.push(`\n…(${ranked.length - included.length} more file(s) in your scope were omitted for size. Use find_files and read_file to reach them.)`);
    }

    const text = wrap(brain, blocks.join('\n\n'));
    return { text, files: included, approxTokens: Math.ceil(text.length / 4) };
  }
}

function wrap(brain: BrainDef, body: string): string {
  return [
    '========================',
    `CONTEXT FOR ${brain.name.toUpperCase()}`,
    '========================',
    body,
  ].join('\n');
}

function readText(abs: string): string | null {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return null;
    }
    const buf = fs.readFileSync(abs);
    return looksBinary(buf) ? null : buf.toString('utf8');
  } catch {
    return null;
  }
}

function renderChange(change: FileChange, cap: number): string {
  if (change.kind === 'delete') {
    return `--- ${change.relPath} (DELETED) ---`;
  }
  const after = change.after ?? '';
  const body = after.length > cap ? after.slice(0, cap) + '\n…(truncated)' : after;
  const label = change.before === null ? 'NEW FILE' : 'MODIFIED';
  return `--- ${change.relPath} (${label}) ---\n${body}\n`;
}

/** Words worth matching a path against. Short and generic words are noise. */
function goalTerms(goal: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'add', 'build', 'create', 'make', 'that', 'this',
    'from', 'into', 'using', 'use', 'new', 'app', 'need', 'want', 'should',
  ]);
  return [...new Set(
    (goal || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 3 && !stop.has(w))
  )].slice(0, 12);
}

function relevance(rel: string, terms: string[], staged: boolean): number {
  const lower = rel.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 10;
    }
  }
  if (staged) {
    score += 25; // produced by this run — almost always the relevant file
  }
  // Prefer source over config noise, and shallow over deeply nested.
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|php|rb|sql|vue|svelte)$/.test(lower)) {
    score += 3;
  }
  score -= lower.split('/').length;
  return score;
}
