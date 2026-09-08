/**
 * `npm run corpus:generate` implementation.
 *
 * Writes synthetic documents to storage, registers them in PostgreSQL as
 * PENDING revisions, and - outside the scale profile - writes the gold
 * evaluation dataset alongside them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CORPUS_PROFILES, type CorpusProfile } from '@docs-rag/shared';
import { getConfig } from '../config/index.js';
import { closePool } from '../db/pool.js';
import { childLogger } from '../utils/logger.js';
import {
  createCorpusGenerator,
  resolveCorpusOptions,
  type EvaluationRecord,
} from '../modules/corpus/corpus-generator.js';
import { defaultCountForProfile } from '../modules/corpus/corpus-planner.js';
import {
  getBoolean,
  getEnum,
  getOptionalNumber,
  parseArgs,
  type ParsedArgs,
} from './args.js';
import { formatBytes, formatDuration, heading, printKeyValues, printTable } from './format.js';

export const EVALUATION_FILE = 'questions.json';

function evaluationDirectory(): string {
  return path.join(getConfig().repoRoot, 'data', 'evaluation');
}

async function writeEvaluationDataset(records: EvaluationRecord[], profile: CorpusProfile): Promise<string> {
  const directory = evaluationDirectory();
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, EVALUATION_FILE);

  const payload = {
    generatedAt: new Date().toISOString(),
    profile,
    questionCount: records.length,
    noAnswerCount: records.filter((record) => record.isNoAnswer).length,
    questions: records,
  };

  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

export interface GenerateCorpusOptions {
  args: ParsedArgs;
}

export async function runGenerateCorpus({ args }: GenerateCorpusOptions): Promise<void> {
  const config = getConfig();
  const logger = childLogger({ component: 'corpus-cli' });

  const profile = getEnum<CorpusProfile>(args, 'profile', CORPUS_PROFILES, config.corpus.profile);
  const count = getOptionalNumber(args, 'count') ?? defaultCountForProfile(profile);
  const seed = getOptionalNumber(args, 'seed') ?? config.corpus.seed;
  const reset = getBoolean(args, 'reset', true);

  const options = resolveCorpusOptions(config, {
    profile,
    count,
    seed,
    reset,
    ...(args.values.has('scanned-ratio') ? { scannedRatio: getOptionalNumber(args, 'scanned-ratio') } : {}),
    ...(args.values.has('corrupt-ratio') ? { corruptRatio: getOptionalNumber(args, 'corrupt-ratio') } : {}),
    ...(args.values.has('multi-revision-ratio')
      ? { multiRevisionRatio: getOptionalNumber(args, 'multi-revision-ratio') }
      : {}),
    ...(args.values.has('no-evaluation') ? { writeEvaluation: false } : {}),
  });

  heading('Synthetic corpus generation');
  printKeyValues([
    ['profile', options.profile],
    ['documents', options.count],
    ['seed', options.seed],
    ['storage', config.storage.root],
    ['reset existing', String(options.reset)],
  ]);

  // Scale corpora take minutes; without this the user has no idea whether it
  // is working.
  if (options.count >= 500) {
    console.log(`\nGenerating ${options.count} documents. Progress is logged every 100 documents.`);
  }

  const generator = createCorpusGenerator(config);
  const { result, evaluation } = await generator.generate(options);

  if (options.writeEvaluation && evaluation.length > 0) {
    result.evaluationPath = await writeEvaluationDataset(evaluation, options.profile);
  }

  heading('Corpus summary');
  printKeyValues([
    ['documents', result.documentsWritten],
    ['revisions', result.revisionsWritten],
    ['files written', result.filesWritten],
    ['bytes written', formatBytes(result.bytesWritten)],
    ['scanned documents', result.scannedDocuments],
    ['workflow diagrams', result.workflowDocuments],
    ['corrupt revisions', result.corruptRevisions],
    ['inactive documents', result.inactiveDocuments],
    ['near-duplicates', result.duplicateDocuments],
    ['duration', formatDuration(result.durationMs)],
  ]);

  heading('Formats');
  printTable(
    ['format', 'documents'],
    Object.entries(result.formatBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([format, total]) => [format, String(total)]),
  );

  if (result.evaluationPath) {
    const noAnswer = evaluation.filter((record) => record.isNoAnswer).length;
    heading('Evaluation dataset');
    printKeyValues([
      ['questions', evaluation.length],
      ['no-answer questions', noAnswer],
      ['written to', path.relative(config.repoRoot, result.evaluationPath)],
    ]);
  } else if (options.profile === 'scale') {
    console.log(
      '\nNo evaluation dataset written: the scale profile exists for infrastructure testing, and ' +
        'retrieval quality must be measured on a corpus embedded with a real model.',
    );
  }

  console.log(
    `\nAll ${result.revisionsWritten} revision(s) are registered as PENDING. ` +
      'Run `npm run ingestion:run` to parse, chunk, embed and activate them.\n',
  );

  logger.info(
    { profile: options.profile, documents: result.documentsWritten, durationMs: result.durationMs },
    'corpus generated',
  );
}

export async function main(): Promise<void> {
  try {
    await runGenerateCorpus({ args: parseArgs() });
  } finally {
    await closePool();
  }
}
