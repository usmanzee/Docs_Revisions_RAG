/**
 * Structure-aware chunker.
 *
 * Fixed-size splitting is cheap and wrong: it severs numbered procedures
 * mid-sequence, orphans table rows from their header, and drops the heading
 * that told you which policy a threshold belonged to. This chunker works from
 * the parsed element tree instead, so the units it produces correspond to
 * things a person would recognise.
 *
 * Rules, in priority order:
 *   1. Never cross a top-level section boundary.
 *   2. Keep a numbered procedure whole when it fits inside CHUNK_MAX_TOKENS.
 *   3. Keep a table whole when it fits; when it does not, repeat the header row
 *      on each piece so every fragment stays readable on its own.
 *   4. Otherwise pack elements up to CHUNK_TARGET_TOKENS, allowing overflow to
 *      CHUNK_MAX_TOKENS to avoid a tiny trailing chunk.
 *   5. Split an oversized single paragraph with a recursive character splitter,
 *      which is the one place a generic splitter is the right tool.
 *
 * Overlap is applied only between chunks inside the same section - carrying
 * text across a section boundary would attribute one section's content to
 * another in citations.
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { ExtractionMethod } from '@docs-rag/shared';
import type { ChunkingConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { countTokens, truncateToTokens } from '../../utils/tokens.js';
import { normalizeWhitespace } from '../../utils/text.js';
import { tableToText, type ParsedDocument, type ParsedElement } from '../parsing/types.js';
import type { BuiltChunk, ChunkDocumentContext, ChunkingResult, DocumentChunker } from './types.js';

/** One element, with the page and heading context it was found under. */
interface Block {
  text: string;
  tokens: number;
  pageNumber: number;
  kind: ParsedElement['type'];
  /** Elements that should not be broken apart if it can be avoided. */
  atomic: boolean;
  /** Table header, repeated when an oversized table must be split. */
  tableHeader?: string[];
  tableRows?: string[][];
  tableCaption?: string;
}

interface Section {
  title: string | null;
  subtitle: string | null;
  headingPath: string | null;
  blocks: Block[];
}

const HEADING_MAX_LEVEL_FOR_SECTION = 2;

/**
 * Sections that describe the document rather than state its requirements.
 *
 * A revision-history table lists every past change, so it accumulates the exact
 * wording of every threshold the document has ever had. Left at full weight it
 * will out-rank the section that states the *current* rule - a document with a
 * long history would answer questions with a summary of its own edits. These
 * chunks are kept, because "how did this policy change?" is a real question,
 * but they are marked so retrieval can demote them.
 */
const ADMINISTRATIVE_SECTION_PATTERN =
  /^(revision history|related documents|document control|approval history|change log|version history|references|distribution)$/i;

function sectionRoleFor(title: string | null): 'CONTENT' | 'ADMINISTRATIVE' {
  if (!title) return 'CONTENT';
  return ADMINISTRATIVE_SECTION_PATTERN.test(title.trim()) ? 'ADMINISTRATIVE' : 'CONTENT';
}

function elementToBlock(element: ParsedElement, pageNumber: number): Block | null {
  switch (element.type) {
    case 'heading':
      return null; // headings define structure, they are not content blocks

    case 'paragraph': {
      const text = normalizeWhitespace(element.text);
      if (text.length === 0) return null;
      return { text, tokens: countTokens(text), pageNumber, kind: 'paragraph', atomic: false };
    }

    case 'list': {
      const text = element.items
        .map((item, index) => (element.ordered ? `${index + 1}. ${item}` : `- ${item}`))
        .join('\n');
      if (text.trim().length === 0) return null;
      // Ordered lists are procedures; splitting one mid-sequence produces a
      // chunk that reads like a complete process but is not.
      return { text, tokens: countTokens(text), pageNumber, kind: 'list', atomic: element.ordered };
    }

    case 'table': {
      const text = tableToText(element.rows, element.caption);
      if (text.trim().length === 0) return null;
      const [header, ...rows] = element.rows;
      const block: Block = { text, tokens: countTokens(text), pageNumber, kind: 'table', atomic: true };
      if (header) block.tableHeader = header;
      if (rows.length > 0) block.tableRows = rows;
      if (element.caption) block.tableCaption = element.caption;
      return block;
    }

    case 'image': {
      const text = `[Figure: ${element.description}]`;
      return { text, tokens: countTokens(text), pageNumber, kind: 'image', atomic: true };
    }
  }
}

