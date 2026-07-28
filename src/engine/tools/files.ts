import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ToolSpec, ToolContext, normalizePath, looksBinary, errText, approved, rejectionMessage } from './common';

/**
 * File tools: read, write, edit, create, delete, list.
 *
 * Every message these return is written for the model to act on, so the wording
 * matters as much as the behaviour — a refusal has to say what to do instead.
 */

const DEFAULT_MAX_LINES = 200;
const MAX_CHARS = 20_000;      // hard cap on the text returned by one call
const MAX_READ_BYTES = 5_000_000;
const MAX_EDIT_BYTES = 5_000_000;
const MAX_NAMES = 60;          // names listed by list_folder
const RAG_EDIT_CONTEXT_LINES = 200;

// Overwrite truncation guard. Below this many lines a file is small enough that
// a rewrite is unremarkable; above it, collapsing to under this fraction of the
// original almost always means the model rewrote from a partial read.
const TRUNCATE_GUARD_MIN_LINES = 20;
const TRUNCATE_GUARD_RATIO = 0.3;

/** Remember exactly what the model saw, so an edit can require fresh context. */
function rememberReadRange(ctx: ToolContext, target: string, startLine: number, endLine: number): void {
  if (endLine < startLine) { return; }
  const ranges = ctx.readRanges || (ctx.readRanges = new Map());
  const fileRanges = ranges.get(target) || [];
  fileRanges.push({ startLine, endLine });
  ranges.set(target, fileRanges);
}

/** Whether one or more read windows cover every line of the required region. */
function hasReadCoverage(ctx: ToolContext, target: string, startLine: number, endLine: number): boolean {
  const ranges = (ctx.readRanges?.get(target) || [])
    .filter(range => range.endLine >= startLine && range.startLine <= endLine)
    .sort((a, b) => a.startLine - b.startLine);
  let coveredThrough = startLine - 1;
  for (const range of ranges) {
    if (range.startLine > coveredThrough + 1) { break; }
    coveredThrough = Math.max(coveredThrough, range.endLine);
    if (coveredThrough >= endLine) { return true; }
  }
  return false;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function lineChangeStats(before: string | null, after: string | null): { added: number; removed: number } {
  const tally = (value: string | null) => {
    const counts = new Map<string, number>();
    if (value) {
      for (const line of value.split(/\r?\n/)) {
        counts.set(line, (counts.get(line) || 0) + 1);
      }
    }
    return counts;
  };
  const oldLines = tally(before);
  const newLines = tally(after);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newLines) { added += Math.max(0, count - (oldLines.get(line) || 0)); }
  for (const [line, count] of oldLines) { removed += Math.max(0, count - (newLines.get(line) || 0)); }
  return { added, removed };
}

function lineChangeLabel(before: string | null, after: string | null): string {
  const { added, removed } = lineChangeStats(before, after);
  return `+${added} −${removed} line${added + removed === 1 ? '' : 's'} changed`;
}

function rememberPendingEdit(ctx: ToolContext, target: string, startLine: number, endLine: number): void {
  const pending = ctx.pendingEditVerifications || (ctx.pendingEditVerifications = new Map());
  pending.set(target, { startLine, endLine });
}

function confirmPendingEdit(ctx: ToolContext, target: string): { startLine: number; endLine: number } | undefined {
  const pending = ctx.pendingEditVerifications?.get(target);
  if (!pending || !hasReadCoverage(ctx, target, pending.startLine, pending.endLine)) {
    return undefined;
  }
  ctx.pendingEditVerifications!.delete(target);
  return pending;
}

function pendingEditRequirement(ctx: ToolContext, target?: string): string | undefined {
  if (target && !ctx.ragFiles?.has(target)) { return undefined; }
  const pending = ctx.pendingEditVerifications;
  if (!pending || pending.size === 0) { return undefined; }
  const entry = target ? pending.get(target) : undefined;
  if (target && !entry) { return undefined; }
  const [pendingTarget, range] = target ? [target, entry!] : [...pending.entries()][0];
  const lines = range.endLine - range.startLine + 1;
  return (
    `Before making another edit to ${pendingTarget}, verify the previous change in ${pendingTarget}. ` +
    `Call read_file(path=${JSON.stringify(pendingTarget)}, offset=${range.startLine}, max_lines=${lines}) ` +
    `to read changed lines ${range.startLine}-${range.endLine}, then either continue only if that read reveals ` +
    `a concrete issue or give the user a final summary. Nothing changed.`
  );
}

