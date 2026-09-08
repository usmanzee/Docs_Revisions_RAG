/**
 * DOCX parser.
 *
 * mammoth converts the OOXML into a small, predictable HTML subset, which
 * preserves exactly the structure the chunker cares about (heading levels,
 * lists, tables) without dragging in a full Office document model.
 *
 * DOCX has no fixed pagination - page breaks are computed by the renderer, not
 * stored - so the whole document is reported as page 1 rather than inventing
 * page numbers that would then appear in citations and be wrong.
 */

import mammoth from 'mammoth';
import { ParseError } from '../../utils/errors.js';
import { htmlToElements } from './html-elements.js';
import { elementsToText, type DocumentParser, type ParsedDocument, type ParseOptions } from './types.js';

export class DocxDocumentParser implements DocumentParser {
  readonly name = 'docx';

  supports(mimeType: string, key: string): boolean {
    return (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      key.endsWith('.docx')
    );
  }

  async parse(data: Buffer, options: ParseOptions): Promise<ParsedDocument> {
    let html: string;
    try {
      const result = await mammoth.convertToHtml({ buffer: data });
      html = result.value;
    } catch (error) {
      // A truncated or non-OOXML payload lands here; the revision is expected
      // to be marked FAILED while its predecessor keeps serving traffic.
      throw new ParseError(`cannot read DOCX "${options.key}"`, { cause: error });
    }

    const elements = htmlToElements(html);
    const text = elementsToText(elements);

    if (text.trim().length === 0) {
      throw new ParseError(`DOCX "${options.key}" produced no text`);
    }

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
