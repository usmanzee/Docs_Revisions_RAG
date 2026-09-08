/**
 * Persistence for logical documents.
 *
 * A document is the revision-independent identity. Nothing here knows about
 * files, chunks or embeddings - that separation is what lets a document survive
 * unchanged while revisions come and go beneath it.
 */

import type { DocumentSummary, DocumentType, Paginated } from '@docs-rag/shared';
import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { ParamList, buildOrderBy, buildPagination, buildWhere, offsetFor } from '../db/query-builder.js';
import { toDateString, toIso, type DocumentRow } from './types.js';

export interface DocumentUpsertInput {
  documentCode: string;
  title: string;
  documentType: DocumentType;
  department: string;
  category?: string | null;
  owner?: string | null;
  description?: string | null;
  isActive?: boolean;
  securityClassification?: string;
  sourceSystem?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DocumentListFilters {
  search?: string | null;
  department?: string | null;
  documentType?: DocumentType | null;
  category?: string | null;
  isActive?: boolean | null;
  /** Only documents that currently have at least one revision in this state. */
  processingStatus?: string | null;
  sort?: string | null;
  page: number;
  pageSize: number;
}

/**
 * Aggregate columns joined onto every document listing. Kept as a single
 * constant so the list and detail queries cannot drift apart.
 */
const DOCUMENT_AGGREGATES = `
    (SELECT count(*) FROM document_revisions r WHERE r.document_id = d.id) AS revision_count,
    (SELECT count(*) FROM document_revisions r
      WHERE r.document_id = d.id AND r.processing_status = 'PENDING') AS pending_revision_count,
    (SELECT count(*) FROM document_revisions r
      WHERE r.document_id = d.id AND r.processing_status = 'FAILED') AS failed_revision_count,
    cur.id                  AS current_revision_id,
    cur.revision_number     AS current_revision_number,
    cur.effective_date      AS current_effective_date,
    COALESCE(cur.chunk_count, 0) AS chunk_count`;

const CURRENT_REVISION_JOIN = `
  LEFT JOIN document_revisions cur
         ON cur.document_id = d.id AND cur.is_current`;

interface DocumentSummaryRow extends DocumentRow {
  revision_count: number;
  pending_revision_count: number;
  failed_revision_count: number;
  current_revision_id: string | null;
  current_revision_number: number | null;
  current_effective_date: Date | null;
  chunk_count: number;
}

const SORTABLE: Readonly<Record<string, string>> = {
  code: 'd.document_code',
  title: 'd.title',
  department: 'd.department',
  type: 'd.document_type',
  updated: 'd.updated_at',
  created: 'd.created_at',
};

export class DocumentRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  /** Bind the repository to a transaction client. */
  withExecutor(executor: Queryable): DocumentRepository {
    return new DocumentRepository(executor);
  }

  /**
   * Insert or update by `document_code`.
   *
   * The corpus generator and any future connector both discover documents
   * repeatedly; upserting on the business key keeps discovery idempotent while
   * the UUID primary key stays stable for everything that references it.
   */
  async upsert(input: DocumentUpsertInput): Promise<DocumentRow> {
    const row = await queryOne<DocumentRow>(
      `INSERT INTO documents (
         document_code, title, document_type, department, category, owner, description,
         is_active, security_classification, source_system, tags, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (document_code) DO UPDATE SET
         title                   = EXCLUDED.title,
         document_type           = EXCLUDED.document_type,
         department              = EXCLUDED.department,
         category                = EXCLUDED.category,
         owner                   = EXCLUDED.owner,
         description             = EXCLUDED.description,
         is_active               = EXCLUDED.is_active,
         security_classification = EXCLUDED.security_classification,
         source_system           = EXCLUDED.source_system,
         tags                    = EXCLUDED.tags,
         metadata                = EXCLUDED.metadata
       RETURNING *`,
      [
        input.documentCode,
        input.title,
        input.documentType,
        input.department,
        input.category ?? null,
        input.owner ?? null,
        input.description ?? null,
        input.isActive ?? true,
        input.securityClassification ?? 'INTERNAL',
        input.sourceSystem ?? 'LOCAL_FS',
        input.tags ?? [],
        JSON.stringify(input.metadata ?? {}),
      ],
      this.db,
    );
    return row as DocumentRow;
  }

