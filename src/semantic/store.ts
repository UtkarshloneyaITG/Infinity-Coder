import * as fs from 'fs';
import * as path from 'path';
import { Chunk, IndexStats, SearchOptions, SearchResult, VectorStore, INDEX_VERSION } from './types';
import { dot } from './embeddings';

/**
 * Vector stores.
 *
 * FlatFileVectorStore is the real one: no native modules, no server, nothing to
 * install. SQLite and HNSW were both considered and rejected — each ships a
 * per-platform binary, which would end the extension's "no dependencies"
 * property and force a .vsix per OS/arch. The VectorStore interface is where
 * either one goes if that trade ever becomes worth it.
 *
 * ON-DISK LAYOUT
 *   semantic-index/<workspace>/
 *     manifest.json   version, model, dimensions, counts
 *     vectors.bin     int8, row-major, fixed stride, row N = chunk N
 *     chunks.jsonl    one JSON chunk per line, row N = line N
 *
 * The two files are positional, so a torn write desynchronises them. Every
 * mutation therefore appends to both and only then rewrites the manifest — the
 * manifest's row count is what makes a prefix of both files authoritative, and
 * anything past it is discarded on load as a partial write.
 */

/**
 * Vectors are stored as int8, not float32: a quarter of the memory and disk for
 * a cosine error under 1% on normalized embeddings, which is far below the gap
 * between a relevant and an irrelevant chunk. This is the single reason a
 * 100k-file repo fits in RAM at all.
 *
 * ponytail: int8 flat scan, ~250k chunks before it gets uncomfortable. Beyond
 * that the upgrade is product quantization or an HNSW graph behind this same
 * interface — not a bigger machine.
 */
const QUANT_SCALE = 127;

export function quantize(vector: Float32Array, out: Int8Array, offset: number): void {
  for (let i = 0; i < vector.length; i++) {
    // Normalized inputs live in [-1, 1]; clamp anyway so a stray value from a
    // misbehaving provider cannot wrap around into a wildly wrong direction.
    const v = Math.max(-1, Math.min(1, vector[i]));
    out[offset + i] = Math.round(v * QUANT_SCALE);
  }
}

/** Dot product between a float query and one quantized row. */
export function dotQuantized(query: Float32Array, rows: Int8Array, offset: number): number {
  let sum = 0;
  for (let i = 0; i < query.length; i++) {
    sum += query[i] * rows[offset + i];
  }
  return sum / QUANT_SCALE;
}

/** In-memory row header. The chunk text stays out of RAM — see `hydrate`. */
interface RowHeader {
  relPath: string;
  /** Byte offset of this row's line in chunks.jsonl. */
  byteOffset: number;
  byteLength: number;
  deleted: boolean;
}

export interface FlatFileStoreOptions {
  directory: string;
  dimensions: number;
  model: string;
  /**
   * Hard ceiling. Reaching it stops indexing with a message rather than
   * exhausting memory — a truncated index the user knows about beats a dead
   * extension host.
   */
  maxChunks?: number;
}

export class FlatFileVectorStore implements VectorStore {
  public readonly dimensions: number;

  private readonly dir: string;
  private readonly model: string;
  private readonly maxChunks: number;

  private headers: RowHeader[] = [];
  private vectors: Int8Array;
  private capacity = 0;
  /** relPath -> file hash, the incremental gate. */
  private hashes = new Map<string, string>();
  /** relPath -> row indices, so a file's chunks can be replaced in place. */
  private byFile = new Map<string, number[]>();
  private deletedRows = 0;
  private lastBuiltAt = 0;
  private lastUpdatedAt = 0;
  private loaded = false;

  constructor(opts: FlatFileStoreOptions) {
    this.dir = opts.directory;
    this.dimensions = opts.dimensions;
    this.model = opts.model;
    this.maxChunks = opts.maxChunks ?? 400_000;
    this.vectors = new Int8Array(0);
  }

  private get vectorsPath(): string { return path.join(this.dir, 'vectors.bin'); }
  private get chunksPath(): string { return path.join(this.dir, 'chunks.jsonl'); }
  private get manifestPath(): string { return path.join(this.dir, 'manifest.json'); }

