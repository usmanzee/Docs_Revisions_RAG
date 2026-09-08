/**
 * Minimal, safe helper for composing dynamic SQL.
 *
 * Filters are optional in several read paths (department, document type,
 * pagination, ...). Building those with string concatenation is exactly how SQL
 * injection happens, so the only thing this helper ever appends to the SQL text
 * is a `$n` placeholder - values go into a separate array and never touch the
 * statement.
 */

export class ParamList {
  private readonly values: unknown[] = [];

  /** Register a value and return the placeholder that refers to it. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** Current parameter array, ready to pass to `query()`. */
  all(): unknown[] {
    return [...this.values];
  }

  get length(): number {
    return this.values.length;
  }
}

/** Join non-empty conditions into a WHERE clause (or an empty string). */
export function buildWhere(conditions: readonly string[]): string {
  const active = conditions.filter((condition) => condition.trim().length > 0);
  return active.length === 0 ? '' : `WHERE ${active.join(' AND ')}`;
}

/** Whitelist-based ORDER BY so a client-supplied sort key can never be SQL. */
export function buildOrderBy(
  requested: string | null | undefined,
  allowed: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (!requested) return fallback;
  const [field, directionRaw] = requested.split(':');
  const column = field ? allowed[field] : undefined;
  if (!column) return fallback;
  const direction = (directionRaw ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `${column} ${direction}`;
}

export interface PageRequest {
  page: number;
  pageSize: number;
}

export function offsetFor({ page, pageSize }: PageRequest): number {
  return (Math.max(1, page) - 1) * pageSize;
}

export function buildPagination<T>(items: T[], total: number, request: PageRequest) {
  return {
    items,
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages: request.pageSize > 0 ? Math.ceil(total / request.pageSize) : 0,
  };
}
