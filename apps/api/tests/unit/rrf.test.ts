import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, reciprocalRankFusion, type RankedList } from '../../src/modules/retrieval/rrf.js';

const list = (name: string, ids: string[]): RankedList => ({
  name,
  items: ids.map((id, index) => ({ id, score: 1 - index * 0.1 })),
});

describe('reciprocal rank fusion', () => {
  it('scores by rank position, not by source score magnitude', () => {
    // Lexical scores here are two orders of magnitude larger than the vector
    // scores. RRF must ignore that entirely - which is the reason it is used.
    const vector: RankedList = { name: 'vector', items: [{ id: 'a', score: 0.81 }] };
    const lexical: RankedList = { name: 'lexical', items: [{ id: 'b', score: 148.2 }] };

    const [first, second] = reciprocalRankFusion([vector, lexical]);

    expect(first?.rrfScore).toBeCloseTo(second?.rrfScore ?? 0, 10);
  });

  it('rewards agreement across lists', () => {
    // "b" is second in both lists; "a" is first in one and absent from the
    // other. Two second places should beat one first place at k=60.
    const fused = reciprocalRankFusion([list('vector', ['a', 'b']), list('lexical', ['c', 'b'])]);

    expect(fused[0]?.id).toBe('b');
    expect(fused[0]?.sources).toBe(2);
  });

  it('applies the documented formula', () => {
    const fused = reciprocalRankFusion([list('vector', ['a'])], { k: 60 });
    expect(fused[0]?.rrfScore).toBeCloseTo(1 / 61, 10);
  });

  it('honours per-list weights', () => {
    const strong: RankedList = { name: 'strong', items: [{ id: 'a', score: 1 }], weight: 1 };
    const weak: RankedList = { name: 'weak', items: [{ id: 'b', score: 1 }], weight: 0.5 };

    const fused = reciprocalRankFusion([strong, weak]);

    expect(fused[0]?.id).toBe('a');
    expect(fused[1]?.rrfScore).toBeCloseTo((fused[0]?.rrfScore ?? 0) / 2, 10);
  });

  it('records the rank and source score from every contributing list', () => {
    const fused = reciprocalRankFusion([list('vector', ['x', 'a']), list('lexical', ['a'])]);
    const entry = fused.find((item) => item.id === 'a');

    expect(entry?.ranks).toEqual({ vector: 2, lexical: 1 });
    expect(entry?.scores.vector).toBeCloseTo(0.9, 10);
  });

  it('is deterministic when scores tie', () => {
    const lists = [list('vector', ['b', 'a']), list('lexical', ['a', 'b'])];

    const first = reciprocalRankFusion(lists).map((item) => item.id);
    const second = reciprocalRankFusion(lists).map((item) => item.id);

    expect(first).toEqual(second);
  });

  it('applies the limit after ordering', () => {
    const fused = reciprocalRankFusion([list('vector', ['a', 'b', 'c', 'd'])], { limit: 2 });
    expect(fused).toHaveLength(2);
    expect(fused[0]?.id).toBe('a');
  });

  it('rejects a non-positive k', () => {
    expect(() => reciprocalRankFusion([list('vector', ['a'])], { k: 0 })).toThrow(/positive/);
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ name: 'vector', items: [] }])).toEqual([]);
  });

  it('uses 60 as the default k', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });
});
