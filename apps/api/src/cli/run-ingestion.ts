/** `npm run ingestion:run` implementation. */

import { getConfig } from '../config/index.js';
import { assertSchemaCompatibility, closePool } from '../db/pool.js';
import { disposeOCRProvider } from '../modules/ocr/index.js';
import { createIngestionService } from '../modules/ingestion/index.js';
import { getEmbeddingProvider } from '../modules/embeddings/index.js';
import { getOptionalNumber, parseArgs, getBoolean, getString, type ParsedArgs } from './args.js';
import { formatDuration, heading, printKeyValues, printTable } from './format.js';

export async function runIngestionCli(args: ParsedArgs): Promise<number> {
  const config = getConfig();
  await assertSchemaCompatibility(config);

  const embeddings = getEmbeddingProvider();

  heading('Ingestion run');
  printKeyValues([
    ['embedding provider', embeddings.name],
    ['embedding model', embeddings.model],
    ['dimensions', embeddings.dimensions],
    ['semantic vectors', String(embeddings.semantic)],
    ['ocr', config.ocr.enabled ? config.ocr.provider : 'disabled'],
    ['vision', config.vision.enabled ? config.vision.provider : 'disabled'],
    ['concurrency', config.ingestion.concurrency],
  ]);

  if (!embeddings.semantic) {
    console.log(
      '\n⚠  Mock embeddings are in use. The pipeline is exercised end to end, but the vectors are not\n' +
        '   semantically meaningful - retrieval quality measured in this mode is not a real result.',
    );
  }

  const service = createIngestionService(config);
  const result = await service.run({
    trigger: 'MANUAL',
    ...(getOptionalNumber(args, 'limit') !== undefined ? { limit: getOptionalNumber(args, 'limit') } : {}),
    ...(getBoolean(args, 'skip-discovery') ? { skipDiscovery: true } : {}),
    ...(getString(args, 'revision') ? { revisionId: getString(args, 'revision') as string } : {}),
  });

  if (result.skippedReason) {
    console.log(`\nRun skipped: ${result.skippedReason}\n`);
    return 0;
  }

  if (result.discovery) {
    heading('Discovery');
    printKeyValues([
      ['files scanned', result.discovery.filesScanned],
      ['revisions registered', result.discovery.revisionsRegistered],
      ['revisions re-queued', result.discovery.revisionsRequeued],
      ['missing files', result.discovery.missingFiles.length],
    ]);
  }

  heading('Result');
  printKeyValues([
    ['job', result.jobId ?? 'n/a'],
    ['status', result.status],
    ['discovered', result.discovered],
    ['processed', result.processed],
    ['skipped', result.skipped],
    ['failed', result.failed],
    ['chunks created', result.chunksCreated],
    ['ocr pages', result.ocrPages],
    ['vision images', result.visionImages],
    ['embedding requests', result.embeddingRequests],
    ['duration', formatDuration(result.durationMs)],
  ]);

  const failures = result.items.filter((item) => item.outcome === 'FAILED');
  if (failures.length > 0) {
    heading(`Failed revisions (${failures.length})`);
    printTable(
      ['document', 'rev', 'stage', 'error'],
      failures.map((item) => [
        item.documentCode,
        String(item.revisionNumber),
        item.errorStage ?? '',
        (item.errorMessage ?? '').slice(0, 90),
      ]),
    );
    console.log(
      '\nThese revisions are marked FAILED. Their previous revision remains current and searchable.',
    );
  }

  const skipped = result.items.filter((item) => item.outcome === 'SKIPPED');
  if (skipped.length > 0) {
    heading(`Skipped revisions (${skipped.length})`);
    printTable(
      ['document', 'rev', 'reason'],
      skipped.map((item) => [item.documentCode, String(item.revisionNumber), item.skipReason ?? '']),
    );
  }

  console.log('');
  return result.status === 'FAILED' ? 1 : 0;
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runIngestionCli(parseArgs());
  } finally {
    await disposeOCRProvider();
    await closePool();
  }
}
