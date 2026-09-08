#!/usr/bin/env tsx
/**
 * Create a deliberately corrupted revision, to exercise failure handling.
 *
 *   npm run corpus:corrupt -- --document=FIN-POL-001
 *
 * Ingestion must fail for this revision only, mark it FAILED, and leave the
 * previous revision current and searchable.
 */

import { main } from '../apps/api/src/cli/create-revision.js';

main(true).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
