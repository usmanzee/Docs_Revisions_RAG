/** `npm run eval:retrieval` implementation. */

import { getConfig } from '../config/index.js';
import { closePool, getPool } from '../db/pool.js';
import { getEmbeddingProvider } from '../modules/embeddings/index.js';
import {
  loadGoldDataset,
  RetrievalEvaluator,
  evaluationDatasetPath,
  formatPercent,
} from '../modules/evaluation/index.js';
import { createRetrievalService } from '../modules/retrieval/index.js';
import { disposeOCRProvider } from '../modules/ocr/index.js';
import { getBoolean, getOptionalNumber, getString, parseArgs, type ParsedArgs } from './args.js';
import { formatDuration, heading, printKeyValues, printTable } from './format.js';

export async function runRetrievalEvaluation(args: ParsedArgs): Promise<number> {
  const config = getConfig();
  const embeddings = getEmbeddingProvider();

  const dataset = await loadGoldDataset(getString(args, 'dataset'), config);

  heading('Retrieval evaluation');
  printKeyValues([
    ['dataset', getString(args, 'dataset') ?? evaluationDatasetPath(config)],
    ['questions', dataset.questions.length],
    ['corpus profile', dataset.profile],
    ['embedding provider', embeddings.name],
    ['embedding model', embeddings.model],
    ['vector top-k', config.retrieval.vectorTopK],
    ['lexical top-k', config.retrieval.lexicalTopK],
    ['rrf k', config.retrieval.rrfK],
  ]);

  const evaluator = new RetrievalEvaluator({
    retrieval: createRetrievalService(config),
    embeddings,
    db: getPool(),
    config,
  });

  const started = performance.now();
  const report = await evaluator.run({
    dataset,
    ...(getOptionalNumber(args, 'limit') !== undefined ? { limit: getOptionalNumber(args, 'limit') } : {}),
    persist: getBoolean(args, 'persist', true),
    allowNonSemantic: getBoolean(args, 'allow-non-semantic', false),
  });
  const durationMs = performance.now() - started;

  const { metrics } = report;

  heading('Metrics');
  printKeyValues([
    ['questions', metrics.questionCount],
    ['answerable', metrics.answerableCount],
    ['no-answer', metrics.noAnswerCount],
    ['Recall@1', formatPercent(metrics.recallAt1)],
    ['Recall@3', formatPercent(metrics.recallAt3)],
    ['Recall@5', formatPercent(metrics.recallAt5)],
    ['MRR', metrics.mrr.toFixed(4)],
    ['section accuracy', formatPercent(metrics.sectionAccuracy)],
    ['current-revision accuracy', formatPercent(metrics.currentRevisionAccuracy)],
    ['no-answer behaviour', formatPercent(metrics.noAnswerBehaviour)],
  ]);

  heading('Latency');
  printKeyValues([
    ['p50', `${metrics.latencyMs.p50} ms`],
    ['p95', `${metrics.latencyMs.p95} ms`],
    ['p99', `${metrics.latencyMs.p99} ms`],
    ['mean', `${metrics.latencyMs.mean} ms`],
    ['total run', formatDuration(durationMs)],
  ]);

  heading('By question type');
  printTable(
    ['type', 'count', 'recall@5', 'mrr', 'refusal'],
    Object.entries(report.byQuestionType)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, summary]) => [
        type,
        String(summary.count),
        // Recall is undefined for questions with no correct document.
        summary.answerable === 0 ? 'n/a' : formatPercent(summary.recallAt5),
        summary.answerable === 0 ? 'n/a' : summary.mrr.toFixed(3),
        summary.answerable === summary.count ? 'n/a' : formatPercent(summary.refusalRate),
      ]),
  );

  const misses = report.results.filter((result) => !result.isNoAnswer && !result.recallAt5);
  if (misses.length > 0) {
    heading(`Misses (${misses.length})`);
    printTable(
      ['expected', 'question', 'top result'],
      misses
        .slice(0, 20)
        .map((result) => [
          result.expectedDocumentCode ?? '-',
          result.question.slice(0, 60),
          result.retrievedTop[0] ? `${result.retrievedTop[0].documentCode} r${result.retrievedTop[0].revision}` : '(none)',
        ]),
    );
  }

  if (report.runId) console.log(`\nRun persisted as evaluation_runs.id = ${report.runId}`);
  if (!report.semantic) {
    console.log(
      '\n⚠  These numbers came from non-semantic mock embeddings and are NOT a measure of retrieval quality.',
    );
  }
  console.log('');

  return 0;
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runRetrievalEvaluation(parseArgs());
  } finally {
    await disposeOCRProvider();
    await closePool();
  }
}
