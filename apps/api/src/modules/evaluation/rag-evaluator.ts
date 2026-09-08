/**
 * End-to-end RAG evaluation.
 *
 * Retrieval evaluation asks "did we find the right document?". This asks the
 * harder question: "did the answer say the right thing, cite the right source,
 * and refuse when it should?".
 *
 * Scoring is deterministic - substring matching against the exact fact values
 * planted in the corpus, plus structural checks on the citations. There is no
 * LLM judge, because a judge doubles the cost of every run and introduces its
 * own errors into a measurement whose whole purpose is to be trustworthy. The
 * facts are known by construction; string matching is sufficient and honest.
 */

import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { queryOne, type Queryable } from '../../db/pool.js';
import { childLogger } from '../../utils/logger.js';
import { normalizeForComparison } from '../../utils/text.js';
import type { RagService } from '../chat/rag-service.js';
import type { EmbeddingProvider } from '../embeddings/index.js';
import type { GoldDataset, GoldQuestion, RagEvaluationReport, RagQuestionResult } from './types.js';

/**
 * Does the answer contain this fact?
 *
 * Compared on normalised text so "$27,500" matches "$27,500." and "27,500", and
 * so a difference in punctuation or spacing is not scored as a wrong answer.
 */
function containsFact(answer: string, fact: string): boolean {
  const normalizedAnswer = normalizeForComparison(answer);
  const normalizedFact = normalizeForComparison(fact);
  if (normalizedFact.length === 0) return false;
  if (normalizedAnswer.includes(normalizedFact)) return true;

  // Numeric facts are the ones that matter most, and the model may render
  // "$27,500" as "27500" or "27,500 USD". Compare the digits directly.
  const factDigits = fact.replace(/[^\d]/g, '');
  if (factDigits.length >= 2) {
    const answerDigits = answer.replace(/[^\d]/g, '');
    if (answerDigits.includes(factDigits)) return true;
  }

  return false;
}

export interface RagEvaluatorDependencies {
  rag: RagService;
  embeddings: EmbeddingProvider;
  chatModelName: string;
  db?: Queryable;
  config?: AppConfig;
}

export interface RunRagEvaluationOptions {
  dataset: GoldDataset;
  limit?: number;
  persist?: boolean;
}

export class RagEvaluator {
  private readonly logger = childLogger({ component: 'rag-evaluation' });
  private readonly config: AppConfig;

  constructor(private readonly deps: RagEvaluatorDependencies) {
    this.config = deps.config ?? getConfig();
  }

  async run(options: RunRagEvaluationOptions): Promise<RagEvaluationReport> {
    const questions = options.limit
      ? options.dataset.questions.slice(0, options.limit)
      : options.dataset.questions;

    const results: RagQuestionResult[] = [];

    for (const question of questions) {
      results.push(await this.evaluateQuestion(question));
      this.logger.debug({ id: question.id }, 'evaluated question');
    }

    const answerable = results.filter((result) => !result.isNoAnswer);
    const noAnswer = results.filter((result) => result.isNoAnswer);
    const withFacts = answerable.filter(
      (result) => result.factsFound.length + result.factsMissing.length > 0,
    );

    const report: RagEvaluationReport = {
      questionCount: results.length,
      answered: results.filter((result) => result.answerStatus === 'ANSWERED').length,
      refused: results.filter((result) => result.answerStatus === 'INSUFFICIENT_CONTEXT').length,
      factRecall:
        withFacts.length === 0
          ? 0
          : withFacts.reduce(
              (total, result) =>
                total + result.factsFound.length / (result.factsFound.length + result.factsMissing.length),
              0,
            ) / withFacts.length,
      citationDocumentAccuracy:
        answerable.length === 0
          ? 0
          : answerable.filter((result) => result.citedExpectedDocument).length / answerable.length,
      citationRevisionAccuracy:
        answerable.length === 0
          ? 0
          : answerable.filter((result) => result.citedExpectedRevision).length / answerable.length,
      supersededCitationRate:
        answerable.length === 0
          ? 0
          : answerable.filter((result) => result.citedSupersededRevision).length / answerable.length,
      noAnswerAccuracy:
        noAnswer.length === 0
          ? 0
          : noAnswer.filter((result) => result.refusedCorrectly).length / noAnswer.length,
      passRate: results.length === 0 ? 0 : results.filter((result) => result.passed).length / results.length,
      results,
      chatModel: this.deps.chatModelName,
      embeddingModel: this.deps.embeddings.model,
      runId: null,
    };

    if (options.persist) report.runId = await this.persist(report);

    return report;
  }

