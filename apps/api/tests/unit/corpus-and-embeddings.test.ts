import { describe, expect, it } from 'vitest';
import { DeterministicMockEmbeddingProvider } from '../../src/modules/embeddings/mock-provider.js';
import { assertIngestionCostGuard } from '../../src/modules/embeddings/index.js';
import { cosineSimilarity, parseVectorLiteral, toVectorLiteral } from '../../src/db/vector.js';
import { SeededRandom, seedFromString } from '../../src/utils/random.js';
import { planCorpus, DEMO_PROTECTED_BLUEPRINTS } from '../../src/modules/corpus/corpus-planner.js';
import { ALL_BLUEPRINTS, ANCHOR_BLUEPRINTS } from '../../src/modules/corpus/blueprints/index.js';
import { composeDocument } from '../../src/modules/corpus/document-composer.js';
import { businessExpensePolicy } from '../../src/modules/corpus/blueprints/finance.js';
import { oracleTablespaceGuidelines } from '../../src/modules/corpus/blueprints/oracle.js';
import { planMutation } from '../../src/modules/corpus/revision-mutations.js';
import type { CorpusGenerationOptions } from '../../src/modules/corpus/types.js';
import type { AppConfig } from '../../src/config/index.js';
import type { EmbeddingProvider } from '../../src/modules/embeddings/types.js';

const options = (overrides: Partial<CorpusGenerationOptions> = {}): CorpusGenerationOptions => ({
  profile: 'smoke',
  count: 20,
  seed: 123,
  scannedRatio: 0.1,
  workflowRatio: 0.05,
  multiRevisionRatio: 0.2,
  corruptRatio: 0.01,
  inactiveRatio: 0.04,
  duplicateRatio: 0.03,
  docxRatio: 0.12,
  textRatio: 0.08,
  tableRatio: 0.25,
  reset: false,
  writeEvaluation: false,
  ...overrides,
});

describe('seeded randomness', () => {
  it('produces the same stream for the same seed', () => {
    const a = new SeededRandom(99);
    const b = new SeededRandom(99);
    const draw = (rng: SeededRandom) => Array.from({ length: 20 }, () => rng.next());
    expect(draw(a)).toEqual(draw(b));
  });

  it('produces different streams for adjacent seeds', () => {
    expect(new SeededRandom(1).next()).not.toBe(new SeededRandom(2).next());
  });

  it('derives a stable seed from a string', () => {
    expect(seedFromString('FIN-POL-001')).toBe(seedFromString('FIN-POL-001'));
    expect(seedFromString('FIN-POL-001')).not.toBe(seedFromString('FIN-POL-002'));
  });

  it('keeps pick and sample inside bounds', () => {
    const rng = new SeededRandom(7);
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i += 1) expect(items).toContain(rng.pick(items));
    expect(rng.sample(items, 5)).toHaveLength(3);
    expect(new Set(rng.sample(items, 3)).size).toBe(3);
  });
});

