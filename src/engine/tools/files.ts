import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ToolSpec, normalizePath, looksBinary, errText, approved, rejectionMessage } from './common';

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

// Overwrite truncation guard. Below this many lines a file is small enough that
// a rewrite is unremarkable; above it, collapsing to under this fraction of the
// original almost always means the model rewrote from a partial read.
const TRUNCATE_GUARD_MIN_LINES = 20;
const TRUNCATE_GUARD_RATIO = 0.3;

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

    const lines = content ? content.split('\n').length : 0;
    const bytes = Buffer.byteLength(content, 'utf8');
    return `${existed ? 'Overwrote' : 'Wrote'} ${lines} line(s) (${bytes} bytes) to ${target}.`;
  },
};

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

    if (args.append !== undefined && args.append !== null) {
      next = text + args.append;
      note = `Appended ${String(args.append).length} character(s) to ${target}.`;
    } else if (args.old_text !== undefined && args.old_text !== null) {
      const old = String(args.old_text);
      // Count occurrences without a regex, so no escaping of the model's text.
      let count = 0;
      let at = text.indexOf(old);
      while (at !== -1 && old.length > 0) {
        count++;
        at = text.indexOf(old, at + old.length);
      }
      if (count === 0) {
        return `Couldn't find that text in ${target}. Nothing changed.`;
      }
      if (count > 1) {
        return `That text appears ${count} times in ${target}; make it more specific so I change exactly the right one.`;
      }
      const idx = text.indexOf(old);
      next = text.slice(0, idx) + (args.new_text ?? '') + text.slice(idx + old.length);
      note = `Replaced 1 occurrence in ${target}.`;
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
