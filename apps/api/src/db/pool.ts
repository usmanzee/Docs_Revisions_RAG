/**
 * PostgreSQL connection pooling and transaction helpers.
 *
 * Every query in the application goes through this module. Two rules follow
 * from that and are enforced by convention plus code review:
 *   1. All SQL is parameterised - no value is ever interpolated into a query
 *      string. Dynamic *structure* (e.g. an optional WHERE clause) is built
 *      with a small builder that still emits placeholders.
 *   2. Multi-statement invariants (above all revision activation) run inside
 *      `withTransaction`, so a failure rolls back rather than leaving a
 *      document with zero current revisions.
 */

import pg from 'pg';
import type { AppConfig } from '../config/index.js';
import { getConfig } from '../config/index.js';
import { AppError, toErrorMessage } from '../utils/errors.js';
import { childLogger } from '../utils/logger.js';

const { Pool } = pg;

export type QueryParam = unknown;

/** The subset of node-postgres we depend on - a pool or a checked-out client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * `bigint` (int8) and `numeric` arrive as strings by default because they can
 * exceed IEEE-754 range. Every int8 we select is a count or a byte size that is
 * comfortably within safe-integer range, so parsing them here removes a pile of
 * `Number(row.count)` noise from the repositories.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

let pool: pg.Pool | null = null;

export function createPool(config: AppConfig = getConfig()): pg.Pool {
  const logger = childLogger({ component: 'db' });

  const instance = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    // A query that runs away should die rather than pin a pool slot forever.
    statement_timeout: config.database.statementTimeoutMs,
    application_name: 'docs-rag-api',
    allowExitOnIdle: false,
  });

  // An idle client erroring (server restart, network blip) must not take the
  // process down - the pool discards it and the next checkout reconnects.
  instance.on('error', (error) => {
    logger.error({ err: { message: toErrorMessage(error) } }, 'idle postgres client error');
  });

  return instance;
}

export function getPool(): pg.Pool {
  pool ??= createPool();
  return pool;
}

/** Swap in an explicitly constructed pool (integration tests, CLI scripts). */
export function setPool(instance: pg.Pool): void {
  pool = instance;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: QueryParam[] = [],
  executor: Queryable = getPool(),
): Promise<pg.QueryResult<R>> {
  return executor.query<R>(text, values);
}

/** Convenience for the very common "select many rows" shape. */
export async function queryRows<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: QueryParam[] = [],
  executor: Queryable = getPool(),
): Promise<R[]> {
  const result = await executor.query<R>(text, values);
  return result.rows;
}

/** Convenience for "select at most one row". */
export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: QueryParam[] = [],
  executor: Queryable = getPool(),
): Promise<R | null> {
  const result = await executor.query<R>(text, values);
  return result.rows[0] ?? null;
}

/**
 * Run `handler` inside a transaction, committing on success and rolling back on
 * any throw. The handler receives the checked-out client and must use it for
 * every statement that belongs to the transaction.
 */
export async function withTransaction<T>(
  handler: (client: pg.PoolClient) => Promise<T>,
  instance: pg.Pool = getPool(),
): Promise<T> {
  const client = await instance.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      childLogger({ component: 'db' }).error(
        { err: { message: toErrorMessage(rollbackError) } },
        'rollback failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Try to take a PostgreSQL advisory lock for the duration of `handler`.
 * Used to stop two ingestion runs (scheduler + manual trigger) overlapping.
 * Returns `null` immediately when the lock is already held.
 */
export async function withAdvisoryLock<T>(
  lockKey: number,
  handler: () => Promise<T>,
  instance: pg.Pool = getPool(),
): Promise<T | null> {
  // A dedicated connection, deliberately NOT taken from the pool.
  //
  // A session-level advisory lock lives for as long as its connection, so it
  // must be held for the entire run - and an ingestion run is long. Borrowing a
  // pool slot for that whole time is a self-deadlock waiting to happen: the run
  // it is protecting needs concurrent slots for its transactions, and on a small
  // pool the lock holder is the slot that tips it over. Costing one extra
  // connection is far cheaper than an ingestion run that hangs forever.
  const client = new pg.Client({
    connectionString: connectionStringFor(instance),
    application_name: 'docs-rag-advisory-lock',
  });

  await client.connect();

  try {
    const acquired = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      lockKey,
    ]);
    if (!acquired.rows[0]?.locked) return null;
    try {
      return await handler();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    // Ending the connection would release the lock anyway; unlocking first keeps
    // the intent explicit and survives a future move to a pooled connection.
    await client.end().catch(() => undefined);
  }
}

/**
 * Recover the connection string a pool was built with.
 *
 * node-postgres keeps it on the pool's options. Falling back to configuration
 * keeps this honest if a pool was constructed some other way.
 */
function connectionStringFor(instance: pg.Pool): string {
  const options = (instance as unknown as { options?: { connectionString?: string } }).options;
  return options?.connectionString ?? getConfig().database.url;
}

/** Stable advisory-lock keys. Arbitrary but must not collide. */
export const ADVISORY_LOCKS = {
  ingestionRun: 918_273_641,
} as const;

export async function assertDatabaseReachable(instance: pg.Pool = getPool()): Promise<void> {
  try {
    await instance.query('SELECT 1');
  } catch (error) {
    throw new AppError('DATABASE_ERROR', `cannot reach PostgreSQL: ${toErrorMessage(error)}`, {
      cause: error,
      expected: false,
    });
  }
}

/**
 * Guard against the single most damaging configuration mistake in this system:
 * an EMBEDDING_DIMENSIONS value that disagrees with the dimension the migrations
 * baked into `document_chunks.embedding`. Inserting would fail row by row deep
 * inside ingestion; failing at boot is far kinder.
 */
export async function assertSchemaCompatibility(
  config: AppConfig = getConfig(),
  instance: pg.Pool = getPool(),
): Promise<void> {
  const row = await queryOne<{ value: string }>(
    'SELECT value FROM system_settings WHERE key = $1',
    ['embedding_dimensions'],
    instance,
  );

  if (!row) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'system_settings.embedding_dimensions is missing. Run `npm run db:migrate` before starting the API.',
      { expected: false },
    );
  }

  const schemaDimensions = Number.parseInt(row.value, 10);
  if (schemaDimensions !== config.embedding.dimensions) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      `Embedding dimension mismatch: the database column is vector(${schemaDimensions}) but ` +
        `EMBEDDING_DIMENSIONS=${config.embedding.dimensions}. Either restore the environment value or ` +
        're-run migrations against an empty database with the new dimension.',
      { expected: false },
    );
  }
}