/** Walk the document, grouping content under the heading that introduced it. */
function buildSections(document: ParsedDocument): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: null, subtitle: null, headingPath: null, blocks: [] };

  const push = (): void => {
    if (current.blocks.length > 0) sections.push(current);
  };

  for (const page of document.pages) {
    for (const element of page.elements) {
      if (element.type === 'heading') {
        if (element.level <= HEADING_MAX_LEVEL_FOR_SECTION) {
          push();
          current = { title: element.text, subtitle: null, headingPath: element.text, blocks: [] };
        } else {
          // A subheading refines the current section without starting a new one,
          // so its content stays attributed to the right parent section.
          push();
          const parentTitle = current.title;
          current = {
            title: parentTitle,
            subtitle: element.text,
            headingPath: parentTitle ? `${parentTitle} > ${element.text}` : element.text,
            blocks: [],
          };
        }
        continue;
      }

      const block = elementToBlock(element, page.pageNumber);
      if (block) current.blocks.push(block);
    }
  }

  push();
  return sections;
}

/** Prefix that gives an embedding the context its body text lacks. */
function buildContextHeader(context: ChunkDocumentContext, section: Section): string {
  const parts = [
    `Document: ${context.documentCode} ${context.documentTitle}`,
    `Department: ${context.department}`,
  ];
  if (section.title) parts.push(`Section: ${section.title}`);
  if (section.subtitle) parts.push(`Subsection: ${section.subtitle}`);
  return parts.join('\n');
}

export class StructureAwareChunker implements DocumentChunker {
  readonly name = 'structure-aware';

  private readonly splitter: RecursiveCharacterTextSplitter;

