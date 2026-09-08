/**
 * PDF parser: native text layer first, OCR only where it is actually needed.
 *
 * The decision is made per page, not per document, because real corpora contain
 * documents where a scanned appendix is bolted onto a native-text policy. OCR is
 * expensive, so a page is only rendered and recognised when its text layer is
 * genuinely too sparse to be the page's content:
 *
 *   * fewer than OCR_MIN_NATIVE_CHARS characters, or
 *   * a character-per-square-point density below OCR_MIN_CHARS_PER_PAGE_AREA
 *     (which catches a large page carrying only a header and a page number).
 *
 * Text-layer reconstruction groups glyph runs into lines by their y coordinate
 * rather than trusting item order, because PDF content streams are free to emit
 * text in any order and frequently do for tables.
 */

import { createCanvas } from '@napi-rs/canvas';
import type { ExtractionMethod } from '@docs-rag/shared';
import { getConfig, type AppConfig } from '../../config/index.js';
import { ParseError, toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { dehyphenate, normalizeWhitespace } from '../../utils/text.js';
import type { OCRProvider } from '../ocr/index.js';
import { buildElementsFromLines } from './element-builder.js';
import {
  elementsToText,
  rollUpExtractionMethod,
  type DocumentParser,
  type ParsedDocument,
  type ParsedImageAsset,
  type ParsedPage,
  type ParseOptions,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- pdfjs' legacy build is untyped */
type PdfDocument = any;
type PdfPage = any;

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Lazily loaded so importing the parser does not pay pdfjs' start-up cost. */
let pdfjsModule: any = null;

async function loadPdfjs(): Promise<any> {
  if (!pdfjsModule) {
    // The legacy build is the one supported in Node; the default build assumes
    // browser APIs that do not exist here.
    pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModule;
}

/**
 * Canvas factory backed by @napi-rs/canvas.
 * pdfjs needs somewhere to rasterise a page; this is the Node equivalent of the
 * browser's HTMLCanvasElement plumbing.
 */
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(canvasAndContext: { canvas: any }, width: number, height: number): void {
    canvasAndContext.canvas.width = Math.ceil(width);
    canvasAndContext.canvas.height = Math.ceil(height);
  }

  destroy(canvasAndContext: { canvas: any; context: any }): void {
    // @napi-rs/canvas buffers are garbage collected; dropping the references is
    // all that is required, but zeroing the size releases the backing store now.
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

/** A reconstructed visual line, with the glyph size that produced it. */
interface ReconstructedLine {
  text: string;
  /** Dominant glyph height on the line, used to identify headings. */
  size: number;
}

/** Group text items into visual lines using their baseline y coordinate. */
function reconstructLines(items: readonly TextItem[]): ReconstructedLine[] {
  interface Line {
    y: number;
    items: { x: number; endX: number; text: string; height: number }[];
  }

  const lines: Line[] = [];

  for (const item of items) {
    if (!item.str || item.str.length === 0) continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const height = Math.abs(item.transform[3] ?? item.height ?? 10) || 10;
    // Half the glyph height is a forgiving but reliable same-line tolerance:
    // wide enough for subscripts and mixed font sizes, tight enough that
    // adjacent table rows stay separate.
    const tolerance = Math.max(2, height * 0.5);

    const existing = lines.find((line) => Math.abs(line.y - y) <= tolerance);
    const entry = { x, endX: x + (item.width ?? 0), text: item.str, height };

    if (existing) {
      existing.items.push(entry);
      // Keep the line anchored at its dominant baseline.
      existing.y = (existing.y + y) / 2;
    } else {
      lines.push({ y, items: [entry] });
    }
  }

  // PDF y grows upward, so descending y is top-to-bottom reading order.
  lines.sort((a, b) => b.y - a.y);

  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd: number | null = null;
    let previousHeight = 10;

    for (const item of line.items) {
      // pdfjs represents a wide horizontal gap as a whitespace-only item whose
      // advance width spans the gap. That is the only signal a PDF gives that
      // two runs are in different table columns, so it is preserved as a
      // multi-space separator rather than collapsed to a single space.
      const isWideSpacer = item.text.trim().length === 0 && item.endX - item.x > item.height;
      if (isWideSpacer) {
        if (!text.endsWith('   ')) text += '   ';
        previousEnd = item.endX;
        continue;
      }

      if (previousEnd !== null) {
        const gap = item.x - previousEnd;
        // A gap wider than a few characters is a column boundary, not a space.
        if (gap > previousHeight * 1.5) {
          if (!text.endsWith('   ')) text += '   ';
        } else if (gap > previousHeight * 0.15 && !text.endsWith(' ') && !item.text.startsWith(' ')) {
          text += ' ';
        }
      }

      text += item.text;
      previousEnd = item.endX;
      previousHeight = item.height;
    }

    // The largest glyph on the line characterises it: a heading stays a
    // heading even when it ends with a small trailing footnote marker.
    const size = line.items.reduce((largest, item) => Math.max(largest, item.height), 0);
    return { text: text.replace(/\s+$/, ''), size };
  });
}

/**
 * Turn font sizes into heading markers.
 *
 * A PDF has no notion of a heading - only glyphs at coordinates. What actually
 * distinguishes "Approval Requirements" from body text is that it is set
 * larger, so that is what is measured: the modal glyph size across the document
 * is the body size, and anything meaningfully above it is a heading.
 *
 * Markers are emitted as Markdown (`#`, `##`) so the shared element builder
 * recognises them without needing a separate code path for PDFs.
 */
function markHeadingsByFontSize(pages: ReconstructedLine[][]): string[][] {
  const histogram = new Map<number, number>();
  for (const lines of pages) {
    for (const line of lines) {
      // Lines with no size come from OCR, which reports no font metrics. They
      // must not enter the histogram: a page of zero-sized lines would drag the
      // computed body size to zero and make every line look like a heading.
      if (line.size <= 0 || line.text.trim().length === 0) continue;
      // Round to a quarter point: the same nominal size varies slightly.
      const bucket = Math.round(line.size * 4) / 4;
      // Weight by text length so a handful of large headings cannot outvote
      // the body text they introduce.
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + line.text.length);
    }
  }

  if (histogram.size === 0) return pages.map((lines) => lines.map((line) => line.text));

  const bodySize = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (bodySize <= 0) return pages.map((lines) => lines.map((line) => line.text));

  const majorThreshold = bodySize * 1.22;
  const minorThreshold = bodySize * 1.06;

  return pages.map((lines) =>
    lines.map((line) => {
      const text = line.text.trim();
      if (text.length === 0) return line.text;
      // No size means OCR: leave the line alone and let the textual heading
      // heuristics in the element builder decide.
      if (line.size <= 0) return line.text;
      // A long line set slightly large is emphasised prose, not a heading.
      if (text.length > 90) return line.text;
      if (line.size >= majorThreshold) return `# ${text}`;
      if (line.size >= minorThreshold) return `## ${text}`;
      return line.text;
    }),
  );
}

/**
 * Remove running headers and footers.
 *
 * Every page of a controlled document repeats its code, title, revision and
 * page number. Left in place, that boilerplate lands in every chunk, dilutes
 * the embedding of genuinely different sections, and makes near-duplicate
 * detection fire on unrelated pages. Removal is evidence-based rather than
 * positional: a line is dropped only if the same normalised text appears in the
 * same band (top or bottom) on most pages.
 *
 * Normalisation maps digits to `#` so "Page 1 of 9" and "Page 7 of 9" are
 * recognised as the same running footer.
 */
function stripRunningHeadersAndFooters(pages: string[][]): string[][] {
  if (pages.length < 2) return pages;

  const BAND = 2;
  const threshold = pages.length === 2 ? 2 : Math.ceil(pages.length * 0.6);

  const tally = (extract: (lines: string[]) => string[]): Set<string> => {
    const counts = new Map<string, number>();
    for (const lines of pages) {
      // Count each distinct normalised line once per page.
      const seen = new Set(extract(lines).map(normalizeRunningLine).filter((line) => line.length > 0));
      for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
  };

  const headerKeys = tally((lines) => lines.slice(0, BAND));
  const footerKeys = tally((lines) => lines.slice(-BAND));

  if (headerKeys.size === 0 && footerKeys.size === 0) return pages;

  return pages.map((lines) => {
    const result = [...lines];

    for (let i = 0; i < Math.min(BAND, result.length); i += 1) {
      const key = normalizeRunningLine(result[i] as string);
      if (key.length > 0 && headerKeys.has(key)) result[i] = '';
    }

    for (let i = Math.max(0, result.length - BAND); i < result.length; i += 1) {
      const key = normalizeRunningLine(result[i] as string);
      if (key.length > 0 && footerKeys.has(key)) result[i] = '';
    }

    return result.filter((line, index) => line.length > 0 || (index > 0 && index < result.length - 1));
  });
}

function normalizeRunningLine(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
}

export class PdfDocumentParser implements DocumentParser {
  readonly name = 'pdf';

  private readonly logger = childLogger({ component: 'parser', parser: 'pdf' });

  constructor(
    private readonly ocr: OCRProvider,
    private readonly config: AppConfig = getConfig(),
  ) {}

  supports(mimeType: string, key: string): boolean {
    return mimeType === 'application/pdf' || key.endsWith('.pdf');
  }

  async parse(data: Buffer, options: ParseOptions): Promise<ParsedDocument> {
    const pdfjs = await loadPdfjs();

    let document: PdfDocument;
    try {
      document = await pdfjs.getDocument({
        // pdfjs takes ownership of the buffer, so hand it a copy - the caller
        // still needs the original bytes to compute the file hash.
        data: new Uint8Array(data),
        // Suppress the console warnings a slightly malformed PDF produces; real
        // failures still throw.
        verbosity: 0,
        isEvalSupported: false,
        useSystemFonts: false,
      }).promise;
    } catch (error) {
      throw new ParseError(`cannot open PDF "${options.key}": ${toErrorMessage(error)}`, { cause: error });
    }

    try {
      return await this.parseDocument(document, options);
    } finally {
      await document.destroy?.();
    }
  }

  private async parseDocument(document: PdfDocument, options: ParseOptions): Promise<ParsedDocument> {
    const pageCount: number = document.numPages;
    if (pageCount === 0) throw new ParseError(`PDF "${options.key}" contains no pages`);

    const sourceMetadata = await this.readMetadata(document);

    const ocrEnabled = options.ocrEnabled ?? this.config.ocr.enabled;
    const maxOcrPages = options.maxOcrPages ?? this.config.ocr.maxPagesPerDocument;
    const ocrAvailable = ocrEnabled ? await this.ocr.isAvailable() : false;

    if (ocrEnabled && !ocrAvailable) {
      this.logger.warn(
        { key: options.key },
        'OCR is enabled but the provider is unavailable; scanned pages will yield no text',
      );
    }

    // Two phases: recover each page's lines first, then strip the boilerplate
    // that repeats across pages, and only then build structured elements. The
    // header/footer decision needs to see every page, so it cannot be made
    // while a single page is being processed.
    interface RawPage {
      pageNumber: number;
      lines: ReconstructedLine[];
      extractionMethod: ExtractionMethod;
      nativeCharCount: number;
      requiredOcr: boolean;
      width: number;
      height: number;
    }

    const rawPages: RawPage[] = [];
    const images: ParsedImageAsset[] = [];
    let ocrPageCount = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page: PdfPage = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const items = (textContent.items ?? []).filter(
          (item: unknown): item is TextItem => typeof (item as TextItem).str === 'string',
        );

        const nativeLines = reconstructLines(items);
        const nativeText = normalizeWhitespace(
          dehyphenate(nativeLines.map((line) => line.text).join('\n')),
        );
        const pageArea = Math.max(1, viewport.width * viewport.height);
        const needsOcr = this.pageNeedsOcr(nativeText, pageArea);

        let lines = nativeLines;
        let extractionMethod: ExtractionMethod = 'NATIVE_TEXT';

        if (needsOcr && ocrAvailable && ocrPageCount < maxOcrPages) {
          const rendered = await this.renderPage(page, options.key, pageNumber);
          if (rendered) {
            const result = await this.ocr.extractText({
              image: rendered,
              language: this.config.ocr.language,
              label: `${options.key}#page-${pageNumber}`,
            });

            if (result.text.trim().length > nativeText.length) {
              // OCR output carries no font metrics, so heading detection on
              // these pages falls back to the textual heuristics.
              lines = normalizeWhitespace(dehyphenate(result.text))
                .split('\n')
                .map((text) => ({ text, size: 0 }));
              extractionMethod = 'OCR';
              ocrPageCount += 1;

              // Keep the rendered page as an asset so the vision enricher (and
              // the OCR evaluation fixtures) have something to work with.
              images.push({
                pageNumber,
                assetIndex: 0,
                data: rendered,
                width: Math.round(viewport.width),
                height: Math.round(viewport.height),
                extractedText: result.text,
              });
            }
          }
        } else if (needsOcr) {
          // Record the intent even when OCR could not run, so the admin console
          // can explain an empty page instead of silently showing nothing.
          this.logger.debug({ key: options.key, pageNumber }, 'page needs OCR but it is unavailable');
        }

        rawPages.push({
          pageNumber,
          lines,
          extractionMethod,
          nativeCharCount: nativeText.length,
          requiredOcr: needsOcr,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        });
      } finally {
        page.cleanup?.();
      }
    }

    const markedPages = markHeadingsByFontSize(rawPages.map((page) => page.lines));
    const cleanedLines = stripRunningHeadersAndFooters(markedPages);

    const pages: ParsedPage[] = rawPages.map((page, index) => ({
      pageNumber: page.pageNumber,
      elements: buildElementsFromLines(cleanedLines[index] ?? page.lines.map((line) => line.text)),
      extractionMethod: page.extractionMethod,
      nativeCharCount: page.nativeCharCount,
      requiredOcr: page.requiredOcr,
      width: page.width,
      height: page.height,
    }));

    const totalText = pages.map((page) => elementsToText(page.elements)).join('').trim();
    if (totalText.length === 0) {
      throw new ParseError(
        `PDF "${options.key}" yielded no extractable text across ${pageCount} page(s). ` +
          (ocrEnabled && !ocrAvailable
            ? 'The document appears to be scanned and the OCR provider is unavailable.'
            : 'The document may be corrupt or image-only.'),
      );
    }

    return {
      pages,
      images,
      sourceMetadata,
      pageCount,
      ocrPageCount,
      extractionMethod: rollUpExtractionMethod(pages),
    };
  }

  /**
   * Is the native text layer plausibly this page's content?
   * Both an absolute floor and a density check, because an A4 page with 150
   * characters is a header on a scan, while an index card with 150 characters
   * may be the whole page.
   */
  private pageNeedsOcr(nativeText: string, pageArea: number): boolean {
    const characters = nativeText.replace(/\s/g, '').length;
    if (characters < this.config.ocr.minNativeChars) return true;
    return characters / pageArea < this.config.ocr.minCharsPerPageArea;
  }

  /** Rasterise a page to PNG for OCR/vision. Returns null if rendering fails. */
  private async renderPage(page: PdfPage, key: string, pageNumber: number): Promise<Buffer | null> {
    try {
      const viewport = page.getViewport({ scale: this.config.ocr.renderScale });
      const factory = new NodeCanvasFactory();
      const { canvas, context } = factory.create(viewport.width, viewport.height);

      // OCR accuracy improves markedly on a white ground; a transparent canvas
      // renders dark-on-dark once flattened to PNG.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        canvasFactory: factory,
        background: '#ffffff',
      }).promise;

      return canvas.toBuffer('image/png');
    } catch (error) {
      this.logger.warn(
        { key, pageNumber, err: { message: toErrorMessage(error) } },
        'failed to render PDF page for OCR',
      );
      return null;
    }
  }

  private async readMetadata(document: PdfDocument): Promise<Record<string, string>> {
    try {
      const { info } = await document.getMetadata();
      const metadata: Record<string, string> = {};
      for (const field of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
        const value = (info as Record<string, unknown>)?.[field];
        if (typeof value === 'string' && value.trim().length > 0) metadata[field] = value.trim();
      }
      return metadata;
    } catch {
      return {};
    }
  }
}
