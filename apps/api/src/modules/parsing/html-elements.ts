/**
 * Minimal HTML-to-structured-element converter.
 *
 * Scoped deliberately to the small, predictable subset mammoth emits for DOCX:
 * h1-h6, p, ul/ol/li, table/tr/td/th, plus inline strong/em/a/br. A full HTML
 * parser would be the wrong dependency for a closed input set - but this is
 * still written as a real tokenizer with an element stack rather than a pile of
 * regexes, because mammoth nests block elements (a table cell contains a
 * paragraph, a list item contains a paragraph) and flat matching silently drops
 * every cell's contents.
 */

import { normalizeWhitespace } from '../../utils/text.js';
import type { ParsedElement } from './types.js';

interface Token {
  kind: 'open' | 'close' | 'text';
  name?: string;
  text?: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (match, entity: string) => {
    const known = ENTITIES[entity.toLowerCase()];
    if (known) return known;
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint)) return String.fromCodePoint(codePoint);
    }
    return match;
  });
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf('<', index);

    if (next === -1) {
      const text = html.slice(index);
      if (text.length > 0) tokens.push({ kind: 'text', text });
      break;
    }

    if (next > index) tokens.push({ kind: 'text', text: html.slice(index, next) });

    const end = html.indexOf('>', next);
    if (end === -1) break;

    const raw = html.slice(next + 1, end).trim();
    index = end + 1;

    if (raw.startsWith('!')) continue; // comment or doctype

    if (raw.startsWith('/')) {
      tokens.push({ kind: 'close', name: raw.slice(1).trim().toLowerCase() });
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const name = (raw.split(/[\s/]/)[0] ?? '').toLowerCase();
    if (name.length === 0) continue;

    tokens.push({ kind: 'open', name });
    if (selfClosing || name === 'br' || name === 'img') tokens.push({ kind: 'close', name });
  }

  return tokens;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Elements whose text becomes its own unit of content. */
const TEXT_CONTAINERS = new Set([...HEADINGS, 'p', 'li', 'td', 'th']);

/**
 * One frame per open text container. Text always accumulates into the
 * innermost frame, so a `<p>` inside a `<td>` contributes to that cell rather
 * than escaping as a stray paragraph.
 */
interface Frame {
  name: string;
  text: string[];
}

export function htmlToElements(html: string): ParsedElement[] {
  const tokens = tokenize(html);
  const elements: ParsedElement[] = [];

  const stack: Frame[] = [];
  const lists: { ordered: boolean; items: string[] }[] = [];
  const tables: string[][][] = [];
  let row: string[] | null = null;

  const currentFrame = (): Frame | undefined => stack[stack.length - 1];

  /** Emit a completed text container into the right destination. */
  const emit = (frame: Frame): void => {
    const text = normalizeWhitespace(decodeEntities(frame.text.join('')));
    const parent = currentFrame();

    // A nested container (p inside td/li) folds into its parent.
    if (parent) {
      if (text.length > 0) parent.text.push(parent.text.length > 0 ? ` ${text}` : text);
      return;
    }

    if (frame.name === 'td' || frame.name === 'th') {
      row?.push(text);
      return;
    }

    if (text.length === 0) return;

    if (frame.name === 'li') {
      const list = lists[lists.length - 1];
      if (list) list.items.push(text);
      else elements.push({ type: 'paragraph', text: `- ${text}` });
      return;
    }

    if (HEADINGS.has(frame.name)) {
      elements.push({ type: 'heading', level: Number.parseInt(frame.name.slice(1), 10), text });
      return;
    }

    elements.push({ type: 'paragraph', text });
  };

  for (const token of tokens) {
    if (token.kind === 'text') {
      currentFrame()?.text.push(token.text ?? '');
      continue;
    }

    const name = token.name as string;

    if (token.kind === 'open') {
      if (name === 'br') {
        currentFrame()?.text.push(' ');
        continue;
      }
      if (name === 'ul' || name === 'ol') {
        lists.push({ ordered: name === 'ol', items: [] });
        continue;
      }
      if (name === 'table') {
        tables.push([]);
        continue;
      }
      if (name === 'tr') {
        row = [];
        continue;
      }
      if (TEXT_CONTAINERS.has(name)) stack.push({ name, text: [] });
      continue;
    }

    // close
    if (name === 'ul' || name === 'ol') {
      const list = lists.pop();
      if (list && list.items.length > 0) {
        elements.push({ type: 'list', ordered: list.ordered, items: list.items });
      }
      continue;
    }

    if (name === 'table') {
      const table = tables.pop();
      if (table && table.length > 0) elements.push({ type: 'table', rows: table });
      continue;
    }

    if (name === 'tr') {
      const table = tables[tables.length - 1];
      if (table && row && row.length > 0) table.push(row);
      row = null;
      continue;
    }

    if (!TEXT_CONTAINERS.has(name)) continue;

    // Close the innermost matching frame, discarding any unclosed frames above
    // it so malformed markup cannot desynchronise the stack.
    const index = stack.map((frame) => frame.name).lastIndexOf(name);
    if (index === -1) continue;
    while (stack.length > index + 1) {
      const orphan = stack.pop();
      if (orphan) emit(orphan);
    }
    const frame = stack.pop();
    if (frame) emit(frame);
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame) emit(frame);
  }

  return elements;
}
