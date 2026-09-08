/**
 * Corpus planning.
 *
 * Pure and deterministic: given a seed and the ratio configuration, produce the
 * complete plan for the corpus - which blueprint each document uses, its code,
 * its format, how many revisions it has, and which defects it carries. No file
 * or database access happens here, which makes the plan cheap to test and makes
 * "same seed, same corpus" a property of the code rather than a hope.
 */

import { ALL_BLUEPRINTS, SCALE_VARIANTS, type Blueprint } from './blueprints/index.js';
import { SeededRandom, seedFromString } from '../../utils/random.js';
import type { CorpusGenerationOptions, SyntheticDocumentPlan, SyntheticFormat } from './types.js';

/**
 * Documents the demo and integration scenarios reference by code. They are
 * never scanned, corrupted, deactivated or pre-loaded with extra revisions, so
 * `corpus:revise -- --document=FIN-POL-001` always starts from a clean
 * single-revision document and the identifier question always has a readable
 * target.
 */
export const DEMO_PROTECTED_BLUEPRINTS = new Set([
  'business-expense-policy',
  'oracle-tablespace-guidelines',
  'incident-management-procedure',
  'annual-leave-policy',
]);

const EFFECTIVE_DATE_START = '2021-01-01';
const EFFECTIVE_DATE_END = '2025-06-30';

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Choose the file format for a document from the configured ratios. */
function chooseFormat(rng: SeededRandom, options: CorpusGenerationOptions, protectedDocument: boolean): SyntheticFormat {
  if (protectedDocument) return 'pdf';

  const roll = rng.next();
  let cursor = 0;

  cursor += options.scannedRatio;
  if (roll < cursor) {
    // A third of scanned documents are mixed native/scanned rather than fully
    // scanned - the harder and more realistic case.
    return rng.bool(0.34) ? 'pdf-mixed' : 'pdf-scanned';
  }

  cursor += options.docxRatio;
  if (roll < cursor) return 'docx';

  cursor += options.textRatio;
  if (roll < cursor) return rng.bool(0.6) ? 'md' : 'txt';

  return 'pdf';
}

function nextCode(counters: Map<string, number>, prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

export interface PlannedCorpus {
  documents: SyntheticDocumentPlan[];
  /** Blueprint used by each document, keyed by document code. */
  blueprints: Map<string, Blueprint>;
}

export function planCorpus(options: CorpusGenerationOptions): PlannedCorpus {
  const rng = new SeededRandom(options.seed);
  const counters = new Map<string, number>();
  const documents: SyntheticDocumentPlan[] = [];
  const blueprints = new Map<string, Blueprint>();

  const previousCodes: string[] = [];

  for (let index = 0; index < options.count; index += 1) {
    const blueprint = ALL_BLUEPRINTS[index % ALL_BLUEPRINTS.length] as Blueprint;
    const cycle = Math.floor(index / ALL_BLUEPRINTS.length);

    // Beyond one pass through the catalogue, documents become regional or
    // divisional variants - which is exactly how a real register grows.
    const variant = cycle === 0 ? null : (SCALE_VARIANTS[(cycle - 1) % SCALE_VARIANTS.length] as string);
    const title = variant ? `${blueprint.title} - ${variant}` : blueprint.title;

    const documentCode = nextCode(counters, blueprint.codePrefix);
    const isProtected = cycle === 0 && DEMO_PROTECTED_BLUEPRINTS.has(blueprint.key);

    // Per-document RNG derived from the code, so adding a document does not
    // shift every later document's content.
    const documentRng = new SeededRandom(seedFromString(`${options.seed}:${documentCode}`));

    const format = chooseFormat(documentRng, options, isProtected);
    const isActive = isProtected ? true : !documentRng.bool(options.inactiveRatio);

    const duplicateOf =
      !isProtected && previousCodes.length > 5 && documentRng.bool(options.duplicateRatio)
        ? documentRng.pick(previousCodes.slice(-40))
        : undefined;

    // A blueprint that defines a workflow was designed around it, so it is
    // usually included. MOCK_WORKFLOW_RATIO acts as a floor governing how many
    // documents overall carry a diagram, not as the per-blueprint probability -
    // only a handful of blueprints have one at all.
    const includeWorkflow =
      Boolean(blueprint.workflow) && documentRng.bool(Math.max(options.workflowRatio, 0.8));
    const includeTable = documentRng.bool(Math.max(options.tableRatio, 0.5));

    const baseDate = documentRng.dateBetween(EFFECTIVE_DATE_START, EFFECTIVE_DATE_END);

    // Revision count. Protected documents always start at exactly one revision
    // so the revision demo has somewhere to go.
    const extraRevisions = isProtected
      ? 0
      : documentRng.bool(options.multiRevisionRatio)
        ? documentRng.int(1, 3)
        : 0;

    const revisions = [];
    let effective = baseDate;

    for (let revisionIndex = 0; revisionIndex <= extraRevisions; revisionIndex += 1) {
      if (revisionIndex > 0) {
        // Successive revisions land 4-20 months after their predecessor.
        effective = new Date(effective.getTime() + documentRng.int(120, 600) * 86_400_000);
      }
      revisions.push({
        revisionNumber: revisionIndex + 1,
        effectiveDate: formatDate(effective),
        changeSummary: revisionIndex === 0 ? 'Initial issue.' : 'Revised following periodic review.',
        corrupt: false,
      });
    }

    // Corrupt only the latest revision of a multi-revision document, so the
    // failure scenario always has a healthy predecessor still serving traffic.
    if (!isProtected && revisions.length > 1 && documentRng.bool(options.corruptRatio)) {
      const last = revisions[revisions.length - 1];
      if (last) {
        last.corrupt = true;
        last.changeSummary = 'Revised following periodic review (file damaged in transfer).';
      }
    }

    const plan: SyntheticDocumentPlan = {
      documentCode,
      blueprintKey: blueprint.key,
      title,
      department: blueprint.department,
      documentType: blueprint.documentType,
      category: blueprint.category,
      owner: blueprint.ownerRole,
      description: blueprint.description,
      tags: blueprint.tags,
      format,
      isActive,
      includeWorkflow,
      includeTable,
      revisions,
      seed: seedFromString(`${options.seed}:${documentCode}:content`),
    };
    if (duplicateOf) plan.duplicateOf = duplicateOf;

    documents.push(plan);
    blueprints.set(documentCode, blueprint);
    previousCodes.push(documentCode);
  }

  // Draw once from the top-level stream so the plan depends on the seed as a
  // whole, keeping the "same seed, same corpus" guarantee explicit.
  void rng.next();

  return { documents, blueprints };
}

/** Profile defaults. The explicit --count flag always wins. */
export function defaultCountForProfile(profile: CorpusGenerationOptions['profile']): number {
  switch (profile) {
    case 'smoke':
      return 15;
    case 'quality':
      return 75;
    case 'scale':
      return 5000;
  }
}