/**
 * Semantic snippets can be stale, abbreviated, or formatted differently from
 * disk. Before changing a file that came from RAG, force a live read around the
 * exact edit location. This runs only for RAG files; normal edits are unchanged.
 */
function ragReadRequirement(
  ctx: ToolContext,
  target: string,
  totalLines: number,
  editStartLine: number,
  editEndLine: number,
): string | undefined {
  if (!ctx.ragFiles?.has(target)) { return undefined; }
  const startLine = Math.max(1, editStartLine - RAG_EDIT_CONTEXT_LINES);
  const endLine = Math.min(totalLines, editEndLine + RAG_EDIT_CONTEXT_LINES);
  if (hasReadCoverage(ctx, target, startLine, endLine)) { return undefined; }

  const firstPageLines = Math.min(2000, endLine - startLine + 1);
  const more = firstPageLines < endLine - startLine + 1
    ? ` Then continue with offset=${startLine + firstPageLines} until line ${endLine}.`
    : '';
  return (
    `Before editing RAG-retrieved code, read the current on-disk context first. ` +
    `This change is at lines ${editStartLine}-${editEndLine}; read lines ${startLine}-${endLine} ` +
    `(${RAG_EDIT_CONTEXT_LINES} lines above and below, expanded for the change) with ` +
    `read_file(path=${JSON.stringify(target)}, offset=${startLine}, max_lines=${firstPageLines}).` +
    `${more} Nothing changed.`
  );
}

const readFile: ToolSpec = {
  name: 'read_file',
  group: 'files',
  description:
    'Read the TEXT CONTENTS of a file. Returns a WINDOW of the file, not always all ' +
    'of it: it starts at line `offset` and returns up to `max_lines` lines. The ' +
    'reply always states the range shown and the total line count, and when more ' +
    'remains it tells you the exact offset to request next — page through a long ' +
    'file that way until you have what you need. Always read a region before you ' +
    'edit it. To find WHERE something is in a large file, use search_in_files ' +
    'first: it reports line numbers, which you can pass here as offset.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file. Relative paths resolve against the project root.' },
      offset: { type: 'integer', description: 'First line to return, counting from 1 (default 1).' },
      max_lines: { type: 'integer', description: 'How many lines to return (default 200, max 2000).' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'Which file should I read?';
    }
    if (!fs.existsSync(target)) {
      return `That path doesn't exist: ${target}. Try find_files to locate it first.`;
    }
    if (fs.statSync(target).isDirectory()) {
      return `That's a folder, not a file: ${target}. Use list_folder to see what's inside.`;
    }

    let maxLines = parseInt(args.max_lines, 10);
    maxLines = Number.isFinite(maxLines) ? Math.max(1, Math.min(maxLines, 2000)) : DEFAULT_MAX_LINES;
    let offset = parseInt(args.offset, 10);
    offset = Number.isFinite(offset) ? Math.max(1, offset) : 1;

    let size: number;
    let raw: Buffer;
    try {
      size = fs.statSync(target).size;
      const fd = fs.openSync(target, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        raw = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return `Couldn't read ${target}: ${errText(e)}`;
    }

    if (raw.length === 0) {
      return `${target} is empty.`;
    }
    if (looksBinary(raw)) {
      return `${target} looks like a binary file, so I can't read it as text.`;
    }

    const allLines = raw.toString('utf8').split(/\r?\n/);
    const total = allLines.length;
    const bytesTruncated = size > raw.length;

    if (offset > total) {
      return `${target} has only ${total} lines, so offset ${offset} is past the end.`;
    }

    // Fill the window line by line and stop on whichever limit hits first, so the
    // "next offset" we report is always a real line boundary. Slicing the joined
    // string would cut mid-line and make the next offset a guess.
    const kept: string[] = [];
    let chars = 0;
    for (const line of allLines.slice(offset - 1, offset - 1 + maxLines)) {
      if (kept.length > 0 && chars + line.length + 1 > MAX_CHARS) {
        break;
      }
      kept.push(line);
      chars += line.length + 1;
    }

    const lastLine = offset - 1 + kept.length;
    const header =
      offset === 1 && lastLine === total
        ? `${target} (${total} line${total !== 1 ? 's' : ''}):`
        : `${target} (lines ${offset}-${lastLine} of ${total}):`;

    let footer = '';
    if (lastLine < total) {
      footer =
        `\n…(${total - lastLine} more line(s). Call read_file with offset=${lastLine + 1} to continue.)`;
    } else if (bytesTruncated) {
      footer = '\n…(the file is too large to read fully; this is as far as it goes.)';
    }

    rememberReadRange(ctx, target, offset, lastLine);
    const verified = confirmPendingEdit(ctx, target);
    if (verified) {
      footer += `\n(Verified the previous edit at lines ${verified.startLine}-${verified.endLine}.)`;
    }
    return `${header}\n${kept.join('\n')}${footer}`;
  },
};

