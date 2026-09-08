#!/usr/bin/env tsx
/**
 * Measure retrieval latency and index sizes against the loaded corpus.
 *
 *   npm run benchmark:retrieval
 *   npm run benchmark:retrieval -- --iterations=10 --queries=20
 */

import { main } from '../apps/api/src/cli/benchmark-retrieval.js';

main().catch((error: unknown) => {
  console.error('\nBenchmark failed:\n');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
