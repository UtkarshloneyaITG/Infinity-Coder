import { EmbeddingProvider } from './types';

/**
 * Embedding providers.
 *
 * There is one implementation, not five. OpenAI, NVIDIA NIM, Ollama,
 * llama.cpp's server and every "OpenAI-compatible endpoint" all accept
 * `POST {baseUrl}/embeddings` with `{ model, input: string[] }` and return
 * `{ data: [{ embedding: number[] }] }`. A class per vendor would be five
 * copies of this file differing only in a base URL the user already configures.
 *
 * Anything that does NOT speak that shape implements EmbeddingProvider directly
 * — that is what the interface is for.
 */

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Providers cap batch size and total tokens per request. 96 is what OpenAI,
   * NIM and Ollama all accept comfortably; larger batches start returning 400s
   * that look like model errors.
   */
  batchSize?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Provider said no in a way that is worth surfacing rather than retrying blind. */
export class EmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  public readonly id: string;
  public readonly model: string;
  public readonly batchSize: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Discovered from the first response, never configured. The same model id
   * returns different widths across providers, and a wrong guess would corrupt
   * every vector in the store without erroring.
   */
  private dims = 0;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.batchSize = opts.batchSize ?? 96;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  public get dimensions(): number {
    return this.dims;
  }

  public async embed(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text], signal);
    return vector;
  }

  public async embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...await this.request(texts.slice(i, i + this.batchSize), signal));
    }
    return out;
  }

  private async request(batch: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    // An empty string embeds to garbage on some providers and 400s on others.
    const input = batch.map(t => (t.trim() ? t : ' '));

    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input, encoding_format: 'float' }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new EmbeddingError(
        `Embedding request failed (${response.status}): ${detail.slice(0, 300)}`,
        response.status,
      );
    }

    const body = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = body.data;
    if (!Array.isArray(rows) || rows.length !== input.length) {
      throw new EmbeddingError(
        `Embedding response had ${rows?.length ?? 0} vectors for ${input.length} inputs`,
      );
    }

    // `index` is authoritative: providers are permitted to return out of order,
    // and a silent mis-ordering here would attach every vector to the wrong chunk.
    const ordered = rows.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    return ordered.map(row => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new EmbeddingError('Embedding response contained an empty vector');
      }
      if (this.dims === 0) {
        this.dims = row.embedding.length;
      } else if (row.embedding.length !== this.dims) {
        throw new EmbeddingError(
          `Model changed width mid-index (${this.dims} then ${row.embedding.length}). ` +
          'Rebuild the index after changing the embedding model.',
        );
      }
      return normalize(Float32Array.from(row.embedding));
    });
  }
}

/**
 * Unit-length vectors, so cosine similarity is a plain dot product at query
 * time. Doing it once here removes a sqrt and a division from every one of the
 * millions of comparisons a search performs.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i];
  }
  const length = Math.sqrt(sum);
  if (length === 0) {
    return vector; // a zero vector has no direction; leave it rather than divide by 0
  }
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i] / length;
  }
  return vector;
}

/** Dot product. Valid as cosine similarity only for normalized inputs. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
