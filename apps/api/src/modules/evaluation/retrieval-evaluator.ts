/**
 * Retrieval evaluation runner.
 *
 * Reads the gold dataset written beside the corpus and scores retrieval against
 * it. Refuses to present quality numbers when the mock embedding provider is in
 * use - the numbers would be a measure of lexical hashing, and reporting them
 * as retrieval quality would be the exact dishonesty this project is meant to
 * avoid.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { queryOne, type Queryable } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import type { EmbeddingProvider } from '../embeddings/index.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { RetrievalCandidate } from '../retrieval/types.js';
import { summariseByQuestionType, summariseRetrieval } from './metrics.js';
import type {
  GoldDataset,
  GoldQuestion,
  RetrievalEvaluationReport,
  RetrievalQuestionResult,
} from './types.js';

export function evaluationDatasetPath(config: AppConfig = getConfig()): string {
  return path.join(config.repoRoot, 'data', 'evaluation', 'questions.json');
}

export async function loadGoldDataset(filePath?: string, config: AppConfig = getConfig()): Promise<GoldDataset> {
  const target = filePath ?? evaluationDatasetPath(config);

  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    throw new AppError(
      'NOT_FOUND',
      `No evaluation dataset at ${target}. Generate one with:\n` +
        '  npm run corpus:generate -- --profile=quality --count=75 --seed=123',
    );
  }

  const parsed = JSON.parse(raw) as GoldDataset;
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new AppError('VALIDATION_ERROR', `evaluation dataset at ${target} contains no questions`);
  }
  return parsed;
}

/**
 * Is a retrieved chunk a correct answer to this question?
 *
 * Both the document and the revision must match. `expectedRevision` is the
 * revision that should be current at evaluation time, so a hit on a superseded
 * revision is scored as a miss - deliberately.
 */
function isCorrect(candidate: RetrievalCandidate, question: GoldQuestion): boolean {
  if (candidate.documentCode !== question.expectedDocumentCode) return false;
  if (question.expectedRevision !== null && candidate.revisionNumber !== question.expectedRevision) return false;
  return true;
}

function sectionMatches(candidate: RetrievalCandidate, question: GoldQuestion): boolean {
  if (!question.expectedSection) return false;
  const expected = question.expectedSection.toLowerCase();
  const heading = `${candidate.sectionTitle ?? ''} ${candidate.subsectionTitle ?? ''} ${candidate.headingPath ?? ''}`.toLowerCase();
  return heading.includes(expected);
}

export interface RetrievalEvaluatorDependencies {
  retrieval: RetrievalService;
  embeddings: EmbeddingProvider;
  db?: Queryable;
  config?: AppConfig;
}

export interface RunRetrievalEvaluationOptions {
  dataset: GoldDataset;
  /** Evaluate only the first N questions. */
  limit?: number;
  /** Persist the run into evaluation_runs / evaluation_results. */
  persist?: boolean;
  /** Report metrics even with non-semantic embeddings (never the default). */
  allowNonSemantic?: boolean;
}

export class RetrievalEvaluator {
  private readonly logger = childLogger({ component: 'evaluation' });
  private readonly config: AppConfig;

  constructor(private readonly deps: RetrievalEvaluatorDependencies) {
    this.config = deps.config ?? getConfig();
  }

