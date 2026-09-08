/**
 * pgvector serialisation helpers.
 *
 * node-postgres has no native codec for the `vector` type, so embeddings cross
 * the wire as the textual literal pgvector accepts: `[0.1,0.2,...]`. Keeping
 * this in one file means no other module has to know that detail - and no other
 * module is tempted to build the literal by string concatenation at a call site
 * where a stray value could become SQL.
 */

import { EmbeddingError } from '../utils/errors.js';

/** Serialise an embedding into the pgvector text literal. */
export function toVectorLiteral(embedding: readonly number[]): string {
  const parts = new Array<string>(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    const value = embedding[i] as number;
    if (!Number.isFinite(value)) {
      throw new EmbeddingError(`embedding contains a non-finite value at index ${i}`);
    }
    // Trim float noise; pgvector stores float4 so extra precision is discarded
    // anyway, and shorter literals mean smaller INSERT payloads.
    parts[i] = value.toFixed(7).replace(/\.?0+$/, '');
  }
  return `[${parts.join(',')}]`;
}

/** Parse a pgvector literal returned as text. */
export function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new EmbeddingError(`malformed vector literal: ${trimmed.slice(0, 40)}`);
  }
  const body = trimmed.slice(1, -1);
  if (body.length === 0) return [];
  return body.split(',').map((part) => Number(part));
}

export function assertDimensions(embedding: readonly number[], expected: number, context: string): void {
  if (embedding.length !== expected) {
    throw new EmbeddingError(
      `${context}: expected ${expected}-dimensional embedding, received ${embedding.length}. ` +
        'EMBEDDING_DIMENSIONS must match both the embedding model and the dimension baked into the schema.',
    );
  }
}

/** Cosine similarity, used by tests and the deterministic mock provider. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new EmbeddingError('cosine similarity requires equal dimensions');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
