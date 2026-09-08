/**
 * Native-text PDF renderer.
 *
 * Produces a PDF with a real text layer, so the ingestion pipeline extracts it
 * natively and never invokes OCR. Workflow diagrams are embedded as images -
 * which is exactly the situation where a text layer is not enough and the
 * optional vision enricher would earn its keep.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import type { SyntheticDocumentContent } from '../types.js';
import { renderWorkflowDiagram } from './diagram-renderer.js';
import { rasterisePage } from './scanned-pdf-renderer.js';
import { DEFAULT_LAYOUT, layoutDocument, type LaidOutPage, type LayoutOptions } from './layout.js';

export interface PdfRenderOptions {
  layout?: LayoutOptions;
  /** Page indices (0-based) to rasterise instead of drawing as text. */
  scannedPageIndices?: Set<number>;
  /** Scale used when rasterising a page. */
  rasterScale?: number;
}

/** Draw the running header and footer that a controlled document carries. */
function drawChrome(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  content: SyntheticDocumentContent,
  pageNumber: number,
  pageCount: number,
  layout: LayoutOptions,
): void {
  const grey = rgb(0.42, 0.45, 0.5);

  page.drawText(`${content.documentCode}  •  ${content.title}`, {
    x: layout.marginX,
    y: layout.pageHeight - 32,
    size: 7.5,
    font,
    color: grey,
  });

  page.drawText(`Revision ${content.revisionNumber}  •  Effective ${content.effectiveDate}`, {
    x: layout.marginX,
    y: 34,
    size: 7.5,
    font,
    color: grey,
  });

  const label = `Page ${pageNumber} of ${pageCount}`;
  page.drawText(label, {
    x: layout.pageWidth - layout.marginX - font.widthOfTextAtSize(label, 7.5),
    y: 34,
    size: 7.5,
    font,
    color: grey,
  });

  page.drawLine({
    start: { x: layout.marginX, y: layout.pageHeight - 40 },
    end: { x: layout.pageWidth - layout.marginX, y: layout.pageHeight - 40 },
    thickness: 0.5,
    color: rgb(0.85, 0.87, 0.9),
  });
}

export async function renderDocumentToPdf(
  content: SyntheticDocumentContent,
  options: PdfRenderOptions = {},
): Promise<Buffer> {
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const pdf = await PDFDocument.create();

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  pdf.setTitle(`${content.documentCode} ${content.title}`);
  pdf.setAuthor(content.owner);
  pdf.setSubject(`${content.department} ${content.documentType}`);
  pdf.setKeywords([content.documentCode, content.department, content.category]);
  pdf.setProducer('docs-revisions-rag synthetic corpus generator');

  const measure = (text: string, size: number, isBold: boolean): number =>
    (isBold ? bold : regular).widthOfTextAtSize(text, size);

  const pages = layoutDocument(content, measure, layout);

  let diagram: PDFImage | null = null;
  if (content.workflow) {
    const figurePage = pages.find((page) => page.figure);
    if (figurePage?.figure) {
      const png = renderWorkflowDiagram(content.workflow, {
        width: figurePage.figure.width,
        height: figurePage.figure.height,
        scale: 2.5,
      });
      diagram = await pdf.embedPng(png);
    }
  }

  const scanned = options.scannedPageIndices ?? new Set<number>();

  for (const [index, laidOut] of pages.entries()) {
    if (scanned.has(index)) {
      await drawRasterisedPage(pdf, laidOut, layout, options.rasterScale ?? 2, content);
      continue;
    }

    const page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
    drawChrome(page, regular, content, index + 1, pages.length, layout);

    for (const line of laidOut.lines) {
      page.drawText(line.text, {
        x: line.x,
        // pdf-lib measures y from the bottom; the layout engine measures from
        // the top, which is the natural direction for flowing text.
        y: layout.pageHeight - line.y,
        size: line.size,
        font: line.bold ? bold : regular,
        color: rgb(0.08, 0.09, 0.11),
      });

      if (line.rule) {
        page.drawLine({
          start: { x: line.x, y: layout.pageHeight - line.y - 4 },
          end: { x: line.x + line.rule.width, y: layout.pageHeight - line.y - 4 },
          thickness: 0.6,
          color: rgb(0.7, 0.73, 0.77),
        });
      }
    }

    if (laidOut.figure && diagram) {
      page.drawImage(diagram, {
        x: laidOut.figure.x,
        y: layout.pageHeight - laidOut.figure.y - laidOut.figure.height,
        width: laidOut.figure.width,
        height: laidOut.figure.height,
      });
    }
  }

  return Buffer.from(await pdf.save());
}

/** Mixed-mode page: painted as a bitmap with no text layer behind it. */
async function drawRasterisedPage(
  pdf: PDFDocument,
  laidOut: LaidOutPage,
  layout: LayoutOptions,
  scale: number,
  content: SyntheticDocumentContent,
): Promise<void> {
  const png = rasterisePage(laidOut, layout, { scale, content });
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
  page.drawImage(image, { x: 0, y: 0, width: layout.pageWidth, height: layout.pageHeight });
}
