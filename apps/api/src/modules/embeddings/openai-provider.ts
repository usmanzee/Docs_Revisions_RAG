/**
 * OpenAI embedding provider.
 *
 * Cost and reliability controls live here rather than at call sites:
 *   * batches are capped at MAX_EMBEDDING_BATCH_SIZE;
 *   * concurrent requests are capped at OPENAI_REQUEST_CONCURRENCY;
 *   * inputs longer than the model's context are truncated before sending,
 *     because a single over-long chunk would otherwise fail an entire batch;
 *   * retries use exponential backoff with jitter, and give up immediately on
 *     errors that will never succeed (bad key, bad request).
 */

import OpenAI from 'openai';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { chunkArray, mapWithConcurrency, retry } from '../../utils/async.js';
import { ConfigurationError, EmbeddingError, toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { truncateToTokens } from '../../utils/tokens.js';
import type { EmbeddingProvider, EmbeddingResult } from './types.js';

/** HTTP statuses where retrying can plausibly succeed. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return error.status === undefined || RETRYABLE_STATUSES.has(error.status);
  }
  // Network-level failures carry no status and are worth retrying.
  return true;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly semantic = true;
  readonly model: string;
  readonly dimensions: number;

  private readonly client: OpenAI;
  private readonly logger = childLogger({ component: 'embeddings', provider: 'openai' });

  constructor(private readonly config: AppConfig = getConfig()) {
    if (!config.openai.apiKey) {
      throw new ConfigurationError(
        'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai. ' +
          'Set the key, or use EMBEDDING_PROVIDER=mock for infrastructure testing.',
      );
    }

    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;

    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
      ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
      timeout: config.openai.requestTimeoutMs,
      // Retries are handled here so they can be logged and bounded consistently
      // with the rest of the pipeline.
      maxRetries: 0,
    });
  }

  private prepare(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // The API rejects empty input; a single space preserves batch alignment
      // so results still map one-to-one onto the chunks that were sent.
      return ' ';
    }
    return truncateToTokens(trimmed, this.config.embedding.inputMaxTokens);
  }

  private async embedBatch(texts: readonly string[]): Promise<{ vectors: number[][]; tokens: number }> {
    const response = await retry(
      async () =>
        this.client.embeddings.create({
          model: this.model,
          input: texts as string[],
          // Explicit dimensions keep the vector width pinned to the schema even
          // if the default for a model changes.
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
      {
        retries: this.config.openai.retryLimit,
        baseDelayMs: 750,
        shouldRetry: (error) => isRetryable(error),
        onRetry: (error, attempt, delayMs) => {
          this.logger.warn(
            { attempt, delayMs, err: { message: toErrorMessage(error) } },
            'retrying embedding request',
          );
        },
      },
    );

    // The API does not guarantee ordering, but it does return an index.
    const vectors = new Array<number[]>(texts.length);
    for (const item of response.data) {
      vectors[item.index] = item.embedding;
    }

    for (const [index, vector] of vectors.entries()) {
      if (!vector) throw new EmbeddingError(`embedding response is missing index ${index}`);
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(
          `model "${this.model}" returned ${vector.length} dimensions but EMBEDDING_DIMENSIONS=${this.dimensions}`,
        );
      }
    }

    return { vectors, tokens: response.usage?.total_tokens ?? 0 };
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { embeddings: [], tokens: 0, model: this.model, requests: 0 };
    }

    const prepared = texts.map((text) => this.prepare(text));
    const batches = chunkArray(prepared, this.config.embedding.maxBatchSize);

    const results = await mapWithConcurrency(
      batches,
      this.config.openai.requestConcurrency,
      async (batch) => this.embedBatch(batch),
    );

    return {
      embeddings: results.flatMap((result) => result.vectors),
      tokens: results.reduce((total, result) => total + result.tokens, 0),
      model: this.model,
      requests: batches.length,
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.embedBatch([this.prepare(text)]);
    const vector = result.vectors[0];
    if (!vector) throw new EmbeddingError('query embedding returned no vector');
    return vector;
  }
}