const writeFile: ToolSpec = {
  name: 'write_file',
  group: 'files',
  description:
    'Write text CONTENT to a file, creating it and any missing parent folders. ' +
    'Use this to create or save a file with content. If the file already exists it ' +
    'is NOT overwritten unless you pass overwrite=true, and an overwrite that would ' +
    'delete most of an existing file is refused unless you also pass ' +
    'allow_truncate=true. To change PART of an existing file use edit_file instead — ' +
    'that is almost always what you want. To create an empty file or folder use ' +
    'create_item.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file to write.' },
      content: { type: 'string', description: 'The text to write into the file.' },
      overwrite: { type: 'boolean', description: 'Replace the file if it already exists (default false).' },
      allow_truncate: {
        type: 'boolean',
        description:
          'Confirm that shrinking an existing file dramatically is intended. Only set ' +
          'this after reading the ENTIRE file, never off the back of a partial read.',
      },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'Where should I write the file?';
    }
    const existed = fs.existsSync(target);
    if (existed && fs.statSync(target).isDirectory()) {
      return `That's a folder, not a file: ${target}.`;
    }
    if (existed && !args.overwrite) {
      return `That file already exists: ${target}. Pass overwrite to replace it, or choose a different name.`;
    }

    const content = args.content ?? '';
    let before: string | null = null;
    if (existed) {
      try {
        const raw = fs.readFileSync(target);
        before = looksBinary(raw) ? null : raw.toString('utf8');
      } catch {
        before = null;
      }
    }

    // read_file returns a WINDOW, so a model that read the first 200 lines of a
    // long file and then "rewrites" it will silently delete the rest. write_file
    // overwrites in place with no Recycle Bin, so that loss is unrecoverable.
    // Refuse before asking the user — an obviously-wrong change should come back
    // to the model as a correction, not to the user as something to reject.
    if (existed && before !== null && !args.allow_truncate) {
      const beforeLines = before.split(/\r?\n/).length;
      const afterLines = content ? content.split(/\r?\n/).length : 0;
      if (beforeLines > TRUNCATE_GUARD_MIN_LINES && afterLines < beforeLines * TRUNCATE_GUARD_RATIO) {
        return (
          `Refusing to overwrite ${target}: it has ${beforeLines} lines but the new ` +
          `content has only ${afterLines}, which would delete ${beforeLines - afterLines} ` +
          `lines. read_file shows only a WINDOW of a file, so you may have seen just ` +
          `part of this one. To change a section, use edit_file. To genuinely replace ` +
          `the whole file, first read all of it (page with offset until there is no ` +
          `more), then call write_file again with allow_truncate=true.`
        );
      }
    }

    const writeVerdict = await approved(ctx, { kind: 'write', path: target, before, after: content });
    if (!writeVerdict.approved) {
      return rejectionMessage(target, writeVerdict);
    }

    try {
      const parent = path.dirname(target);
      if (parent) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(target, content, 'utf8');
    } catch (e) {
      return `Couldn't write ${target}: ${errText(e)}`;
    }

    const lines = content ? content.split(/\r?\n/).length : 0;
    const bytes = Buffer.byteLength(content, 'utf8');
    const changeLabel = lineChangeLabel(before, content);
    rememberPendingEdit(ctx, target, 1, lines);
    return `${existed ? 'Overwrote' : 'Wrote'} ${lines} line(s) (${bytes} bytes) to ${target} (${changeLabel}).`;
  },
};

