/**
 * Scanned-PDF renderer.
 *
 * Produces genuinely image-only pages: the laid-out text is painted onto a
 * bitmap, the bitmap becomes the whole page, and no text layer is written. A
 * PDF produced here returns nothing useful from native extraction, which forces
 * the ingestion pipeline down the OCR path for real rather than because a
 * metadata flag said so.
 *
 * Light scan artefacts (a small rotation, faint speckle, slightly grey paper)
 * are applied so OCR faces something closer to a real scanned document than to
 * a pristine screenshot.
 */

import { createCanvas, Image, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import type { SeededRandom } from '../../../utils/random.js';
import type { SyntheticDocumentContent } from '../types.js';
import { renderWorkflowDiagram } from './diagram-renderer.js';
import { DEFAULT_LAYOUT, layoutDocument, type LaidOutPage, type LayoutOptions } from './layout.js';

export interface RasteriseOptions {
  scale: number;
  content: SyntheticDocumentContent;
  /** Deterministic source for scan artefacts; omit for a clean render. */
  rng?: SeededRandom;
}

/** Faint speckle and a slightly off-white ground, as a real scanner produces. */
function applyScanArtefacts(ctx: SKRSContext2D, width: number, height: number, rng: SeededRandom): void {
  const speckCount = Math.floor((width * height) / 26_000);
  ctx.fillStyle = 'rgba(60, 60, 60, 0.16)';
  for (let i = 0; i < speckCount; i += 1) {
    const x = rng.float(0, width);
    const y = rng.float(0, height);
    const size = rng.float(0.5, 1.6);
    ctx.fillRect(x, y, size, size);
  }

  // A soft vignette along one edge, imitating the shadow of a lifted page.
  const gradient = ctx.createLinearGradient(0, 0, width * 0.18, 0);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.07)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width * 0.18, height);
}

/** Paint one laid-out page onto a bitmap and return PNG bytes. */
export function rasterisePage(
  laidOut: LaidOutPage,
  layout: LayoutOptions,
  options: RasteriseOptions,
): Buffer {
  const { scale, content, rng } = options;
  const canvas = createCanvas(Math.ceil(layout.pageWidth * scale), Math.ceil(layout.pageHeight * scale));
  const ctx = canvas.getContext('2d');

  ctx.scale(scale, scale);

  // Slightly grey paper rather than pure white - pure white is a giveaway that
  // a "scan" was generated, and it also flatters OCR unrealistically.
  ctx.fillStyle = rng ? '#fbfbf9' : '#ffffff';
  ctx.fillRect(0, 0, layout.pageWidth, layout.pageHeight);

  if (rng) {
    // A fraction of a degree of skew, about the page centre.
    const skew = rng.float(-0.45, 0.45) * (Math.PI / 180);
    ctx.translate(layout.pageWidth / 2, layout.pageHeight / 2);
    ctx.rotate(skew);
    ctx.translate(-layout.pageWidth / 2, -layout.pageHeight / 2);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#141414';

  for (const line of laidOut.lines) {
    ctx.font = `${line.bold ? 'bold ' : ''}${line.size}px Helvetica, Arial, sans-serif`;
    ctx.fillText(line.text, line.x, line.y);

    if (line.rule) {
      ctx.strokeStyle = '#5a5a5a';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(line.x, line.y + 4);
      ctx.lineTo(line.x + line.rule.width, line.y + 4);
      ctx.stroke();
    }
  }

  if (laidOut.figure && content.workflow) {
    const png = renderWorkflowDiagram(content.workflow, {
      width: laidOut.figure.width,
      height: laidOut.figure.height,
      scale: 2,
    });
    const image = new Image();
    image.src = png;
    ctx.drawImage(image, laidOut.figure.x, laidOut.figure.y, laidOut.figure.width, laidOut.figure.height);
  }

  if (rng) applyScanArtefacts(ctx, layout.pageWidth, layout.pageHeight, rng);

  return canvas.toBuffer('image/png');
}

export interface ScannedPdfOptions {
  layout?: LayoutOptions;
  scale?: number;
  rng?: SeededRandom;
}

/** Render an entire document as an image-only PDF. */
export async function renderDocumentToScannedPdf(
  content: SyntheticDocumentContent,
  options: ScannedPdfOptions = {},
): Promise<Buffer> {
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const scale = options.scale ?? 2;

  const pdf = await PDFDocument.create();
  // Deliberately minimal metadata: a scanned document carries no authoring info.
  pdf.setProducer('Fujitsu ScanSnap');
  pdf.setCreator('Enterprise Document Scanner');

  // Measurement uses a canvas context so wrapping matches what is painted.
  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext('2d');
  const measure = (text: string, size: number, bold: boolean): number => {
    measureCtx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
    return measureCtx.measureText(text).width;
  };

  const pages = layoutDocument(content, measure, layout);

  for (const laidOut of pages) {
    const png = rasterisePage(laidOut, layout, { scale, content, rng: options.rng });
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
    page.drawImage(image, { x: 0, y: 0, width: layout.pageWidth, height: layout.pageHeight });
  }

  return Buffer.from(await pdf.save());
}
