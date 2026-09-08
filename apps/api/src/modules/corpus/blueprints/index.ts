/**
 * Blueprint registry.
 *
 * Order is significant: the generator assigns document codes sequentially per
 * prefix, so the anchor blueprints must stay in this order for the demo
 * scenarios and gold questions to keep referring to the same codes.
 *
 *   FIN-POL-001   Business Expense Policy            (revision demo)
 *   ORA-GUIDE-003 Oracle Tablespace Management Guide (identifier retrieval demo)
 */

import { financeBlueprints } from './finance.js';
import { genericBlueprints } from './generic.js';
import { hrBlueprints } from './hr.js';
import { itBlueprints } from './it.js';
import { operationsBlueprints } from './operations.js';
import { oracleBlueprints } from './oracle.js';
import { securityBlueprints } from './security.js';
import type { Blueprint } from './shared.js';

export * from './shared.js';
export { SCALE_VARIANTS } from './generic.js';

/** Hand-written blueprints with rich, distinctive content. */
export const ANCHOR_BLUEPRINTS: Blueprint[] = [
  ...financeBlueprints,
  ...hrBlueprints,
  ...securityBlueprints,
  ...itBlueprints,
  ...oracleBlueprints,
  ...operationsBlueprints,
];

/** Every blueprint available to the generator. */
export const ALL_BLUEPRINTS: Blueprint[] = [...ANCHOR_BLUEPRINTS, ...genericBlueprints];

export function findBlueprint(key: string): Blueprint | undefined {
  return ALL_BLUEPRINTS.find((blueprint) => blueprint.key === key);
}