  private async evaluateQuestion(question: GoldQuestion): Promise<RagQuestionResult> {
    const started = performance.now();

    const answer = await this.deps.rag.answer({
      question: question.question,
      source: 'EVALUATION',
      log: false,
    });

    const latencyMs = Math.round(performance.now() - started);

    const factsFound = question.expectedFacts.filter((fact) => containsFact(answer.answer, fact));
    const factsMissing = question.expectedFacts.filter((fact) => !containsFact(answer.answer, fact));

    const citedExpectedDocument =
      question.expectedDocumentCode === null
        ? false
        : answer.citations.some((citation) => citation.documentCode === question.expectedDocumentCode);

    const citedExpectedRevision =
      question.expectedDocumentCode === null || question.expectedRevision === null
        ? false
        : answer.citations.some(
            (citation) =>
              citation.documentCode === question.expectedDocumentCode &&
              citation.revision === question.expectedRevision,
          );

    // Citing a revision older than the expected current one is the failure the
    // whole revision lifecycle exists to prevent.
    const citedSupersededRevision =
      question.expectedDocumentCode === null || question.expectedRevision === null
        ? false
        : answer.citations.some(
            (citation) =>
              citation.documentCode === question.expectedDocumentCode &&
              citation.revision < (question.expectedRevision as number),
          );

    const leakedSupersededAnswer =
      question.supersededAnswer !== undefined && containsFact(answer.answer, question.supersededAnswer);

    const refusedCorrectly = question.isNoAnswer
      ? answer.answerStatus === 'INSUFFICIENT_CONTEXT'
      : null;

    const passed = question.isNoAnswer
      ? refusedCorrectly === true
      : factsMissing.length === 0 && citedExpectedDocument && !leakedSupersededAnswer;

    return {
      id: question.id,
      question: question.question,
      questionType: question.questionType,
      isNoAnswer: question.isNoAnswer,
      answer: answer.answer,
      answerStatus: answer.answerStatus,
      factsFound,
      factsMissing,
      citedExpectedDocument,
      citedExpectedRevision,
      citedSupersededRevision,
      refusedCorrectly,
      leakedSupersededAnswer,
      passed,
      latencyMs,
    };
  }

  private async persist(report: RagEvaluationReport): Promise<string | null> {
    if (!this.deps.db) return null;

    try {
      const run = await queryOne<{ id: string }>(
        `INSERT INTO evaluation_runs (kind, completed_at, question_count, embedding_provider, embedding_model, chat_model, metrics, config)
         VALUES ('RAG', now(), $1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING id`,
        [
          report.questionCount,
          this.deps.embeddings.name,
          this.deps.embeddings.model,
          this.deps.chatModelName,
          JSON.stringify({
            factRecall: report.factRecall,
            citationDocumentAccuracy: report.citationDocumentAccuracy,
            citationRevisionAccuracy: report.citationRevisionAccuracy,
            supersededCitationRate: report.supersededCitationRate,
            noAnswerAccuracy: report.noAnswerAccuracy,
            passRate: report.passRate,
          }),
          JSON.stringify({ finalContextChunks: this.config.retrieval.finalContextChunks }),
        ],
        this.deps.db,
      );

      if (!run) return null;

      for (const result of report.results) {
        await this.deps.db.query(
          `INSERT INTO evaluation_results (
             evaluation_run_id, external_id, question, facts_found, facts_missing,
             answer, refused_correctly, latency_ms, passed
           ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
          [
            run.id,
            result.id,
            result.question,
            JSON.stringify(result.factsFound),
            JSON.stringify(result.factsMissing),
            result.answer.slice(0, 8000),
            result.refusedCorrectly,
            result.latencyMs,
            result.passed,
          ],
        );
      }

      return run.id;
    } catch (error) {
      this.logger.warn({ err: { message: String(error) } }, 'failed to persist RAG evaluation run');
      return null;
    }
  }
}
