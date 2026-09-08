/**
 * Turn a sequence of text lines into structured elements.
 *
 * Shared by the plain-text parser, the OCR path and the PDF text-layer path,
 * all of which recover lines but no formatting. Keeping the heuristics in one
 * place means a scanned page and a native page produce the same structure, so
 * downstream chunking and citations do not care how the text was obtained.
 */

import {
  looksLikeColumnRow,
  looksLikeHeading,
  looksLikeListItem,
  looksLikeTableRow,
  normalizeWhitespace,
  splitColumnRow,
} from '../../utils/text.js';
import type { ParsedElement } from './types.js';

interface Accumulator {
  elements: ParsedElement[];
  paragraph: string[];
  list: { ordered: boolean; items: string[] } | null;
  table: string[][] | null;
  /** Candidate PDF table rows, confirmed only once several arrive together. */
  columns: string[][];
}

function flushParagraph(state: Accumulator): void {
  if (state.paragraph.length === 0) return;
  const text = normalizeWhitespace(state.paragraph.join(' '));
  if (text.length > 0) state.elements.push({ type: 'paragraph', text });
  state.paragraph = [];
}

function flushList(state: Accumulator): void {
  if (!state.list || state.list.items.length === 0) {
    state.list = null;
    return;
  }
  state.elements.push({ type: 'list', ordered: state.list.ordered, items: state.list.items });
  state.list = null;
}

function flushTable(state: Accumulator): void {
  if (!state.table || state.table.length === 0) {
    state.table = null;
    return;
  }
  state.elements.push({ type: 'table', rows: state.table });
  state.table = null;
}

/**
 * Decide what a run of wide-gap lines actually was.
 *
 * A single such line is far more likely to be an oddly spaced sentence than a
 * table, so a run only becomes a table at two or more rows. Anything shorter is
 * re-emitted as ordinary prose with the gaps collapsed, which loses nothing.
 */
function flushColumns(state: Accumulator): void {
  if (state.columns.length === 0) return;

  if (state.columns.length >= 2) {
    state.elements.push({ type: 'table', rows: state.columns });
  } else {
    const text = normalizeWhitespace((state.columns[0] as string[]).join(' '));
    if (text.length > 0) state.elements.push({ type: 'paragraph', text });
  }

  state.columns = [];
}

function flushAll(state: Accumulator): void {
  flushParagraph(state);
  flushList(state);
  flushTable(state);
  flushColumns(state);
}

/** Strip the bullet/number prefix so list items store just their content. */
function stripListMarker(line: string): { text: string; ordered: boolean } {
  const ordered = /^\s*\(?\d+[.)]/.test(line) || /^\s*[a-z][.)]\s/.test(line);
  const text = line.replace(/^\s*(?:[-*•·]|\(?\d+[.)]|[a-z][.)])\s+/, '').trim();
  return { text, ordered };
}

/** A Markdown separator row (`|---|---|`) carries no data. */
function isTableSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

export function buildElementsFromLines(lines: readonly string[]): ParsedElement[] {
  const state: Accumulator = { elements: [], paragraph: [], list: null, table: null, columns: [] };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      // A blank line ends a paragraph but not necessarily a list or table -
      // generated procedures often have a blank line between numbered steps.
      flushParagraph(state);
      flushColumns(state);
      continue;
    }

    // Wide-gap rows: how a table survives PDF text extraction.
    if (looksLikeColumnRow(rawLine) && !looksLikeTableRow(trimmed)) {
      flushParagraph(state);
      flushList(state);
      flushTable(state);
      state.columns.push(splitColumnRow(rawLine));
      continue;
    }
    flushColumns(state);

    if (looksLikeTableRow(trimmed)) {
      flushParagraph(state);
      flushList(state);
      const cells = parseTableRow(trimmed);
      if (isTableSeparator(cells)) continue;
      state.table ??= [];
      state.table.push(cells);
      continue;
    }
    flushTable(state);

    const heading = looksLikeHeading(trimmed);
    if (heading.isHeading) {
      flushAll(state);
      state.elements.push({ type: 'heading', level: heading.level, text: heading.text });
      continue;
    }

    if (looksLikeListItem(trimmed)) {
      flushParagraph(state);
      const { text, ordered } = stripListMarker(trimmed);
      if (state.list && state.list.ordered !== ordered) flushList(state);
      state.list ??= { ordered, items: [] };
      if (text.length > 0) state.list.items.push(text);
      continue;
    }

    // A non-marker line directly after a list item is usually its continuation
    // ("...must be approved by Finance" wrapped onto a second line).
    if (state.list && state.list.items.length > 0 && /^[a-z(]/.test(trimmed)) {
      const lastIndex = state.list.items.length - 1;
      state.list.items[lastIndex] = `${state.list.items[lastIndex]} ${trimmed}`;
      continue;
    }
    flushList(state);

    state.paragraph.push(trimmed);
  }

  flushAll(state);
  return state.elements;
}

/** Convenience wrapper for a block of raw text. */
export function buildElementsFromText(text: string): ParsedElement[] {
  return buildElementsFromLines(text.split('\n'));
}
