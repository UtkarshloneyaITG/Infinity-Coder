/**
 * Self-check for the semantic index. No framework — run it with:
 *   npm run compile && node out/semantic/semantic.test.js
 *
 * Covers the three places this system can be wrong in ways nothing else would
 * catch: chunks that do not line up with real code, a store that loses or
 * mismatches vectors across a reload, and ranking that quietly degrades into
 * keyword search.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { chunkFile, extractImports, extractExports, estimateTokens, sha1 } from './chunker';
import { normalize, dot, OpenAICompatibleEmbeddings } from './embeddings';
import { FlatFileVectorStore, MemoryVectorStore, quantize, dotQuantized, IndexFullError } from './store';
import { rank, keywordScore, tokenizeQuery, buildContext, SemanticSearchEngine } from './search';
import { Chunk, EmbeddingProvider } from './types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infinity-semantic-'));

/** A chunk with sensible defaults, so each test only states what it cares about. */
function chunk(over: Partial<Chunk> = {}): Chunk {
  const text = over.text ?? 'function noop() { return 1; }';
  return {
    id: over.id ?? `f.ts#noop@1`,
    workspace: '/w',
    relPath: 'src/f.ts',
    language: 'typescript',
    fileHash: 'filehash',
    chunkHash: sha1(text),
    startLine: 1,
    endLine: 1,
    updatedAt: Date.now(),
    symbol: 'noop',
    symbolKind: 'function',
    imports: [],
    exports: [],
    dependencies: [],
    exported: false,
    tokenCount: estimateTokens(text),
    text,
    ...over,
  };
}

/**
 * Deterministic stand-in for an embedding endpoint: a bag-of-words vector over a
 * fixed vocabulary. Real enough that "auth" queries actually rank auth chunks
 * highest, with no network and no key.
 */
const VOCAB = ['auth', 'jwt', 'login', 'session', 'token', 'render', 'button', 'style', 'user', 'password'];

