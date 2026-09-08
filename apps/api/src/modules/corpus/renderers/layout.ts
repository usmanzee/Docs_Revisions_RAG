/**
 * Page layout engine.
 *
 * Produces positioned text lines from a composed document. Two renderers
 * consume the result: the native-PDF renderer draws the lines as real text, and
 * the scanned renderer paints the identical lines onto a bitmap. Sharing the
 * layout is what makes a scanned page a faithful image of the same document
 * rather than a different document that happens to be a picture.
 *
 * Measurement is injected because pdf-lib and canvas have different font
 * metrics; each renderer supplies its own.
 */

import type { SyntheticDocumentContent, SyntheticSection } from '../types.js';

export interface LaidOutLine {
  text: string;
  x: number;
  /** Distance from the top of the page, in points. */
  y: number;
  size: number;
  bold: boolean;
  /** Horizontal rule drawn beneath the line (used by table headers). */
  rule?: { width: number };
}

export interface LaidOutPage {
  lines: LaidOutLine[];
  /** Reserved band for a workflow diagram, when the page carries one. */
  figure?: { x: number; y: number; width: number; height: number; title: string };
}

export interface LayoutOptions {
  pageWidth: number;
  pageHeight: number;
  marginX: number;
  marginTop: number;
  marginBottom: number;
  bodySize: number;
  lineGap: number;
}

/** A4 in PostScript points. */
export const A4: Pick<LayoutOptions, 'pageWidth' | 'pageHeight'> = {
  pageWidth: 595.28,
  pageHeight: 841.89,
};

export const DEFAULT_LAYOUT: LayoutOptions = {
  ...A4,
  marginX: 56,
  marginTop: 64,
  marginBottom: 64,
  bodySize: 10.5,
  lineGap: 4.2,
};

export type MeasureText = (text: string, size: number, bold: boolean) => number;

/**
 * Greedy word wrap. Words longer than the available width (a long URL, a
 * concatenated identifier) are hard-split so nothing silently overflows the
 * page and disappears.
 */
function wrap(text: string, maxWidth: number, size: number, bold: boolean, measure: MeasureText): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measure(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) lines.push(current);

    if (measure(word, size, bold) <= maxWidth) {
      current = word;
      continue;
    }

    // Hard-split an over-long token.
    let remainder = word;
    while (measure(remainder, size, bold) > maxWidth && remainder.length > 1) {
      let cut = remainder.length - 1;
      while (cut > 1 && measure(remainder.slice(0, cut), size, bold) > maxWidth) cut -= 1;
      lines.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut);
    }
    current = remainder;
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

class PageCursor {
  readonly pages: LaidOutPage[] = [];
  private current: LaidOutPage = { lines: [] };
  private y: number;

  constructor(private readonly options: LayoutOptions) {
    this.y = options.marginTop;
    this.pages.push(this.current);
  }

  get contentWidth(): number {
    return this.options.pageWidth - this.options.marginX * 2;
  }

  private get bottom(): number {
    return this.options.pageHeight - this.options.marginBottom;
  }

  /** Start a new page. */
  break(): void {
    this.current = { lines: [] };
    this.pages.push(this.current);
    this.y = this.options.marginTop;
  }

  space(amount: number): void {
    this.y += amount;
  }

  /** Reserve vertical space, breaking the page if it will not fit. */
  reserve(height: number): void {
    if (this.y + height > this.bottom) this.break();
  }

  write(text: string, options: { size?: number; bold?: boolean; indent?: number; rule?: boolean } = {}): void {
    const size = options.size ?? this.options.bodySize;
    const height = size + this.options.lineGap;
    if (this.y + height > this.bottom) this.break();

    const line: LaidOutLine = {
      text,
      x: this.options.marginX + (options.indent ?? 0),
      y: this.y + size,
      size,
      bold: options.bold ?? false,
    };
    if (options.rule) line.rule = { width: this.contentWidth };

    this.current.lines.push(line);
    this.y += height;
  }

  /** Place a figure band, moving to a new page when it will not fit. */
  figure(width: number, height: number, title: string): void {
    if (this.y + height > this.bottom) this.break();
    this.current.figure = { x: this.options.marginX, y: this.y, width, height, title };
    this.y += height;
  }

  /** Cells laid out at fixed column positions. */
  writeRow(cells: string[], columns: number[], options: { bold?: boolean; size?: number; rule?: boolean } = {}): void {
    const size = options.size ?? this.options.bodySize - 0.5;
    const height = size + this.options.lineGap;
    if (this.y + height > this.bottom) this.break();

    cells.forEach((cell, index) => {
      this.current.lines.push({
        text: cell,
        x: this.options.marginX + (columns[index] ?? 0),
        y: this.y + size,
        size,
        bold: options.bold ?? false,
      });
    });

    if (options.rule) {
      const last = this.current.lines[this.current.lines.length - 1];
      if (last) last.rule = { width: this.contentWidth };
    }

    this.y += height;
  }
}

