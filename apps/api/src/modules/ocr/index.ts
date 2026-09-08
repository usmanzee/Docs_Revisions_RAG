/**
 * OCR factory.
 *
 * A single shared provider instance is used process-wide so the worker pool is
 * not rebuilt per document.
 */

import { getConfig, type AppConfig } from '../../config/index.js';
import type { OCRInput, OCRProvider, OCRResult } from './types.js';
import { TesseractOCRProvider } from './tesseract-provider.js';

export * from './types.js';
export { TesseractOCRProvider } from './tesseract-provider.js';

/** Used when OCR is disabled; keeps call sites free of null checks. */
export class NoopOCRProvider implements OCRProvider {
  readonly name = 'none';
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async extractText(_input: OCRInput): Promise<OCRResult> {
    return { text: '', confidence: null, provider: this.name, durationMs: 0 };
  }
  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

let cached: OCRProvider | null = null;

export function createOCRProvider(config: AppConfig = getConfig()): OCRProvider {
  if (!config.ocr.enabled || config.ocr.provider === 'none') return new NoopOCRProvider();
  return new TesseractOCRProvider(config.ocr.language, config.ocr.concurrency);
}

export function getOCRProvider(): OCRProvider {
  cached ??= createOCRProvider();
  return cached;
}

export function setOCRProvider(provider: OCRProvider | null): void {
  cached = provider;
}

export async function disposeOCRProvider(): Promise<void> {
  if (cached) {
    await cached.dispose();
    cached = null;
  }
}
