/**
 * Reranker abstraction.
 *
 * The baseline is a no-op: the MVP must not depend on a second paid service,
 * and a cross-encoder that is not measured is not an improvement. The interface
 * exists so a real reranker can be introduced later and evaluated against the
 * same gold dataset that measures the current pipeline.
 */

import type { RetrievalCandidate } from './types.js';

export interface Reranker {
  readonly name: string;
  /**
   * Reorder candidates for a query. Implementations may also trim the list.
   * The returned candidates carry a `rerankScore` when the reranker produced one.
   */
  rerank(query: string, candidates: RetrievalCandidate[], limit: number): Promise<RetrievalCandidate[]>;
}

/** Preserves fusion order and simply applies the limit. */
export class NoopReranker implements Reranker {
  readonly name = 'noop';

  async rerank(_query: string, candidates: RetrievalCandidate[], limit: number): Promise<RetrievalCandidate[]> {
    return candidates.slice(0, limit);
  }
}

export function createReranker(kind: 'noop'): Reranker {
  switch (kind) {
    case 'noop':
      return new NoopReranker();
  }
}
