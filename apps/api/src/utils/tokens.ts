/**
 * Token counting.
 *
 * Uses the o200k_base tokenizer (GPT-4o / GPT-4.1 family). Counting is on the
 * hot path for chunking, so results are memoised for short strings and an
 * approximation is used above a size where exactness stops mattering.
 */

import { encode } from 'gpt-tokenizer/encoding/o200k_base';

const CACHE_LIMIT = 4000;
const CACHE_MAX_INPUT_LENGTH = 2000;
const cache = new Map<string, number>();

/** Characters-per-token ratio used for the cheap path on very long strings. */
const APPROX_CHARS_PER_TOKEN = 3.8;

export function countTokens(text: string): number {
  if (text.length === 0) return 0;

  if (text.length > 20_000) {
    // Exact counting on very long strings costs more than it is worth; the
    // chunker never operates on units this large.
    return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
  }

  if (text.length <= CACHE_MAX_INPUT_LENGTH) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const count = encode(text).length;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(text, count);
    return count;
  }

  return encode(text).length;
}

/** Truncate to a token budget, cutting on a whitespace boundary when possible. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (countTokens(text) <= maxTokens) return text;

  // Binary search on characters - far cheaper than repeatedly re-encoding a
  // shrinking string one token at a time.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }

  const cut = text.slice(0, low);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > low * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

export function clearTokenCache(): void {
  cache.clear();
}
