#!/usr/bin/env tsx
/**
 * End-to-end RAG evaluation: are the answers right, grounded and correctly cited?
 *
 *   npm run eval:rag
 *   npm run eval:rag -- --limit=30
 *
 * Requires OPENAI_API_KEY (one chat completion per question). Scoring is
 * deterministic string and citation matching - no LLM judge, so a run costs
 * exactly as much as the answers themselves.
 */

import { main } from '../apps/api/src/cli/evaluate-rag.js';
import { assertSupportedNodeVersion } from '../apps/api/src/utils/runtime.js';

assertSupportedNodeVersion();

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
