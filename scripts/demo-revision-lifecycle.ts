#!/usr/bin/env tsx
/**
 * Walk the whole revision lifecycle end to end and print what changes at each
 * step. This is the scenario the project exists to demonstrate:
 *
 *   1. ask a question, get revision 1's answer
 *   2. create revision 2 with a changed threshold
 *   3. ask again - still revision 1, because revision 2 is not ingested
 *   4. ingest
 *   5. ask again - now revision 2, and revision 1 is retained but superseded
 *
 *   npm run demo:revision
 *   npm run demo:revision -- --document=FIN-POL-001 --fact=financeDirectorThreshold
 */

import { getConfig } from '../apps/api/src/config/index.js';
import { closePool, getPool, queryRows } from '../apps/api/src/db/pool.js';
import { getString, parseArgs } from '../apps/api/src/cli/args.js';
import { heading, printTable } from '../apps/api/src/cli/format.js';
import { createIngestionService } from '../apps/api/src/modules/ingestion/index.js';
import { createRevisionSimulator } from '../apps/api/src/modules/corpus/revision-simulator.js';
import { createRetrievalService } from '../apps/api/src/modules/retrieval/index.js';
import { disposeOCRProvider } from '../apps/api/src/modules/ocr/index.js';
import { assertSupportedNodeVersion } from '../apps/api/src/utils/runtime.js';

assertSupportedNodeVersion();

interface RevisionRow {
  revision_number: number;
  is_current: boolean;
  status: string;
  processing_status: string;
  chunks: number;
}

const args = parseArgs();
const documentCode = getString(args, 'document', 'FIN-POL-001');
const factId = getString(args, 'fact', 'financeDirectorThreshold');
const question = getString(
  args,
  'question',
  'What expense amount requires Finance Director approval?',
);

const config = getConfig();
const retrieval = createRetrievalService(config);

/**
 * Print the revision table plus the sentence that actually answers the
 * question, so the change is visible rather than inferred. `highlight` names
 * the value the mutation introduced, so the right sentence is picked instead of
 * whichever one happens to contain the first number.
 */
async function showState(label: string, highlight?: string): Promise<void> {
  const revisions = await queryRows<RevisionRow>(
    `SELECT r.revision_number, r.is_current, r.status, r.processing_status,
            (SELECT count(*)::int FROM document_chunks c WHERE c.document_revision_id = r.id) AS chunks
       FROM document_revisions r
       JOIN documents d ON d.id = r.document_id
      WHERE d.document_code = $1
      ORDER BY r.revision_number`,
    [documentCode],
  );

  heading(label);
  printTable(
    ['rev', 'current', 'status', 'processing', 'chunks'],
    revisions.map((revision) => [
      String(revision.revision_number),
      revision.is_current ? 'CURRENT' : '',
      revision.status,
      revision.processing_status,
      String(revision.chunks),
    ]),
  );

  const result = await retrieval.retrieve({ query: question, log: false, source: 'DEBUG' });
  const top = result.selected.find((candidate) => candidate.documentCode === documentCode);

  if (!top) {
    console.log(`\n  Retrieval did not surface ${documentCode} for this question.`);
    return;
  }

  console.log(`\n  Top ${documentCode} chunk: revision ${top.revisionNumber}, section "${top.sectionTitle}"`);

  // Prose only: a table row containing the same figure is a correct match but
  // reads as noise when the point is to show the sentence that changed.
  const sentences = top.content
    .split(/(?<=\.)\s+/)
    .flatMap((part) => part.split('\n'))
    .filter((part) => !part.trimStart().startsWith('|') && part.trim().length > 30);
  const sentence =
    (highlight ? sentences.find((part) => part.includes(highlight)) : undefined) ??
    sentences.find((part) => /Finance Director|requires .* approval/i.test(part)) ??
    sentences.find((part) => /\$[\d,]+|\d+\s*(days|hours|minutes|months|years|%)/.test(part));

  if (sentence) console.log(`  "${sentence.trim().slice(0, 220)}"`);
}

async function main(): Promise<void> {
  console.log(`\nDocument: ${documentCode}`);
  console.log(`Question: "${question}"`);

  await showState('1. Starting state');


  const simulator = createRevisionSimulator(config);
  const created = await simulator.createRevision(documentCode, { factId, preferFactChange: true });

  console.log(`\n>>> Created revision ${created.revisionNumber}: ${created.changeSummary}`);
  if (created.mutation.previousValue && created.mutation.newValue) {
    console.log(`    ${created.mutation.previousValue}  ->  ${created.mutation.newValue}`);
  }

  await showState(
    '2. After creating the revision (not yet ingested)',
    created.mutation.previousValue,
  );
  console.log('\n    The answer has not changed: the new revision is PENDING and invisible to retrieval.');

  console.log('\n>>> Running ingestion...');
  const ingestion = createIngestionService(config);
  const run = await ingestion.run({ trigger: 'MANUAL' });
  console.log(`    processed=${run.processed} failed=${run.failed} chunks=${run.chunksCreated}`);

  await showState('3. After ingestion', created.mutation.newValue);
  console.log(
    `\n    Revision ${created.previousRevisionNumber} is SUPERSEDED but its chunks are retained, so\n` +
      '    "what did the previous revision say?" remains answerable.\n' +
      `    Revision ${created.revisionNumber} is CURRENT and is what retrieval now returns.\n`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disposeOCRProvider();
    await closePool();
    void getPool;
  });
