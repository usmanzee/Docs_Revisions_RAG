/**
 * OCR provider abstraction.
 *
 * Tesseract is the shipped implementation, but the interface is what ingestion
 * depends on so a hosted service (Azure Document Intelligence, Google Document
 * AI, an OpenAI vision model) can be swapped in without touching the pipeline.
 */

export interface OCRInput {
  /** Raster image bytes - PNG is what the PDF renderer produces. */
  image: Buffer;
  /** Language hint, e.g. "eng". */
  language: string;
  /** Diagnostic context: "<storageKey>#page-3". */
  label?: string;
}

export interface OCRResult {
  text: string;
  /** 0-100 where the provider reports it; null when it does not. */
  confidence: number | null;
  provider: string;
  durationMs: number;
}

export interface OCRProvider {
  readonly name: string;
  /** False when the provider cannot run (missing model data, no credentials). */
  isAvailable(): Promise<boolean>;
  extractText(input: OCRInput): Promise<OCRResult>;
  /** Release workers/connections. Called during graceful shutdown. */
  dispose(): Promise<void>;
}
