/**
 * Revision mutations.
 *
 * A new revision of a document is not a re-roll of its content - it is the
 * previous revision with a specific, describable change. That distinction is
 * what makes the revision demo meaningful: after ingestion, the answer to one
 * question changes, and everything else stays the same.
 *
 * Fact-valued mutations change the fact and let the composer re-render, so the
 * new number appears consistently in the prose, the table and the gold answer.
 * Structural mutations transform the composed sections directly.
 */

import type { SeededRandom } from '../../utils/random.js';
import { APPROVAL_ROLES, type Blueprint } from './blueprints/index.js';
import type {
  DocumentFact,
  RevisionMutation,
  RevisionMutationType,
  SyntheticSection,
} from './types.js';

export interface MutationPlan {
  mutation: RevisionMutation;
  /** Fact overrides applied when the next revision is composed. */
  factOverrides: Record<string, DocumentFact>;
  /** Structural transform applied after composition. */
  transform?: (sections: SyntheticSection[], rng: SeededRandom) => SyntheticSection[];
}

/** Scale a numeric fact by a plausible amount and re-render its display value. */
function scaleFact(fact: DocumentFact, rng: SeededRandom): DocumentFact | null {
  if (fact.numericValue === undefined) return null;

  // Real revisions move thresholds by a noticeable but plausible amount.
  const direction = rng.bool(0.7) ? 1 : -1;
  const factor = 1 + direction * rng.float(0.15, 0.6);
  const raw = fact.numericValue * factor;

  // Round to the granularity implied by the original value so the new figure
  // reads like something a committee would actually approve.
  const magnitude = fact.numericValue >= 10_000 ? 2500 : fact.numericValue >= 1000 ? 500 : fact.numericValue >= 100 ? 10 : 1;
  const rounded = Math.max(magnitude, Math.round(raw / magnitude) * magnitude);
  if (rounded === fact.numericValue) return null;

  const value = fact.value.replace(
    /[\d,]+(?:\.\d+)?/,
    fact.value.includes(',') || rounded >= 1000 ? rounded.toLocaleString('en-US') : String(rounded),
  );

  return { ...fact, value, numericValue: rounded };
}

/** Facts whose value can be scaled numerically. */
function numericFacts(facts: Record<string, DocumentFact>): DocumentFact[] {
  return Object.values(facts).filter((fact) => fact.numericValue !== undefined);
}

function findSection(sections: SyntheticSection[], predicate: (section: SyntheticSection) => boolean): SyntheticSection | null {
  for (const section of sections) {
    if (predicate(section)) return section;
    const nested = findSection(section.subsections ?? [], predicate);
    if (nested) return nested;
  }
  return null;
}

/** Deep clone so a transform never mutates the previous revision's sections. */
function cloneSections(sections: SyntheticSection[]): SyntheticSection[] {
  return structuredClone(sections);
}

const ADDED_STEPS = [
  'Confirm that the request has a recorded business justification before proceeding.',
  'Verify that the requester holds current mandatory training for this activity.',
  'Record the decision and its rationale in the system of record before closing the request.',
  'Notify the affected service owner once the activity has completed.',
  'Attach supporting evidence to the record so the control can be tested later.',
];

const REPLACEMENT_PARAGRAPHS = [
  'This requirement has been restated following the annual control review. The substance is unchanged, ' +
    'but the wording now makes explicit that it applies to activity performed by suppliers on the ' +
    'organisation’s behalf as well as to employees.',
  'Following an internal audit finding, this section now requires the reason for any deviation to be ' +
    'recorded at the time it occurs rather than at the next review.',
  'This section has been updated to align with the current delegation of authority framework. Where this ' +
    'document and that framework differ, the framework takes precedence.',
];

/**
 * Choose a mutation for the next revision.
 *
 * `preferFactChange` is used by the demo and test scenarios, which need a
 * revision whose numeric answer provably changes.
 */
