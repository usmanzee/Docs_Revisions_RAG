/**
 * Content hashing.
 *
 * `file_hash`    - SHA-256 of raw bytes. Answers "is this the same file?".
 * `content_hash` - SHA-256 of normalised extracted text. Answers "did the
 *                  meaning change?", which survives cosmetic re-exports of the
 *                  same document (different PDF producer, new timestamp, etc.).
 */

import { createHash } from 'node:crypto';

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Normalise text before hashing so irrelevant whitespace/casing differences do
 * not look like content changes.
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLowerCase();
}

export function contentHash(text: string): string {
  return sha256(normalizeForHash(text));
}

/** Short, human-friendly hash prefix for log lines and UI badges. */
export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
