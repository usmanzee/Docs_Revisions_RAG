#!/usr/bin/env tsx
/**
 * Score retrieval against the gold dataset in data/evaluation/questions.json.
 *
 *   npm run eval:retrieval
 *   npm run eval:retrieval -- --limit=20
 *   npm run eval:retrieval -- --allow-non-semantic   (plumbing check only)
 */

import { main } from '../apps/api/src/cli/evaluate-retrieval.js';

main().catch((error: unknown) => {
  console.error('\nRetrieval evaluation failed:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
