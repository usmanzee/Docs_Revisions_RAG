#!/usr/bin/env tsx
/**
 * Migration CLI.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate:status     show what is applied
 *   npm run db:reset              drop + recreate (non-production only)
 */

import { getConfig } from '../apps/api/src/config/index.js';
import { closePool, getPool } from '../apps/api/src/db/pool.js';
import { getMigrationStatus, migrateUp, resetDatabase } from '../apps/api/src/db/migrator.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = getConfig();
  const pool = getPool();

  console.log(`database : ${config.database.url.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`dimension: ${config.embedding.dimensions} (EMBEDDING_DIMENSIONS)\n`);

  switch (command) {
    case 'up': {
      const result = await migrateUp(config, pool);
      if (result.applied.length === 0) {
        console.log(`Nothing to do - ${result.skipped.length} migration(s) already applied.`);
      } else {
        console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
      }
      break;
    }

    case 'status': {
      const status = await getMigrationStatus(config, pool);
      const width = Math.max(...status.map((row) => row.name.length));
      for (const row of status) {
        const state = row.applied ? (row.checksumMatches ? 'applied' : 'CHECKSUM MISMATCH') : 'pending';
        const when = row.appliedAt ? row.appliedAt.toISOString() : '';
        console.log(`  ${row.version}  ${row.name.padEnd(width)}  ${state.padEnd(18)} ${when}`);
      }
      const pending = status.filter((row) => !row.applied).length;
      console.log(`\n${status.length - pending}/${status.length} applied, ${pending} pending.`);
      break;
    }

    case 'reset': {
      await resetDatabase(config, pool);
      console.log('Database reset and migrated from scratch.');
      break;
    }

    default:
      console.error(`Unknown command "${command}". Use: up | status | reset`);
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('\nMigration failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