class FakeEmbeddings implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-embed';
  readonly dimensions = VOCAB.length;
  readonly batchSize = 8;
  public calls = 0;

  async embed(text: string): Promise<Float32Array> {
    this.calls++;
    const lower = text.toLowerCase();
    const vector = new Float32Array(VOCAB.length);
    VOCAB.forEach((word, i) => {
      vector[i] = (lower.split(word).length - 1);
    });
    // An all-zero vector would make every similarity 0 and hide ordering bugs.
    if (vector.every(v => v === 0)) {
      vector[0] = 0.01;
    }
    return normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

async function main() {
  // ── chunking: syntax, not windows ────────────────────────────────
  const tsSource = [
    "import { sign } from 'jsonwebtoken';",       // 1
    "import type { User } from './types';",        // 2
    '',                                            // 3
    'export class JwtService {',                   // 4
    '  private secret = process.env.SECRET;',      // 5
    '',                                            // 6
    '  public issue(user: User): string {',        // 7
    '    return sign({ sub: user.id }, this.secret);', // 8
    '  }',                                         // 9
    '',                                            // 10
    '  public verify(token: string): boolean {',   // 11
    '    return Boolean(token);',                  // 12
    '  }',                                         // 13
    '}',                                           // 14
  ].join('\n');

  const symbols = [{
    name: 'JwtService', kind: 'class' as const, startLine: 4, endLine: 14,
    children: [
      { name: 'issue', kind: 'method' as const, startLine: 7, endLine: 9, children: [] },
      { name: 'verify', kind: 'method' as const, startLine: 11, endLine: 13, children: [] },
    ],
  }];

  const tsChunks = chunkFile({
    workspace: '/w', relPath: 'src/auth/jwt.ts', language: 'typescript',
    text: tsSource, fileHash: 'h1', symbols,
  });

  const issue = tsChunks.find(c => c.symbol === 'issue');
  assert.ok(issue, 'a method becomes its own chunk');
  assert.strictEqual(issue!.parentSymbol, 'JwtService', 'the enclosing class is recorded');
  assert.strictEqual(issue!.startLine, 7, 'line numbers match the editor (1-based)');
  assert.ok(issue!.text.includes('sign({ sub'), 'the chunk holds the real body');
  assert.ok(
    !tsChunks.some(c => c.symbol === 'JwtService' && c.text.includes('verify')),
    'a class with members is not also emitted whole — that would duplicate every method',
  );
  assert.deepStrictEqual(issue!.imports, ['jsonwebtoken', './types'], 'imports are attached to every chunk');
  assert.ok(issue!.exports.includes('JwtService'), 'exports are attached too');

  // The class declaration line keeps its own chunk: "what is this class" lives
  // there, not in any single method.
  assert.ok(tsChunks.some(c => c.symbol === 'JwtService'), 'the class signature is still indexed');

  // ── chunk ids and hashes are stable ──────────────────────────────
  const again = chunkFile({
    workspace: '/w', relPath: 'src/auth/jwt.ts', language: 'typescript',
    text: tsSource, fileHash: 'h1', symbols,
  });
  assert.deepStrictEqual(
    again.map(c => c.id), tsChunks.map(c => c.id),
    'chunking is deterministic — otherwise every re-index re-embeds everything',
  );
  assert.deepStrictEqual(again.map(c => c.chunkHash), tsChunks.map(c => c.chunkHash));

  // ── markdown chunks by heading ───────────────────────────────────
  const mdChunks = chunkFile({
    workspace: '/w', relPath: 'README.md', language: 'markdown', fileHash: 'h2',
    text: ['Intro text.', '', '# Install', 'Run npm i.', '', '## From source', 'Clone it.', '', '# Usage', 'Press F5.'].join('\n'),
  });
  const md = mdChunks.map(c => c.symbol);
  assert.ok(md.includes('Install') && md.includes('Usage'), 'headings become sections');
  assert.ok(md.includes('From source'), 'subheadings too');
  assert.ok(md.includes('preamble'), 'text before the first heading is not dropped');
  const install = mdChunks.find(c => c.symbol === 'From source')!;
  assert.strictEqual(install.parentSymbol, 'Install', 'nesting follows heading level');

  // ── json chunks by top-level key ─────────────────────────────────
  const jsonChunks = chunkFile({
    workspace: '/w', relPath: 'package.json', language: 'json', fileHash: 'h3',
    text: ['{', '  "name": "app",', '  "scripts": {', '    "build": "tsc"', '  },', '  "version": "1.0.0"', '}'].join('\n'),
  });
  const scripts = jsonChunks.find(c => c.symbol === 'scripts');
  assert.ok(scripts, 'a nested object is one configuration block');
  assert.ok(scripts!.text.includes('"build"'), 'and holds its contents');

  // ── heuristic fallback when no language server answers ───────────
  const pyChunks = chunkFile({
    workspace: '/w', relPath: 'auth.py', language: 'python', fileHash: 'h4',
    text: ['import os', '', 'def login(user):', '    return True', '', 'class Session:', '    pass'].join('\n'),
  });
  assert.ok(pyChunks.some(c => c.symbol === 'login'), 'python defs are found without a parser');
  assert.ok(pyChunks.some(c => c.symbol === 'Session'), 'and classes');
  assert.deepStrictEqual(
    extractImports('import os\nfrom a.b import c', 'python').sort(), ['a.b', 'os'],
    'python imports are found in both forms',
  );
  assert.ok(extractExports('def public():\n  pass\ndef _private():\n  pass', 'python').includes('public'));
  assert.ok(!extractExports('def _private():\n  pass', 'python').includes('_private'), 'underscore means private');

  // ── every line survives an over-long symbol ──────────────────────
  const long = Array.from({ length: 400 }, (_, i) => `  const line${i} = ${i};`).join('\n');
  const bigChunks = chunkFile({
    workspace: '/w', relPath: 'big.ts', language: 'typescript', fileHash: 'h5',
    text: `function big() {\n${long}\n}`,
    symbols: [{ name: 'big', kind: 'function', startLine: 1, endLine: 402, children: [] }],
    options: { maxChars: 1000 },
  });
  assert.ok(bigChunks.length > 1, 'an oversized symbol is windowed');
  const covered = new Set<number>();
  bigChunks.forEach(c => { for (let l = c.startLine; l <= c.endLine; l++) { covered.add(l); } });
  for (let line = 1; line <= 402; line++) {
    assert.ok(covered.has(line), `line ${line} must appear in some window`);
  }

  // ── quantization keeps ordering intact ───────────────────────────
  const a = normalize(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const b = normalize(Float32Array.from([0.9, 0.3, 0, 0, 0, 0, 0, 0, 0, 0]));
  const far = normalize(Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]));
  const packed = new Int8Array(30);
  quantize(a, packed, 0);
  quantize(b, packed, 10);
  quantize(far, packed, 20);
  assert.ok(Math.abs(dotQuantized(a, packed, 0) - 1) < 0.02, 'a vector against itself is ~1');
  assert.ok(dotQuantized(a, packed, 10) > dotQuantized(a, packed, 20), 'int8 preserves ranking');
  assert.ok(Math.abs(dotQuantized(a, packed, 10) - dot(a, b)) < 0.02, 'int8 error stays under 2%');

  // ── asymmetric models: input_type is learned from the rejection ──
  // NVIDIA's nv-embedqa family 400s without input_type. Rather than hardcode a
  // list of asymmetric model names, the provider reads the refusal and retries.
  {
    const seen: any[] = [];
    const fakeFetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      if (body.input_type === undefined) {
        return {
          ok: false, status: 400,
          text: async () => '{"error":"\'input_type\' parameter is required for asymmetric models"}',
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [1, 0, 0] })) }),
      };
    }) as any;

    const nim = new OpenAICompatibleEmbeddings({
      id: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'k', model: 'nvidia/nv-embedqa-e5-v5', fetchImpl: fakeFetch,
    });

    const vector = await nim.embed('where is auth', undefined, 'query');
    assert.strictEqual(seen.length, 2, 'the 400 is retried, not surfaced');
    assert.strictEqual(seen[0].input_type, undefined, 'the first attempt omits it');
    assert.strictEqual(seen[1].input_type, 'query', 'the retry sends the caller\'s kind');
    assert.strictEqual(vector.length, 3, 'and the retry\'s vector is returned');

    // Learned once, not re-discovered on every call — otherwise every batch of a
    // 100k-file build would pay a wasted 400 first.
    await nim.embedBatch(['a chunk of code'], undefined, 'passage');
    assert.strictEqual(seen.length, 3, 'no second probe');
    assert.strictEqual(seen[2].input_type, 'passage', 'documents embed as passages, not queries');
  }

  // A 400 that is NOT about input_type must still surface, or a bad model id
  // would look like an empty index.
  {
    const failing = new OpenAICompatibleEmbeddings({
      id: 'x', baseUrl: 'http://x/v1', apiKey: 'k', model: 'nope',
      fetchImpl: (async () => ({ ok: false, status: 400, text: async () => 'unknown model' })) as any,
    });
    await assert.rejects(() => failing.embed('hi'), /unknown model/, 'unrelated 400s are reported');
  }

  // ── the store survives a reload ──────────────────────────────────
  const dir = path.join(tmp, 'index');
  const provider = new FakeEmbeddings();
  const makeStore = () => new FlatFileVectorStore({
    directory: dir, dimensions: provider.dimensions, model: provider.model,
  });

  const store = makeStore();
  await store.load();

  const authChunk = chunk({
    id: 'auth', relPath: 'src/auth/middleware.ts', symbol: 'requireAuth', exported: true,
    text: 'export function requireAuth(req) { const token = req.headers.authorization; return jwt.verify(token); }',
  });
  const styleChunk = chunk({
    id: 'style', relPath: 'src/ui/button.css', symbol: 'button', language: 'css',
    text: '.button { border-radius: 4px; }',
  });
  await store.insert(
    [authChunk, styleChunk],
    await provider.embedBatch([authChunk.text, styleChunk.text]),
  );

  let stats = await store.stats();
  assert.strictEqual(stats.chunks, 2);
  assert.strictEqual(store.fileHash('src/auth/middleware.ts'), 'filehash', 'file hashes are tracked');

  // Reopening must give back the same index — this is the whole point of the
  // manifest/vectors/chunks layout.
  const reopened = makeStore();
  await reopened.load();
  const reloadedStats = await reopened.stats();
  assert.strictEqual(reloadedStats.chunks, 2, 'chunks survive a reload');
  assert.strictEqual(reopened.fileHash('src/auth/middleware.ts'), 'filehash', 'so do file hashes');

  const authQuery = await provider.embed('jwt auth token');
  const hits = await reopened.search(authQuery, { topK: 2 });
  assert.strictEqual(hits[0].chunk.relPath, 'src/auth/middleware.ts', 'the right chunk comes back first');
  assert.ok(hits[0].chunk.text.includes('requireAuth'), 'and its text was hydrated from disk');

  // ── a model change invalidates rather than corrupts ──────────────
  const wrongModel = new FlatFileVectorStore({ directory: dir, dimensions: 10, model: 'other-model' });
  await wrongModel.load();
  assert.strictEqual((await wrongModel.stats()).chunks, 0, 'vectors from another model are discarded, not reused');

  // ── delete removes a file from results ───────────────────────────
  const store2 = makeStore();
  await store2.load();
  await store2.insert([authChunk, styleChunk], await provider.embedBatch([authChunk.text, styleChunk.text]));
  await store2.delete(['src/auth/middleware.ts']);
  const afterDelete = await store2.search(authQuery, { topK: 5 });
  assert.ok(
    !afterDelete.some(r => r.chunk.relPath === 'src/auth/middleware.ts'),
    'a deleted file must not stay searchable',
  );
  assert.strictEqual(store2.fileHash('src/auth/middleware.ts'), undefined, 'its hash goes too');

  // ── the chunk ceiling reports rather than exhausts memory ────────
  const tiny = new FlatFileVectorStore({
    directory: path.join(tmp, 'tiny'), dimensions: provider.dimensions, model: provider.model, maxChunks: 1,
  });
  await tiny.load();
  await assert.rejects(
    () => tiny.insert([authChunk, styleChunk], [new Float32Array(10), new Float32Array(10)]),
    (e: any) => e instanceof IndexFullError,
    'hitting the ceiling is an error the user can act on, not an OOM',
  );

  // ── ranking: hybrid, not keyword ─────────────────────────────────
  assert.deepStrictEqual(tokenizeQuery('Where is jwtService implemented?'), ['jwt', 'service']);
  assert.ok(
    keywordScore(['auth'], chunk({ symbol: 'requireAuth' })) >
    keywordScore(['auth'], chunk({ symbol: 'render', text: 'auth auth auth' })),
    'a name match beats repeated body mentions',
  );

  // Identical symbol names on purpose: the keyword term must score the same on
  // both, so the assertion isolates the exported/entry-point boosts alone.
  const ranked = rank(
    [
      { chunk: chunk({ id: 'x', symbol: 'helper', exported: false, relPath: 'src/deep/util.ts' }), score: 0, similarity: 0.80, reasons: [] },
      { chunk: chunk({ id: 'y', symbol: 'helper', exported: true, relPath: 'src/index.ts' }), score: 0, similarity: 0.78, reasons: [] },
    ],
    'helper',
  );
  assert.strictEqual(ranked[0].chunk.id, 'y', 'exported + entry point outranks a marginally better vector');
  assert.ok(ranked[0].reasons.includes('exported symbol'), 'and says why');
  assert.ok(ranked[0].reasons.includes('entry point'));

  // Similarity still dominates: a big gap must not be overturned by boosts.
  const dominated = rank(
    [
      { chunk: chunk({ id: 'near', symbol: 'a' }), score: 0, similarity: 0.95, reasons: [] },
      { chunk: chunk({ id: 'far', symbol: 'b', exported: true, relPath: 'src/index.ts' }), score: 0, similarity: 0.40, reasons: [] },
    ],
    'a',
  );
  assert.strictEqual(dominated[0].chunk.id, 'near', 'boosts break ties, they do not replace the vector');

  // ── context builder ──────────────────────────────────────────────
  const dupText = 'export function login() {}';
  const built = buildContext(
    [
      { chunk: chunk({ id: '1', text: dupText, relPath: 'a.ts' }), score: 1, similarity: 1, reasons: [] },
      // Same text under a different id — a copy is not new information.
      { chunk: chunk({ id: '2', text: dupText, relPath: 'b.ts' }), score: 0.9, similarity: 0.9, reasons: [] },
      { chunk: chunk({ id: '3', text: 'const other = 1;', relPath: 'c.ts' }), score: 0.8, similarity: 0.8, reasons: [] },
    ],
    { maxTokens: 1000 },
  );
  assert.strictEqual(built.chunks.length, 2, 'duplicate text is dropped');
  assert.ok(built.text.includes('--- a.ts ---'), 'output is grouped per file');

  // The budget is a hard ceiling, and what it drops is reported.
  const squeezed = buildContext(
    [
      { chunk: chunk({ id: 'big1', text: 'x'.repeat(4000), relPath: 'a.ts' }), score: 1, similarity: 1, reasons: [] },
      { chunk: chunk({ id: 'big2', text: 'y'.repeat(4000), relPath: 'b.ts' }), score: 0.9, similarity: 0.9, reasons: [] },
    ],
    { maxTokens: 1200 },
  );
  assert.strictEqual(squeezed.chunks.length, 1, 'the token budget is enforced');
  assert.strictEqual(squeezed.omitted, 1, 'and what was dropped is counted, never silently lost');
  assert.ok(squeezed.tokens <= 1200);

  // Adjacent chunks of one file merge instead of arriving as fragments.
  const mergedCtx = buildContext(
    [
      { chunk: chunk({ id: 'm1', relPath: 'm.ts', startLine: 1, endLine: 10, text: 'function a() {' }), score: 1, similarity: 1, reasons: [] },
      { chunk: chunk({ id: 'm2', relPath: 'm.ts', startLine: 12, endLine: 20, text: '} // end a' }), score: 0.9, similarity: 0.9, reasons: [] },
    ],
    { maxTokens: 1000 },
  );
  assert.strictEqual(mergedCtx.chunks.length, 1, 'near-adjacent regions of one file are fused');
  assert.strictEqual(mergedCtx.chunks[0].endLine, 20);

  // ── end to end: the question from the brief ──────────────────────
  const memory = new MemoryVectorStore(provider.dimensions);
  const corpus = [
    chunk({ id: 'mw', relPath: 'src/auth/middleware.ts', symbol: 'requireAuth', exported: true, text: 'auth auth session token check' }),
    chunk({ id: 'jwt', relPath: 'src/services/jwt.ts', symbol: 'JwtService', exported: true, text: 'jwt jwt token sign verify' }),
    chunk({ id: 'login', relPath: 'src/controllers/login.ts', symbol: 'loginController', exported: true, text: 'login login user password auth' }),
    chunk({ id: 'button', relPath: 'src/ui/button.tsx', symbol: 'Button', exported: true, text: 'render button style' }),
  ];
  await memory.insert(corpus, await provider.embedBatch(corpus.map(c => c.text)));

  const engine = new SemanticSearchEngine({ store: memory, provider });
  const found = await engine.findRelevantFiles('Where is authentication implemented?', { topK: 3 });
  assert.ok(found.includes('src/auth/middleware.ts'), 'auth middleware is retrieved');
  assert.ok(found.includes('src/services/jwt.ts'), 'so is the jwt service');
  assert.ok(found.includes('src/controllers/login.ts'), 'and the login controller');
  assert.ok(!found.includes('src/ui/button.tsx'), 'the unrelated UI chunk is not');

  const symbolHits = await engine.findRelevantSymbols('jwt token signing', { topK: 2 });
  assert.strictEqual(symbolHits[0].symbol, 'JwtService', 'symbol search names the symbol');
  assert.ok(symbolHits[0].relPath.endsWith('jwt.ts'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('semantic self-check passed');
}

main().catch(err => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