function normalizeForEdit(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[\u2014\u2013]|&mdash;|&ndash;/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function findNormalizedMatch(text: string, old: string): { idx: number; matchText: string } | null {
  const normText = normalizeForEdit(text);
  const normOld = normalizeForEdit(old);
  if (!normOld || !normText.includes(normOld)) { return null; }

  let count = 0;
  let at = normText.indexOf(normOld);
  while (at !== -1) {
    count++;
    at = normText.indexOf(normOld, at + normOld.length);
  }
  if (count !== 1) { return null; }

  const rawLines = text.split(/\r?\n/);
  const oldLines = old.split(/\r?\n/);
  const normOldLines = oldLines.map(normalizeForEdit);

  let matchStartLine = -1;
  let matchesCount = 0;

  for (let i = 0; i <= rawLines.length - normOldLines.length; i++) {
    let matchesAll = true;
    for (let j = 0; j < normOldLines.length; j++) {
      if (!normalizeForEdit(rawLines[i + j]).includes(normOldLines[j])) {
        matchesAll = false;
        break;
      }
    }
    if (matchesAll) {
      matchesCount++;
      matchStartLine = i;
    }
  }

  if (matchesCount === 1 && matchStartLine !== -1) {
    if (normOldLines.length === 1) {
      const rawLine = rawLines[matchStartLine];
      const lineNorm = normalizeForEdit(rawLine);
      const startInNorm = lineNorm.indexOf(normOldLines[0]);
      if (startInNorm !== -1) {
        let rawCharIdx = 0;
        let normCharIdx = 0;
        let rawStart = 0;

        while (rawCharIdx < rawLine.length && normCharIdx <= startInNorm) {
          if (normCharIdx === startInNorm) { rawStart = rawCharIdx; }
          const rest = rawLine.slice(rawCharIdx);
          if (rest.startsWith('&mdash;') || rest.startsWith('&ndash;')) {
            rawCharIdx += 7;
            normCharIdx += 1;
          } else {
            rawCharIdx += 1;
            normCharIdx += 1;
          }
        }
        const targetNormEnd = startInNorm + normOldLines[0].length;
        rawCharIdx = rawStart;
        normCharIdx = startInNorm;
        while (rawCharIdx < rawLine.length && normCharIdx < targetNormEnd) {
          const rest = rawLine.slice(rawCharIdx);
          if (rest.startsWith('&mdash;') || rest.startsWith('&ndash;')) {
            rawCharIdx += 7;
            normCharIdx += 1;
          } else {
            rawCharIdx += 1;
            normCharIdx += 1;
          }
        }
        const rawEnd = rawCharIdx;
        const matchText = rawLine.slice(rawStart, rawEnd);
        let charOffset = 0;
        for (let l = 0; l < matchStartLine; l++) {
          charOffset += rawLines[l].length + (text.includes('\r\n') ? 2 : 1);
        }
        charOffset += rawStart;
        return { idx: charOffset, matchText };
      }
    }
  }

  return null;
}

const editFile: ToolSpec = {
  name: 'edit_file',
  group: 'files',
  description:
    'Edit an existing text file. Either REPLACE an exact snippet (pass old_text and ' +
    'new_text — old_text must appear exactly once; an empty new_text deletes it) or ' +
    'APPEND text to the end (pass append). Read the file first so old_text matches ' +
    'exactly. To create a new file use write_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file to edit.' },
      old_text: { type: 'string', description: 'Exact text to find and replace (replace mode).' },
      new_text: { type: 'string', description: 'Replacement text (default empty = delete the old_text).' },
      append: { type: 'string', description: 'Text to add to the end of the file (append mode).' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'Which file should I edit?';
    }
    if (!fs.existsSync(target)) {
      return `That path doesn't exist: ${target}. Use write_file to create it first.`;
    }
    if (fs.statSync(target).isDirectory()) {
      return `That's a folder, not a file: ${target}.`;
    }

    const pendingReq = pendingEditRequirement(ctx, target);
    if (pendingReq) { return pendingReq; }

    let raw: Buffer;
    try {
      if (fs.statSync(target).size > MAX_EDIT_BYTES) {
        return `That file is too large to edit in place: ${target}.`;
      }
      raw = fs.readFileSync(target);
    } catch (e) {
      return `Couldn't read ${target}: ${errText(e)}`;
    }
    if (looksBinary(raw)) {
      return `${target} looks like a binary file, so I can't edit it as text.`;
    }

    const text = raw.toString('utf8');
    let next: string;
    let note: string;

    const totalLines = text.split(/\r?\n/).length;



    if (args.append !== undefined && args.append !== null) {
      const requirement = ragReadRequirement(ctx, target, totalLines, totalLines, totalLines);
      if (requirement) { return requirement; }
      next = text + args.append;
      const appendLines = String(args.append).split(/\r?\n/).length;
      const changeLabel = lineChangeLabel(text, next);
      rememberPendingEdit(ctx, target, totalLines, Math.max(totalLines, totalLines + appendLines - 1));
      note = `Appended ${String(args.append).length} character(s) to ${target} (${changeLabel}).`;
    } else if (args.old_text !== undefined && args.old_text !== null) {
      const old = String(args.old_text);
      // Count occurrences without a regex, so no escaping of the model's text.
      let count = 0;
      let at = text.indexOf(old);
      while (at !== -1 && old.length > 0) {
        count++;
        at = text.indexOf(old, at + old.length);
      }
      let idx = text.indexOf(old);
      let targetOldText = old;

      if (count === 0) {
        const normMatch = findNormalizedMatch(text, old);
        if (normMatch) {
          count = 1;
          idx = normMatch.idx;
          targetOldText = normMatch.matchText;
        } else {
          return (
            `Couldn't find that text in ${target}. Check if dashes (— vs -), quotes (' vs "), ` +
            `HTML entities (&mdash;), or newlines differ. Call read_file around that line first, ` +
            `and copy a smaller 1-line anchor string directly from the file content. Nothing changed.`
          );
        }
      }
      if (count > 1) {
        return `That text appears ${count} times in ${target}; make it more specific so I change exactly the right one.`;
      }
      const editStartLine = lineAt(text, idx);
      const editEndLine = lineAt(text, idx + Math.max(0, targetOldText.length - 1));
      const requirement = ragReadRequirement(ctx, target, totalLines, editStartLine, editEndLine);
      if (requirement) { return requirement; }
      next = text.slice(0, idx) + (args.new_text ?? '') + text.slice(idx + targetOldText.length);
      if (next === text) {
        return `Target text produces no change in ${target}. Nothing changed.`;
      }
      const changeLabel = lineChangeLabel(text, next);
      rememberPendingEdit(ctx, target, editStartLine, editEndLine);
      note = `Replaced 1 occurrence in ${target} (${changeLabel}).`;
    } else {
      return 'Tell me what to change: give old_text (and new_text) to replace, or append to add text to the end.';
    }

    const editVerdict = await approved(ctx, { kind: 'edit', path: target, before: text, after: next });
    if (!editVerdict.approved) {
      return rejectionMessage(target, editVerdict);
    }

    try {
      fs.writeFileSync(target, next, 'utf8');
    } catch (e) {
      return `Couldn't write ${target}: ${errText(e)}`;
    }
    return note;
  },
};

