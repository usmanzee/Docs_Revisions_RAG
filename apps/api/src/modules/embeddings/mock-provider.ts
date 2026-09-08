/**
 * Deterministic mock embedding provider.
 *
 * ⚠️  THESE VECTORS ARE NOT SEMANTICALLY MEANINGFUL.
 *
 * They exist so the ingestion pipeline, pgvector indexing, batching, query
 * paths and benchmarks can be exercised at scale without spending money on a
 * corpus that is being used to test infrastructure rather than answer quality.
 * Retrieval-quality numbers produced with this provider are meaningless and the
 * evaluation runner refuses to report them as if they were real.
 *
 * The construction is a hashing vectoriser: each token is hashed into a small
 * number of dimensions with a signed weight, then the vector is L2-normalised.
 * That gives two useful properties - identical text always produces an
 * identical vector, and lexically overlapping text produces measurably closer
 * vectors - without ever pretending to encode meaning.
 */

import { normalizeForComparison } from '../../utils/text.js';
import type { EmbeddingProvider, EmbeddingResult } from './types.js';

/** Dimensions each token contributes to. More gives a smoother distribution. */
const HASHES_PER_TOKEN = 4;

function hashToken(token: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class DeterministicMockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-mock';
  readonly semantic = false;

  constructor(readonly dimensions: number) {}

  private vectorFor(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = normalizeForComparison(text).split(' ').filter((token) => token.length > 0);

    if (tokens.length === 0) {
      // A zero vector has no direction, and cosine distance against it is
      // undefined. Anchor empty input to a fixed, arbitrary direction instead.
      vector[0] = 1;
      return vector;
    }

    // Sub-linear term weighting, as a lexical model would use: a word repeated
    // twenty times should not dominate a chunk's direction.
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [token, count] of counts) {
      const weight = 1 + Math.log(count);
      for (let salt = 0; salt < HASHES_PER_TOKEN; salt += 1) {
        const hash = hashToken(token, salt);
        const index = hash % this.dimensions;
        // Sign from a spare bit, so unrelated tokens cancel rather than
        // accumulate into a single positive blob.
        const sign = (hash >>> 31) === 0 ? 1 : -1;
        vector[index] = (vector[index] as number) + sign * weight;
      }
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }

    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] as number) / norm;
    }
    return vector;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return {
      embeddings: texts.map((text) => this.vectorFor(text)),
      // Rough token estimate so job accounting has a comparable figure.
      tokens: texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0),
      model: this.model,
      requests: 0,
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorFor(text);
  }
}
