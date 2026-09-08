/**
 * Reciprocal Rank Fusion.
 *
 * Combines several ranked lists without needing their scores to be comparable -
 * which matters here because pgvector returns cosine similarity in [-1, 1] and
 * `ts_rank_cd` returns an unbounded relevance figure whose scale depends on the
 * query. Normalising those onto a common scale requires assumptions that break
 * the moment a query is unusual; RRF only uses *position*, so it is robust to
 * exactly the cases where score normalisation misleads.
 *
 *     score(d) = Σ_lists  weight_list / (k + rank_list(d))
 *
 * `k` damps the contribution of top ranks: a larger k flattens the curve so a
 * document must appear in several lists to win, a smaller k lets a single
 * first-place finish dominate. 60 is the value from the original Cormack et al.
 * paper and a sane default, but it is configurable because the right value
 * depends on candidate-list length.
 */

export interface RankedItem {
  id: string;
  /** Source score, retained for debugging - it does not affect fusion. */
  score: number;
}

export interface RankedList<T extends RankedItem = RankedItem> {
  /** Identifies the source in debug output, e.g. "vector", "lexical". */
  name: string;
  items: T[];
  /** Relative influence of this list. Defaults to 1. */
  weight?: number;
}

export interface FusedItem {
  id: string;
  rrfScore: number;
  /** 1-based rank in each list that contained this item. */
  ranks: Record<string, number>;
  /** Original score from each list that contained this item. */
  scores: Record<string, number>;
  /** Number of lists that surfaced this item. */
  sources: number;
}

export interface RrfOptions {
  k?: number;
  limit?: number;
}

export const DEFAULT_RRF_K = 60;

/**
 * Fuse ranked lists. Items are returned in descending fused score.
 *
 * Ties are broken by the number of contributing lists (agreement across
 * retrieval strategies is a genuine signal) and then by id, so the ordering is
 * deterministic - which matters for reproducible evaluation runs.
 */
export function reciprocalRankFusion<T extends RankedItem>(
  lists: readonly RankedList<T>[],
  options: RrfOptions = {},
): FusedItem[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (k <= 0) throw new Error('RRF k must be positive');

  const fused = new Map<string, FusedItem>();

  for (const list of lists) {
    const weight = list.weight ?? 1;

    for (const [index, item] of list.items.entries()) {
      const rank = index + 1;
      const contribution = weight / (k + rank);

      const existing = fused.get(item.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.ranks[list.name] = rank;
        existing.scores[list.name] = item.score;
        existing.sources += 1;
        continue;
      }

      fused.set(item.id, {
        id: item.id,
        rrfScore: contribution,
        ranks: { [list.name]: rank },
        scores: { [list.name]: item.score },
        sources: 1,
      });
    }
  }

  const ordered = [...fused.values()].sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    if (b.sources !== a.sources) return b.sources - a.sources;
    return a.id.localeCompare(b.id);
  });

  return options.limit === undefined ? ordered : ordered.slice(0, options.limit);
}
