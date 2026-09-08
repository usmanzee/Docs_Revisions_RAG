/**
 * Compose a full document from a blueprint.
 *
 * Facts are instantiated once from the seeded RNG, then handed to the
 * blueprint's section builder. Because the builder reads facts through the
 * context rather than generating numbers inline, the same fact value appears
 * consistently in the prose, in the table and in the gold answer - and a
 * revision that changes the fact changes all three together, exactly as a real
 * document revision would.
 */

import type { SeededRandom } from '../../utils/random.js';
import type { Blueprint, BlueprintContext, GoldQuestionSeed } from './blueprints/index.js';
import type { DocumentFact, SyntheticDocumentContent, SyntheticSection } from './types.js';

export interface ComposeInput {
  blueprint: Blueprint;
  documentCode: string;
  title: string;
  owner: string;
  revisionNumber: number;
  effectiveDate: string;
  rng: SeededRandom;
  /** Fact overrides applied by a revision mutation. */
  factOverrides?: Record<string, DocumentFact>;
  revisionHistory: { revision: number; date: string; summary: string }[];
  includeWorkflow: boolean;
}

export interface ComposedDocument {
  content: SyntheticDocumentContent;
  facts: Record<string, DocumentFact>;
  questions: GoldQuestionSeed[];
}

/** Instantiate a blueprint's facts, honouring any revision overrides. */
export function instantiateFacts(
  blueprint: Blueprint,
  rng: SeededRandom,
  overrides: Record<string, DocumentFact> = {},
): Record<string, DocumentFact> {
  const facts: Record<string, DocumentFact> = {};

  for (const spec of blueprint.facts) {
    // Draw for every fact even when an override exists, so the RNG stream stays
    // aligned and unrelated facts keep the values they had in revision 1.
    const generated = spec.generate(rng);
    const override = overrides[spec.id];

    facts[spec.id] = override ?? {
      id: spec.id,
      label: spec.label,
      sectionKey: spec.sectionKey,
      value: generated.value,
      numericValue: generated.numericValue,
      unit: generated.unit,
    };
  }

  return facts;
}

function buildContext(input: ComposeInput, facts: Record<string, DocumentFact>): BlueprintContext {
  return {
    rng: input.rng,
    documentCode: input.documentCode,
    title: input.title,
    effectiveDate: input.effectiveDate,
    revisionNumber: input.revisionNumber,
    owner: input.owner,
    facts: Object.values(facts),
    f: (id: string) => {
      const value = facts[id]?.value;
      if (value === undefined) throw new Error(`blueprint "${input.blueprint.key}" referenced unknown fact "${id}"`);
      return value;
    },
    n: (id: string) => {
      const value = facts[id]?.numericValue;
      if (value === undefined) {
        throw new Error(`fact "${id}" in "${input.blueprint.key}" has no numeric component`);
      }
      return value;
    },
  };
}

export function composeDocument(input: ComposeInput): ComposedDocument {
  const { blueprint } = input;
  const facts = instantiateFacts(blueprint, input.rng, input.factOverrides);
  const context = buildContext(input, facts);

  const bodySections = blueprint.build(context);
  const workflow = input.includeWorkflow && blueprint.workflow ? blueprint.workflow(context) : undefined;

  const sections: SyntheticSection[] = [
    {
      key: 'purpose',
      title: 'Purpose',
      paragraphs: [blueprint.purpose],
    },
    {
      key: 'scope',
      title: 'Scope',
      paragraphs: [blueprint.scope],
    },
    ...bodySections,
  ];

  if (workflow) {
    // The diagram is rendered as an image by the PDF renderer; the textual form
    // stays in the document so text-only formats remain complete.
    sections.push({
      key: 'workflow',
      title: 'Process Flow',
      paragraphs: [
        `The diagram below summarises the ${workflow.title.toLowerCase()}. Where the diagram and the ` +
          'text of this document differ, the text takes precedence.',
      ],
      steps: workflow.nodes,
    });
  }

  sections.push({
    key: 'revision-history',
    title: 'Revision History',
    paragraphs: ['Changes to this document are recorded below.'],
    table: {
      caption: 'Revision history',
      header: ['Revision', 'Effective date', 'Summary of change'],
      rows: input.revisionHistory.map((entry) => [
        String(entry.revision),
        entry.date,
        entry.summary,
      ]),
    },
  });

  const content: SyntheticDocumentContent = {
    documentCode: input.documentCode,
    title: input.title,
    department: blueprint.department,
    documentType: blueprint.documentType,
    category: blueprint.category,
    owner: input.owner,
    effectiveDate: input.effectiveDate,
    revisionNumber: input.revisionNumber,
    reviewCycle: 'annually',
    purpose: blueprint.purpose,
    scope: blueprint.scope,
    sections,
    facts: Object.values(facts),
    workflow,
    revisionHistory: input.revisionHistory,
  };

  return { content, facts, questions: blueprint.questions(context) };
}

/** Flatten a document to plain text - used for hashing and the .txt renderer. */
export function sectionToLines(section: SyntheticSection, depth = 2): string[] {
  const lines: string[] = [];
  lines.push('', `${'#'.repeat(Math.min(depth, 6))} ${section.title}`, '');

  for (const paragraph of section.paragraphs) lines.push(paragraph, '');

  if (section.bullets?.length) {
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    lines.push('');
  }

  if (section.steps?.length) {
    section.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }

  if (section.table) {
    if (section.table.caption) lines.push(`${section.table.caption}:`, '');
    lines.push(`| ${section.table.header.join(' | ')} |`);
    lines.push(`| ${section.table.header.map(() => '---').join(' | ')} |`);
    for (const row of section.table.rows) lines.push(`| ${row.join(' | ')} |`);
    lines.push('');
  }

  for (const subsection of section.subsections ?? []) {
    lines.push(...sectionToLines(subsection, depth + 1));
  }

  return lines;
}

export function documentToMarkdown(content: SyntheticDocumentContent): string {
  const lines: string[] = [
    `# ${content.documentCode} ${content.title}`,
    '',
    `Document Code: ${content.documentCode}`,
    `Title: ${content.title}`,
    `Department: ${content.department}`,
    `Document Type: ${content.documentType}`,
    `Category: ${content.category}`,
    `Owner: ${content.owner}`,
    `Effective Date: ${content.effectiveDate}`,
    `Revision: ${content.revisionNumber}`,
    `Review Cycle: ${content.reviewCycle}`,
  ];

  for (const section of content.sections) lines.push(...sectionToLines(section, 2));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
