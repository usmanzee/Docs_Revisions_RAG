/**
 * Plain text and Markdown parser.
 *
 * These formats have no pages, so the whole document is reported as page 1.
 * Everything downstream (chunking, citations) is page-optional, so this stays a
 * simple, honest mapping rather than an invented pagination.
 */

import { dehyphenate, normalizeWhitespace, printableRatio } from '../../utils/text.js';
import { ParseError } from '../../utils/errors.js';
import { buildElementsFromText } from './element-builder.js';
import type { DocumentParser, ParsedDocument, ParseOptions } from './types.js';

/**
 * A file whose bytes are mostly unprintable is not text, whatever its
 * extension claims. The corpus generator plants exactly this kind of corrupt
 * file, and the ingestion pipeline is expected to fail that revision cleanly
 * rather than embed noise.
 */
const MIN_PRINTABLE_RATIO = 0.85;

export class TextDocumentParser implements DocumentParser {
  readonly name = 'text';

  supports(mimeType: string, key: string): boolean {
    return (
      mimeType === 'text/plain' ||
      mimeType === 'text/markdown' ||
      key.endsWith('.txt') ||
      key.endsWith('.md') ||
      key.endsWith('.markdown')
    );
  }

  async parse(data: Buffer, options: ParseOptions): Promise<ParsedDocument> {
    const raw = data.toString('utf8');

    if (raw.trim().length === 0) {
      throw new ParseError(`"${options.key}" contains no text`);
    }

    const ratio = printableRatio(raw);
    if (ratio < MIN_PRINTABLE_RATIO) {
      throw new ParseError(
        `"${options.key}" does not look like text (only ${(ratio * 100).toFixed(1)}% printable characters)`,
      );
    }

    const text = normalizeWhitespace(dehyphenate(raw));
    const elements = buildElementsFromText(text);

    return {
      pages: [
        {
          pageNumber: 1,
          elements,
          extractionMethod: 'NATIVE_TEXT',
          nativeCharCount: text.length,
          requiredOcr: false,
        },
      ],
      images: [],
      sourceMetadata: {},
      pageCount: 1,
      ocrPageCount: 0,
      extractionMethod: 'NATIVE_TEXT',
    };
  }
}
