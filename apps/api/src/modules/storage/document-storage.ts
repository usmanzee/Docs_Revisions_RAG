/**
 * Storage abstraction for the enterprise document repository.
 *
 * Ingestion talks only to this interface, so replacing the local filesystem
 * with S3, Azure Blob, a network share or SharePoint means writing one new
 * implementation - not touching the pipeline.
 *
 * The contract is deliberately narrow and key-based. A `StorageKey` is an
 * opaque, driver-relative identifier such as
 * `FIN-POL-0001/rev-002/expense-policy.pdf`. It is never an absolute path, and
 * a driver must reject any key that tries to escape its root. That single rule
 * is what makes it safe to store keys in the database and accept revision ids
 * from HTTP clients: no client-supplied string ever becomes a filesystem path.
 */

export type StorageKey = string;

export interface StoredObjectMetadata {
  key: StorageKey;
  size: number;
  modifiedAt: Date;
  contentType: string;
}

export interface StorageListEntry {
  key: StorageKey;
  size: number;
  modifiedAt: Date;
}

export interface DocumentStorage {
  /** Driver identifier persisted on the revision row (`local`, `s3`, ...). */
  readonly driver: string;

  /** Human-readable root, for logs and the admin console. */
  readonly root: string;

  read(key: StorageKey): Promise<Buffer>;

  write(key: StorageKey, data: Buffer | string, options?: { contentType?: string }): Promise<StoredObjectMetadata>;

  exists(key: StorageKey): Promise<boolean>;

  stat(key: StorageKey): Promise<StoredObjectMetadata>;

  /** Recursive listing beneath a prefix, used by revision discovery. */
  list(prefix?: StorageKey): Promise<StorageListEntry[]>;

  delete(key: StorageKey): Promise<void>;

  /**
   * Open a stream for serving the original file over HTTP.
   * Returns a Node readable so a large PDF is not buffered in memory.
   */
  createReadStream(key: StorageKey): Promise<NodeJS.ReadableStream>;
}

/** Content types the pipeline understands. Anything else is rejected early. */
export const SUPPORTED_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
} as const;

export type SupportedExtension = keyof typeof SUPPORTED_MIME_TYPES;

/**
 * Map a key's extension to a content type.
 *
 * Extension-based rather than sniffed by design: the file is untrusted content,
 * and the pipeline decides how to parse it from the declared type recorded at
 * discovery time. A parser that receives bytes it cannot read fails loudly and
 * the revision is marked FAILED - which is the behaviour we want and test for.
 */
export function contentTypeForKey(key: StorageKey): string {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'pdf':
      return SUPPORTED_MIME_TYPES.pdf;
    case 'docx':
      return SUPPORTED_MIME_TYPES.docx;
    case 'txt':
      return SUPPORTED_MIME_TYPES.txt;
    case 'md':
    case 'markdown':
      return SUPPORTED_MIME_TYPES.md;
    default:
      return 'application/octet-stream';
  }
}

export function isSupportedMimeType(mimeType: string): boolean {
  return (Object.values(SUPPORTED_MIME_TYPES) as string[]).includes(mimeType);
}