  constructor(private readonly config: ChunkingConfig = getConfig().chunking) {
    // Characters, not tokens - LangChain's splitter is character-based. The
    // ratio is deliberately conservative so a split piece stays under the token
    // cap even for token-dense text such as tables of figures.
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: config.maxTokens * 3,
      chunkOverlap: config.overlapTokens * 3,
      separators: ['\n\n', '\n', '. ', '; ', ', ', ' ', ''],
    });
  }

  /** Break a table into pieces, repeating the header on each one. */
  private splitTable(block: Block): string[] {
    if (!block.tableHeader || !block.tableRows) return [block.text];

    const pieces: string[] = [];
    let rows: string[][] = [];

    const render = (batch: string[][]): string =>
      tableToText([block.tableHeader as string[], ...batch], block.tableCaption);

    for (const row of block.tableRows) {
      const candidate = [...rows, row];
      if (countTokens(render(candidate)) > this.config.maxTokens && rows.length > 0) {
        pieces.push(render(rows));
        rows = [row];
      } else {
        rows = candidate;
      }
    }

    if (rows.length > 0) pieces.push(render(rows));
    return pieces;
  }

  /**
   * Expand a block into pieces that each fit within the token cap.
   *
   * Async because LangChain's recursive splitter is async-only. That splitter is
   * used for exactly one case - a single paragraph too long to fit - where a
   * generic character-based split is genuinely the right tool.
   */
  private async explodeOversizedBlock(block: Block): Promise<string[]> {
    if (block.tokens <= this.config.maxTokens) return [block.text];

    if (block.kind === 'table') return this.splitTable(block);

    if (block.kind === 'list') {
      // Preserve step boundaries: split between items, never inside one.
      const items = block.text.split('\n');
      const pieces: string[] = [];
      let buffer: string[] = [];
      for (const item of items) {
        const candidate = [...buffer, item];
        if (countTokens(candidate.join('\n')) > this.config.maxTokens && buffer.length > 0) {
          pieces.push(buffer.join('\n'));
          buffer = [item];
        } else {
          buffer = candidate;
        }
      }
      if (buffer.length > 0) pieces.push(buffer.join('\n'));
      return pieces;
    }

    // A single very long paragraph: the one case for a generic splitter.
    return this.splitter.splitText(block.text);
  }

  /** Trailing text of the previous chunk, used as overlap. */
  private overlapTail(text: string): string {
    if (this.config.overlapTokens <= 0) return '';

    const sentences = text.split(/(?<=[.!?])\s+/);
    const tail: string[] = [];
    let tokens = 0;

    for (let index = sentences.length - 1; index >= 0; index -= 1) {
      const sentence = sentences[index] as string;
      const sentenceTokens = countTokens(sentence);
      if (tokens + sentenceTokens > this.config.overlapTokens) break;
      tail.unshift(sentence);
      tokens += sentenceTokens;
    }

    return tail.join(' ').trim();
  }

  async chunk(document: ParsedDocument, context: ChunkDocumentContext): Promise<ChunkingResult> {
    const sections = buildSections(document);
    const chunks: BuiltChunk[] = [];
    let chunkIndex = 0;

    const documentMethod = document.extractionMethod;

    /**
     * Only *trivially* small sections are accumulated and emitted together.
     *
     * Purpose and Scope are each a couple of sentences; embedding them as
     * separate 30-token chunks buries their signal and multiplies the index for
     * nothing. But merging is kept deliberately timid, because a merged chunk
     * can only carry one section title and citations are expected to name the
     * section an answer came from. Anything large enough to be a meaningful
     * retrieval target on its own - "Approval Requirements", say - keeps its own
     * chunk and its own title.
     */
    let pending: { section: Section; text: string; tokens: number }[] = [];
    let pendingTokens = 0;

    const flushPending = (): void => {
      if (pending.length === 0) return;

      const first = pending[0] as { section: Section; text: string; tokens: number };
      const last = pending[pending.length - 1] as { section: Section; text: string; tokens: number };

      // A merged chunk spans several headings, so each heading is written into
      // the body - otherwise the reader cannot tell where one ends.
      const content =
        pending.length === 1
          ? first.text
          : pending
              .map((entry) => (entry.section.title ? `${entry.section.title}\n${entry.text}` : entry.text))
              .join('\n\n');

      const titles = pending
        .map((entry) => entry.section.title)
        .filter((title): title is string => Boolean(title));

      const headerSection: Section =
        pending.length === 1
          ? first.section
          : {
              title: first.section.title,
              subtitle: null,
              headingPath: titles.join(' | '),
              blocks: [],
            };

      const pages = pending.flatMap((entry) => entry.section.blocks.map((block) => block.pageNumber));
      const methods = new Set(
        document.pages
          .filter((page) => pages.includes(page.pageNumber))
          .map((page) => page.extractionMethod),
      );

      chunks.push({
        chunkIndex: chunkIndex++,
        chunkType: 'CHILD',
        parentChunkIndex: null,
        pageStart: pages.length > 0 ? Math.min(...pages) : null,
        pageEnd: pages.length > 0 ? Math.max(...pages) : null,
        sectionTitle: first.section.title,
        subsectionTitle: pending.length === 1 ? first.section.subtitle : null,
        headingPath: headerSection.headingPath,
        content,
        embeddingText: `${buildContextHeader(context, headerSection)}\n\n${content}`,
        tokenCount: countTokens(content),
        extractionMethod:
          methods.size === 1
            ? ((methods.values().next().value ?? documentMethod) as ExtractionMethod)
            : 'MIXED',
        metadata: {
          ...(pending.length > 1 ? { mergedSections: titles } : {}),
          // Groups are role-homogeneous by construction, so the first entry
          // decides the role for the whole chunk.
          ...(sectionRoleFor(first.section.title) === 'ADMINISTRATIVE'
            ? { sectionRole: 'ADMINISTRATIVE' }
            : {}),
        },
      });

      void last;
      pending = [];
      pendingTokens = 0;
    };

    for (const section of sections) {
      const header = buildContextHeader(context, section);
      const sectionText = section.blocks.map((block) => block.text).join('\n\n');
      if (sectionText.trim().length === 0) continue;

      const wholeSectionTokens = countTokens(sectionText);

      // Small enough to travel with its neighbours.
      if (wholeSectionTokens <= this.config.minTokens) {
        // Never merge an administrative section into a content one. Doing so
        // would both mislabel the chunk's section title and erase the role that
        // lets retrieval demote revision histories.
        const role = sectionRoleFor(section.title);
        const pendingRole = pending[0] ? sectionRoleFor(pending[0].section.title) : role;

        if (pendingTokens + wholeSectionTokens > this.config.targetTokens || role !== pendingRole) {
          flushPending();
        }
        pending.push({ section, text: sectionText, tokens: wholeSectionTokens });
        pendingTokens += wholeSectionTokens;
        continue;
      }

      // Large sections are chunked on their own, so flush what is waiting.
      flushPending();

      const pageStart = section.blocks[0]?.pageNumber ?? null;
      const pageEnd = section.blocks[section.blocks.length - 1]?.pageNumber ?? null;

      // Extraction method for this section: pages it spans may differ.
      const sectionPages = new Set(section.blocks.map((block) => block.pageNumber));
      const methods = new Set(
        document.pages
          .filter((page) => sectionPages.has(page.pageNumber))
          .map((page) => page.extractionMethod),
      );
      const extractionMethod: ExtractionMethod =
        methods.size === 1 ? ((methods.values().next().value ?? documentMethod) as ExtractionMethod) : 'MIXED';

      // --- Parent chunk -----------------------------------------------------
      // A parent is only worth creating when the section is large enough that a
      // child had to be cut out of it.
      let parentIndex: number | null = null;

      if (this.config.parentChunksEnabled && wholeSectionTokens > this.config.targetTokens) {
        // Bound the parent's *content*, not just its recorded size: a parent is
        // handed to the model in place of its child, so an unbounded one would
        // blow the context budget it was meant to fit inside.
        const parentContent =
          wholeSectionTokens > this.config.parentMaxTokens
            ? truncateToTokens(sectionText, this.config.parentMaxTokens)
            : sectionText;

        parentIndex = chunkIndex;
        chunks.push({
          chunkIndex: chunkIndex++,
          chunkType: 'PARENT',
          parentChunkIndex: null,
          pageStart,
          pageEnd,
          sectionTitle: section.title,
          subsectionTitle: section.subtitle,
          headingPath: section.headingPath,
          content: parentContent,
          // Parents are not retrieval targets, so they are not embedded; they
          // are fetched by id when a matching child asks for more context.
          embeddingText: '',
          tokenCount: countTokens(parentContent),
          extractionMethod,
          metadata: {
            role: 'parent-section',
            ...(sectionRoleFor(section.title) === 'ADMINISTRATIVE'
              ? { sectionRole: 'ADMINISTRATIVE' }
              : {}),
          },
        });
      }

      // --- Child chunks -----------------------------------------------------
      const pieces: { text: string; page: number; atomic: boolean }[] = [];
      for (const block of section.blocks) {
        for (const piece of await this.explodeOversizedBlock(block)) {
          pieces.push({ text: piece, page: block.pageNumber, atomic: block.atomic });
        }
      }

      let buffer: string[] = [];
      let bufferTokens = 0;
      let bufferPageStart: number | null = null;
      let bufferPageEnd: number | null = null;
      let previousText = '';

      const flush = (): void => {
        if (buffer.length === 0) return;

        const overlap = previousText.length > 0 ? this.overlapTail(previousText) : '';
        const body = buffer.join('\n\n');
        const content = overlap.length > 0 ? `${overlap}\n\n${body}` : body;

        chunks.push({
          chunkIndex: chunkIndex++,
          chunkType: 'CHILD',
          parentChunkIndex: parentIndex,
          pageStart: bufferPageStart,
          pageEnd: bufferPageEnd,
          sectionTitle: section.title,
          subsectionTitle: section.subtitle,
          headingPath: section.headingPath,
          content,
          embeddingText: `${header}\n\n${content}`,
          tokenCount: countTokens(content),
          extractionMethod,
          metadata:
            sectionRoleFor(section.title) === 'ADMINISTRATIVE' ? { sectionRole: 'ADMINISTRATIVE' } : {},
        });

        previousText = body;
        buffer = [];
        bufferTokens = 0;
        bufferPageStart = null;
        bufferPageEnd = null;
      };

      for (const piece of pieces) {
        const pieceTokens = countTokens(piece.text);

        // Past the target, close the chunk - unless the piece is atomic (a
        // procedure or a table), in which case tolerate overflow up to the hard
        // cap rather than sever it.
        const wouldExceedTarget = bufferTokens + pieceTokens > this.config.targetTokens;
        const wouldExceedMax = bufferTokens + pieceTokens > this.config.maxTokens;

        if (buffer.length > 0 && (wouldExceedMax || (wouldExceedTarget && !piece.atomic))) {
          flush();
        }

        buffer.push(piece.text);
        bufferTokens += pieceTokens;
        bufferPageStart ??= piece.page;
        bufferPageEnd = piece.page;
      }

      // A very small trailing chunk carries little signal on its own; merge it
      // back into its predecessor when the combined size still fits.
      if (buffer.length > 0 && bufferTokens < this.config.minTokens && chunks.length > 0) {
        const last = chunks[chunks.length - 1];
        if (
          last &&
          last.chunkType === 'CHILD' &&
          last.sectionTitle === section.title &&
          last.tokenCount + bufferTokens <= this.config.maxTokens
        ) {
          last.content = `${last.content}\n\n${buffer.join('\n\n')}`;
          last.embeddingText = `${header}\n\n${last.content}`;
          last.tokenCount = countTokens(last.content);
          last.pageEnd = bufferPageEnd ?? last.pageEnd;
          buffer = [];
          bufferTokens = 0;
        }
      }

      flush();
    }

    flushPending();

    const childCount = chunks.filter((chunk) => chunk.chunkType === 'CHILD').length;

    return {
      chunks,
      childCount,
      parentCount: chunks.length - childCount,
      totalTokens: chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
    };
  }
}

export function createChunker(config: ChunkingConfig = getConfig().chunking): DocumentChunker {
  return new StructureAwareChunker(config);
}