export function planMutation(
  blueprint: Blueprint,
  facts: Record<string, DocumentFact>,
  rng: SeededRandom,
  options: { preferFactChange?: boolean; forceType?: RevisionMutationType; factId?: string } = {},
): MutationPlan {
  // A caller can name the fact to change. The revision demo and the revision
  // integration test both need a *specific* answer to change, not just some
  // answer, so they pin the fact rather than hoping the random choice lands on
  // the one the question asks about.
  const targeted = options.factId ? facts[options.factId] : undefined;
  const candidates = targeted?.numericValue !== undefined ? [targeted] : numericFacts(facts);

  const type: RevisionMutationType =
    options.forceType ??
    (targeted !== undefined || (options.preferFactChange && candidates.length > 0)
      ? 'NUMERIC_THRESHOLD'
      : rng.pick([
          'NUMERIC_THRESHOLD',
          'NUMERIC_THRESHOLD',
          'RETENTION_DURATION',
          'APPROVAL_ROLE',
          'RESPONSIBILITY',
          'PROCESS_STEP_ADDED',
          'PROCESS_STEP_REMOVED',
          'PARAGRAPH_REPLACED',
          'EFFECTIVE_DATE',
          ...(blueprint.department === 'Database Administration' ? (['ORACLE_RECOMMENDATION'] as const) : []),
        ] as const));

  switch (type) {
    case 'NUMERIC_THRESHOLD':
    case 'RETENTION_DURATION':
    case 'ORACLE_RECOMMENDATION': {
      // Prefer a threshold-shaped fact so the change is the kind a reader would
      // actually ask about.
      const preferred = targeted
        ? candidates
        : candidates.filter((fact) =>
            /threshold|limit|retention|days|hours|minutes|percent/i.test(`${fact.id} ${fact.unit ?? ''}`),
          );
      const pool = preferred.length > 0 ? preferred : candidates;
      if (pool.length === 0) break;

      const target = rng.pick(pool);
      const updated = scaleFact(target, rng);
      if (!updated) break;

      return {
        mutation: {
          type,
          factId: target.id,
          previousValue: target.value,
          newValue: updated.value,
          description: `${target.label} changed from ${target.value} to ${updated.value}.`,
        },
        factOverrides: { [target.id]: updated },
      };
    }

    case 'APPROVAL_ROLE': {
      const role = rng.pick(APPROVAL_ROLES);
      return {
        mutation: {
          type,
          description: `Approval authority reassigned to the ${role}.`,
          newValue: role,
        },
        factOverrides: {},
        transform: (sections) => {
          const next = cloneSections(sections);
          const target =
            findSection(next, (section) => /approval|authoris/i.test(section.title)) ??
            findSection(next, (section) => section.key === 'requirements');
          if (target) {
            target.paragraphs.push(
              `With effect from this revision, approval authority under this section rests with the ` +
                `${role}. Approvals granted under the previous authority before the effective date remain valid.`,
            );
          }
          return next;
        },
      };
    }

    case 'RESPONSIBILITY': {
      const role = rng.pick(APPROVAL_ROLES);
      return {
        mutation: {
          type,
          description: `Responsibility for periodic review transferred to the ${role}.`,
          newValue: role,
        },
        factOverrides: {},
        transform: (sections) => {
          const next = cloneSections(sections);
          const target = findSection(next, (section) => section.key === 'responsibilities');
          if (target?.table) {
            target.table.rows.push([role, 'Performs the periodic review introduced in this revision']);
          }
          return next;
        },
      };
    }

    case 'PROCESS_STEP_ADDED': {
      const step = rng.pick(ADDED_STEPS);
      return {
        mutation: { type, description: `Additional process step introduced: "${step}"`, newValue: step },
        factOverrides: {},
        transform: (sections) => {
          const next = cloneSections(sections);
          const target = findSection(next, (section) => (section.steps?.length ?? 0) > 0);
          if (target?.steps) {
            const position = Math.max(1, target.steps.length - 1);
            target.steps.splice(position, 0, step);
          }
          return next;
        },
      };
    }

    case 'PROCESS_STEP_REMOVED': {
      return {
        mutation: { type, description: 'A redundant process step was removed following a control review.' },
        factOverrides: {},
        transform: (sections, innerRng) => {
          const next = cloneSections(sections);
          const target = findSection(next, (section) => (section.steps?.length ?? 0) > 3);
          if (target?.steps) {
            const index = innerRng.int(1, target.steps.length - 2);
            target.steps.splice(index, 1);
          }
          return next;
        },
      };
    }

    case 'PARAGRAPH_REPLACED': {
      const replacement = rng.pick(REPLACEMENT_PARAGRAPHS);
      return {
        mutation: { type, description: 'A policy paragraph was restated following the annual review.' },
        factOverrides: {},
        transform: (sections, innerRng) => {
          const next = cloneSections(sections);
          const eligible = next.filter((section) => section.paragraphs.length > 1);
          if (eligible.length > 0) {
            const target = innerRng.pick(eligible);
            target.paragraphs[target.paragraphs.length - 1] = replacement;
          }
          return next;
        },
      };
    }

    case 'EFFECTIVE_DATE':
      break;
  }

  // EFFECTIVE_DATE, and the fallback when no suitable fact was available: the
  // revision exists and its effective date moves, but the content is unchanged.
  return {
    mutation: {
      type: 'EFFECTIVE_DATE',
      description: 'Reviewed with no change to requirements; effective date updated.',
    },
    factOverrides: {},
  };
}
