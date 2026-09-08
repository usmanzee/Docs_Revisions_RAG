/**
 * Forward-only SQL migration runner.
 *
 * Deliberately not "sync the schema from application models on boot": the
 * schema is a reviewed artefact, applied explicitly, recorded with a checksum
 * so an edited-after-the-fact migration is caught instead of silently diverging
 * between environments.
 *
 * Templating: a migration may contain `{{EMBEDDING_DIMENSIONS}}`. It is
 * substituted from configuration at apply time, which is how the vector
 * dimension stays a single configurable value instead of a constant duplicated
 * across SQL and TypeScript. Only a fixed allow-list of keys is substituted,
 * and each value is validated as an integer before it reaches the SQL text.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { getConfig, type AppConfig } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { childLogger } from '../utils/logger.js';
import { getPool, queryRows, withTransaction } from './pool.js';

export interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(32)  PRIMARY KEY,
    name        TEXT         NOT NULL,
    checksum    VARCHAR(64)  NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    duration_ms INTEGER      NOT NULL DEFAULT 0
);`;

export function migrationsDirectory(config: AppConfig = getConfig()): string {
  return path.join(config.repoRoot, 'migrations');
}

/** Values injectable into migration SQL. Integers only - never free text. */
function templateValues(config: AppConfig): Record<string, string> {
  return {
    EMBEDDING_DIMENSIONS: String(config.embedding.dimensions),
  };
}

function applyTemplate(sql: string, values: Record<string, string>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new AppError('CONFIGURATION_ERROR', `migration references unknown template key {{${key}}}`, {
        expected: false,
      });
    }
    if (!/^\d+$/.test(value)) {
      throw new AppError('CONFIGURATION_ERROR', `migration template value for ${key} must be an integer`, {
        expected: false,
      });
    }
    return value;
  });
}

export async function loadMigrations(config: AppConfig = getConfig()): Promise<MigrationFile[]> {
  const directory = migrationsDirectory(config);
  const entries = await readdir(directory);
  const sqlFiles = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const values = templateValues(config);
  const migrations: MigrationFile[] = [];

  for (const fileName of sqlFiles) {
    const match = /^(\d{4})_(.+)\.sql$/.exec(fileName);
    if (!match) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        `migration file "${fileName}" does not follow the NNNN_name.sql convention`,
        { expected: false },
      );
    }
    const filePath = path.join(directory, fileName);
    const raw = await readFile(filePath, 'utf8');
    const sql = applyTemplate(raw, values);
    migrations.push({
      version: match[1] as string,
      name: match[2] as string,
      filePath,
      sql,
      // Checksum the *templated* SQL: changing EMBEDDING_DIMENSIONS genuinely
      // changes the schema those statements would produce.
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
}

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(MIGRATIONS_TABLE);
}

export async function getAppliedMigrations(pool: pg.Pool = getPool()): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(pool);
  return queryRows<AppliedMigration>(
    'SELECT version, name, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version',
    [],
    pool,
  );
}

export interface MigrationStatus {
  version: string;
  name: string;
  applied: boolean;
  appliedAt: Date | null;
  checksumMatches: boolean | null;
}

export async function getMigrationStatus(
  config: AppConfig = getConfig(),
  pool: pg.Pool = getPool(),
): Promise<MigrationStatus[]> {
  const [files, applied] = await Promise.all([loadMigrations(config), getAppliedMigrations(pool)]);
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  return files.map((file) => {
    const record = appliedByVersion.get(file.version);
    return {
      version: file.version,
      name: file.name,
      applied: record !== undefined,
      appliedAt: record?.applied_at ?? null,
      checksumMatches: record ? record.checksum === file.checksum : null,
    };
  });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every pending migration in version order.
 *
 * Each migration runs in its own transaction, so a failure leaves the database
 * at the last fully-applied version rather than half-way through one.
 */
export async function migrateUp(
  config: AppConfig = getConfig(),
  pool: pg.Pool = getPool(),
): Promise<MigrateResult> {
  const logger = childLogger({ component: 'migrator' });
  await ensureMigrationsTable(pool);

  const files = await loadMigrations(config);
  const applied = await getAppliedMigrations(pool);
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const file of files) {
    const record = appliedByVersion.get(file.version);

    if (record) {
      if (record.checksum !== file.checksum) {
        throw new AppError(
          'CONFIGURATION_ERROR',
          `Migration ${file.version}_${file.name} has changed since it was applied ` +
            `(expected checksum ${record.checksum.slice(0, 12)}, found ${file.checksum.slice(0, 12)}). ` +
            'Applied migrations are immutable - add a new migration instead. ' +
            'If EMBEDDING_DIMENSIONS was changed, re-run migrations on an empty database.',
          { expected: false },
        );
      }
      result.skipped.push(file.version);
      continue;
    }

    const started = performance.now();
    await withTransaction(async (client) => {
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
        [file.version, file.name, file.checksum, Math.round(performance.now() - started)],
      );
    }, pool);

    const durationMs = Math.round(performance.now() - started);
    logger.info({ version: file.version, name: file.name, durationMs }, 'migration applied');
    result.applied.push(file.version);
  }

  return result;
}

/**
 * Drop every application object and re-apply from scratch.
 * Refuses to run against NODE_ENV=production - this is a development and test
 * convenience, not an operations tool.
 */
export async function resetDatabase(
  config: AppConfig = getConfig(),
  pool: pg.Pool = getPool(),
): Promise<void> {
  if (config.isProduction) {
    throw new AppError('FORBIDDEN', 'refusing to reset the database while NODE_ENV=production');
  }

  const logger = childLogger({ component: 'migrator' });
  logger.warn('dropping and recreating the public schema');

  // DROP SCHEMA is the only reliable way to remove tables, types, triggers and
  // functions in dependency order without maintaining a teardown script.
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');

  await migrateUp(config, pool);
}