function layoutSection(
  section: SyntheticSection,
  cursor: PageCursor,
  measure: MeasureText,
  options: LayoutOptions,
  depth: number,
): void {
  const headingSize = depth === 0 ? options.bodySize + 3 : options.bodySize + 1;

  // Keep a heading with at least the first line of its body.
  cursor.reserve(headingSize + options.bodySize + options.lineGap * 3);
  cursor.space(depth === 0 ? 8 : 5);
  cursor.write(section.title, { size: headingSize, bold: true });
  cursor.space(3);

  for (const paragraph of section.paragraphs) {
    for (const line of wrap(paragraph, cursor.contentWidth, options.bodySize, false, measure)) {
      cursor.write(line);
    }
    cursor.space(4);
  }

  if (section.bullets?.length) {
    for (const bullet of section.bullets) {
      const lines = wrap(`•  ${bullet}`, cursor.contentWidth - 14, options.bodySize, false, measure);
      lines.forEach((line, index) => cursor.write(line, { indent: index === 0 ? 10 : 22 }));
    }
    cursor.space(4);
  }

  if (section.steps?.length) {
    section.steps.forEach((step, index) => {
      const lines = wrap(`${index + 1}.  ${step}`, cursor.contentWidth - 16, options.bodySize, false, measure);
      lines.forEach((line, lineIndex) => cursor.write(line, { indent: lineIndex === 0 ? 10 : 24 }));
    });
    cursor.space(4);
  }

  if (section.table) {
    const { header, rows, caption } = section.table;
    if (caption) {
      cursor.write(caption, { size: options.bodySize - 0.5, bold: true });
      cursor.space(2);
    }

    // Even column split - simple, and adequate for the narrow tables the
    // generator produces. Cell text is truncated rather than wrapped so a row
    // stays on one line and the table remains a recognisable unit for chunking.
    const columnWidth = cursor.contentWidth / header.length;
    const columns = header.map((_cell, index) => index * columnWidth);
    const fit = (cell: string, bold: boolean): string => {
      const maxWidth = columnWidth - 8;
      if (measure(cell, options.bodySize - 0.5, bold) <= maxWidth) return cell;
      let cut = cell.length;
      while (cut > 1 && measure(`${cell.slice(0, cut)}…`, options.bodySize - 0.5, bold) > maxWidth) cut -= 1;
      return `${cell.slice(0, cut)}…`;
    };

    cursor.reserve((rows.length + 2) * (options.bodySize + options.lineGap));
    cursor.writeRow(header.map((cell) => fit(cell, true)), columns, { bold: true, rule: true });
    for (const row of rows) cursor.writeRow(row.map((cell) => fit(cell, false)), columns);
    cursor.space(6);
  }

  for (const subsection of section.subsections ?? []) {
    layoutSection(subsection, cursor, measure, options, depth + 1);
  }
}

export function layoutDocument(
  content: SyntheticDocumentContent,
  measure: MeasureText,
  options: LayoutOptions = DEFAULT_LAYOUT,
): LaidOutPage[] {
  const cursor = new PageCursor(options);

  // Cover block - the metadata a real controlled document carries.
  cursor.write(content.documentCode, { size: options.bodySize + 6, bold: true });
  cursor.space(2);
  cursor.write(content.title, { size: options.bodySize + 4, bold: true });
  cursor.space(8);

  const metadata: [string, string][] = [
    ['Department', content.department],
    ['Document Type', content.documentType],
    ['Category', content.category],
    ['Owner', content.owner],
    ['Effective Date', content.effectiveDate],
    ['Revision', String(content.revisionNumber)],
    ['Review Cycle', content.reviewCycle],
    ['Classification', 'Internal'],
  ];
  for (const [label, value] of metadata) {
    cursor.write(`${label}: ${value}`, { size: options.bodySize - 0.5 });
  }
  cursor.space(10);

  for (const section of content.sections) {
    if (section.key === 'workflow' && content.workflow) {
      cursor.space(6);
      cursor.write(section.title, { size: options.bodySize + 3, bold: true });
      cursor.space(3);
      for (const paragraph of section.paragraphs) {
        for (const line of wrap(paragraph, cursor.contentWidth, options.bodySize, false, measure)) {
          cursor.write(line);
        }
      }
      cursor.space(6);
      // Height scales with node count so the diagram is never clipped.
      const height = Math.min(420, 60 + content.workflow.nodes.length * 46);
      cursor.figure(cursor.contentWidth, height, content.workflow.title);
      cursor.space(6);
      continue;
    }

    layoutSection(section, cursor, measure, options, 0);
  }

  return cursor.pages;
}
