/**
 * Runtime preflight.
 *
 * Plain JavaScript, no dependencies, no TypeScript loader - it has to run
 * correctly on the very versions of Node it exists to reject.
 *
 * Why this runs before `dev`, `test` and `build` rather than relying on the
 * per-service guards: `npm run dev` starts three processes in parallel. On an
 * unsupported runtime the API and the HCM service exit immediately, Vite does
 * not, and the one survivor buries their two clear error messages under a
 * scrolling wall of ECONNREFUSED proxy errors. By the time you read it, the
 * useful output is gone.
 *
 * Failing here stops all three before any of them start.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MINIMUM_MAJOR = 22;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function readPinnedVersion() {
  try {
    return readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
  } catch {
    return String(MINIMUM_MAJOR);
  }
}

const current = process.versions.node;
const major = Number.parseInt(current.split('.')[0], 10);

if (Number.isFinite(major) && major >= MINIMUM_MAJOR) {
  process.exit(0);
}

const pinned = readPinnedVersion();

const message = [
  '',
  '  ┌───────────────────────────────────────────────────────────────┐',
  '  │  Wrong Node version - nothing was started.                    │',
  '  └───────────────────────────────────────────────────────────────┘',
  '',
  '    you have:  v' + current,
  '    required:  v' + MINIMUM_MAJOR + ' or newer  (.nvmrc pins ' + pinned + ')',
  '',
  '  Run this in THIS terminal, then try again:',
  '',
  '      nvm use',
  '      node -v          # expect v' + pinned,
  '',
  '  Tired of doing that in every new terminal?',
  '',
  '      nvm alias default ' + pinned,
  '',
  '  Why it matters: pdfjs-dist, openai and @langchain/openai all need',
  '  Node ' + MINIMUM_MAJOR + '+. On older Node every PDF fails to parse with',
  '  "Promise.withResolvers is not a function", which reads like corrupt',
  '  files but is really a missing language feature.',
  '',
].join('\n');

process.stderr.write(message + '\n');
process.exit(1);