const createItem: ToolSpec = {
  name: 'create_item',
  group: 'files',
  description:
    "Create a new EMPTY file or a new folder, making any missing parent folders. " +
    "Set type to 'file' or 'folder'. It will not overwrite something that already " +
    'exists. To write a file WITH content, use write_file instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to create.' },
      type: { type: 'string', enum: ['file', 'folder'], description: "What to create (default 'file')." },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'What should I create, and where?';
    }
    const kind = args.type === 'folder' ? 'folder' : 'file';
    if (fs.existsSync(target)) {
      const what = fs.statSync(target).isDirectory() ? 'folder' : 'file';
      return `That already exists (a ${what}): ${target}. Nothing created.`;
    }
    try {
      if (kind === 'folder') {
        fs.mkdirSync(target, { recursive: true });
      } else {
        const parent = path.dirname(target);
        if (parent) {
          fs.mkdirSync(parent, { recursive: true });
        }
        fs.writeFileSync(target, '', { flag: 'wx' });
      }
    } catch (e) {
      return `Couldn't create ${target}: ${errText(e)}`;
    }
    return `Created the ${kind}: ${target}.`;
  },
};

const deleteItem: ToolSpec = {
  name: 'delete_item',
  group: 'files',
  description:
    'Delete a file or folder by moving it to the Recycle Bin / Trash (recoverable). ' +
    'A non-empty folder is only deleted when recursive=true, so be sure the user ' +
    'really wants to remove the folder AND its contents before setting it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file or folder to delete.' },
      recursive: { type: 'boolean', description: 'Required (true) to delete a non-empty folder and its contents.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'What should I delete?';
    }
    if (!fs.existsSync(target)) {
      return `That path doesn't exist: ${target}. Nothing to delete.`;
    }

    const isDir = fs.statSync(target).isDirectory();
    if (isDir && !args.recursive) {
      let nonEmpty = true;
      try {
        nonEmpty = fs.readdirSync(target).length > 0;
      } catch {
        nonEmpty = true;
      }
      if (nonEmpty) {
        return `That folder isn't empty: ${target}. Pass recursive to remove it and everything inside.`;
      }
    }

    const deleteVerdict = await approved(ctx, { kind: 'delete', path: target, before: null, after: null });
    if (!deleteVerdict.approved) {
      return rejectionMessage(target, deleteVerdict);
    }

    try {
      // useTrash is VS Code's own recycle-bin delete — the send2trash equivalent,
      // so a mistaken delete stays recoverable.
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
    } catch (e) {
      return `Couldn't delete ${target}: ${errText(e)}`;
    }
    return `Moved the ${isDir ? 'folder' : 'file'} to the Recycle Bin: ${target}.`;
  },
};

