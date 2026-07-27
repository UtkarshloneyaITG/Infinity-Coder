import * as crypto from 'crypto';
import { Chunk, SymbolKind, LANGUAGE_BY_EXT } from './types';

/**
 * Chunking. Never a fixed window over raw bytes — a chunk that starts mid-function
 * embeds to something that matches nothing, and retrieving it hands the model a
 * fragment it cannot use.
 *
 * Structure comes from VS Code's DocumentSymbol provider when one exists for the
 * language, which is why there is no tree-sitter dependency here: the editor
 * already has a real parser for every language the user has an extension for,
 * and it costs no native binaries. `SymbolNode` is the narrow shape the vscode
 * layer converts DocumentSymbol into, so this file stays testable outside the
 * extension host.
 *
 * When no provider answers (a plain `.txt`-ish language, or an extension that
 * has not activated) the structural fallbacks below take over: headings for
 * markdown, top-level keys for JSON, a symbol regex for everything else, and
 * finally an overlapping line window so nothing is silently skipped.
 */

export interface SymbolNode {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  children: SymbolNode[];
}

export interface ChunkOptions {
  /** Target chunk size in characters. Symbols larger than this are windowed. */
  maxChars?: number;
  /** Symbols smaller than this are merged with their neighbours. */
  minChars?: number;
  /** Lines of overlap when a symbol has to be split. */
  overlapLines?: number;
}

const DEFAULTS: Required<ChunkOptions> = { maxChars: 4000, minChars: 120, overlapLines: 6 };

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** ~4 characters per token holds well enough across code and prose to budget with. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function languageFor(relPath: string): string | undefined {
  const ext = relPath.split('.').pop()?.toLowerCase();
  return ext ? LANGUAGE_BY_EXT[ext] : undefined;
}

/**
 * Module specifiers this file depends on. One regex set per language family —
 * enough to power the dependency-chain boost in ranking, and cheap enough to run
 * on every file of a 100k-file repo.
 */