  async findById(id: string): Promise<DocumentRow | null> {
    return queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id], this.db);
  }

  async findByCode(documentCode: string): Promise<DocumentRow | null> {
    return queryOne<DocumentRow>(
      'SELECT * FROM documents WHERE document_code = $1',
      [documentCode],
      this.db,
    );
  }

  async findSummaryById(id: string): Promise<DocumentSummary | null> {
    const row = await queryOne<DocumentSummaryRow>(
      `SELECT d.*, ${DOCUMENT_AGGREGATES} FROM documents d ${CURRENT_REVISION_JOIN} WHERE d.id = $1`,
      [id],
      this.db,
    );
    return row ? mapDocumentSummary(row) : null;
  }

  async findSummaryByCode(documentCode: string): Promise<DocumentSummary | null> {
    const row = await queryOne<DocumentSummaryRow>(
      `SELECT d.*, ${DOCUMENT_AGGREGATES} FROM documents d ${CURRENT_REVISION_JOIN} WHERE d.document_code = $1`,
      [documentCode],
      this.db,
    );
    return row ? mapDocumentSummary(row) : null;
  }

  async list(filters: DocumentListFilters): Promise<Paginated<DocumentSummary>> {
    const params = new ParamList();
    const conditions: string[] = [];

    if (filters.search) {
      // Trigram indexes back the ILIKE; the code match is anchored so typing a
      // document code jumps straight to it.
      const needle = params.add(`%${filters.search}%`);
      conditions.push(`(d.document_code ILIKE ${needle} OR d.title ILIKE ${needle} OR d.description ILIKE ${needle})`);
    }
    if (filters.department) conditions.push(`d.department = ${params.add(filters.department)}`);
    if (filters.documentType) conditions.push(`d.document_type = ${params.add(filters.documentType)}`);
    if (filters.category) conditions.push(`d.category = ${params.add(filters.category)}`);
    if (filters.isActive !== null && filters.isActive !== undefined) {
      conditions.push(`d.is_active = ${params.add(filters.isActive)}`);
    }
    if (filters.processingStatus) {
      conditions.push(
        `EXISTS (SELECT 1 FROM document_revisions r
                  WHERE r.document_id = d.id AND r.processing_status = ${params.add(filters.processingStatus)})`,
      );
    }

    const where = buildWhere(conditions);
    const orderBy = buildOrderBy(filters.sort, SORTABLE, 'd.document_code ASC');

    const totalRow = await queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM documents d ${where}`,
      params.all(),
      this.db,
    );

    const limit = params.add(filters.pageSize);
    const offset = params.add(offsetFor(filters));

    const rows = await queryRows<DocumentSummaryRow>(
      `SELECT d.*, ${DOCUMENT_AGGREGATES}
         FROM documents d
         ${CURRENT_REVISION_JOIN}
         ${where}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params.all(),
      this.db,
    );

    return buildPagination(rows.map(mapDocumentSummary), totalRow?.total ?? 0, filters);
  }

  /** Distinct facet values, used to populate the UI filter dropdowns. */
  async listFacets(): Promise<{ departments: string[]; documentTypes: string[]; categories: string[] }> {
    const [departments, documentTypes, categories] = await Promise.all([
      queryRows<{ value: string }>(
        'SELECT DISTINCT department AS value FROM documents ORDER BY value',
        [],
        this.db,
      ),
      queryRows<{ value: string }>(
        'SELECT DISTINCT document_type AS value FROM documents ORDER BY value',
        [],
        this.db,
      ),
      queryRows<{ value: string }>(
        'SELECT DISTINCT category AS value FROM documents WHERE category IS NOT NULL ORDER BY value',
        [],
        this.db,
      ),
    ]);
    return {
      departments: departments.map((row) => row.value),
      documentTypes: documentTypes.map((row) => row.value),
      categories: categories.map((row) => row.value),
    };
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.db.query('UPDATE documents SET is_active = $2 WHERE id = $1', [id, isActive]);
  }

  async countAll(): Promise<number> {
    const row = await queryOne<{ total: number }>('SELECT count(*)::int AS total FROM documents', [], this.db);
    return row?.total ?? 0;
  }
}

export function mapDocumentSummary(row: DocumentSummaryRow): DocumentSummary {
  return {
    id: row.id,
    documentCode: row.document_code,
    title: row.title,
    documentType: row.document_type,
    department: row.department,
    category: row.category,
    owner: row.owner,
    description: row.description,
    isActive: row.is_active,
    tags: row.tags ?? [],
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
    revisionCount: row.revision_count,
    currentRevisionNumber: row.current_revision_number,
    currentRevisionId: row.current_revision_id,
    currentEffectiveDate: toDateString(row.current_effective_date),
    chunkCount: row.chunk_count,
    pendingRevisionCount: row.pending_revision_count,
    failedRevisionCount: row.failed_revision_count,
  };
}
