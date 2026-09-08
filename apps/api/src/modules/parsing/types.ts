/**
 * Structured document representation.
 *
 * Parsers deliberately do NOT return one giant string. Headings, list items,
 * procedure steps, tables and page boundaries are the structure the chunker
 * needs to avoid splitting a numbered procedure down the middle or orphaning a
 * table from its caption - and the structure citations need to say "section
 * 4.2, page 7" rather than "somewhere in this document".
 */

import type { ExtractionMethod } from '@docs-rag/shared';

export type ParsedElement =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][]; caption?: string }
  | { type: 'image'; description: string; assetIndex: number };

export interface ParsedPage {
  pageNumber: number;
  elements: ParsedElement[];
  /** How this page's text was obtained. Recorded per page, not per document. */
  extractionMethod: ExtractionMethod;
  /** Characters recovered from the native text layer, before any OCR. */
  nativeCharCount: number;
  /** True when the native layer was too sparse and OCR was used or required. */
  requiredOcr: boolean;
  width?: number;
  height?: number;
}

/** An embedded image worth describing (workflow diagram, screenshot, scan). */
export interface ParsedImageAsset {
  pageNumber: number;
  assetIndex: number;
  /** PNG bytes, present only when the parser could render the region. */
  data?: Buffer;
  width?: number;
  height?: number;
  /** Text recovered by OCR, when it ran. */
  extractedText?: string;
  /** Natural-language description from the vision enricher, when enabled. */
  description?: string;
}

export interface ParsedDocument {
  pages: ParsedPage[];
  images: ParsedImageAsset[];
  /** Metadata the file itself declared (PDF Info dictionary, DOCX core props). */
  sourceMetadata: Record<string, string>;
  pageCount: number;
  ocrPageCount: number;
  /** Roll-up across pages: MIXED when a document has both native and OCR pages. */
  extractionMethod: ExtractionMethod;
}

export interface ParseOptions {
  /** Storage key, for error messages and logging only. */
  key: string;
  mimeType: string;
  /** Disable OCR for this call regardless of configuration (used by tests). */
  ocrEnabled?: boolean;
  /** Bound OCR work on very long documents. */
  maxOcrPages?: number;
}

/**
 * A parser for one family of source formats.
 * Registering a new format means implementing this and adding it to the
 * registry - the ingestion pipeline does not change.
 */
export interface DocumentParser {
  readonly name: string;
  supports(mimeType: string, key: string): boolean;
  parse(data: Buffer, options: ParseOptions): Promise<ParsedDocument>;
}

/** Flatten a page's elements into plain text, preserving structure cues. */
export function elementsToText(elements: readonly ParsedElement[]): string {
  const parts: string[] = [];
  for (const element of elements) {
    switch (element.type) {
      case 'heading':
        parts.push(element.text);
        break;
      case 'paragraph':
        parts.push(element.text);
        break;
      case 'list':
        parts.push(
          element.items
            .map((item, index) => (element.ordered ? `${index + 1}. ${item}` : `- ${item}`))
            .join('\n'),
        );
        break;
      case 'table':
        parts.push(tableToText(element.rows, element.caption));
        break;
      case 'image':
        parts.push(`[Figure: ${element.description}]`);
        break;
    }
  }
  return parts.join('\n\n');
}

/**
 * Render a table as pipe-delimited Markdown.
 *
 * Chosen over flattening to prose because the LLM reads it accurately, it
 * survives chunking as a recognisable unit, and a human reading a citation
 * excerpt can still tell which column a number came from.
 */
export function tableToText(rows: readonly string[][], caption?: string): string {
  if (rows.length === 0) return caption ?? '';
  const lines: string[] = [];
  if (caption) lines.push(caption);

  const [header, ...body] = rows;
  lines.push(`| ${(header as string[]).join(' | ')} |`);
  lines.push(`| ${(header as string[]).map(() => '---').join(' | ')} |`);
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);

  return lines.join('\n');
}

export function documentToText(document: ParsedDocument): string {
  return document.pages.map((page) => elementsToText(page.elements)).join('\n\n');
}

/** Roll page-level extraction methods into a single document-level value. */
export function rollUpExtractionMethod(pages: readonly ParsedPage[]): ExtractionMethod {
  const methods = new Set(pages.map((page) => page.extractionMethod));
  if (methods.size === 0) return 'NATIVE_TEXT';
  if (methods.size === 1) return [...methods][0] as ExtractionMethod;
  return 'MIXED';
}
