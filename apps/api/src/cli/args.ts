/**
 * Minimal CLI argument parsing.
 *
 * Supports the `--flag`, `--key=value` and `--key value` forms the project's
 * scripts use. Written here rather than pulled in as a dependency because the
 * surface is this small and every script needs identical, predictable behaviour.
 */

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');

    if (equals !== -1) {
      values.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      index += 1;
      continue;
    }

    flags.add(body);
    // A bare `--flag` is also readable as the string "true", so callers can use
    // one accessor for both spellings.
    values.set(body, 'true');
  }

  return { flags, values, positional };
}

export function getString(args: ParsedArgs, name: string, fallback: string): string;
export function getString(args: ParsedArgs, name: string): string | undefined;
export function getString(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  return args.values.get(name) ?? fallback;
}

export function getNumber(args: ParsedArgs, name: string, fallback: number): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} expects a number, received "${raw}"`);
  }
  return parsed;
}

export function getOptionalNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = args.values.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, received "${raw}"`);
  return parsed;
}

export function getBoolean(args: ParsedArgs, name: string, fallback = false): boolean {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function getEnum<T extends string>(
  args: ParsedArgs,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`--${name} must be one of: ${allowed.join(', ')} (received "${raw}")`);
  }
  return raw as T;
}
