/**
 * Parser registry.
 *
 * Ingestion asks for "a parser that supports this mime type" and gets one back;
 * it never branches on file format itself. Adding XLSX or HTML support means
 * adding one class and one registry entry.
 */

import { getConfig, type AppConfig } from '../../config/index.js';
import { ParseError } from '../../utils/errors.js';
import { getOCRProvider, type OCRProvider } from '../ocr/index.js';
import { DocxDocumentParser } from './docx-parser.js';
import { PdfDocumentParser } from './pdf-parser.js';
import { TextDocumentParser } from './text-parser.js';
import type { DocumentParser, ParsedDocument, ParseOptions } from './types.js';

export * from './types.js';
export { DocxDocumentParser } from './docx-parser.js';
export { PdfDocumentParser } from './pdf-parser.js';
export { TextDocumentParser } from './text-parser.js';
export { buildElementsFromLines, buildElementsFromText } from './element-builder.js';
export { htmlToElements } from './html-elements.js';

export class ParserRegistry {
  private readonly parsers: DocumentParser[];

  constructor(parsers: DocumentParser[]) {
    this.parsers = parsers;
  }

  find(mimeType: string, key: string): DocumentParser | null {
    return this.parsers.find((parser) => parser.supports(mimeType, key)) ?? null;
  }

  async parse(data: Buffer, options: ParseOptions): Promise<ParsedDocument> {
    const parser = this.find(options.mimeType, options.key);
    if (!parser) {
      throw new ParseError(`no parser registered for "${options.mimeType}" (${options.key})`);
    }
    return parser.parse(data, options);
  }
}

export function createParserRegistry(
  config: AppConfig = getConfig(),
  ocr: OCRProvider = getOCRProvider(),
): ParserRegistry {
  return new ParserRegistry([
    new PdfDocumentParser(ocr, config),
    new DocxDocumentParser(),
    new TextDocumentParser(),
  ]);
}
