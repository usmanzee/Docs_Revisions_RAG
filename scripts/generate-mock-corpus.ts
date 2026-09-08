#!/usr/bin/env tsx
/**
 * Generate the synthetic enterprise corpus.
 *
 *   npm run corpus:generate -- --profile=quality --count=75 --seed=123
 *   npm run corpus:generate -- --profile=scale --count=5000 --seed=123
 *   npm run corpus:generate -- --profile=smoke --no-reset
 *
 * Options:
 *   --profile   smoke | quality | scale   (default: MOCK_CORPUS_PROFILE)
 *   --count     number of documents       (default: profile default)
 *   --seed      deterministic seed        (default: MOCK_CORPUS_SEED)
 *   --reset     wipe existing corpus first (default: true)
 *   --no-evaluation  skip writing data/evaluation/questions.json
 */

import { main } from '../apps/api/src/cli/generate-corpus.js';

main().catch((error: unknown) => {
  console.error('\nCorpus generation failed:');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
