/**
 * Workflow diagram rendering.
 *
 * Draws a real vertical flowchart to a bitmap. The diagram carries information
 * that exists nowhere in the page's text layer, which is precisely what makes
 * it a useful test for OCR and vision extraction - the ground-truth text form
 * is stored separately in the fixture metadata so extraction can be scored.
 */

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { SyntheticWorkflow } from '../types.js';

export interface DiagramOptions {
  width: number;
  height: number;
  /** Pixels per point, so the bitmap is crisp when placed into a PDF. */
  scale: number;
}

const BOX_HEIGHT = 34;
const BOX_GAP = 12;
const ARROW_HEIGHT = 12;

function roundedRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawArrow(ctx: SKRSContext2D, centerX: number, fromY: number, toY: number): void {
  ctx.beginPath();
  ctx.moveTo(centerX, fromY);
  ctx.lineTo(centerX, toY - 5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX - 5, toY - 6);
  ctx.lineTo(centerX + 5, toY - 6);
  ctx.lineTo(centerX, toY);
  ctx.closePath();
  ctx.fill();
}

export function renderWorkflowDiagram(workflow: SyntheticWorkflow, options: DiagramOptions): Buffer {
  const { width, height, scale } = options;
  const canvas = createCanvas(Math.ceil(width * scale), Math.ceil(height * scale));
  const ctx = canvas.getContext('2d');

  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#1f2933';
  ctx.fillStyle = '#1f2933';
  ctx.lineWidth = 1.1;
  ctx.textBaseline = 'middle';

  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(workflow.title, 4, 12);

  const boxWidth = Math.min(width - 40, 260);
  const centerX = width / 2;
  const left = centerX - boxWidth / 2;

  // Compress spacing if the flow is taller than the reserved band.
  const nodeCount = workflow.nodes.length;
  const naturalHeight = nodeCount * BOX_HEIGHT + (nodeCount - 1) * (BOX_GAP + ARROW_HEIGHT);
  const available = height - 26;
  const compression = naturalHeight > available ? available / naturalHeight : 1;
  const boxHeight = BOX_HEIGHT * compression;
  const step = boxHeight + (BOX_GAP + ARROW_HEIGHT) * compression;

  let y = 24;

  workflow.nodes.forEach((node, index) => {
    ctx.strokeStyle = '#1f2933';
    ctx.fillStyle = '#f4f6f8';
    roundedRect(ctx, left, y, boxWidth, boxHeight, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#111827';
    ctx.font = `${Math.max(8, 10 * compression)}px sans-serif`;
    ctx.textAlign = 'center';

    // Truncate rather than overflow the box.
    let label = node;
    while (label.length > 4 && ctx.measureText(label).width > boxWidth - 14) {
      label = `${label.slice(0, label.length - 2)}…`;
    }
    ctx.fillText(label, centerX, y + boxHeight / 2);

    if (index < nodeCount - 1) {
      ctx.strokeStyle = '#1f2933';
      ctx.fillStyle = '#1f2933';
      drawArrow(ctx, centerX, y + boxHeight, y + step);
    }

    y += step;
  });

  return canvas.toBuffer('image/png');
}
