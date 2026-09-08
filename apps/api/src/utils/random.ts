/**
 * Deterministic pseudo-random number generation.
 *
 * The synthetic corpus must be reproducible: the same seed must always produce
 * the same documents, revisions, defect placement and evaluation questions.
 * Math.random() cannot do that, so this is a small, well-behaved PRNG
 * (mulberry32 seeded through splitmix32) with the helpers the generator needs.
 */

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // splitmix32 avalanche so nearby seeds produce unrelated streams.
    let x = seed >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
    this.state = (x ^ (x >>> 15)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`invalid range [${min}, ${max}]`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** `count` distinct items (or all of them, if the list is shorter). */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const taken: T[] = [];
    const target = Math.min(count, pool.length);
    for (let i = 0; i < target; i += 1) {
      const index = this.int(0, pool.length - 1);
      taken.push(pool.splice(index, 1)[0] as T);
    }
    return taken;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = result[i] as T;
      const b = result[j] as T;
      result[i] = b;
      result[j] = a;
    }
    return result;
  }

  /** A rounded "money-shaped" number, e.g. 5000, 7500, 12500. */
  money(min: number, max: number, step = 500): number {
    const steps = Math.floor((max - min) / step);
    return min + this.int(0, steps) * step;
  }

  /** Deterministic date offset from a fixed epoch, formatted YYYY-MM-DD. */
  dateBetween(startIso: string, endIso: string): Date {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    return new Date(start + Math.floor(this.next() * (end - start)));
  }

  /** Fork a child generator so one sub-system's draws cannot shift another's. */
  fork(salt: number): SeededRandom {
    return new SeededRandom((this.int(0, 2 ** 30) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

/** Stable numeric seed derived from a string, for per-document sub-streams. */
export function seedFromString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