  async run(options: RunRetrievalEvaluationOptions): Promise<RetrievalEvaluationReport> {
    if (!this.deps.embeddings.semantic && !options.allowNonSemantic) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Retrieval evaluation was requested with the deterministic mock embedding provider.\n' +
          'Those vectors are not semantically meaningful, so recall and MRR computed from them are not\n' +
          'retrieval-quality results and must not be reported as such.\n\n' +
          'Either set EMBEDDING_PROVIDER=openai and re-ingest, or pass --allow-non-semantic to run the\n' +
          'harness for plumbing purposes only.',
      );
    }

    const questions = options.limit ? options.dataset.questions.slice(0, options.limit) : options.dataset.questions;
    const results: RetrievalQuestionResult[] = [];

    for (const question of questions) {
      results.push(await this.evaluateQuestion(question));
    }

    const metrics = summariseRetrieval(results);
    const runId = options.persist ? await this.persist(metrics, results) : null;

    return {
      metrics,
      results,
      byQuestionType: summariseByQuestionType(results),
      embeddingProvider: this.deps.embeddings.name,
      embeddingModel: this.deps.embeddings.model,
      semantic: this.deps.embeddings.semantic,
      corpusProfile: options.dataset.profile,
      runId,
    };
  }

  private async evaluateQuestion(question: GoldQuestion): Promise<RetrievalQuestionResult> {
    const started = performance.now();

    const retrieved = await this.deps.retrieval.retrieve({
      query: question.question,
      source: 'EVALUATION',
      log: false,
      // Deeper than the chat path: recall@5 cannot be measured from 8 chunks
      // once several belong to the same document.
      limit: Math.max(10, this.config.retrieval.finalContextChunks),
    });

    const latencyMs = Math.round(performance.now() - started);
    const candidates = retrieved.selected;

    // Rank by document, not by chunk: the second chunk of the right document is
    // still the right document at rank 1.
    const documentRanks: string[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.documentCode}#${candidate.revisionNumber}`;
      if (!documentRanks.includes(key)) documentRanks.push(key);
    }

    const hitIndex = question.isNoAnswer
      ? -1
      : documentRanks.findIndex((key) => {
          const candidate = candidates.find(
            (entry) => `${entry.documentCode}#${entry.revisionNumber}` === key,
          );
          return candidate ? isCorrect(candidate, question) : false;
        });

    const hitRank = hitIndex >= 0 ? hitIndex + 1 : null;

    // For no-answer questions the desired behaviour is that nothing from any
    // one document dominates. A weak, scattered result set is the retrieval
    // signal that the generator should refuse.
    const refusedCorrectly = question.isNoAnswer
      ? candidates.length === 0 ||
        new Set(candidates.slice(0, 5).map((candidate) => candidate.documentCode)).size >= 3
      : null;

    return {
      id: question.id,
      question: question.question,
      questionType: question.questionType,
      expectedDocumentCode: question.expectedDocumentCode,
      isNoAnswer: question.isNoAnswer,
      hitRank,
      reciprocalRank: hitRank ? 1 / hitRank : 0,
      recallAt1: hitRank !== null && hitRank <= 1,
      recallAt3: hitRank !== null && hitRank <= 3,
      recallAt5: hitRank !== null && hitRank <= 5,
      sectionHit: candidates.some(
        (candidate) => isCorrect(candidate, question) && sectionMatches(candidate, question),
      ),
      revisionCorrect: question.isNoAnswer
        ? null
        : candidates.some((candidate) => candidate.documentCode === question.expectedDocumentCode)
          ? candidates.some((candidate) => isCorrect(candidate, question))
          : null,
      refusedCorrectly,
      retrievedTop: candidates.slice(0, 5).map((candidate) => ({
        documentCode: candidate.documentCode,
        revision: candidate.revisionNumber,
        section: candidate.sectionTitle,
        score: Number(candidate.score.toFixed(6)),
      })),
      latencyMs,
    };
  }

  private async persist(
    metrics: RetrievalEvaluationReport['metrics'],
    results: readonly RetrievalQuestionResult[],
  ): Promise<string | null> {
    if (!this.deps.db) return null;

    try {
      const run = await queryOne<{ id: string }>(
        `INSERT INTO evaluation_runs (kind, completed_at, question_count, embedding_provider, embedding_model, metrics, config)
         VALUES ('RETRIEVAL', now(), $1, $2, $3, $4::jsonb, $5::jsonb)
         RETURNING id`,
        [
          results.length,
          this.deps.embeddings.name,
          this.deps.embeddings.model,
          JSON.stringify(metrics),
          JSON.stringify({
            vectorTopK: this.config.retrieval.vectorTopK,
            lexicalTopK: this.config.retrieval.lexicalTopK,
            rrfK: this.config.retrieval.rrfK,
            finalContextChunks: this.config.retrieval.finalContextChunks,
          }),
        ],
        this.deps.db,
      );

      if (!run) return null;

      for (const result of results) {
        await this.deps.db.query(
          `INSERT INTO evaluation_results (
             evaluation_run_id, external_id, question, hit_rank, reciprocal_rank,
             recall_at_1, recall_at_3, recall_at_5, section_hit, revision_correct,
             refused_correctly, retrieved, latency_ms, passed
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
          [
            run.id,
            result.id,
            result.question,
            result.hitRank,
            result.reciprocalRank,
            result.recallAt1,
            result.recallAt3,
            result.recallAt5,
            result.sectionHit,
            result.revisionCorrect,
            result.refusedCorrectly,
            JSON.stringify(result.retrievedTop),
            result.latencyMs,
            result.isNoAnswer ? result.refusedCorrectly === true : result.recallAt5,
          ],
        );
      }

      return run.id;
    } catch (error) {
      this.logger.warn({ err: { message: String(error) } }, 'failed to persist evaluation run');
      return null;
    }
  }
}