  /**
   * Load an existing index, or start an empty one. A manifest from another
   * version, model or width is discarded rather than migrated: the vectors are
   * meaningless under a different model, so reuse would return confident
   * nonsense.
   */
  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    fs.mkdirSync(this.dir, { recursive: true });

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      return; // no index yet
    }

    if (
      manifest.version !== INDEX_VERSION ||
      manifest.model !== this.model ||
      manifest.dimensions !== this.dimensions
    ) {
      await this.clear();
      return;
    }

    const rows: number = manifest.rows || 0;
    this.lastBuiltAt = manifest.lastBuiltAt || 0;
    this.lastUpdatedAt = manifest.lastUpdatedAt || 0;

    // Only the manifest's row count is trusted. Bytes past it are a partial
    // write from a crash mid-flush and are dropped.
    const needed = rows * this.dimensions;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.vectorsPath);
    } catch {
      await this.clear();
      return;
    }
    if (raw.length < needed) {
      await this.clear();
      return;
    }
    this.grow(rows);
    this.vectors.set(new Int8Array(raw.buffer, raw.byteOffset, needed), 0);

    let text: string;
    try {
      text = fs.readFileSync(this.chunksPath, 'utf8');
    } catch {
      await this.clear();
      return;
    }

    let offset = 0;
    let row = 0;
    for (const line of text.split('\n')) {
      const byteLength = Buffer.byteLength(line, 'utf8');
      if (line.length > 0 && row < rows) {
        try {
          const chunk = JSON.parse(line) as Chunk & { deleted?: boolean };
          this.headers.push({
            relPath: chunk.relPath,
            byteOffset: offset,
            byteLength,
            deleted: !!chunk.deleted,
          });
          if (chunk.deleted) {
            this.deletedRows++;
          } else {
            this.hashes.set(chunk.relPath, chunk.fileHash);
            const list = this.byFile.get(chunk.relPath);
            if (list) { list.push(row); } else { this.byFile.set(chunk.relPath, [row]); }
          }
          row++;
        } catch {
          break; // truncated final line — stop, the manifest count still governs
        }
      }
      offset += byteLength + 1; // +1 for the newline
    }

    // Metadata shorter than the manifest promised means the two files
    // desynchronised. Rebuilding is cheap next to serving mismatched results.
    if (row !== rows) {
      await this.clear();
    }
  }

  private grow(rows: number): void {
    if (rows <= this.capacity) {
      return;
    }
    // Double rather than fit exactly: insert() is called once per file, so an
    // exact-fit realloc would copy the whole index on every file.
    const capacity = Math.max(rows, this.capacity * 2, 1024);
    const next = new Int8Array(capacity * this.dimensions);
    next.set(this.vectors.subarray(0, this.capacity * this.dimensions), 0);
    this.vectors = next;
    this.capacity = capacity;
  }

  public async insert(chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    if (chunks.length !== vectors.length) {
      throw new Error(`insert got ${chunks.length} chunks and ${vectors.length} vectors`);
    }
    if (this.headers.length + chunks.length > this.maxChunks) {
      throw new IndexFullError(
        `Semantic index is full at ${this.maxChunks.toLocaleString()} chunks. ` +
        'Narrow the indexed folders in Settings, or raise the limit.',
      );
    }

    fs.mkdirSync(this.dir, { recursive: true });
    this.grow(this.headers.length + chunks.length);

    let jsonl = '';
    let byteOffset = fs.existsSync(this.chunksPath) ? fs.statSync(this.chunksPath).size : 0;
    const quantized = new Int8Array(chunks.length * this.dimensions);

    chunks.forEach((chunk, i) => {
      if (vectors[i].length !== this.dimensions) {
        throw new Error(`vector width ${vectors[i].length} != index width ${this.dimensions}`);
      }
      quantize(vectors[i], quantized, i * this.dimensions);

      const line = JSON.stringify(chunk);
      const byteLength = Buffer.byteLength(line, 'utf8');
      const row = this.headers.length;
      this.headers.push({ relPath: chunk.relPath, byteOffset, byteLength, deleted: false });
      const list = this.byFile.get(chunk.relPath);
      if (list) { list.push(row); } else { this.byFile.set(chunk.relPath, [row]); }
      this.hashes.set(chunk.relPath, chunk.fileHash);
      jsonl += line + '\n';
      byteOffset += byteLength + 1;
    });

    this.vectors.set(quantized, (this.headers.length - chunks.length) * this.dimensions);

    // Append both files before the manifest: the manifest's row count is what
    // makes these rows visible, so a crash here leaves ignorable trailing bytes.
    fs.appendFileSync(this.chunksPath, jsonl, 'utf8');
    fs.appendFileSync(this.vectorsPath, Buffer.from(quantized.buffer, 0, quantized.byteLength));
    this.lastUpdatedAt = Date.now();
    if (!this.lastBuiltAt) {
      this.lastBuiltAt = this.lastUpdatedAt;
    }
    await this.flush();
  }

  /** Replace one file's chunks. Tombstone the old rows, append the new ones. */
  public async update(relPath: string, chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    await this.delete([relPath]);
    await this.insert(chunks, vectors);
  }

  public async delete(relPaths: string[]): Promise<void> {
    let touched = false;
    for (const relPath of relPaths) {
      const rows = this.byFile.get(relPath);
      if (!rows) {
        continue;
      }
      for (const row of rows) {
        if (!this.headers[row].deleted) {
          this.headers[row].deleted = true;
          this.deletedRows++;
          touched = true;
        }
      }
      this.byFile.delete(relPath);
      this.hashes.delete(relPath);
    }
    if (!touched) {
      return;
    }
    this.lastUpdatedAt = Date.now();
    // Tombstones live in memory and in the manifest until a compaction. Rewriting
    // a multi-GB chunks.jsonl on every saved file would make editing unusable.
    if (this.deletedRows > 1000 && this.deletedRows > this.headers.length / 4) {
      await this.compact();
    } else {
      await this.flush();
    }
  }

  /** Rewrite both files without the tombstoned rows. */
  public async compact(): Promise<void> {
    const keep: number[] = [];
    for (let row = 0; row < this.headers.length; row++) {
      if (!this.headers[row].deleted) {
        keep.push(row);
      }
    }

    const chunksFd = fs.openSync(this.chunksPath, 'r');
    const tmpChunks = this.chunksPath + '.tmp';
    const tmpVectors = this.vectorsPath + '.tmp';
    const outChunks = fs.openSync(tmpChunks, 'w');
    const vectors = new Int8Array(keep.length * this.dimensions);
    const headers: RowHeader[] = [];
    const byFile = new Map<string, number[]>();

    let byteOffset = 0;
    try {
      keep.forEach((row, i) => {
        const header = this.headers[row];
        const buf = Buffer.allocUnsafe(header.byteLength);
        fs.readSync(chunksFd, buf, 0, header.byteLength, header.byteOffset);
        fs.writeSync(outChunks, buf);
        fs.writeSync(outChunks, '\n');
        vectors.set(
          this.vectors.subarray(row * this.dimensions, (row + 1) * this.dimensions),
          i * this.dimensions,
        );
        headers.push({ ...header, byteOffset, deleted: false });
        const list = byFile.get(header.relPath);
        if (list) { list.push(i); } else { byFile.set(header.relPath, [i]); }
        byteOffset += header.byteLength + 1;
      });
    } finally {
      fs.closeSync(chunksFd);
      fs.closeSync(outChunks);
    }

    fs.writeFileSync(tmpVectors, Buffer.from(vectors.buffer, 0, vectors.byteLength));
    fs.renameSync(tmpChunks, this.chunksPath);
    fs.renameSync(tmpVectors, this.vectorsPath);

    this.headers = headers;
    this.byFile = byFile;
    this.capacity = keep.length;
    this.vectors = vectors;
    this.deletedRows = 0;
    await this.flush();
  }

  public async search(query: Float32Array, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (query.length !== this.dimensions) {
      throw new Error(`query width ${query.length} != index width ${this.dimensions}`);
    }
    const topK = options.topK ?? 20;
    const minSimilarity = options.minSimilarity ?? 0;

    // A bounded insertion list, not a sort of every row: at a million rows the
    // sort costs more than the scan that produced it.
    const best: Array<{ row: number; score: number }> = [];
    let worst = -Infinity;

    for (let row = 0; row < this.headers.length; row++) {
      const header = this.headers[row];
      if (header.deleted) {
        continue;
      }
      if (options.pathPrefixes && !options.pathPrefixes.some(p => header.relPath.startsWith(p))) {
        continue;
      }
      const score = dotQuantized(query, this.vectors, row * this.dimensions);
      if (score < minSimilarity || (best.length >= topK && score <= worst)) {
        continue;
      }
      insertRanked(best, { row, score }, topK);
      worst = best[best.length - 1].score;

      // Cancellation is checked per block, not per row: reading a property a
      // million times measurably outweighs the latency it saves.
      if ((row & 0x3fff) === 0 && options.signal?.aborted) {
        break;
      }
    }

    const results: SearchResult[] = [];
    for (const entry of best) {
      const chunk = this.hydrate(entry.row);
      if (!chunk) {
        continue;
      }
      if (options.languages && !options.languages.includes(chunk.language)) {
        continue;
      }
      results.push({ chunk, score: entry.score, similarity: entry.score, reasons: [] });
    }
    return results;
  }

  /** Read one chunk's JSON back from disk. Text is never held in memory. */
  private hydrate(row: number): Chunk | undefined {
    const header = this.headers[row];
    if (!header) {
      return undefined;
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.chunksPath, 'r');
      const buf = Buffer.allocUnsafe(header.byteLength);
      fs.readSync(fd, buf, 0, header.byteLength, header.byteOffset);
      return JSON.parse(buf.toString('utf8')) as Chunk;
    } catch {
      return undefined; // a row we cannot read is a row we skip, not a failed search
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  public async clear(): Promise<void> {
    this.headers = [];
    this.vectors = new Int8Array(0);
    this.capacity = 0;
    this.hashes.clear();
    this.byFile.clear();
    this.deletedRows = 0;
    this.lastBuiltAt = 0;
    this.lastUpdatedAt = 0;
    for (const file of [this.vectorsPath, this.chunksPath, this.manifestPath]) {
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
  }

  public async flush(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const manifest = {
      version: INDEX_VERSION,
      model: this.model,
      dimensions: this.dimensions,
      rows: this.headers.length,
      deleted: this.deletedRows,
      files: this.byFile.size,
      lastBuiltAt: this.lastBuiltAt,
      lastUpdatedAt: this.lastUpdatedAt,
    };
    // Rename over the old manifest so it is never observed half-written.
    const tmp = this.manifestPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, this.manifestPath);
  }

  public async stats(): Promise<IndexStats> {
    const size = (file: string) => {
      try { return fs.statSync(file).size; } catch { return 0; }
    };
    return {
      version: INDEX_VERSION,
      files: this.byFile.size,
      chunks: this.headers.length - this.deletedRows,
      vectors: this.headers.length - this.deletedRows,
      dimensions: this.dimensions,
      bytes: size(this.vectorsPath) + size(this.chunksPath),
      lastBuiltAt: this.lastBuiltAt,
      lastUpdatedAt: this.lastUpdatedAt,
      model: this.model,
    };
  }

  public fileHash(relPath: string): string | undefined {
    return this.hashes.get(relPath);
  }

  public indexedFiles(): string[] {
    return [...this.byFile.keys()];
  }
}

