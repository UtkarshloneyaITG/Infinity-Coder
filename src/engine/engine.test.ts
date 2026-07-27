/**
 * Self-check for the engine — tools, path handling, web parsing, history trim.
 * No framework. Run with:  npm run compile && node out/engine/engine.test.js
 *
 * The tool modules import 'vscode', which only exists inside the extension host,
 * so a minimal stub is installed in the module loader before they are required.
 * That is also why this file uses require() rather than import for them: TypeScript
 * hoists imports above every statement, and the stub has to be in place first.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const trashed: string[] = [];

const Module = require('module');
const realLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') {
    return {
      Uri: { file: (p: string) => ({ fsPath: p }) },
      workspace: {
        fs: {
          async delete(uri: any, opts: any) {
            trashed.push(uri.fsPath);
            fs.rmSync(uri.fsPath, { recursive: !!opts?.recursive, force: true });
          },
        },
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { dispatch, toolSchemas, ALL_TOOLS } = require('./tools');
const { normalizePath, walk } = require('./tools/common');
const { _internal } = require('./tools/web');
const { trimHistory, estimateTokens, _internals: agentInternals } = require('./agent');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infinity-coder-test-'));
const ctx = { workspaceRoot: tmp, logDir: path.join(tmp, '.logs'), isTrusted: true };

async function main() {
  // ── path handling ────────────────────────────────────────────────
  assert.strictEqual(
    normalizePath('src/app.ts', ctx),
    path.join(tmp, 'src', 'app.ts'),
    'a relative path resolves against the project root'
  );
  assert.strictEqual(
    normalizePath('  "  quoted.txt  "  ', ctx),
    path.join(tmp, 'quoted.txt'),
    'surrounding quotes and whitespace are stripped'
  );
  assert.ok(normalizePath('~/x', ctx).startsWith(os.homedir()), '~ expands to the home dir');
  assert.strictEqual(normalizePath('', ctx), '', 'empty stays empty');

  // ── write / read ─────────────────────────────────────────────────
  let out = await dispatch('write_file', { path: 'a.txt', content: 'hello\nworld' }, ctx);
  assert.ok(out.startsWith('Wrote'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'hello\nworld');

  out = await dispatch('write_file', { path: 'a.txt', content: 'nope' }, ctx);
  assert.ok(out.includes('already exists'), 'write refuses to clobber without overwrite');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'hello\nworld', 'file untouched');

  out = await dispatch('write_file', { path: 'a.txt', content: 'replaced', overwrite: true }, ctx);
  assert.ok(out.startsWith('Overwrote'), out);

  out = await dispatch('read_file', { path: 'a.txt' }, ctx);
  assert.ok(out.includes('replaced'), 'read returns the content');

  out = await dispatch('read_file', { path: 'missing.txt' }, ctx);
  assert.ok(out.includes("doesn't exist"), 'missing file is reported, not thrown');

  // Binary files must be refused rather than dumped as garbage.
  fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  out = await dispatch('read_file', { path: 'bin.dat' }, ctx);
  assert.ok(out.includes('binary'), 'binary file is refused');

  // ── paging through a long file ───────────────────────────────────
  // A 3000-line file must be fully reachable: the window has to advance, and the
  // reply has to say exactly where to continue, or the model cannot edit
  // anything past the first screen.
  const bigLines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`);
  fs.writeFileSync(path.join(tmp, 'big.txt'), bigLines.join('\n'));

  out = await dispatch('read_file', { path: 'big.txt' }, ctx);
  assert.ok(out.includes('lines 1-200 of 3000'), `header should state the range and total: ${out.slice(0, 80)}`);
  assert.ok(out.includes('offset=201'), 'the reply must say how to continue');
  assert.ok(out.includes('line200') && !out.includes('line201'), 'the window stops where it says');

  out = await dispatch('read_file', { path: 'big.txt', offset: 201, max_lines: 100 }, ctx);
  assert.ok(out.includes('lines 201-300 of 3000'), out.slice(0, 80));
  assert.ok(out.includes('line201') && out.includes('line300'), 'the window starts at the offset');
  assert.ok(!out.includes('line200\n') && !out.includes('line301'), 'and contains nothing outside it');
  assert.ok(out.includes('offset=301'), 'paging continues');

  // The very end reports no continuation.
  out = await dispatch('read_file', { path: 'big.txt', offset: 2951 }, ctx);
  assert.ok(out.includes('lines 2951-3000 of 3000'), out.slice(0, 80));
  assert.ok(!out.includes('offset='), 'no "continue" hint once the end is reached');
  assert.ok(out.includes('line3000'), 'the last line is reachable');

  // Walking the whole file must terminate and cover every line exactly once.
  let cursor = 1;
  let seen = 0;
  let hops = 0;
  while (cursor <= 3000 && hops < 50) {
    hops++;
    const page = await dispatch('read_file', { path: 'big.txt', offset: cursor, max_lines: 500 }, ctx);
    const range = page.match(/lines (\d+)-(\d+) of 3000/);
    assert.ok(range, `page ${hops} should report a range: ${page.slice(0, 80)}`);
    assert.strictEqual(Number(range![1]), cursor, 'each page starts where the last one ended');
    seen += Number(range![2]) - Number(range![1]) + 1;
    cursor = Number(range![2]) + 1;
  }
  assert.strictEqual(seen, 3000, 'paging covers every line exactly once');
  assert.ok(hops < 50, `paging terminated in ${hops} hops`);

  // An offset past the end is reported, not silently empty.
  out = await dispatch('read_file', { path: 'big.txt', offset: 9999 }, ctx);
  assert.ok(out.includes('only 3000 lines'), out);

  // A short file still reads whole, with no paging noise.
  fs.writeFileSync(path.join(tmp, 'long.txt'), Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'));
  out = await dispatch('read_file', { path: 'long.txt' }, ctx);
  assert.ok(out.includes('(50 lines)'), 'a whole file reports a plain count');
  assert.ok(!out.includes('offset='), 'and no continuation hint');

  out = await dispatch('read_file', { path: 'long.txt', max_lines: 5 }, ctx);
  assert.ok(out.includes('lines 1-5 of 50'), 'max_lines still applies');
  assert.ok(!out.includes('line6'), 'lines past the cap are not returned');

  // The character cap must also land on a line boundary, so the next offset is
  // real rather than mid-line.
  fs.writeFileSync(path.join(tmp, 'wide.txt'), Array.from({ length: 40 }, () => 'x'.repeat(2000)).join('\n'));
  out = await dispatch('read_file', { path: 'wide.txt', max_lines: 40 }, ctx);
  const wideRange = out.match(/lines 1-(\d+) of 40/);
  assert.ok(wideRange, `the char cap should still report a line range: ${out.slice(0, 80)}`);
  const shown = Number(wideRange![1]);
  assert.ok(shown < 40, 'the character cap cut the window short');
  assert.ok(out.includes(`offset=${shown + 1}`), 'and the next offset continues from a real line');

  // ── overwrite truncation guard ───────────────────────────────────
  // The realistic failure: the model reads the first window of a long file and
  // then "rewrites" it, silently deleting the rest. write_file has no Recycle
  // Bin, so that loss is permanent.
  fs.writeFileSync(path.join(tmp, 'victim.txt'), Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join('\n'));

  out = await dispatch('write_file', { path: 'victim.txt', content: 'line1\nline2', overwrite: true }, ctx);
  assert.ok(out.startsWith('Refusing to overwrite'), out);
  assert.ok(out.includes('3000 lines') && out.includes('only 2'), 'the message states the real numbers');
  assert.ok(out.includes('edit_file'), 'and points at the tool it should have used');
  assert.strictEqual(
    fs.readFileSync(path.join(tmp, 'victim.txt'), 'utf8').split('\n').length,
    3000,
    'the file is untouched'
  );

  // Explicit acknowledgement gets through — a real rewrite must stay possible.
  out = await dispatch('write_file',
    { path: 'victim.txt', content: 'line1\nline2', overwrite: true, allow_truncate: true }, ctx);
  assert.ok(out.startsWith('Overwrote'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'victim.txt'), 'utf8'), 'line1\nline2');

  // The guard must not fire on ordinary work.
  fs.writeFileSync(path.join(tmp, 'normal.txt'), Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'));
  out = await dispatch('write_file',
    { path: 'normal.txt', content: Array.from({ length: 95 }, (_, i) => `l${i}`).join('\n'), overwrite: true }, ctx);
  assert.ok(out.startsWith('Overwrote'), 'a small shrink is normal editing, not truncation');

  out = await dispatch('write_file',
    { path: 'normal.txt', content: Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n'), overwrite: true }, ctx);
  assert.ok(out.startsWith('Overwrote'), 'growing a file is never truncation');

  // A short file can be rewritten freely — "truncation" is meaningless there.
  fs.writeFileSync(path.join(tmp, 'tiny.txt'), 'a\nb\nc\nd\ne');
  out = await dispatch('write_file', { path: 'tiny.txt', content: 'z', overwrite: true }, ctx);
  assert.ok(out.startsWith('Overwrote'), 'a tiny file is not guarded');

  // A brand-new file has nothing to lose.
  out = await dispatch('write_file', { path: 'fresh.txt', content: 'x' }, ctx);
  assert.ok(out.startsWith('Wrote'), 'a new file is never guarded');

  // The guard runs BEFORE approval, so an obviously-wrong change comes back to
  // the model as a correction instead of bothering the user with a rejection.
  const guardAsked: any[] = [];
  const guardCtx = { ...ctx, approve: async (r: any) => { guardAsked.push(r); return { approved: true }; } };
  fs.writeFileSync(path.join(tmp, 'victim2.txt'), Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'));
  out = await dispatch('write_file', { path: 'victim2.txt', content: 'l0', overwrite: true }, guardCtx);
  assert.ok(out.startsWith('Refusing to overwrite'), out);
  assert.strictEqual(guardAsked.length, 0, 'the user is never asked to approve a truncation');

  // ── edit ─────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(tmp, 'edit.txt'), 'alpha\nbeta\nalpha\n');

  out = await dispatch('edit_file', { path: 'edit.txt', old_text: 'alpha' }, ctx);
  assert.ok(out.includes('appears 2 times'), 'an ambiguous edit is refused, not guessed');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'edit.txt'), 'utf8'), 'alpha\nbeta\nalpha\n', 'unchanged');

  out = await dispatch('edit_file', { path: 'edit.txt', old_text: 'beta', new_text: 'BETA' }, ctx);
  assert.ok(out.includes('Replaced 1'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'edit.txt'), 'utf8'), 'alpha\nBETA\nalpha\n');

  out = await dispatch('edit_file', { path: 'edit.txt', old_text: 'nowhere' }, ctx);
  assert.ok(out.includes("Couldn't find"), 'a missing snippet is reported');

  out = await dispatch('edit_file', { path: 'edit.txt', append: 'gamma\n' }, ctx);
  assert.ok(out.includes('Appended'), out);
  assert.ok(fs.readFileSync(path.join(tmp, 'edit.txt'), 'utf8').endsWith('gamma\n'));

  // Replacement text containing regex metacharacters must survive verbatim —
  // the replace is index-based precisely so $& and friends are not expanded.
  fs.writeFileSync(path.join(tmp, 'meta.txt'), 'keep TARGET keep');
  await dispatch('edit_file', { path: 'meta.txt', old_text: 'TARGET', new_text: '$& $1 \\n' }, ctx);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'meta.txt'), 'utf8'), 'keep $& $1 \\n keep');

  out = await dispatch('edit_file', { path: 'edit.txt' }, ctx);
  assert.ok(out.includes('Tell me what to change'), 'an edit with no mode asks rather than no-ops silently');

  // ── create / list ────────────────────────────────────────────────
  out = await dispatch('create_item', { path: 'sub', type: 'folder' }, ctx);
  assert.ok(out.includes('Created the folder'), out);
  out = await dispatch('create_item', { path: 'sub', type: 'folder' }, ctx);
  assert.ok(out.includes('already exists'), 'create never overwrites');

  fs.writeFileSync(path.join(tmp, 'sub', 'nested.ts'), 'export const x = 1;\n');
  out = await dispatch('list_folder', { path: 'sub' }, ctx);
  assert.ok(out.includes('nested.ts') && out.includes('1 file(s)'), out);

  // ── delete goes to the trash, and guards non-empty folders ───────
  out = await dispatch('delete_item', { path: 'sub' }, ctx);
  assert.ok(out.includes("isn't empty"), 'a non-empty folder needs recursive');
  assert.ok(fs.existsSync(path.join(tmp, 'sub')), 'still there');

  out = await dispatch('delete_item', { path: 'a.txt' }, ctx);
  assert.ok(out.includes('Recycle Bin'), out);
  assert.deepStrictEqual(trashed, [path.join(tmp, 'a.txt')], 'delete routes through the trash API');

  // ── search ───────────────────────────────────────────────────────
  fs.mkdirSync(path.join(tmp, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'junk', 'nested.ts'), 'export const x = 1;\n');

  out = await dispatch('find_files', { query: 'nested' }, ctx);
  assert.ok(out.includes(path.join('sub', 'nested.ts')), 'finds the project file');
  assert.ok(!out.includes('node_modules'), 'node_modules is pruned from the walk');

  out = await dispatch('find_files', { query: 'sub', kind: 'folder' }, ctx);
  assert.ok(out.includes('[folder]') && !out.includes('nested.ts'), 'kind filter applies');

  out = await dispatch('search_in_files', { query: 'export const' }, ctx);
  assert.ok(out.includes('nested.ts:1:'), 'grep reports file:line');
  assert.ok(!out.includes('node_modules'), 'grep prunes node_modules too');

  out = await dispatch('search_in_files', { query: 'EXPORT', path: 'sub/nested.ts' }, ctx);
  assert.ok(out.includes('nested.ts:1:'), 'plain-text search is case-insensitive');

  out = await dispatch('search_in_files', { query: 'expo(rt', regex: true }, ctx);
  assert.ok(out.includes('not a valid regular expression'), 'a bad regex is reported, not thrown');

  // A walk must not follow pruned or hidden directories.
  fs.mkdirSync(path.join(tmp, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.hidden', 'secret.ts'), 'x');
  const walked = [...walk(tmp, Date.now() + 5000)].map((e: any) => e.name);
  assert.ok(!walked.includes('secret.ts'), 'hidden directories are not descended into');

  // ── dispatch behaviour ───────────────────────────────────────────
  out = await dispatch('cat', { path: 'edit.txt' }, ctx);
  assert.ok(out.includes('BETA'), "'cat' aliases to read_file");
  out = await dispatch('grep', { path: 'edit.txt', query: 'BETA' }, ctx);
  assert.ok(out.includes('BETA'), "'grep' with a path aliases to search_in_files");
  out = await dispatch('totally_made_up', {}, ctx);
  assert.ok(out.startsWith('Unknown tool'), 'an unknown tool returns a message, never throws');

  // ── tool schemas / groups ────────────────────────────────────────
  const all = toolSchemas();
  assert.strictEqual(all.length, ALL_TOOLS.length);
  assert.ok(all.every((t: any) => t.type === 'function' && t.function.name && t.function.parameters));
  const filesOnly = toolSchemas({ files: true, search: false, shell: false, web: false });
  assert.strictEqual(filesOnly.length, 6, 'only the file group is offered');
  assert.ok(!filesOnly.some((t: any) => t.function.name === 'run_command'), 'shell is withheld');

  // ── workspace trust gates the shell group ────────────────────────
  const untrustedSchemas = toolSchemas(undefined, false);
  assert.ok(
    !untrustedSchemas.some((t: any) => ['run_command', 'list_processes', 'stop_process'].includes(t.function.name)),
    'an untrusted workspace is never offered shell tools'
  );
  assert.ok(
    untrustedSchemas.some((t: any) => t.function.name === 'read_file'),
    'the other groups still work in an untrusted workspace'
  );

  // ── plan mode is read-only ───────────────────────────────────────
  // The whole promise of the feature: while planning, nothing can be changed.
  const planSchemas = toolSchemas(undefined, true, true);
  const planNames = planSchemas.map((t: any) => t.function.name);
  for (const mutating of ['write_file', 'edit_file', 'create_item', 'delete_item', 'run_command', 'stop_process']) {
    assert.ok(!planNames.includes(mutating), `plan mode must not offer ${mutating}`);
  }
  for (const readonly of ['read_file', 'list_folder', 'find_files', 'search_in_files', 'web_search']) {
    assert.ok(planNames.includes(readonly), `plan mode still needs ${readonly} to investigate`);
  }
  // A tool added later is withheld until it is explicitly declared read-only,
  // so the allowlist failing open is itself a test failure.
  assert.ok(planNames.length < ALL_TOOLS.length, 'plan mode withholds something');

  const planCtx = { ...ctx, planMode: true };
  const planTarget = path.join(tmp, 'plan-guard.txt');
  out = await dispatch('write_file', { path: planTarget, content: 'nope' }, planCtx);
  assert.ok(out.includes('Plan mode'), 'dispatch refuses a write the model asked for anyway');
  assert.ok(!fs.existsSync(planTarget), 'plan mode must not have created the file');
  out = await dispatch('run_command', { command: 'echo pwned' }, planCtx);
  assert.ok(out.includes('Plan mode'), 'plan mode refuses commands');
  out = await dispatch('bash', { command: 'echo pwned' }, planCtx);
  assert.ok(out.includes('Plan mode'), 'the alias path is gated too');
  out = await dispatch('read_file', { path: 'edit.txt' }, planCtx);
  assert.ok(out.includes('BETA'), 'reading still works while planning');

  // Defence in depth: a model can name a tool it was never offered.
  const untrustedCtx = { ...ctx, isTrusted: false };
  out = await dispatch('run_command', { command: 'echo pwned' }, untrustedCtx);
  assert.ok(out.includes('not trusted'), 'dispatch refuses shell tools when untrusted');
  out = await dispatch('bash', { command: 'echo pwned' }, untrustedCtx);
  assert.ok(out.includes('not trusted'), 'the alias path is gated too');
  out = await dispatch('read_file', { path: 'edit.txt' }, untrustedCtx);
  assert.ok(out.includes('BETA'), 'non-shell tools still run when untrusted');

  // ── approval gate ────────────────────────────────────────────────
  // Rejecting must leave the file byte-identical, and the tool must say so
  // clearly enough that the model doesn't just retry the same change.
  const asked: any[] = [];
  const rejectCtx = { ...ctx, approve: async (r: any) => { asked.push(r); return { approved: false }; } };
  const acceptCtx = { ...ctx, approve: async (r: any) => { asked.push(r); return { approved: true }; } };
  const redirectCtx = {
    ...ctx,
    approve: async (r: any) => { asked.push(r); return { approved: false, feedback: 'use Tailwind classes instead' }; },
  };

  fs.writeFileSync(path.join(tmp, 'guard.txt'), 'original');

  out = await dispatch('write_file', { path: 'guard.txt', content: 'clobbered', overwrite: true }, rejectCtx);
  assert.ok(out.includes('rejected') && out.includes('do not retry'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'guard.txt'), 'utf8'), 'original', 'rejected write changes nothing');
  assert.strictEqual(asked.at(-1).kind, 'write');
  assert.strictEqual(asked.at(-1).before, 'original', 'the diff gets the real current content');
  assert.strictEqual(asked.at(-1).after, 'clobbered');

  out = await dispatch('edit_file', { path: 'guard.txt', old_text: 'original', new_text: 'edited' }, rejectCtx);
  assert.ok(out.includes('rejected'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'guard.txt'), 'utf8'), 'original', 'rejected edit changes nothing');
  assert.strictEqual(asked.at(-1).kind, 'edit');

  out = await dispatch('delete_item', { path: 'guard.txt' }, rejectCtx);
  assert.ok(out.includes('rejected'), out);
  assert.ok(fs.existsSync(path.join(tmp, 'guard.txt')), 'rejected delete keeps the file');
  assert.strictEqual(asked.at(-1).kind, 'delete');

  // A new file reports before=null so the diff can render it as a creation.
  await dispatch('write_file', { path: 'brand-new.txt', content: 'hi' }, rejectCtx);
  assert.strictEqual(asked.at(-1).before, null, 'a new file has no "before" side');
  assert.ok(!fs.existsSync(path.join(tmp, 'brand-new.txt')));

  // Approving goes through.
  out = await dispatch('edit_file', { path: 'guard.txt', old_text: 'original', new_text: 'edited' }, acceptCtx);
  assert.ok(out.includes('Replaced 1'), out);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'guard.txt'), 'utf8'), 'edited');

  // Approval is only consulted when there is something to approve: a failed
  // precondition must not open a diff for a change that was never going to land.
  const before = asked.length;
  await dispatch('edit_file', { path: 'guard.txt', old_text: 'not-present' }, rejectCtx);
  await dispatch('write_file', { path: 'guard.txt', content: 'x' }, rejectCtx); // no overwrite flag
  assert.strictEqual(asked.length, before, 'no prompt for an edit that cannot apply');

  // No approver at all = auto-apply.
  out = await dispatch('write_file', { path: 'auto.txt', content: 'yes' }, ctx);
  assert.ok(out.startsWith('Wrote'), 'without an approver the change just applies');

  // Rejecting WITH an instruction must relay it — that redirection is the whole
  // point of rejecting rather than stopping, and it has to reach the model.
  out = await dispatch('edit_file', { path: 'guard.txt', old_text: 'edited', new_text: 'again' }, redirectCtx);
  assert.ok(out.includes('use Tailwind classes instead'), 'the feedback reaches the model');
  assert.ok(out.includes('Follow that instruction'), 'the model is told to act on it');
  assert.ok(!out.includes('Ask what they would like instead'), 'no contradictory "ask them" when they already said');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'guard.txt'), 'utf8'), 'edited', 'still unchanged');

  // ── web: the SSRF guard ──────────────────────────────────────────
  const internal = ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1'];
  for (const ip of internal) {
    assert.ok(_internal.ipIsInternal(ip), `${ip} must be treated as internal`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.ok(!_internal.ipIsInternal(ip), `${ip} must be treated as public`);
  }
  await assert.rejects(() => _internal.validateUrl('http://localhost:8000/'), /internal or private/);
  await assert.rejects(() => _internal.validateUrl('file:///etc/passwd'), /only open http/);
  await assert.rejects(() => _internal.validateUrl('not a url'), /valid web address/);

  // ── web: parsing ─────────────────────────────────────────────────
  assert.strictEqual(_internal.decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39;'), "a & b <c> 'd'");

  const html = `
    <html><head><title>My &amp; Page</title></head><body>
    <nav><p>skip me</p></nav>
    <script>var p = "<p>not text</p>";</script>
    <p>First para.</p><h2>Heading</h2><p>Second <b>para</b>.</p>
    <a href="/rel">Rel</a><a href="https://other.com/x">Other</a>
    <a href="mailto:a@b.c">Mail</a><a href="#top">Anchor</a><a href="/rel">Dupe</a>
    </body></html>`;
  const text = _internal.stripToText(html);
  assert.ok(text.includes('First para.') && text.includes('Second para.'), text);
  assert.ok(!text.includes('skip me'), 'nav content is dropped');
  assert.ok(!text.includes('not text'), 'script content is dropped');

  // Code blocks are the main reason to read a docs page — returning the prose
  // about an API with none of the examples is close to useless.
  const withCode = _internal.stripToText(
    '<p>Before.</p>' +
    '<pre><code><span class="k">const</span> <span class="n">x</span> = 1;</code></pre>' +
    '<p>After.</p>'
  );
  assert.ok(withCode.includes('```'), 'code blocks are fenced');
  assert.ok(withCode.includes('const x = 1;'),
    'inline highlight spans strip to nothing, not to spaces: ' + JSON.stringify(withCode));
  assert.ok(withCode.indexOf('Before.') < withCode.indexOf('```'), 'document order is preserved');
  assert.ok(withCode.indexOf('```') < withCode.indexOf('After.'));

  // Many docs sites put each source line in its own div; without converting
  // those the whole sample collapses onto one line.
  const perLine = _internal.stripToText(
    '<pre><div class="line">const a = 1;</div><div class="line">const b = 2;</div></pre>'
  );
  assert.ok(perLine.includes('const a = 1;\nconst b = 2;'),
    'block tags inside pre become newlines: ' + JSON.stringify(perLine));

  const withBr = _internal.stripToText('<pre>one<br>two</pre>');
  assert.ok(withBr.includes('one\ntwo'), '<br> becomes a newline in code');

  // Definition lists and table cells carry MDN-style parameter docs.
  const defs = _internal.stripToText('<dl><dt>time</dt><dd>Milliseconds before aborting.</dd></dl>');
  assert.ok(defs.includes('time') && defs.includes('Milliseconds before aborting.'),
    'definition lists are extracted');

  // A <p> nested inside a <dd> matches twice; it must not print twice.
  const nested = _internal.stripToText('<dd><p>Only once.</p></dd>');
  assert.strictEqual(nested.split('Only once.').length - 1, 1, 'nested blocks are not duplicated');

  const links = _internal.parseLinks(html, 'https://example.com/dir/page', false);
  const hrefs = links.map((l: any) => l.href);
  assert.ok(hrefs.includes('https://example.com/rel'), 'relative links resolve absolute');
  assert.ok(hrefs.includes('https://other.com/x'));
  assert.ok(!hrefs.some((h: string) => h.startsWith('mailto:')), 'mailto is skipped');
  assert.strictEqual(hrefs.filter((h: string) => h === 'https://example.com/rel').length, 1, 'duplicates collapse');

  const sameOnly = _internal.parseLinks(html, 'https://example.com/dir/page', true);
  assert.ok(sameOnly.every((l: any) => l.href.startsWith('https://example.com')), 'same_domain filters');

  // ── history trim keeps tool messages attached ────────────────────
  const makeHistory = (turns: number, filler = '') => {
    const h: any[] = [];
    for (let i = 0; i < turns; i++) {
      h.push({ role: 'user', content: `q${i}${filler}` });
      h.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      h.push({ role: 'tool', tool_call_id: `t${i}`, content: `result${filler}` });
      h.push({ role: 'assistant', content: `a${i}${filler}` });
    }
    return h;
  };

  // Small messages: the message-count ceiling is what bites.
  const history = makeHistory(60);
  trimHistory(history, 128_000);
  assert.ok(history.length <= 80, `trimmed to ${history.length}`);
  assert.strictEqual(history[0].role, 'user', 'history never starts on an orphaned tool result');
  assert.strictEqual(typeof history[0].content, 'string');

  // Large messages with a small budget: the token budget is what bites, and it
  // must bite much sooner than the message ceiling would.
  const heavy = makeHistory(30, 'x'.repeat(4000));
  trimHistory(heavy, 8000);
  assert.ok(heavy.length < 80, `token budget trimmed to ${heavy.length} messages`);
  assert.strictEqual(heavy[0].role, 'user', 'token-based trim still cuts at a user turn');
  const heavyTokens = heavy.reduce((n: number, m: any) => n + estimateTokens(m), 0);
  assert.ok(heavyTokens <= 8000, `kept ${heavyTokens} tokens, budget was 8000`);

  // Never orphan a tool result, whichever limit applied.
  for (const h of [history, heavy]) {
    for (let i = 0; i < h.length; i++) {
      if (h[i].role === 'tool') {
        const prior = h.slice(0, i).reverse().find((m: any) => m.role === 'assistant' && m.tool_calls);
        assert.ok(prior, 'every tool message is preceded by the assistant turn that asked for it');
        break;
      }
    }
  }

  // ── rebuilding history after a reload ────────────────────────────
  // The live history is in memory, so a restarted extension host rebuilds it
  // from the saved session. If that rebuild drops the tool results, "continue"
  // makes the agent re-explore the project from scratch.
  const { rebuildEngineHistory } = require('./history');

  const saved: any[] = [
    { role: 'user', content: 'enhance this website', blocks: [] },
    {
      role: 'assistant',
      content: '',                        // a tool-only round has NO text at all
      blocks: [
        { type: 'reasoning', text: 'let me look around' },
        { type: 'tool', name: 'list_folder', input: { path: 'app' }, result: 'app/page.tsx', done: true },
        { type: 'tool', name: 'read_file', input: { path: 'app/page.tsx' }, result: 'export default function Page(){}', done: true },
        { type: 'text', text: 'Here is what I found.' },
      ],
    },
  ];

  const rebuilt = rebuildEngineHistory(saved);

  assert.strictEqual(rebuilt[0].role, 'user');
  const toolMessages = rebuilt.filter((m: any) => m.role === 'tool');
  assert.strictEqual(toolMessages.length, 2, 'both tool results survive the rebuild');
  assert.ok(
    toolMessages.some((m: any) => m.content.includes('export default function Page')),
    'the file contents the agent read are still in context'
  );
  assert.ok(
    rebuilt.some((m: any) => m.content === 'Here is what I found.'),
    'trailing prose survives'
  );

  // Every tool message must be answered by an assistant tool_call with a
  // matching id, or providers reject the whole request.
  const callIds = new Set<string>();
  for (const m of rebuilt as any[]) {
    for (const call of m.tool_calls || []) {
      assert.ok(!callIds.has(call.id), 'tool_call ids must be unique');
      callIds.add(call.id);
      assert.doesNotThrow(() => JSON.parse(call.function.arguments), 'arguments must be valid JSON');
    }
    if (m.role === 'tool') {
      assert.ok(callIds.has(m.tool_call_id), `orphaned tool result: ${m.tool_call_id}`);
    }
  }
  assert.ok(!rebuilt.some((m: any) => m.role === 'assistant' && !m.content && !m.tool_calls),
    'no empty assistant messages');

  // An unfinished tool call would leave a dangling id, so it must be dropped.
  const withPending = rebuildEngineHistory([
    { role: 'assistant', content: '', blocks: [{ type: 'tool', name: 'read_file', input: {}, done: false }] },
  ]);
  assert.strictEqual(withPending.length, 0, 'an in-flight tool call is not rebuilt');

  // Errored turns and legacy block-less messages.
  const mixed = rebuildEngineHistory([
    { role: 'assistant', content: 'boom', error: true, blocks: [] },
    { role: 'assistant', content: 'plain old message' },
  ]);
  assert.deepStrictEqual(mixed, [{ role: 'assistant', content: 'plain old message' }],
    'errors are dropped, legacy messages are kept');

  // ── loop detection ───────────────────────────────────────────────
  // With the round cap raised to 100, this is what stops a stuck model early.
  const sig = agentInternals.callSignature;

  assert.strictEqual(
    sig([{ name: 'read_file', args: '{"path":"a.ts"}' }]),
    sig([{ name: 'read_file', args: '{"path":"a.ts"}' }]),
    'the same call has the same signature'
  );
  assert.notStrictEqual(
    sig([{ name: 'read_file', args: '{"path":"a.ts"}' }]),
    sig([{ name: 'read_file', args: '{"path":"b.ts"}' }]),
    'different arguments are different work, not a loop'
  );
  assert.notStrictEqual(
    sig([{ name: 'read_file', args: '{}' }]),
    sig([{ name: 'write_file', args: '{}' }]),
    'different tools are different work'
  );
  // Providers do not guarantee ordering within a parallel tool-call batch, so the
  // same batch in a different order must not read as new work.
  assert.strictEqual(
    sig([{ name: 'read_file', args: '{"p":1}' }, { name: 'list_folder', args: '{"p":2}' }]),
    sig([{ name: 'list_folder', args: '{"p":2}' }, { name: 'read_file', args: '{"p":1}' }]),
    'a reordered batch is the same batch'
  );

  // Replay the detector's own arithmetic: it must fire on the 3rd identical
  // round and never on a varying sequence.
  const fires = (signatures: string[]) => {
    let last = '';
    let repeats = 0;
    for (let i = 0; i < signatures.length; i++) {
      repeats = signatures[i] === last ? repeats + 1 : 0;
      last = signatures[i];
      if (repeats >= agentInternals.MAX_REPEATED_CALLS - 1) {
        return i + 1;
      }
    }
    return 0;
  };
  assert.strictEqual(fires(['a', 'a', 'a', 'a']), 3, 'stops on the third identical round');
  assert.strictEqual(fires(['a', 'b', 'a', 'b', 'a']), 0, 'alternating work never trips it');
  assert.strictEqual(fires(['a', 'a', 'b', 'b', 'c']), 0, 'a pair of repeats is tolerated');

  // The wrap-up prompts must forbid further tool calls, or the model just
  // restarts the loop during the summary round.
  for (const reason of ['rounds', 'loop', 'context']) {
    assert.ok(
      /do NOT call/i.test(agentInternals.FINALIZE_PROMPT[reason]),
      `the ${reason} wrap-up prompt must forbid more tool calls`
    );
  }
  assert.ok(agentInternals.CONTEXT_STOP_FRACTION < 1, 'the context guard must stop before the window is full');

  // A short history is left alone.
  const short = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }];
  trimHistory(short, 128_000);
  assert.strictEqual(short.length, 2, 'a short history is untouched');

  // One oversized turn must not be trimmed to nothing — a too-big turn is
  // better than an empty history that loses the question entirely.
  const oversized = [{ role: 'user', content: 'y'.repeat(200_000) }];
  trimHistory(oversized, 8000);
  assert.strictEqual(oversized.length, 1, 'a single oversized turn survives');

  console.log('engine self-check passed');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
