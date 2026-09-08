/**
 * DOCX renderer.
 *
 * Emits real OOXML with heading styles, bullet and numbered lists and tables,
 * so the DOCX parser has genuine structure to recover rather than a wall of
 * paragraphs.
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { SyntheticDocumentContent, SyntheticSection, SyntheticTable } from '../types.js';

function renderTable(table: SyntheticTable): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];

  if (table.caption) {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: table.caption, italics: true, size: 19 })],
        spacing: { before: 120, after: 60 },
      }),
    );
  }

  const headerRow = new TableRow({
    tableHeader: true,
    children: table.header.map(
      (cell) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true, size: 19 })] })],
        }),
    ),
  });

  const bodyRows = table.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cell, size: 19 })] })],
            }),
        ),
      }),
  );

  blocks.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...bodyRows],
    }),
  );

  blocks.push(new Paragraph({ text: '', spacing: { after: 120 } }));
  return blocks;
}

function renderSection(section: SyntheticSection, depth: number): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];

  blocks.push(
    new Paragraph({
      text: section.title,
      heading: depth === 0 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 100 },
    }),
  );

  for (const paragraph of section.paragraphs) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: paragraph, size: 21 })], spacing: { after: 120 } }));
  }

  for (const bullet of section.bullets ?? []) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: bullet, size: 21 })], bullet: { level: 0 } }));
  }

  (section.steps ?? []).forEach((step, index) => {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: `${index + 1}. ${step}`, size: 21 })],
        indent: { left: 360 },
        spacing: { after: 60 },
      }),
    );
  });

  if (section.table) blocks.push(...renderTable(section.table));

  for (const subsection of section.subsections ?? []) blocks.push(...renderSection(subsection, depth + 1));

  return blocks;
}

export async function renderDocumentToDocx(content: SyntheticDocumentContent): Promise<Buffer> {
  const header: (Paragraph | Table)[] = [
    new Paragraph({
      children: [new TextRun({ text: content.documentCode, bold: true, size: 32 })],
      alignment: AlignmentType.LEFT,
    }),
    new Paragraph({
      children: [new TextRun({ text: content.title, bold: true, size: 28 })],
      spacing: { after: 200 },
    }),
    ...(
      [
        ['Department', content.department],
        ['Document Type', content.documentType],
        ['Category', content.category],
        ['Owner', content.owner],
        ['Effective Date', content.effectiveDate],
        ['Revision', String(content.revisionNumber)],
        ['Classification', 'Internal'],
      ] as [string, string][]
    ).map(
      ([label, value]) =>
        new Paragraph({
          children: [
            new TextRun({ text: `${label}: `, bold: true, size: 19 }),
            new TextRun({ text: value, size: 19 }),
          ],
        }),
    ),
    new Paragraph({ text: '', spacing: { after: 200 } }),
  ];

  const body = content.sections.flatMap((section) => renderSection(section, 0));

  const document = new Document({
    title: `${content.documentCode} ${content.title}`,
    description: content.purpose,
    creator: content.owner,
    sections: [{ properties: {}, children: [...header, ...body] }],
  });

  return Buffer.from(await Packer.toBuffer(document));
}