export function extractImports(text: string, language: string): string[] {
  const found = new Set<string>();
  const add = (m: RegExpMatchArray | null) => { if (m && m[1]) { found.add(m[1]); } };

  const patterns: Record<string, RegExp[]> = {
    js: [
      /^\s*import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/gm,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^\s*export\s+(?:\*|{[^}]*})\s+from\s+['"]([^'"]+)['"]/gm,
    ],
    python: [/^\s*from\s+([\w.]+)\s+import\s/gm, /^\s*import\s+([\w.]+)/gm],
    go: [/^\s*import\s+(?:\(\s*)?["]([^"]+)["]/gm, /^\s+_?\s*["]([^"]+)["]$/gm],
    java: [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
    csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm],
    rust: [/^\s*use\s+([\w:]+)/gm],
    ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
    php: [/^\s*(?:use|require|include)(?:_once)?\s+['"]?([\w\\/.]+)['"]?/gm],
    swift: [/^\s*import\s+(\w+)/gm],
    kotlin: [/^\s*import\s+([\w.]+)/gm],
    css: [/@import\s+(?:url\()?['"]([^'"]+)['"]/g],
  };

  for (const regex of patterns[familyOf(language)] || []) {
    for (const match of text.matchAll(regex)) {
      add(match);
    }
  }
  return [...found];
}

/** Exported/public symbol names — the surface other modules can reach. */
export function extractExports(text: string, language: string): string[] {
  const found = new Set<string>();
  const family = familyOf(language);

  if (family === 'js') {
    const patterns = [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm,
      /^\s*export\s*{\s*([^}]+)\s*}/gm,
    ];
    for (const regex of patterns) {
      for (const match of text.matchAll(regex)) {
        for (const name of match[1].split(',')) {
          const clean = name.trim().split(/\s+as\s+/)[0].trim();
          if (clean) { found.add(clean); }
        }
      }
    }
    if (/^\s*export\s+default\s/m.test(text)) {
      found.add('default');
    }
  } else if (family === 'python') {
    // No export keyword: module-level defs that are not _private are the surface.
    for (const match of text.matchAll(/^(?:def|class)\s+(\w+)/gm)) {
      if (!match[1].startsWith('_')) { found.add(match[1]); }
    }
  } else if (family === 'go') {
    // Capitalised identifiers are Go's export rule.
    for (const match of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)) {
      found.add(match[1]);
    }
    for (const match of text.matchAll(/^type\s+([A-Z]\w*)/gm)) {
      found.add(match[1]);
    }
  } else if (family === 'java' || family === 'csharp' || family === 'kotlin') {
    for (const match of text.matchAll(/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/g)) {
      found.add(match[1]);
    }
  } else if (family === 'rust') {
    for (const match of text.matchAll(/^\s*pub\s+(?:fn|struct|enum|trait|mod|const)\s+(\w+)/gm)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function familyOf(language: string): string {
  if (['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue', 'svelte'].includes(language)) {
    return 'js';
  }
  return language;
}

/**
 * A React component or hook, which the generic symbol kinds cannot express but
 * which is exactly what someone means by "where is the login form".
 */
function refineJsKind(name: string, kind: SymbolKind, text: string): SymbolKind {
  if (/^use[A-Z]/.test(name)) {
    return 'hook';
  }
  if (/^[A-Z]/.test(name) && /<\/?[A-Za-z]|React\.createElement|jsx\(/.test(text)) {
    return 'component';
  }
  return kind;
}

export interface ChunkInput {
  workspace: string;
  relPath: string;
  language: string;
  text: string;
  fileHash: string;
  /** From the editor's language server, when one answered. */
  symbols?: SymbolNode[];
  options?: ChunkOptions;
}

/**
 * Split one file into chunks. Pure: same input, same chunks, so the incremental
 * path can compare chunk hashes and re-embed only what actually moved.
 */
export function chunkFile(input: ChunkInput): Chunk[] {
  const opts = { ...DEFAULTS, ...(input.options || {}) };
  const lines = input.text.split('\n');
  const imports = extractImports(input.text, input.language);
  const exports = extractExports(input.text, input.language);

  let regions: Region[];
  if (input.symbols && input.symbols.length > 0) {
    regions = fromSymbols(input.symbols, lines, opts, input.language);
  } else if (familyOf(input.language) === 'markdown') {
    regions = fromMarkdown(lines);
  } else if (input.language === 'json') {
    regions = fromJson(lines);
  } else {
    regions = fromHeuristics(lines, input.language);
  }

  if (regions.length === 0) {
    regions = windowed(1, lines.length, lines, opts, 'file', 'file');
  }

  const now = Date.now();
  return regions
    .map(region => {
      const text = lines.slice(region.startLine - 1, region.endLine).join('\n');
      return { region, text };
    })
    // A region of pure whitespace embeds to noise and can only ever pollute results.
    .filter(({ text }) => text.trim().length > 0)
    .map(({ region, text }) => {
      const exported = exports.includes(region.symbol) ||
        /^\s*(?:export|pub|public)\b/m.test(text);
      const chunk: Chunk = {
        id: `${input.relPath}#${region.parent ? region.parent + '.' : ''}${region.symbol}@${region.startLine}`,
        workspace: input.workspace,
        relPath: input.relPath,
        language: input.language,
        fileHash: input.fileHash,
        chunkHash: sha1(text),
        startLine: region.startLine,
        endLine: region.endLine,
        updatedAt: now,
        symbol: region.symbol,
        symbolKind: region.kind,
        parentSymbol: region.parent,
        imports,
        exports,
        dependencies: imports,
        exported,
        tokenCount: estimateTokens(text),
        text,
      };
      return chunk;
    });
}

interface Region {
  symbol: string;
  kind: SymbolKind;
  parent?: string;
  startLine: number;
  endLine: number;
}

/**
 * Walk the symbol tree depth-first. A container (class, namespace) is not itself
 * a chunk when it has children — its members are, so a method is retrievable
 * without dragging in a 900-line class. A container with no children is a chunk.
 */
function fromSymbols(
  symbols: SymbolNode[],
  lines: string[],
  opts: Required<ChunkOptions>,
  language: string,
  parent?: string,
): Region[] {
  const out: Region[] = [];
  for (const symbol of symbols) {
    const startLine = Math.max(1, symbol.startLine);
    const endLine = Math.min(lines.length, Math.max(symbol.endLine, startLine));
    const text = lines.slice(startLine - 1, endLine).join('\n');
    const isContainer = ['class', 'interface', 'namespace'].includes(symbol.kind);

    if (isContainer && symbol.children.length > 0) {
      // The declaration line(s) before the first member: the class signature,
      // decorators and doc comment, which is where "what is this class" lives.
      const firstChild = Math.min(...symbol.children.map(c => c.startLine));
      if (firstChild - startLine > 1) {
        out.push({
          symbol: symbol.name,
          kind: symbol.kind,
          parent,
          startLine,
          endLine: firstChild - 1,
        });
      }
      out.push(...fromSymbols(symbol.children, lines, opts, language, symbol.name));
      continue;
    }

    const kind = familyOf(language) === 'js'
      ? refineJsKind(symbol.name, symbol.kind, text)
      : symbol.kind;

    if (text.length > opts.maxChars) {
      out.push(...windowed(startLine, endLine, lines, opts, symbol.name, kind, parent));
    } else {
      out.push({ symbol: symbol.name, kind, parent, startLine, endLine });
    }
  }
  return out;
}

/** Markdown: every heading owns the text until the next heading of its level or higher. */
function fromMarkdown(lines: string[]): Region[] {
  const out: Region[] = [];
  const open: Array<{ level: number; name: string; start: number }> = [];

  const close = (level: number, endLine: number) => {
    while (open.length > 0 && open[open.length - 1].level >= level) {
      const section = open.pop()!;
      if (endLine >= section.start) {
        out.push({
          symbol: section.name,
          kind: 'section',
          parent: open[open.length - 1]?.name,
          startLine: section.start,
          endLine,
        });
      }
    }
  };

  lines.forEach((line, i) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      close(heading[1].length, i);
      open.push({ level: heading[1].length, name: heading[2].trim() || 'section', start: i + 1 });
    }
  });
  close(0, lines.length);

  // Preamble before the first heading — often the whole point of a README.
  const firstHeading = lines.findIndex(l => /^#{1,6}\s+/.test(l));
  if (firstHeading > 0) {
    out.push({ symbol: 'preamble', kind: 'section', startLine: 1, endLine: firstHeading });
  } else if (firstHeading === -1 && lines.length > 0) {
    out.push({ symbol: 'document', kind: 'section', startLine: 1, endLine: lines.length });
  }
  return out.sort((a, b) => a.startLine - b.startLine);
}

/**
 * JSON: each top-level key is a configuration block. Brace counting rather than
 * JSON.parse, because the line numbers are the point and a parse throws away
 * exactly that — and because a .jsonc with comments still has to chunk.
 */
function fromJson(lines: string[]): Region[] {
  const out: Region[] = [];
  let depth = 0;
  let current: { name: string; start: number } | undefined;

  lines.forEach((line, i) => {
    const before = depth;
    if (before === 1 && !current) {
      const key = /^\s*"([^"]+)"\s*:/.exec(line);
      if (key) {
        current = { name: key[1], start: i + 1 };
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[') { depth++; }
      if (ch === '}' || ch === ']') { depth--; }
    }
    // Back to depth 1 (or 0 at the closing brace) ends the current top-level key.
    if (current && depth <= 1 && i + 1 >= current.start) {
      const singleLine = before === 1 && depth === 1;
      const closed = depth <= 1;
      if (singleLine || closed) {
        out.push({ symbol: current.name, kind: 'config', startLine: current.start, endLine: i + 1 });
        current = undefined;
      }
    }
  });

  if (current) {
    out.push({ symbol: current.name, kind: 'config', startLine: current.start, endLine: lines.length });
  }
  return out;
}

/**
 * No language server answered. Find declarations with a regex that covers the
 * shapes shared by every C-family and script language we index, and treat each
 * as running until the next one starts.
 */
const DECLARATION = new RegExp(
  [
    // export? async? function name(   |   const name = (…) =>
    /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|pub\s+)*(?:function|fn|func|def|sub)\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*(?::[^=]+)?=>)/,
    // class / interface / struct / enum / trait / namespace / type
    /^\s*(?:export\s+)?(?:public\s+|abstract\s+|final\s+|pub\s+)*(?:class|interface|struct|enum|trait|namespace|module|record|type)\s+(\w+)/,
  ].map(r => r.source).join('|'),
);

function fromHeuristics(lines: string[], language: string): Region[] {
  const starts: Array<{ line: number; name: string; kind: SymbolKind }> = [];

  lines.forEach((line, i) => {
    const match = DECLARATION.exec(line);
    if (!match) {
      return;
    }
    const name = match[1] || match[2] || match[3] || 'anonymous';
    let kind: SymbolKind = 'function';
    if (/\b(?:class|struct|record)\b/.test(line)) { kind = 'class'; }
    else if (/\binterface\b|\btrait\b/.test(line)) { kind = 'interface'; }
    else if (/\benum\b/.test(line)) { kind = 'enum'; }
    else if (/\bnamespace\b|\bmodule\b/.test(line)) { kind = 'namespace'; }
    else if (/^\s*(?:export\s+)?type\s/.test(line)) { kind = 'type'; }
    starts.push({ line: i + 1, name, kind: familyOf(language) === 'js' ? refineJsKind(name, kind, line) : kind });
  });

  if (starts.length === 0) {
    return [];
  }

  const out: Region[] = [];
  // Imports and constants above the first declaration are their own chunk: that
  // header is how a file's dependencies become searchable.
  if (starts[0].line > 1) {
    out.push({ symbol: 'module header', kind: 'file', startLine: 1, endLine: starts[0].line - 1 });
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].line - 1 : lines.length;
    out.push({ symbol: start.name, kind: start.kind, startLine: start.line, endLine: Math.max(end, start.line) });
  });
  return out;
}

/** Split an over-long region into overlapping windows so no line is lost. */
function windowed(
  startLine: number,
  endLine: number,
  lines: string[],
  opts: Required<ChunkOptions>,
  symbol: string,
  kind: SymbolKind,
  parent?: string,
): Region[] {
  const out: Region[] = [];
  // Convert the character budget into a line budget using this region's own
  // average line length, so dense minified-ish code windows tighter than prose.
  const slice = lines.slice(startLine - 1, endLine);
  const avg = Math.max(1, slice.join('\n').length / Math.max(1, slice.length));
  const linesPerWindow = Math.max(20, Math.floor(opts.maxChars / avg));

  for (let line = startLine; line <= endLine; line += linesPerWindow - opts.overlapLines) {
    const stop = Math.min(endLine, line + linesPerWindow - 1);
    out.push({ symbol, kind, parent, startLine: line, endLine: stop });
    if (stop >= endLine) {
      break;
    }
  }
  return out;
}
