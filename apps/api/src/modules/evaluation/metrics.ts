/**
 * Retrieval metrics.
 *
 * Recall@k and MRR are computed over *documents*, not chunks: the question is
 * whether the system found the right document, and a corpus that chunks a
 * policy into ten pieces should not be penalised for surfacing the second-best
 * chunk of the right document first.
 *
 * "Correct" additionally requires the current revision. A retriever that
 * confidently returns the superseded answer has failed at the thing this system
 * exists to get right, and a metric that scored it as a hit would hide that.
 */

import type { RetrievalEvaluationMetrics } from '@docs-rag/shared';
import type { RetrievalQuestionResult } from './types.js';

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method: unambiguous and stable for small samples.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summariseRetrieval(results: readonly RetrievalQuestionResult[]): RetrievalEvaluationMetrics {
  const answerable = results.filter((result) => !result.isNoAnswer);
  const noAnswer = results.filter((result) => result.isNoAnswer);
  const latencies = results.map((result) => result.latencyMs);

  const revisionScored = answerable.filter((result) => result.revisionCorrect !== null);

  return {
    questionCount: results.length,
    answerableCount: answerable.length,
    noAnswerCount: noAnswer.length,
    recallAt1: ratio(answerable.filter((result) => result.recallAt1).length, answerable.length),
    recallAt3: ratio(answerable.filter((result) => result.recallAt3).length, answerable.length),
    recallAt5: ratio(answerable.filter((result) => result.recallAt5).length, answerable.length),
    mrr: mean(answerable.map((result) => result.reciprocalRank)),
    sectionAccuracy: ratio(answerable.filter((result) => result.sectionHit).length, answerable.length),
    currentRevisionAccuracy: ratio(
      revisionScored.filter((result) => result.revisionCorrect === true).length,
      revisionScored.length,
    ),
    noAnswerBehaviour: ratio(
      noAnswer.filter((result) => result.refusedCorrectly === true).length,
      noAnswer.length,
    ),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      mean: Math.round(mean(latencies)),
    },
  };
}

export interface QuestionTypeSummary {
  count: number;
  /** Questions in this group that have a correct document to find. */
  answerable: number;
  recallAt5: number;
  mrr: number;
  /** Refusal rate, meaningful only for the NO_ANSWER group. */
  refusalRate: number;
}

export function summariseByQuestionType(
  results: readonly RetrievalQuestionResult[],
): Record<string, QuestionTypeSummary> {
  const groups = new Map<string, RetrievalQuestionResult[]>();

  for (const result of results) {
    const bucket = groups.get(result.questionType) ?? [];
    bucket.push(result);
    groups.set(result.questionType, bucket);
  }

  const summary: Record<string, QuestionTypeSummary> = {};

  for (const [type, bucket] of groups) {
    // NO_ANSWER questions have no correct document by construction, so recall
    // is undefined for them rather than zero. The distinction matters: a 0%
    // recall row reads as a failure when it is simply not the right measure.
    const answerable = bucket.filter((result) => !result.isNoAnswer);
    const noAnswer = bucket.filter((result) => result.isNoAnswer);

    summary[type] = {
      count: bucket.length,
      answerable: answerable.length,
      recallAt5: ratio(answerable.filter((result) => result.recallAt5).length, answerable.length),
      mrr: mean(answerable.map((result) => result.reciprocalRank)),
      refusalRate: ratio(noAnswer.filter((result) => result.refusedCorrectly === true).length, noAnswer.length),
    };
  }

  return summary;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