const listFolder: ToolSpec = {
  name: 'list_folder',
  group: 'files',
  description:
    'List what is directly inside a folder — its files and subfolders, with counts. ' +
    "Use this to see a folder's contents. It does not recurse; to search deeper use " +
    'find_files or search_in_files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the folder to list.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const target = normalizePath(args.path, ctx);
    if (!target) {
      return 'Which folder should I look inside?';
    }
    if (!fs.existsSync(target)) {
      return `That path doesn't exist: ${target}. Try find_files to locate it first.`;
    }
    if (!fs.statSync(target).isDirectory()) {
      return `That's a file, not a folder: ${target}.`;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
      return `Couldn't read ${target}: ${errText(e)}`;
    }

    const folders = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const files = entries.filter(e => e.isFile()).map(e => e.name).sort();

    const lines = [`${target} contains ${folders.length} folder(s) and ${files.length} file(s).`];
    const summarize = (label: string, names: string[]) => {
      if (names.length === 0) {
        return;
      }
      const more = names.length > MAX_NAMES ? ` …(+${names.length - MAX_NAMES} more)` : '';
      lines.push(`${label}: ${names.slice(0, MAX_NAMES).join(', ')}${more}`);
    };
    summarize('Folders', folders);
    summarize('Files', files);
    return lines.join('\n');
  },
};

export const FILE_TOOLS: ToolSpec[] = [readFile, writeFile, editFile, createItem, deleteItem, listFolder];
