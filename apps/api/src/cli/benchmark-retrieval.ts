/**
 * `npm run benchmark:retrieval` implementation.
 *
 * Measures retrieval latency against whatever corpus is currently loaded, and
 * reports the physical sizes that explain the numbers. Vector and lexical
 * search are timed separately as well as fused, because they scale differently:
 * ANN search degrades with index size, full-text search with matching-row count.
 */

import { getConfig } from '../config/index.js';
import { closePool, getPool } from '../db/pool.js';
import { RetrievalRepository } from '../repositories/retrieval-repository.js';
import { StatsRepository } from '../repositories/stats-repository.js';
import { getEmbeddingProvider } from '../modules/embeddings/index.js';
import { createRetrievalService } from '../modules/retrieval/index.js';
import { mean, percentile } from '../modules/evaluation/metrics.js';
import { loadGoldDataset } from '../modules/evaluation/retrieval-evaluator.js';
import { disposeOCRProvider } from '../modules/ocr/index.js';
import { getNumber, getOptionalNumber, parseArgs, type ParsedArgs } from './args.js';
import { formatBytes, formatDuration, heading, printKeyValues, printTable } from './format.js';

/**
 * Fallback queries when no gold dataset is present - a scale corpus is
 * generated without one. Chosen to exercise different retrieval shapes:
 * natural language, exact identifiers, and rare terminology.
 */
const FALLBACK_QUERIES: readonly string[] = [
  'What expenses require Finance Director approval?',
  'How long are production backups retained?',
  'When must a priority-one incident be escalated?',
  'What does ORA-GUIDE-003 recommend regarding tablespace monitoring?',
  'What is the minimum password length?',
  'How many days of annual leave can be carried over?',
  'What approval is needed for a single-source supplier award?',
  'What is the recovery point objective for tier-one systems?',
  'How often is ERP access recertified?',
  'What tablespace utilisation triggers a critical alert?',
  'ORA-01555 snapshot too old',
  'remote working VPN requirement',
];

export async function runBenchmark(args: ParsedArgs): Promise<number> {
  const config = getConfig();
  const pool = getPool();
  const embeddings = getEmbeddingProvider();

  const iterations = getNumber(args, 'iterations', 5);
  const warmup = getNumber(args, 'warmup', 2);

  // Prefer real evaluation questions when they exist; they are representative
  // of what the system is actually asked.
  let queries: string[] = [...FALLBACK_QUERIES];
  try {
    const dataset = await loadGoldDataset(undefined, config);
    const sampled = dataset.questions.filter((question) => !question.isNoAnswer).slice(0, 25);
    if (sampled.length >= 5) queries = sampled.map((question) => question.question);
  } catch {
    // No dataset (scale corpus): the fallback set is the right choice.
  }

  const limit = getOptionalNumber(args, 'queries');
  if (limit !== undefined) queries = queries.slice(0, limit);

  const stats = new StatsRepository(pool);
  const repository = new RetrievalRepository(pool);
  const service = createRetrievalService(config);

  const [counts, sizes] = await Promise.all([stats.corpusCounts(), stats.databaseSizes()]);

  heading('Retrieval benchmark');
  printKeyValues([
    ['documents', counts.documentsTotal],
    ['current revisions', counts.revisionsCurrent],
    ['chunks (total)', counts.chunksTotal],
    ['chunks (current)', counts.chunksCurrent],
    ['chunks with embedding', counts.chunksWithEmbedding],
    ['embedding provider', embeddings.name],
    ['embedding model', embeddings.model],
    ['dimensions', embeddings.dimensions],
    ['queries', queries.length],
    ['iterations', iterations],
  ]);

  heading('Storage');
  printKeyValues([
    ['database size', formatBytes(sizes.databaseBytes)],
    ['document_chunks (incl. indexes)', formatBytes(sizes.chunkTableBytes)],
    ['vector index (HNSW)', formatBytes(sizes.vectorIndexBytes)],
    ['full-text index (GIN)', formatBytes(sizes.textIndexBytes)],
  ]);

  if (counts.chunksWithEmbedding === 0) {
    console.log('\nNo embedded chunks found. Run `npm run ingestion:run` before benchmarking.\n');
    return 1;
  }

  // Warm-up runs are discarded: the first queries pay for connection setup,
  // plan caching and pulling index pages into the buffer cache, and including
  // them would report a latency nobody experiences in steady state.
  for (let i = 0; i < warmup; i += 1) {
    for (const query of queries.slice(0, 3)) {
      await service.retrieve({ query, log: false, source: 'BENCHMARK' });
    }
  }

  const hybrid: number[] = [];
  const vector: number[] = [];
  const lexical: number[] = [];
  const embed: number[] = [];

  const started = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const query of queries) {
      const result = await service.retrieve({ query, log: false, source: 'BENCHMARK' });
      hybrid.push(result.timings.totalMs);
      vector.push(result.timings.vectorMs);
      lexical.push(result.timings.lexicalMs);
      embed.push(result.timings.embeddingMs);
    }
  }

  // Isolate the raw SQL cost, without embedding or fusion overhead.
  const embedding = await embeddings.embedQuery(queries[0] as string);
  const rawVector: number[] = [];
  const rawLexical: number[] = [];

  for (const query of queries) {
    const vectorStart = performance.now();
    await repository.vectorSearch(embedding, config.retrieval.vectorTopK, {});
    rawVector.push(performance.now() - vectorStart);

    const lexicalStart = performance.now();
    await repository.lexicalSearch(query, config.retrieval.lexicalTopK, {});
    rawLexical.push(performance.now() - lexicalStart);
  }

  const totalMs = performance.now() - started;

  const row = (label: string, values: number[]): string[] => [
    label,
    `${percentile(values, 50).toFixed(1)}`,
    `${percentile(values, 95).toFixed(1)}`,
    `${percentile(values, 99).toFixed(1)}`,
    `${mean(values).toFixed(1)}`,
  ];

  heading('Latency (ms)');
  printTable(
    ['stage', 'p50', 'p95', 'p99', 'mean'],
    [
      row('hybrid (end to end)', hybrid),
      row('  query embedding', embed),
      row('  vector search', vector),
      row('  lexical search', lexical),
      row('vector SQL only', rawVector),
      row('lexical SQL only', rawLexical),
    ],
  );

  heading('Throughput');
  printKeyValues([
    ['queries executed', hybrid.length],
    ['wall clock', formatDuration(totalMs)],
    ['queries/second', (hybrid.length / (totalMs / 1000)).toFixed(1)],
  ]);

  if (!embeddings.semantic) {
    console.log(
      '\nNote: mock embeddings are in use. Latency figures are valid - the vector arithmetic and index\n' +
        'traversal are identical - but retrieval quality is not being measured here.',
    );
  }

  console.log('');
  return 0;
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runBenchmark(parseArgs());
  } finally {
    await disposeOCRProvider();
    await closePool();
  }
}
