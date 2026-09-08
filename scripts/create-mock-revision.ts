#!/usr/bin/env tsx
/**
 * Create a new revision of an existing synthetic document.
 *
 *   npm run corpus:revise -- --document=FIN-POL-001
 *   npm run corpus:revise -- --document=FIN-POL-001 --fact=financeDirectorThreshold
 *   npm run corpus:revise -- --document=IT-PROC-001 --mutation=PROCESS_STEP_ADDED
 *
 * The new revision is written as PENDING. The previous revision stays current
 * until ingestion successfully processes the new one.
 */

import { main } from '../apps/api/src/cli/create-revision.js';

main(false).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
