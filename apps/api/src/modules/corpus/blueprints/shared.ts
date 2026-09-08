/**
 * Blueprint scaffolding.
 *
 * A blueprint describes one kind of real enterprise document: what facts it
 * asserts, how those facts are worded, and which sections they live in. The
 * generator instantiates a blueprint with a seeded RNG, so the same seed always
 * produces the same "Annual Leave Policy" with the same numbers - which is what
 * makes evaluation reproducible.
 */

import type { Department, DocumentType } from '@docs-rag/shared';
import type { SeededRandom } from '../../../utils/random.js';
import type { DocumentFact, SyntheticSection, SyntheticWorkflow } from '../types.js';

export interface FactSpec {
  id: string;
  label: string;
  /** Section the fact is stated in - becomes `expectedSection` in evaluation. */
  sectionKey: string;
  generate(rng: SeededRandom): { value: string; numericValue?: number; unit?: string };
}

/** Runtime view of a blueprint's facts, handed to section builders. */
export interface BlueprintContext {
  rng: SeededRandom;
  documentCode: string;
  title: string;
  effectiveDate: string;
  revisionNumber: number;
  owner: string;
  /** Rendered value of a fact, e.g. "$25,000". */
  f(id: string): string;
  /** Numeric component of a fact. */
  n(id: string): number;
  facts: DocumentFact[];
}

export interface GoldQuestionSeed {
  /** Distinguishes the question shape for reporting and coverage checks. */
  type: 'DIRECT' | 'PARAPHRASE' | 'TERMINOLOGY' | 'IDENTIFIER' | 'CROSS_SECTION' | 'REVISION_SENSITIVE';
  question: string;
  sectionKey: string;
  /** Fact ids whose rendered values must appear in a correct answer. */
  factIds: string[];
  referenceAnswer: string;
}

export interface Blueprint {
  key: string;
  /** Document code prefix, e.g. "FIN-POL". Numbering is assigned by the generator. */
  codePrefix: string;
  title: string;
  department: Department;
  documentType: DocumentType;
  category: string;
  ownerRole: string;
  tags: string[];
  description: string;
  purpose: string;
  scope: string;
  facts: FactSpec[];
  /** Distinctive body sections. Boilerplate sections are added by the composer. */
  build(context: BlueprintContext): SyntheticSection[];
  workflow?(context: BlueprintContext): SyntheticWorkflow;
  questions(context: BlueprintContext): GoldQuestionSeed[];
}

// --- Fact value generators -------------------------------------------------

export function money(min: number, max: number, step = 500): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.money(min, max, step);
    return { value: `$${amount.toLocaleString('en-US')}`, numericValue: amount, unit: 'USD' };
  };
}

export function days(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} days`, numericValue: amount, unit: 'days' };
  };
}

export function calendarDays(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} calendar days`, numericValue: amount, unit: 'calendar days' };
  };
}

export function businessDays(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} business days`, numericValue: amount, unit: 'business days' };
  };
}

export function minutes(min: number, max: number, step = 5): FactSpec['generate'] {
  return (rng) => {
    const amount = min + rng.int(0, Math.floor((max - min) / step)) * step;
    return { value: `${amount} minutes`, numericValue: amount, unit: 'minutes' };
  };
}

export function hours(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} hours`, numericValue: amount, unit: 'hours' };
  };
}

export function weeks(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} weeks`, numericValue: amount, unit: 'weeks' };
  };
}

export function months(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} months`, numericValue: amount, unit: 'months' };
  };
}

export function years(min: number, max: number): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} years`, numericValue: amount, unit: 'years' };
  };
}

export function percent(min: number, max: number, step = 1): FactSpec['generate'] {
  return (rng) => {
    const amount = min + rng.int(0, Math.floor((max - min) / step)) * step;
    return { value: `${amount}%`, numericValue: amount, unit: 'percent' };
  };
}

export function count(min: number, max: number, unit: string): FactSpec['generate'] {
  return (rng) => {
    const amount = rng.int(min, max);
    return { value: `${amount} ${unit}`, numericValue: amount, unit };
  };
}

export function choice(options: readonly string[]): FactSpec['generate'] {
  return (rng) => ({ value: rng.pick(options) });
}

export function fact(
  id: string,
  label: string,
  sectionKey: string,
  generate: FactSpec['generate'],
): FactSpec {
  return { id, label, sectionKey, generate };
}

// --- Shared vocabulary -----------------------------------------------------

export const APPROVAL_ROLES = [
  'Department Manager',
  'Finance Director',
  'Chief Financial Officer',
  'Head of Operations',
  'Chief Information Officer',
  'Chief Information Security Officer',
  'Procurement Manager',
  'Head of Human Resources',
] as const;

export const REVIEW_CYCLES = ['annually', 'every 12 months', 'every 18 months', 'every two years'] as const;

export const ORACLE_VERSIONS = ['19c', '21c', '23ai'] as const;

// --- Boilerplate section builders -----------------------------------------

/**
 * Definitions section. Real policies open with one, and it is a useful
 * retrieval target for terminology questions ("what does the policy mean by
 * 'material expenditure'?").
 */
export function definitionsSection(entries: readonly [string, string][]): SyntheticSection {
  return {
    key: 'definitions',
    title: 'Definitions',
    paragraphs: [
      'The following terms are used throughout this document and carry the meanings set out below.',
    ],
    bullets: entries.map(([term, meaning]) => `${term}: ${meaning}`),
  };
}

export function responsibilitiesSection(entries: readonly [string, string][]): SyntheticSection {
  return {
    key: 'responsibilities',
    title: 'Responsibilities',
    paragraphs: [
      'Accountability for the requirements in this document is distributed as described in the table below. ' +
        'Where a responsibility is shared, the first named role is accountable for the outcome.',
    ],
    table: {
      caption: 'Role responsibilities',
      header: ['Role', 'Responsibility'],
      rows: entries.map(([role, responsibility]) => [role, responsibility]),
    },
  };
}

export function exceptionsSection(approver: string, windowText: string): SyntheticSection {
  return {
    key: 'exceptions',
    title: 'Exceptions',
    paragraphs: [
      `Any deviation from this document must be requested in writing and approved by the ${approver} before ` +
        'the activity takes place. Retrospective approval is granted only where a documented emergency ' +
        'prevented prior submission.',
      `Approved exceptions are valid for ${windowText} unless a shorter period is stated in the approval, ` +
        'and are recorded in the governance register with the business justification.',
    ],
  };
}

export function relatedDocumentsSection(entries: readonly string[]): SyntheticSection {
  return {
    key: 'related-documents',
    title: 'Related Documents',
    paragraphs: ['This document should be read together with the following:'],
    bullets: [...entries],
  };
}

export function complianceSection(reviewCycle: string, owner: string): SyntheticSection {
  return {
    key: 'compliance',
    title: 'Compliance and Review',
    paragraphs: [
      `This document is reviewed ${reviewCycle} by the ${owner}, and after any material change to the ` +
        'underlying process, regulation or supporting system.',
      'Non-compliance is handled through the standard management process and may be escalated where the ' +
        'breach creates financial, legal or security exposure.',
    ],
  };
}
