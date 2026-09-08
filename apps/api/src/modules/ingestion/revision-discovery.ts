/**
 * Revision discovery.
 *
 * Reconciles what is on the storage driver with what PostgreSQL knows about.
 * The synthetic corpus generator registers its own rows, but discovery is what
 * makes the system behave like a real document repository: drop a new
 * `rev-003/` folder onto the share and the next ingestion run picks it up.
 *
 * Three cases are handled:
 *   * a file with no revision row       -> register it as PENDING
 *   * a file whose bytes changed        -> re-queue the revision as PENDING
 *   * a revision row with no file       -> reported, never silently deleted
 */

import type { DocumentType } from '@docs-rag/shared';
import { getPool, queryOne, type Queryable } from '../../db/pool.js';
import { DocumentRepository } from '../../repositories/document-repository.js';
import { RevisionRepository } from '../../repositories/revision-repository.js';
import { sha256 } from '../../utils/hash.js';
import { childLogger } from '../../utils/logger.js';
import { contentTypeForKey, type DocumentStorage } from '../storage/index.js';

export interface DiscoveryResult {
  filesScanned: number;
  revisionsRegistered: number;
  revisionsRequeued: number;
  missingFiles: string[];
  unknownDocuments: string[];
}

/** `FIN-POL-0001/rev-002/expense-policy.pdf` -> code + revision number. */
const KEY_PATTERN = /^([A-Za-z0-9._-]+)\/rev-(\d{1,4})\/(.+)$/;

export interface ParsedStorageKey {
  documentCode: string;
  revisionNumber: number;
  fileName: string;
}

export function parseStorageKey(key: string): ParsedStorageKey | null {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const revisionNumber = Number.parseInt(match[2] as string, 10);
  if (!Number.isFinite(revisionNumber) || revisionNumber < 1) return null;
  return { documentCode: match[1] as string, revisionNumber, fileName: match[3] as string };
}

/** Human-readable title from a file name, for documents found without metadata. */
function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Best-effort document type from the code prefix, e.g. "FIN-POL-001" -> POLICY. */
function documentTypeFromCode(documentCode: string): DocumentType {
  const segment = documentCode.split('-')[1]?.toUpperCase() ?? '';
  switch (segment) {
    case 'POL':
      return 'POLICY';
    case 'PROC':
      return 'PROCEDURE';
    case 'STD':
      return 'STANDARD';
    case 'GUIDE':
      return 'GUIDELINE';
    case 'MAN':
      return 'MANUAL';
    case 'WF':
      return 'WORKFLOW';
    case 'FAQ':
      return 'FAQ';
    default:
      return 'POLICY';
  }
}

export class RevisionDiscoveryService {
  private readonly logger = childLogger({ component: 'discovery' });

  constructor(
    private readonly storage: DocumentStorage,
    private readonly documents: DocumentRepository,
    private readonly revisions: RevisionRepository,
    private readonly db: Queryable = getPool(),
  ) {}

  async discover(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      filesScanned: 0,
      revisionsRegistered: 0,
      revisionsRequeued: 0,
      missingFiles: [],
      unknownDocuments: [],
    };

    const entries = await this.storage.list();
    result.filesScanned = entries.length;

    for (const entry of entries) {
      const parsed = parseStorageKey(entry.key);
      if (!parsed) {
        // A file outside the <code>/rev-NNN/<file> convention is not a document
        // revision; ignoring it is correct, but it is worth surfacing.
        this.logger.debug({ key: entry.key }, 'ignoring file that does not match the revision layout');
        continue;
      }

      const existing = await queryOne<{
        id: string;
        file_hash: string;
        processing_status: string;
        file_size_bytes: number | null;
        source_modified_at: Date | null;
      }>(
        `SELECT r.id, r.file_hash, r.processing_status, r.file_size_bytes, r.source_modified_at
           FROM document_revisions r
           JOIN documents d ON d.id = r.document_id
          WHERE d.document_code = $1 AND r.revision_number = $2`,
        [parsed.documentCode, parsed.revisionNumber],
        this.db,
      );

      if (existing) {
        // Cheap check first. Reading and hashing every file on every run is the
        // dominant cost of discovery at scale - 5,000 documents means 5,000 full
        // file reads to usually learn that nothing changed. Size and mtime are
        // free from the directory listing, so a file whose size and timestamp
        // both match what was recorded is taken as unchanged.
        //
        // This is a heuristic, and a deliberate one: a same-size edit that
        // preserves mtime would be missed. That is the standard trade every
        // incremental sync makes, and the escape hatch is explicit - reprocess
        // the revision from the admin API, which always re-reads.
        const unchangedBySignature =
          existing.file_size_bytes === entry.size &&
          existing.source_modified_at !== null &&
          existing.source_modified_at.getTime() === entry.modifiedAt.getTime();

        if (unchangedBySignature) continue;

        const bytes = await this.storage.read(entry.key);
        const fileHash = sha256(bytes);

        if (fileHash !== existing.file_hash) {
          this.logger.info(
            { documentCode: parsed.documentCode, revisionNumber: parsed.revisionNumber },
            'file changed in place; re-queueing revision',
          );
          await this.db.query(
            `UPDATE document_revisions
                SET file_hash        = $2,
                    file_size_bytes  = $3,
                    source_modified_at = $4,
                    processing_status = 'PENDING',
                    processing_error  = NULL
              WHERE id = $1`,
            [existing.id, fileHash, bytes.length, entry.modifiedAt],
          );
          result.revisionsRequeued += 1;
        }
        continue;
      }

      // No revision row: register it, creating the document if necessary.
      let document = await this.documents.findByCode(parsed.documentCode);
      if (!document) {
        result.unknownDocuments.push(parsed.documentCode);
        this.logger.info(
          { documentCode: parsed.documentCode },
          'discovered a document not present in the register; creating it from the storage layout',
        );
        document = await this.documents.upsert({
          documentCode: parsed.documentCode,
          title: titleFromFileName(parsed.fileName),
          documentType: documentTypeFromCode(parsed.documentCode),
          department: 'Unassigned',
          description: 'Discovered on the document share; metadata not yet supplied.',
          metadata: { discovered: true, storageKey: entry.key },
        });
      }

      const bytes = await this.storage.read(entry.key);

      await this.revisions.create({
        documentId: document.id,
        revisionNumber: parsed.revisionNumber,
        filePath: entry.key,
        fileName: parsed.fileName,
        mimeType: contentTypeForKey(entry.key),
        fileSizeBytes: bytes.length,
        fileHash: sha256(bytes),
        sourceModifiedAt: entry.modifiedAt,
        storageDriver: this.storage.driver,
        metadata: { discovered: true },
      });

      result.revisionsRegistered += 1;
    }

    // Revisions whose file has vanished. Never deleted automatically: losing a
    // file is an operational problem, and silently discarding its chunks would
    // remove content that is still the organisation's current policy.
    const known = new Set(entries.map((entry) => entry.key));
    const rows = await this.db.query<{ file_path: string }>(
      `SELECT r.file_path FROM document_revisions r WHERE r.processing_status <> 'FAILED'`,
      [],
    );
    for (const row of rows.rows) {
      if (!known.has(row.file_path)) result.missingFiles.push(row.file_path);
    }

    if (result.missingFiles.length > 0) {
      this.logger.warn(
        { count: result.missingFiles.length, sample: result.missingFiles.slice(0, 5) },
        'revisions reference files that are no longer present on the storage driver',
      );
    }

    return result;
  }
}
