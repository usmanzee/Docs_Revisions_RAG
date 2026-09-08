/** `npm run corpus:revise` and `npm run corpus:corrupt` implementation. */

import { getConfig } from '../config/index.js';
import { closePool } from '../db/pool.js';
import { RevisionRepository } from '../repositories/revision-repository.js';
import { getPool } from '../db/pool.js';
import { DocumentRepository } from '../repositories/document-repository.js';
import { createRevisionSimulator } from '../modules/corpus/revision-simulator.js';
import type { RevisionMutationType } from '../modules/corpus/types.js';
import { getBoolean, getString, parseArgs, type ParsedArgs } from './args.js';
import { formatBytes, heading, printKeyValues, printTable } from './format.js';

const MUTATION_TYPES: readonly RevisionMutationType[] = [
  'NUMERIC_THRESHOLD',
  'EFFECTIVE_DATE',
  'RESPONSIBILITY',
  'PROCESS_STEP_ADDED',
  'PROCESS_STEP_REMOVED',
  'PARAGRAPH_REPLACED',
  'ORACLE_RECOMMENDATION',
  'RETENTION_DURATION',
  'APPROVAL_ROLE',
];

export async function runCreateRevision(args: ParsedArgs, forceCorrupt = false): Promise<number> {
  const config = getConfig();
  const documentCode = getString(args, 'document');

  if (!documentCode) {
    console.error('Specify a document: npm run corpus:revise -- --document=FIN-POL-001');
    return 1;
  }

  const mutationType = getString(args, 'mutation');
  if (mutationType && !MUTATION_TYPES.includes(mutationType as RevisionMutationType)) {
    console.error(`--mutation must be one of: ${MUTATION_TYPES.join(', ')}`);
    return 1;
  }

  const corrupt = forceCorrupt || getBoolean(args, 'corrupt', false);
  const simulator = createRevisionSimulator(config);

  const created = await simulator.createRevision(documentCode, {
    ...(mutationType ? { mutationType: mutationType as RevisionMutationType } : {}),
    ...(getString(args, 'fact') ? { factId: getString(args, 'fact') as string } : {}),
    corrupt,
  });

  heading(corrupt ? 'Created corrupted revision' : 'Created revision');
  printKeyValues([
    ['document', created.documentCode],
    ['new revision', created.revisionNumber],
    ['previous revision', created.previousRevisionNumber],
    ['effective date', created.effectiveDate],
    ['mutation', created.mutation.type],
    ['change', created.changeSummary],
    ['file', created.storageKey],
    ['size', formatBytes(created.fileSizeBytes)],
    ['processing status', 'PENDING'],
  ]);

  if (created.mutation.previousValue && created.mutation.newValue) {
    console.log(`\n  ${created.mutation.previousValue}  ->  ${created.mutation.newValue}`);
  }

  const revisions = await new RevisionRepository(getPool()).findByDocumentCode(documentCode);
  heading('Revision state');
  printTable(
    ['rev', 'current', 'status', 'processing', 'effective'],
    revisions
      .slice()
      .reverse()
      .map((revision) => [
        String(revision.revision_number),
        revision.is_current ? 'CURRENT' : '',
        revision.status,
        revision.processing_status,
        revision.effective_date ? revision.effective_date.toISOString().slice(0, 10) : '',
      ]),
  );

  console.log(
    corrupt
      ? '\nThe new revision is unreadable on purpose. Run `npm run ingestion:run`: it must fail for this\n' +
          'revision only, leaving the previous revision current and searchable.\n'
      : '\nThe previous revision is still current. Run `npm run ingestion:run` to process and activate the\n' +
          'new one, then ask the same question again.\n',
  );

  return 0;
}

/** List documents that can be revised, when the user gets the code wrong. */
export async function listRevisableDocuments(): Promise<void> {
  const documents = await new DocumentRepository(getPool()).list({ page: 1, pageSize: 20 });
  heading('Available documents');
  printTable(
    ['code', 'title', 'revisions'],
    documents.items.map((document) => [
      document.documentCode,
      document.title.slice(0, 50),
      String(document.revisionCount),
    ]),
  );
}

export async function main(forceCorrupt = false): Promise<void> {
  const args = parseArgs();
  try {
    process.exitCode = await runCreateRevision(args, forceCorrupt);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    if (getString(args, 'document')) await listRevisableDocuments().catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
