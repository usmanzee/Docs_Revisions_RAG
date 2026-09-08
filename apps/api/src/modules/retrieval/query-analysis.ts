/**
 * Query analysis.
 *
 * Two jobs, both cheap and both done before any retrieval call:
 *   * pull out document identifiers so an exact-code question can be routed to
 *     the document it names;
 *   * decide whether a follow-up question needs to be rewritten into a
 *     standalone one.
 */

/**
 * Document codes (FIN-POL-001, ORA-GUIDE-003) and Oracle error numbers
 * (ORA-01555). Both are rare tokens that embeddings handle poorly and that
 * users type verbatim when they know what they want.
 */
const DOCUMENT_CODE_PATTERN = /\b[A-Z]{2,6}(?:-[A-Z]{2,8})+-\d{1,4}\b/g;
const ORACLE_ERROR_PATTERN = /\bORA-\d{4,5}\b/g;

export function extractDocumentCodes(query: string): string[] {
  const matches = query.toUpperCase().match(DOCUMENT_CODE_PATTERN) ?? [];
  return [...new Set(matches)];
}

export function extractErrorCodes(query: string): string[] {
  const matches = query.toUpperCase().match(ORACLE_ERROR_PATTERN) ?? [];
  return [...new Set(matches)];
}

/**
 * Words that make a question depend on what came before it. Their presence is
 * not proof a rewrite is needed, but their absence is good evidence it is not -
 * which lets the common case skip an LLM call.
 */
const REFERENTIAL_TOKENS = [
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'they',
  'them',
  'their',
  'the same',
  'there',
  'he',
  'she',
  'his',
  'her',
];

const FOLLOW_UP_STARTERS = [
  'what about',
  'how about',
  'and for',
  'and what',
  'what if',
  'why',
  'and',
  'but',
  'also',
  'then',
];

/**
 * Would this question be ambiguous on its own?
 *
 * Deliberately conservative in the direction of rewriting: a needless rewrite
 * costs one small model call, while a missed one silently retrieves for the
 * wrong subject and produces a confidently wrong answer.
 */
export function needsRewrite(query: string, hasHistory: boolean): boolean {
  if (!hasHistory) return false;

  const normalized = query.trim().toLowerCase();

  // Very short questions almost always lean on context ("what about contractors?").
  if (normalized.split(/\s+/).length <= 6) return true;

  if (FOLLOW_UP_STARTERS.some((starter) => normalized.startsWith(`${starter} `))) return true;

  const words = new Set(normalized.replace(/[^a-z\s]/g, ' ').split(/\s+/));
  if (REFERENTIAL_TOKENS.some((token) => (token.includes(' ') ? normalized.includes(token) : words.has(token)))) {
    return true;
  }

  return false;
}

/** Strip a model's framing so only the rewritten question survives. */
export function cleanRewrittenQuery(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^(?:standalone question|rewritten question|question)\s*:\s*/i, '')
    .trim();

  // A rewrite that collapsed to nothing, or ballooned into an explanation, is
  // worse than the original question.
  if (cleaned.length === 0 || cleaned.length > 400) return fallback;
  return cleaned;
}
