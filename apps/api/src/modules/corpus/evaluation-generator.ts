/**
 * Gold evaluation dataset generation.
 *
 * Questions are derived from the same facts the documents assert, at the moment
 * those documents are generated. That is the whole point: the expected answer
 * is known by construction rather than written by hand afterwards, so retrieval
 * and answer quality can be scored objectively and the dataset stays in sync
 * with the corpus it describes.
 *
 * The dataset deliberately includes questions that must NOT be answerable. A
 * system that answers everything is not grounded, and without negative examples
 * that failure is invisible.
 */

import type { EvaluationQuestion } from '@docs-rag/shared';
import type { SeededRandom } from '../../utils/random.js';
import type { GoldQuestionSeed } from './blueprints/index.js';
import type { GeneratedDocument, SyntheticDocumentContent } from './types.js';

export interface EvaluationRecord extends EvaluationQuestion {
  corpusSeed: number;
  corpusProfile: string;
  /** Present for revision-sensitive questions - the value before the change. */
  supersededAnswer?: string;
}

/**
 * Questions about plausible enterprise topics the corpus genuinely does not
 * cover. The right behaviour is an explicit "not enough information", so these
 * measure refusal rather than recall.
 */
const NO_ANSWER_QUESTIONS: readonly string[] = [
  'What is the company policy on cryptocurrency payments to suppliers?',
  'How many parking spaces are allocated to each department at the head office?',
  'What is the maximum reimbursement for pet insurance under the benefits scheme?',
  'Which airline holds our negotiated corporate discount agreement?',
  'What is the notice period for terminating the office cleaning contract?',
  'How much annual budget is allocated to the employee social committee?',
  'What is the procedure for requesting a company car?',
  'Which vendor supplies the canteen coffee machines?',
  'What is the escalation path for a complaint about building temperature?',
  'How many days of paid sabbatical leave are available after ten years of service?',
  'What is the approved supplier for corporate branded merchandise?',
  'What percentage discount do employees receive on company products?',
];

function sectionTitleFor(content: SyntheticDocumentContent, sectionKey: string): string | null {
  const search = (sections: SyntheticDocumentContent['sections']): string | null => {
    for (const section of sections) {
      if (section.key === sectionKey) return section.title;
      const nested = section.subsections ? search(section.subsections) : null;
      if (nested) return nested;
    }
    return null;
  };
  return search(content.sections);
}

function expectedFactValues(content: SyntheticDocumentContent, factIds: readonly string[]): string[] {
  const byId = new Map(content.facts.map((fact) => [fact.id, fact]));
  return factIds
    .map((id) => byId.get(id)?.value)
    .filter((value): value is string => value !== undefined);
}

function buildRecord(
  document: GeneratedDocument,
  seed: GoldQuestionSeed,
  index: number,
  options: { seed: number; profile: string },
): EvaluationRecord | null {
  // Questions always target the revision that will be current after ingestion.
  const current = document.revisions.filter((revision) => !revision.corrupt).at(-1);
  if (!current) return null;

  const { content } = current;
  const facts = expectedFactValues(content, seed.factIds);

  // A fact-based question whose facts did not render is not verifiable; drop it
  // rather than ship a question with an unscoreable expected answer.
  if (seed.factIds.length > 0 && facts.length === 0) return null;

  const record: EvaluationRecord = {
    id: `${content.documentCode}-q${String(index + 1).padStart(2, '0')}`,
    question: seed.question,
    questionType: seed.type,
    expectedDocumentCode: content.documentCode,
    expectedRevision: current.revisionNumber,
    expectedSection: sectionTitleFor(content, seed.sectionKey),
    referenceAnswer: seed.referenceAnswer,
    expectedFacts: facts,
    isNoAnswer: false,
    corpusSeed: options.seed,
    corpusProfile: options.profile,
  };

  // For a revision-sensitive question, record what the superseded revision said
  // so the evaluator can assert the answer is NOT the old value.
  if (seed.type === 'REVISION_SENSITIVE' && document.revisions.length > 1) {
    const previous = document.revisions[document.revisions.length - 2];
    if (previous) {
      const previousFacts = expectedFactValues(previous.content, seed.factIds);
      if (previousFacts.length > 0 && previousFacts[0] !== facts[0]) {
        record.supersededAnswer = previousFacts[0];
      }
    }
  }

  return record;
}

export interface EvaluationGenerationOptions {
  seed: number;
  profile: string;
  /** Cap on questions drawn from answerable documents. */
  maxAnswerable?: number;
  noAnswerCount?: number;
}

export function generateEvaluationDataset(
  documents: readonly GeneratedDocument[],
  questionSeeds: ReadonlyMap<string, GoldQuestionSeed[]>,
  rng: SeededRandom,
  options: EvaluationGenerationOptions,
): EvaluationRecord[] {
  const records: EvaluationRecord[] = [];

  for (const document of documents) {
    // Inactive documents are excluded from retrieval, so a question expecting
    // an answer from one would be scored as a failure of the system rather than
    // of the corpus.
    if (!document.plan.isActive) continue;
    if (document.plan.duplicateOf) continue;

    const seeds = questionSeeds.get(document.plan.documentCode) ?? [];
    for (const [index, seed] of seeds.entries()) {
      const record = buildRecord(document, seed, index, options);
      if (record) records.push(record);
    }
  }

  const maxAnswerable = options.maxAnswerable ?? records.length;
  const answerable = records.length > maxAnswerable ? rng.sample(records, maxAnswerable) : records;

  const noAnswerCount = Math.min(
    options.noAnswerCount ?? Math.max(4, Math.round(answerable.length * 0.12)),
    NO_ANSWER_QUESTIONS.length,
  );

  const noAnswer: EvaluationRecord[] = rng
    .sample(NO_ANSWER_QUESTIONS, noAnswerCount)
    .map((question, index) => ({
      id: `no-answer-${String(index + 1).padStart(2, '0')}`,
      question,
      questionType: 'NO_ANSWER' as const,
      expectedDocumentCode: null,
      expectedRevision: null,
      expectedSection: null,
      referenceAnswer:
        'The available documents do not contain enough information to answer this question.',
      expectedFacts: [],
      isNoAnswer: true,
      corpusSeed: options.seed,
      corpusProfile: options.profile,
    }));

  // Interleaving keeps a truncated evaluation run representative rather than
  // ending up with every negative example at the tail.
  return rng.shuffle([...answerable, ...noAnswer]);
}
