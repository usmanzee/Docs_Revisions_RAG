/** Small async primitives used across ingestion, embedding and evaluation. */

import pLimit from 'p-limit';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Map with bounded concurrency, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(items.map((item, index) => limit(() => mapper(item, index))));
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast on errors that will never succeed (e.g. 401). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with full jitter. */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, baseDelayMs = 500, maxDelayMs = 20_000, shouldRetry, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      if (shouldRetry && !shouldRetry(error, attempt)) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.floor(Math.random() * ceiling);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Reject if a promise has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Split a list into fixed-size batches (embedding batching, bulk inserts). */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('batch size must be positive');
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Wall-clock duration of an async operation, in milliseconds. */
export async function timed<T>(operation: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await operation();
  return { result, ms: Math.round(performance.now() - started) };
}
