/**
 * Storage factory.
 *
 * The driver is chosen from configuration. Adding S3 means adding a case here
 * and a class next to LocalDocumentStorage - nothing upstream changes.
 */

import { getConfig, type AppConfig } from '../../config/index.js';
import { ConfigurationError } from '../../utils/errors.js';
import type { DocumentStorage } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';

export * from './document-storage.js';
export { LocalDocumentStorage } from './local-document-storage.js';

let cached: DocumentStorage | null = null;

export function createDocumentStorage(config: AppConfig = getConfig()): DocumentStorage {
  switch (config.storage.driver) {
    case 'local':
      return new LocalDocumentStorage(config.storage.root);
    default:
      throw new ConfigurationError(`unsupported DOCUMENT_STORAGE_DRIVER: ${String(config.storage.driver)}`);
  }
}

export function getDocumentStorage(): DocumentStorage {
  cached ??= createDocumentStorage();
  return cached;
}

export function setDocumentStorage(storage: DocumentStorage | null): void {
  cached = storage;
}