describe('corpus planning', () => {
  it('is reproducible for the same seed', () => {
    const first = planCorpus(options());
    const second = planCorpus(options());

    expect(first.documents.map((document) => document.documentCode)).toEqual(
      second.documents.map((document) => document.documentCode),
    );
    expect(first.documents.map((document) => document.format)).toEqual(
      second.documents.map((document) => document.format),
    );
  });

  it('differs for a different seed', () => {
    const a = planCorpus(options({ seed: 1 }));
    const b = planCorpus(options({ seed: 2 }));
    expect(a.documents.map((d) => d.format).join()).not.toBe(b.documents.map((d) => d.format).join());
  });

  it('assigns the document codes the demo scenarios depend on', () => {
    const plan = planCorpus(options({ count: ANCHOR_BLUEPRINTS.length }));
    const byCode = new Map(plan.documents.map((document) => [document.documentCode, document]));

    expect(byCode.get('FIN-POL-001')?.title).toBe('Business Expense Policy');
    expect(byCode.get('ORA-GUIDE-003')?.title).toBe('Oracle Tablespace Management Guidelines');
    expect(byCode.get('IT-PROC-001')?.title).toBe('Production Incident Management Procedure');
    expect(byCode.get('SEC-POL-001')?.title).toBe('Password Security Policy');
  });

  it('never corrupts, scans or deactivates a demo-protected document', () => {
    const plan = planCorpus(options({ count: 40, corruptRatio: 1, scannedRatio: 1, inactiveRatio: 1 }));

    for (const document of plan.documents) {
      if (!DEMO_PROTECTED_BLUEPRINTS.has(document.blueprintKey)) continue;
      expect(document.format).toBe('pdf');
      expect(document.isActive).toBe(true);
      expect(document.revisions).toHaveLength(1);
      expect(document.revisions.every((revision) => !revision.corrupt)).toBe(true);
    }
  });

  it('only ever corrupts a revision that has a healthy predecessor', () => {
    const plan = planCorpus(options({ count: 60, corruptRatio: 1, multiRevisionRatio: 1 }));

    for (const document of plan.documents) {
      const corrupt = document.revisions.filter((revision) => revision.corrupt);
      for (const revision of corrupt) {
        expect(revision.revisionNumber).toBeGreaterThan(1);
      }
    }
  });

  it('generates unique document codes', () => {
    const plan = planCorpus(options({ count: 200 }));
    const codes = plan.documents.map((document) => document.documentCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('scales past the blueprint catalogue using named variants', () => {
    const plan = planCorpus(options({ count: ALL_BLUEPRINTS.length + 5 }));
    const variants = plan.documents.filter((document) => document.title.includes(' - '));
    expect(variants.length).toBeGreaterThan(0);
  });
});

describe('document composition', () => {
  const compose = (overrides = {}) =>
    composeDocument({
      blueprint: businessExpensePolicy,
      documentCode: 'FIN-POL-001',
      title: businessExpensePolicy.title,
      owner: businessExpensePolicy.ownerRole,
      revisionNumber: 1,
      effectiveDate: '2025-01-01',
      rng: new SeededRandom(555),
      revisionHistory: [{ revision: 1, date: '2025-01-01', summary: 'Initial issue.' }],
      includeWorkflow: false,
      ...overrides,
    });

  it('states every fact somewhere in the document', () => {
    const composed = compose();
    const text = JSON.stringify(composed.content.sections);

    for (const fact of composed.content.facts) {
      expect(text).toContain(fact.value);
    }
  });

  it('produces gold questions whose expected values appear in the document', () => {
    const composed = compose();
    const text = JSON.stringify(composed.content.sections);
    const factValues = new Map(composed.content.facts.map((fact) => [fact.id, fact.value]));

    for (const question of composed.questions) {
      for (const factId of question.factIds) {
        const value = factValues.get(factId);
        expect(value, `question "${question.question}" references unknown fact ${factId}`).toBeDefined();
        expect(text).toContain(value as string);
      }
    }
  });

  it('is deterministic for the same seed', () => {
    expect(JSON.stringify(compose().content)).toBe(JSON.stringify(compose().content));
  });

  it('includes the standard controlled-document sections', () => {
    const titles = compose().content.sections.map((section) => section.title);
    for (const expected of ['Purpose', 'Scope', 'Definitions', 'Responsibilities', 'Revision History']) {
      expect(titles).toContain(expected);
    }
  });
});

describe('revision mutations', () => {
  it('changes the targeted fact and nothing else', () => {
    const composed = composeDocument({
      blueprint: businessExpensePolicy,
      documentCode: 'FIN-POL-001',
      title: businessExpensePolicy.title,
      owner: 'Finance Director',
      revisionNumber: 1,
      effectiveDate: '2025-01-01',
      rng: new SeededRandom(31),
      revisionHistory: [],
      includeWorkflow: false,
    });

    const plan = planMutation(businessExpensePolicy, composed.facts, new SeededRandom(9), {
      factId: 'financeDirectorThreshold',
    });

    expect(plan.mutation.type).toBe('NUMERIC_THRESHOLD');
    expect(plan.mutation.factId).toBe('financeDirectorThreshold');
    expect(Object.keys(plan.factOverrides)).toEqual(['financeDirectorThreshold']);
    expect(plan.mutation.newValue).not.toBe(plan.mutation.previousValue);
  });

  it('always describes the change', () => {
    const composed = composeDocument({
      blueprint: oracleTablespaceGuidelines,
      documentCode: 'ORA-GUIDE-003',
      title: oracleTablespaceGuidelines.title,
      owner: 'Lead Database Administrator',
      revisionNumber: 1,
      effectiveDate: '2025-01-01',
      rng: new SeededRandom(12),
      revisionHistory: [],
      includeWorkflow: false,
    });

    for (let seed = 0; seed < 25; seed += 1) {
      const plan = planMutation(oracleTablespaceGuidelines, composed.facts, new SeededRandom(seed));
      expect(plan.mutation.description.length).toBeGreaterThan(10);
    }
  });
});

describe('deterministic mock embeddings', () => {
  const provider = new DeterministicMockEmbeddingProvider(256);

  it('is deterministic', async () => {
    const a = await provider.embedQuery('expense approval threshold');
    const b = await provider.embedQuery('expense approval threshold');
    expect(a).toEqual(b);
  });

  it('produces unit vectors of the configured dimension', async () => {
    const vector = await provider.embedQuery('anything at all');
    expect(vector).toHaveLength(256);
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('never produces a zero vector, even for empty input', async () => {
    const vector = await provider.embedQuery('');
    expect(vector.some((value) => value !== 0)).toBe(true);
  });

  it('scores overlapping text more similar than unrelated text', async () => {
    const { embeddings } = await provider.embed([
      'finance director approval threshold for expenses',
      'finance director approval threshold for expenditure',
      'oracle tablespace autoextend maxsize configuration',
    ]);

    const [a, b, c] = embeddings as [number[], number[], number[]];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it('declares itself non-semantic', () => {
    expect(provider.semantic).toBe(false);
  });

  it('preserves batch order', async () => {
    const texts = ['one', 'two', 'three'];
    const batch = await provider.embed(texts);
    for (const [index, text] of texts.entries()) {
      expect(batch.embeddings[index]).toEqual(await provider.embedQuery(text));
    }
  });
});

describe('pgvector serialisation', () => {
  it('round-trips a vector', () => {
    const vector = [0.1, -0.25, 0, 1];
    expect(parseVectorLiteral(toVectorLiteral(vector))).toEqual(vector);
  });

  it('rejects non-finite values', () => {
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/non-finite/);
  });

  it('rejects a malformed literal', () => {
    expect(() => parseVectorLiteral('1,2,3')).toThrow(/malformed/);
  });
});

describe('OpenAI cost guard', () => {
  const openaiProvider = { name: 'openai', semantic: true } as EmbeddingProvider;
  const mockProvider = { name: 'mock', semantic: false } as EmbeddingProvider;

  const config = (allow: boolean, threshold = 250) =>
    ({ ingestion: { allowLargeOpenAIIngestion: allow, largeOpenAIThreshold: threshold } }) as AppConfig;

  it('blocks a large OpenAI run that was not explicitly allowed', () => {
    expect(() => assertIngestionCostGuard(5000, openaiProvider, config(false))).toThrow(/Refusing to embed/);
  });

  it('allows it when explicitly permitted', () => {
    expect(() => assertIngestionCostGuard(5000, openaiProvider, config(true))).not.toThrow();
  });

  it('allows a run below the threshold', () => {
    expect(() => assertIngestionCostGuard(100, openaiProvider, config(false))).not.toThrow();
  });

  it('never blocks the mock provider', () => {
    expect(() => assertIngestionCostGuard(100_000, mockProvider, config(false))).not.toThrow();
  });
});
