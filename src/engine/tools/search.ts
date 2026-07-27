import * as fs from 'fs';
import * as path from 'path';
import { ToolSpec, normalizePath, walk, looksBinary } from './common';

/**
 * Search tools: find files by name, and grep inside file contents.
 *
 * Both default to the workspace root rather than the whole machine — inside an
 * editor the useful scope is the open project. An absolute `path` still works if
 * you genuinely mean somewhere else.
 */

const WALK_BUDGET_MS = 8000;
const GREP_MAX_BYTES = 2_000_000;
const LINE_CAP = 200;

const findFiles: ToolSpec = {
  name: 'find_files',
  group: 'search',
  description:
    'Find files and folders by NAME (substring, case-insensitive) inside the ' +
    'project. Use this when you know part of a name but not where it lives. ' +
    'Searches names only — to search file CONTENTS use search_in_files, and to ' +
    'read one file use read_file.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Name or partial name, e.g. 'sidebar', 'package.json'." },
      kind: { type: 'string', enum: ['any', 'file', 'folder'], description: "Restrict results (default 'any')." },
      path: { type: 'string', description: 'Folder to search in (default: the project root).' },
      limit: { type: 'integer', description: 'Maximum matches to return (default 25).' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) {
      return 'Please tell me what to search for.';
    }
    const root = normalizePath(args.path || ctx.workspaceRoot, ctx);
    if (!root || !fs.existsSync(root)) {
      return root
        ? `That path doesn't exist: ${root}.`
        : 'No project folder is open, so there is nowhere to search. Give me an absolute path.';
    }

    const kind = ['any', 'file', 'folder'].includes(args.kind) ? args.kind : 'any';
    let limit = parseInt(args.limit, 10);
    limit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 25;

    const needle = query.toLowerCase();
    const deadline = Date.now() + WALK_BUDGET_MS;
    const hits: string[] = [];

    for (const entry of walk(root, deadline)) {
      if (hits.length >= limit) {
        break;
      }
      if (!entry.name.toLowerCase().includes(needle)) {
        continue;
      }
      if (kind === 'file' && entry.isDir) {
        continue;
      }
      if (kind === 'folder' && !entry.isDir) {
        continue;
      }
      hits.push(`- ${entry.fullPath}  [${entry.isDir ? 'folder' : 'file'}]`);
    }

    if (hits.length === 0) {
      return `No matches for '${query}' under ${root}. Try a shorter or different name.`;
    }
    const capped = hits.length >= limit ? ' (more may exist — narrow the query)' : '';
    return [`Found ${hits.length} match(es) for '${query}' under ${root}${capped}:`, ...hits].join('\n');
  },
};

const searchInFiles: ToolSpec = {
  name: 'search_in_files',
  group: 'search',
  description:
    'Search INSIDE files for text — like grep. Use this to find WHERE a symbol, ' +
    'function name, import, or phrase APPEARS in file CONTENTS. Give `query` (plain ' +
    'text, or a regex when regex=true) and optionally `path` (a file OR a folder; ' +
    'defaults to the project root). Returns matching lines as "file:line: text". ' +
    'To find files by NAME use find_files instead.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text (or a regex, if regex=true) to find in file contents.' },
      path: { type: 'string', description: 'File or folder to search in (default: the project root).' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression (default false).' },
      max_results: { type: 'integer', description: 'Maximum matching lines to return (default 50).' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) {
      return 'What text should I search for?';
    }
    const target = normalizePath(args.path || ctx.workspaceRoot, ctx);
    if (!target) {
      return 'No project folder is open, so there is nowhere to search. Give me an absolute path.';
    }
    if (!fs.existsSync(target)) {
      return `That path doesn't exist: ${target}. Try find_files to locate it first.`;
    }

    let limit = parseInt(args.max_results, 10);
    limit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50;

    let matches: (line: string) => boolean;
    if (args.regex) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, 'i');
      } catch (e: any) {
        return `That's not a valid regular expression: ${e.message}`;
      }
      matches = line => pattern.test(line);
    } else {
      const needle = query.toLowerCase();
      matches = line => line.toLowerCase().includes(needle);
    }

    const hits: string[] = [];
    const isFile = fs.statSync(target).isFile();

    const grep = (file: string, display: string) => {
      let raw: Buffer;
      try {
        if (fs.statSync(file).size > GREP_MAX_BYTES) {
          return;
        }
        raw = fs.readFileSync(file);
      } catch {
        return;
      }
      if (looksBinary(raw)) {
        return;
      }
      const lines = raw.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches(lines[i])) {
          hits.push(`${display}:${i + 1}: ${lines[i].trim().slice(0, LINE_CAP)}`);
          if (hits.length >= limit) {
            return;
          }
        }
      }
    };

    if (isFile) {
      grep(target, path.basename(target));
    } else {
      const deadline = Date.now() + WALK_BUDGET_MS;
      for (const entry of walk(target, deadline)) {
        if (hits.length >= limit || Date.now() > deadline) {
          break;
        }
        if (!entry.isDir) {
          grep(entry.fullPath, path.relative(target, entry.fullPath));
        }
      }
    }

    if (hits.length === 0) {
      return `No matches for '${query}' in ${target}.`;
    }
    const where = isFile ? 'file' : 'folder';
    return [`Found ${hits.length} match(es) for '${query}' in ${where} ${target}:`, ...hits].join('\n');
  },
};

export const SEARCH_TOOLS: ToolSpec[] = [findFiles, searchInFiles];
