/** Text normalisation and similarity helpers used by parsing, chunking and dedup. */

/** Collapse the whitespace damage typical of PDF and OCR text extraction. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rejoin words split across a line break by hyphenation ("proce-\ndure"). */
export function dehyphenate(text: string): string {
  return text.replace(/([a-z])-\n([a-z])/g, '$1$2');
}

export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-level Jaccard similarity - cheap and good enough for near-dup checks. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeForComparison(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeForComparison(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Fraction of `candidate`'s words that also appear in `reference`.
 * Asymmetric on purpose: it answers "is this chunk already covered?".
 */
export function containmentRatio(candidate: string, reference: string): number {
  const candidateWords = normalizeForComparison(candidate).split(' ').filter(Boolean);
  if (candidateWords.length === 0) return 0;
  const referenceWords = new Set(normalizeForComparison(reference).split(' ').filter(Boolean));
  let covered = 0;
  for (const word of candidateWords) if (referenceWords.has(word)) covered += 1;
  return covered / candidateWords.length;
}

/** Excerpt for citations: trimmed to a length, cut on a word boundary. */
export function buildExcerpt(text: string, maxLength = 320): string {
  const clean = normalizeWhitespace(text).replace(/\n+/g, ' ');
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const HEADING_NUMBER = /^(\d+(?:\.\d+)*)[.)]?\s+(.{2,120})$/;
const ALL_CAPS_HEADING = /^[A-Z0-9][A-Z0-9 &/,'()\-.]{2,80}$/;

/**
 * Heuristic heading detection for plain text and for PDF text layers where
 * font information is unavailable or unreliable.
 */
export function looksLikeHeading(line: string): { isHeading: boolean; level: number; text: string } {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return { isHeading: false, level: 0, text: trimmed };

  // Markdown-style headings, used by the generated .md documents.
  const md = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (md) {
    return { isHeading: true, level: (md[1] as string).length, text: (md[2] as string).trim() };
  }

  const numbered = HEADING_NUMBER.exec(trimmed);
  if (numbered) {
    const depth = (numbered[1] as string).split('.').length;
    // "3.2 Approval Requirements" is a heading; "3. of the amount is" is prose.
    const body = numbered[2] as string;
    if (!/[.:;]$/.test(body) && body.split(' ').length <= 12) {
      return { isHeading: true, level: Math.min(depth + 1, 6), text: trimmed };
    }
  }

  if (ALL_CAPS_HEADING.test(trimmed) && trimmed.split(' ').length <= 10 && !/[.]$/.test(trimmed)) {
    return { isHeading: true, level: 2, text: trimmed };
  }

  // Title Case short line. This is the only structural signal left on an OCR'd
  // page, where font metrics are unavailable - "Approval Requirements" has to be
  // recognised as a heading from its shape alone. The conditions are strict
  // because a false positive silently deletes a line of body text.
  if (isTitleCaseHeading(trimmed)) {
    return { isHeading: true, level: 2, text: trimmed };
  }

  return { isHeading: false, level: 0, text: trimmed };
}

/** Words that legitimately stay lowercase inside a Title Case heading. */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of',
  'on', 'or', 'per', 'the', 'to', 'up', 'via', 'with',
]);

function isTitleCaseHeading(line: string): boolean {
  if (line.length > 70) return false;
  // Trailing punctuation means it is a sentence, not a label.
  if (/[.,;:!?]$/.test(line)) return false;
  // Wide gaps mean it is a table row that happens to be short.
  if (/\s{3,}/.test(line)) return false;
  // "Owner: Finance Director" is a metadata label/value pair from a document
  // cover block, not a section heading.
  if (/^[A-Za-z][A-Za-z ]{0,30}:\s+\S/.test(line)) return false;

  const words = line.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0 || words.length > 9) return false;

  const first = words[0] as string;
  if (!/^[A-Z]/.test(first)) return false;

  let significant = 0;
  let capitalised = 0;

  for (const word of words) {
    const cleaned = word.replace(/[^A-Za-z]/g, '');
    if (cleaned.length === 0) return false; // digits/symbols: not a heading
    if (MINOR_WORDS.has(cleaned.toLowerCase())) continue;
    significant += 1;
    if (/^[A-Z]/.test(cleaned)) capitalised += 1;
  }

  if (significant === 0) return false;
  return capitalised / significant >= 0.8;
}

const LIST_ITEM = /^\s*(?:[-*•·]|\(?\d+[.)]|[a-z][.)])\s+\S/;

export function looksLikeListItem(line: string): boolean {
  return LIST_ITEM.test(line);
}

/** Pipe-delimited table row, the shape emitted by the corpus generator. */
export function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 3;
}

/**
 * A line whose cells are separated by wide gaps - what a PDF table row looks
 * like once the text layer has been reconstructed, since PDFs carry no table
 * markup. Requires at least two separators so ordinary sentences with an
 * accidental double space are not mistaken for rows.
 */
export function looksLikeColumnRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const cells = splitColumnRow(trimmed);
  return cells.length >= 3 && cells.every((cell) => cell.length > 0);
}

export function splitColumnRow(line: string): string[] {
  return line
    .trim()
    .split(/\s{3,}/)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/** Printable-character ratio - a crude but effective OCR-garbage detector. */
export function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code > 160) printable += 1;
  }
  return printable / text.length;
}
