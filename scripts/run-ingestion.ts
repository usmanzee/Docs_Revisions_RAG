#!/usr/bin/env tsx
/**
 * Run one ingestion synchronisation.
 *
 *   npm run ingestion:run
 *   npm run ingestion:run -- --limit=50
 *   npm run ingestion:run -- --revision=<uuid>     reprocess one revision
 *   npm run ingestion:run -- --skip-discovery
 */

import { main } from '../apps/api/src/cli/run-ingestion.js';
import { assertSupportedNodeVersion } from '../apps/api/src/utils/runtime.js';

assertSupportedNodeVersion();

main().catch((error: unknown) => {
  console.error('\nIngestion failed:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
