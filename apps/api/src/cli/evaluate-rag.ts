/** `npm run eval:rag` implementation. */

import { getConfig } from '../config/index.js';
import { closePool, getPool } from '../db/pool.js';
import { createRagService } from '../modules/chat/index.js';
import { getChatModelProvider } from '../modules/chat/chat-model.js';
import { getEmbeddingProvider } from '../modules/embeddings/index.js';
import { loadGoldDataset, RagEvaluator, formatPercent } from '../modules/evaluation/index.js';
import { disposeOCRProvider } from '../modules/ocr/index.js';
import { AppError } from '../utils/errors.js';
import { getBoolean, getNumber, getString, parseArgs, type ParsedArgs } from './args.js';
import { formatDuration, heading, printKeyValues, printTable } from './format.js';

/**
 * RAG evaluation calls a chat model once per question, so it defaults to a
 * small subset. Running the full dataset is opt-in via --limit.
 */
const DEFAULT_LIMIT = 15;

export async function runRagEvaluation(args: ParsedArgs): Promise<number> {
  const config = getConfig();
  const embeddings = getEmbeddingProvider();
  const chatModel = getChatModelProvider();

  if (!chatModel.isAvailable()) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'RAG evaluation needs a chat model. Set OPENAI_API_KEY.\n' +
        'Retrieval-only evaluation runs without one: npm run eval:retrieval',
    );
  }

  if (!embeddings.semantic && !getBoolean(args, 'allow-non-semantic', false)) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'RAG evaluation with mock embeddings measures the generator against effectively random retrieval.\n' +
        'Set EMBEDDING_PROVIDER=openai and re-ingest, or pass --allow-non-semantic to run it anyway.',
    );
  }

  const dataset = await loadGoldDataset(getString(args, 'dataset'), config);
  const limit = getNumber(args, 'limit', DEFAULT_LIMIT);

  heading('RAG evaluation');
  printKeyValues([
    ['questions available', dataset.questions.length],
    ['questions to run', Math.min(limit, dataset.questions.length)],
    ['chat model', chatModel.model],
    ['embedding model', embeddings.model],
  ]);

  console.log(`\nThis makes one chat completion per question - ${Math.min(limit, dataset.questions.length)} calls.\n`);

  const evaluator = new RagEvaluator({
    rag: createRagService(config),
    embeddings,
    chatModelName: chatModel.model,
    db: getPool(),
    config,
  });

  const started = performance.now();
  const report = await evaluator.run({ dataset, limit, persist: getBoolean(args, 'persist', true) });
  const durationMs = performance.now() - started;

  heading('Results');
  printKeyValues([
    ['questions', report.questionCount],
    ['answered', report.answered],
    ['refused', report.refused],
    ['expected facts present', formatPercent(report.factRecall)],
    ['citation - correct document', formatPercent(report.citationDocumentAccuracy)],
    ['citation - correct revision', formatPercent(report.citationRevisionAccuracy)],
    ['citation - superseded revision', formatPercent(report.supersededCitationRate)],
    ['no-answer refused correctly', formatPercent(report.noAnswerAccuracy)],
    ['overall pass rate', formatPercent(report.passRate)],
    ['duration', formatDuration(durationMs)],
  ]);

  const failures = report.results.filter((result) => !result.passed);
  if (failures.length > 0) {
    heading(`Failures (${failures.length})`);
    printTable(
      ['question', 'status', 'missing facts', 'cited doc'],
      failures
        .slice(0, 15)
        .map((result) => [
          result.question.slice(0, 52),
          result.answerStatus,
          result.factsMissing.join(', ').slice(0, 30) || '-',
          result.citedExpectedDocument ? 'yes' : 'no',
        ]),
    );
  }

  if (report.supersededCitationRate > 0) {
    console.log(
      '\n⚠  At least one answer cited a superseded revision. That is the failure the revision lifecycle\n' +
        '   exists to prevent - check that ingestion activated the newest revision.',
    );
  }

  if (report.runId) console.log(`\nRun persisted as evaluation_runs.id = ${report.runId}`);
  console.log('');

  return 0;
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runRagEvaluation(parseArgs());
  } finally {
    await disposeOCRProvider();
    await closePool();
  }
}
