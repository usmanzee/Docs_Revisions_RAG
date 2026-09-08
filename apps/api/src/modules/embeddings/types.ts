/**
 * Embedding provider abstraction.
 *
 * Ingestion and retrieval depend on this interface rather than on OpenAI, which
 * is what allows a 5,000-document scale test to run against deterministic local
 * vectors without touching a paid API - and allows the provider to be swapped
 * later without reworking the pipeline.
 */

export interface EmbeddingResult {
  embeddings: number[][];
  /** Tokens billed, where the provider reports them. */
  tokens: number;
  model: string;
  /** Number of upstream requests made, for cost accounting. */
  requests: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /**
   * True when embeddings from this provider carry real semantic meaning.
   * False for the deterministic mock, which exists only for infrastructure
   * testing - evaluation refuses to report quality metrics when this is false.
   */
  readonly semantic: boolean;

  /** Embed a batch. Order of results matches order of inputs. */
  embed(texts: readonly string[]): Promise<EmbeddingResult>;

  /**
   * Embed a single search query. Kept separate because some models use a
   * different prefix or endpoint for queries than for documents.
   */
  embedQuery(text: string): Promise<number[]>;
}
