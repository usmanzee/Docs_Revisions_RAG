/**
 * Node runtime check.
 *
 * Deliberately duplicated rather than imported from the API app. This service
 * stands in for a system owned by somebody else; if it reached across into the
 * API's source tree, the boundary it exists to model would be fiction. Thirty
 * lines of duplication is the cheaper price.
 */

export const MINIMUM_NODE_MAJOR = 22;

export function nodeVersionError(version: string = process.versions.node): string | null {
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) return null;

  return [
    '',
    `  Node ${version} is too old. This service requires Node ${MINIMUM_NODE_MAJOR} or newer.`,
    '',
    '  Fix (an .nvmrc is committed at the repo root):',
    '',
    '      nvm use',
    '      node -v      # expect v24.x',
    '',
  ].join('\n');
}

export function assertSupportedNodeVersion(): void {
  const message = nodeVersionError();
  if (!message) return;
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