/** Thrown when the chunk ceiling is hit, so callers can report it as a state. */
export class IndexFullError extends Error {}

/** Insert into a descending-score list capped at `limit`. */
function insertRanked<T extends { score: number }>(list: T[], item: T, limit: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].score > item.score) { lo = mid + 1; } else { hi = mid; }
  }
  list.splice(lo, 0, item);
  if (list.length > limit) {
    list.pop();
  }
}

/**
 * Everything in RAM, nothing on disk. This is the test double — it exists so the
 * search and ranking logic can be tested without a provider or a filesystem,
 * not as a second product-grade backend.
 */
export class MemoryVectorStore implements VectorStore {
  private rows: Array<{ chunk: Chunk; vector: Float32Array }> = [];

  constructor(public readonly dimensions: number) {}

  public async insert(chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    chunks.forEach((chunk, i) => this.rows.push({ chunk, vector: vectors[i] }));
  }

  public async update(relPath: string, chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    await this.delete([relPath]);
    await this.insert(chunks, vectors);
  }

  public async delete(relPaths: string[]): Promise<void> {
    const drop = new Set(relPaths);
    this.rows = this.rows.filter(r => !drop.has(r.chunk.relPath));
  }

  public async search(query: Float32Array, options: SearchOptions = {}): Promise<SearchResult[]> {
    const topK = options.topK ?? 20;
    const minSimilarity = options.minSimilarity ?? 0;
    return this.rows
      .filter(r => !options.pathPrefixes || options.pathPrefixes.some(p => r.chunk.relPath.startsWith(p)))
      .filter(r => !options.languages || options.languages.includes(r.chunk.language))
      .map(r => ({ chunk: r.chunk, score: dot(query, r.vector), similarity: dot(query, r.vector), reasons: [] }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  public async clear(): Promise<void> { this.rows = []; }
  public async flush(): Promise<void> { /* nothing to persist */ }

  public async stats(): Promise<IndexStats> {
    return {
      version: INDEX_VERSION,
      files: new Set(this.rows.map(r => r.chunk.relPath)).size,
      chunks: this.rows.length,
      vectors: this.rows.length,
      dimensions: this.dimensions,
      bytes: 0,
      lastBuiltAt: 0,
      lastUpdatedAt: 0,
      model: 'memory',
    };
  }

  public fileHash(relPath: string): string | undefined {
    return this.rows.find(r => r.chunk.relPath === relPath)?.chunk.fileHash;
  }

  public indexedFiles(): string[] {
    return [...new Set(this.rows.map(r => r.chunk.relPath))];
  }
}
