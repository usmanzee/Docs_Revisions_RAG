#!/usr/bin/env tsx
/**
 * Open psql against the configured DATABASE_URL.
 *
 *   npm run db:psql
 *
 * Convenience so nobody has to reconstruct the connection string by hand while
 * inspecting pgvector data.
 */

import { spawn } from 'node:child_process';
import { getConfig } from '../apps/api/src/config/index.js';
import { assertSupportedNodeVersion } from '../apps/api/src/utils/runtime.js';

assertSupportedNodeVersion();

const { database } = getConfig();

const child = spawn('psql', [database.url], { stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`Could not start psql: ${error.message}`);
  console.error('Install the PostgreSQL client tools, or connect with your own client using DATABASE_URL.');
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
