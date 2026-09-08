/**
 * Context assembly.
 *
 * Retrieval returns the most relevant chunks; this decides what actually
 * reaches the model. Three problems have to be solved before generation:
 *
 *   1. Redundancy. Overlapping chunks and near-duplicate documents mean the
 *      same paragraph can arrive three times. Sending it three times wastes
 *      budget and, worse, makes the model treat repetition as corroboration.
 *   2. Fragmentation. Adjacent chunks from one section read better - and are
 *      cited more accurately - when merged back into one passage.
 *   3. Budget. The context has a hard token ceiling, and it must be spent on
 *      the highest-ranked material rather than truncated arbitrarily at the end.
 *
 * Every citation is built from the chunk rows themselves. The model is never
 * asked to produce citation metadata, so it cannot invent a page number.
 */

import type { Citation } from '@docs-rag/shared';
import { countTokens } from '../../utils/tokens.js';
import { buildExcerpt, containmentRatio } from '../../utils/text.js';
import type { BuiltContext, RetrievalCandidate } from './types.js';

/**
 * Above this containment, a candidate says nothing the already-selected text
 * does not. Chosen empirically: chunk overlap produces ratios around 0.3-0.5,
 * while genuine duplicates and near-duplicate documents land above 0.85.
 */
const DUPLICATE_CONTAINMENT_THRESHOLD = 0.85;

/** Tokens reserved for the per-source headers written into the context. */
const SOURCE_HEADER_TOKENS = 40;

export interface ContextBuilderOptions {
  tokenBudget: number;
  maxChunks: number;
  /** Merge chunks that were adjacent in the source document. */
  mergeAdjacent?: boolean;
}

/** Drop candidates already covered by higher-ranked ones. */
export function deduplicateCandidates(candidates: readonly RetrievalCandidate[]): RetrievalCandidate[] {
  const kept: RetrievalCandidate[] = [];
  const seenChunkIds = new Set<string>();

  for (const candidate of candidates) {
    if (seenChunkIds.has(candidate.chunkId)) continue;

    // A parent expansion can swallow a sibling that is also in the list.
    const covered = kept.some((existing) => {
      if (existing.revisionId !== candidate.revisionId) {
        // Across documents, only near-identical text counts as duplication -
        // that is the near-duplicate document case.
        return containmentRatio(candidate.content, existing.content) >= DUPLICATE_CONTAINMENT_THRESHOLD;
      }
      return containmentRatio(candidate.content, existing.content) >= DUPLICATE_CONTAINMENT_THRESHOLD;
    });

    if (covered) continue;

    seenChunkIds.add(candidate.chunkId);
    kept.push(candidate);
  }

  return kept;
}

/**
 * Merge candidates that were neighbours in the same revision.
 *
 * Only strictly adjacent chunk indices are merged, and only when the result
 * stays within the per-source ceiling, so a merge never quietly turns two
 * sections into one citation.
 */
export function mergeAdjacentCandidates(
  candidates: readonly RetrievalCandidate[],
  maxTokens: number,
): RetrievalCandidate[] {
  if (candidates.length < 2) return [...candidates];

  // Preserve ranking: merging is applied to a document-ordered copy, then the
  // result is re-sorted by the best score of its constituents.
  const byRevision = new Map<string, RetrievalCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byRevision.get(candidate.revisionId) ?? [];
    bucket.push(candidate);
    byRevision.set(candidate.revisionId, bucket);
  }

  const merged: RetrievalCandidate[] = [];

  for (const bucket of byRevision.values()) {
    bucket.sort((a, b) => a.chunkIndex - b.chunkIndex);

    let current: RetrievalCandidate | null = null;

    for (const candidate of bucket) {
      if (!current) {
        current = { ...candidate };
        continue;
      }

      const adjacent = candidate.chunkIndex === current.chunkIndex + 1;
      const sameSection = candidate.sectionTitle === current.sectionTitle;
      const fits = current.tokenCount + candidate.tokenCount <= maxTokens;

      if (adjacent && sameSection && fits) {
        current = {
          ...current,
          content: `${current.content}\n\n${candidate.content}`,
          tokenCount: current.tokenCount + candidate.tokenCount,
          chunkIndex: candidate.chunkIndex,
          pageEnd: candidate.pageEnd ?? current.pageEnd,
          // Keep the stronger score so merging cannot demote a passage.
          score: Math.max(current.score, candidate.score),
        };
        continue;
      }

      merged.push(current);
      current = { ...candidate };
    }

    if (current) merged.push(current);
  }

  return merged.sort((a, b) => b.score - a.score);
}

/** Header written above each source, so the model can attribute claims. */
function formatSourceHeader(index: number, candidate: RetrievalCandidate): string {
  const parts = [
    `[${index}] ${candidate.documentCode} - ${candidate.documentTitle}`,
    `Revision ${candidate.revisionNumber}${candidate.effectiveDate ? `, effective ${candidate.effectiveDate}` : ''}`,
  ];
  if (candidate.sectionTitle) parts.push(`Section: ${candidate.headingPath ?? candidate.sectionTitle}`);
  if (candidate.pageStart) {
    parts.push(
      candidate.pageEnd && candidate.pageEnd !== candidate.pageStart
        ? `Pages ${candidate.pageStart}-${candidate.pageEnd}`
        : `Page ${candidate.pageStart}`,
    );
  }
  if (candidate.extractionMethod === 'OCR') parts.push('Source text recovered by OCR');
  if (!candidate.isCurrent) parts.push('SUPERSEDED REVISION');
  return parts.join(' | ');
}

export function candidateToCitation(index: number, candidate: RetrievalCandidate): Citation {
  return {
    index,
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    revisionId: candidate.revisionId,
    documentCode: candidate.documentCode,
    documentTitle: candidate.documentTitle,
    revision: candidate.revisionNumber,
    page: candidate.pageStart,
    section: candidate.sectionTitle,
    subsection: candidate.subsectionTitle,
    effectiveDate: candidate.effectiveDate,
    excerpt: buildExcerpt(candidate.content, 320),
    extractionMethod: candidate.extractionMethod,
    score: Number(candidate.score.toFixed(6)),
  };
}

export function buildContext(
  candidates: readonly RetrievalCandidate[],
  options: ContextBuilderOptions,
): BuiltContext {
  const deduped = deduplicateCandidates(candidates);
  const prepared =
    options.mergeAdjacent === false
      ? deduped
      : mergeAdjacentCandidates(deduped, Math.max(600, Math.floor(options.tokenBudget / 3)));

  const included: RetrievalCandidate[] = [];
  const blocks: string[] = [];
  const citations: Citation[] = [];

  let used = 0;

  for (const candidate of prepared) {
    if (included.length >= options.maxChunks) break;

    const cost = candidate.tokenCount + SOURCE_HEADER_TOKENS;
    if (used + cost > options.tokenBudget) {
      // Keep scanning: a smaller, lower-ranked passage may still fit, and using
      // the remaining budget is better than leaving it unspent.
      continue;
    }

    const index = included.length + 1;
    blocks.push(`${formatSourceHeader(index, candidate)}\n${candidate.content}`);
    citations.push(candidateToCitation(index, candidate));
    included.push(candidate);
    used += cost;
  }

  const text = blocks.join('\n\n---\n\n');

  return { text, citations, tokenCount: countTokens(text), included };
}
