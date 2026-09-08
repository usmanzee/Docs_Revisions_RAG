/**
 * Local filesystem implementation of DocumentStorage.
 *
 * Simulates the corporate network drive the original system read from. The
 * interesting part is `resolveKey`, which is the only function in the codebase
 * that turns a stored key into a real path - and the only place path traversal
 * has to be defended against.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from '../../utils/errors.js';
import {
  contentTypeForKey,
  type DocumentStorage,
  type StorageKey,
  type StorageListEntry,
  type StoredObjectMetadata,
} from './document-storage.js';

/** Rejected outright, before any path resolution happens. */
const FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [
  /\0/, //            NUL byte - classic path-truncation trick
  /^[a-zA-Z]:[\\/]/, // Windows absolute path
  /^\\\\/, //         UNC path
];

export class LocalDocumentStorage implements DocumentStorage {
  readonly driver = 'local';
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a storage key to an absolute path inside the root, or throw.
   *
   * Defence in depth, because this is the boundary that matters:
   *   1. reject absolute keys and obviously hostile shapes up front;
   *   2. normalise, which collapses `..` segments;
   *   3. verify the resolved path is still inside the root, comparing with a
   *      trailing separator so `/storage/documents-evil` cannot pass as a child
   *      of `/storage/documents`.
   *
   * Step 3 alone would be sufficient, but the earlier checks give a clearer
   * error and keep the intent obvious to the next reader.
   */
  private resolveKey(key: StorageKey): string {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new StorageError('storage key must be a non-empty string');
    }

    for (const pattern of FORBIDDEN_KEY_PATTERNS) {
      if (pattern.test(key)) {
        throw new StorageError(`illegal storage key: ${JSON.stringify(key.slice(0, 80))}`);
      }
    }

    if (path.isAbsolute(key)) {
      throw new StorageError('storage keys must be relative to the storage root');
    }

    const normalized = path.normalize(key);
    const resolved = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;

    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new StorageError(`storage key escapes the storage root: ${JSON.stringify(key.slice(0, 80))}`);
    }

    return resolved;
  }

  /** Exposed for the file-download route, which needs a real path to stream. */
  resolveKeyForRead(key: StorageKey): string {
    return this.resolveKey(key);
  }

  async read(key: StorageKey): Promise<Buffer> {
    const target = this.resolveKey(key);
    try {
      return await readFile(target);
    } catch (error) {
      throw new StorageError(`cannot read "${key}"`, { cause: error });
    }
  }

  async write(
    key: StorageKey,
    data: Buffer | string,
    options: { contentType?: string } = {},
  ): Promise<StoredObjectMetadata> {
    const target = this.resolveKey(key);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      const stats = await stat(target);
      return {
        key,
        size: stats.size,
        modifiedAt: stats.mtime,
        contentType: options.contentType ?? contentTypeForKey(key),
      };
    } catch (error) {
      throw new StorageError(`cannot write "${key}"`, { cause: error });
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: StorageKey): Promise<StoredObjectMetadata> {
    const target = this.resolveKey(key);
    try {
      const stats = await stat(target);
      return {
        key,
        size: stats.size,
        modifiedAt: stats.mtime,
        contentType: contentTypeForKey(key),
      };
    } catch (error) {
      throw new StorageError(`cannot stat "${key}"`, { cause: error });
    }
  }

  async list(prefix: StorageKey = ''): Promise<StorageListEntry[]> {
    const base = prefix ? this.resolveKey(prefix) : this.root;
    const entries: StorageListEntry[] = [];

    const walk = async (directory: string): Promise<void> => {
      let contents;
      try {
        contents = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        // A missing root simply means "no documents generated yet".
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new StorageError(`cannot list "${directory}"`, { cause: error });
      }

      for (const entry of contents) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue; // .gitkeep, .DS_Store

        const stats = await stat(absolute);
        entries.push({
          key: path.relative(this.root, absolute).split(path.sep).join('/'),
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      }
    };

    await walk(base);
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  async delete(key: StorageKey): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await rm(target, { force: true });
    } catch (error) {
      throw new StorageError(`cannot delete "${key}"`, { cause: error });
    }
  }

  async createReadStream(key: StorageKey): Promise<NodeJS.ReadableStream> {
    const target = this.resolveKey(key);
    // Confirm existence first so a missing file surfaces as a clean 404 rather
    // than an error event mid-response.
    await this.stat(key);
    return createReadStream(target);
  }

  /** Build the canonical key layout: <documentCode>/rev-00N/<fileName>. */
  static buildKey(documentCode: string, revisionNumber: number, fileName: string): StorageKey {
    const safeCode = documentCode.replace(/[^A-Za-z0-9._-]/g, '_');
    const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return `${safeCode}/rev-${String(revisionNumber).padStart(3, '0')}/${safeName}`;
  }
}
