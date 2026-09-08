/**
 * Tesseract OCR provider (tesseract.js).
 *
 * Workers are expensive to create - each one loads a language model - so a
 * small pool is created lazily and reused across pages and documents, bounded
 * by OCR_CONCURRENCY. Language data is cached under .tesseract-cache so only
 * the first run needs network access.
 */

import path from 'node:path';
import { createWorker, type Worker } from 'tesseract.js';
import { getConfig } from '../../config/index.js';
import { AppError, toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import type { OCRInput, OCRProvider, OCRResult } from './types.js';

export class TesseractOCRProvider implements OCRProvider {
  readonly name = 'tesseract';

  private readonly logger = childLogger({ component: 'ocr', provider: 'tesseract' });
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  /**
   * Every worker ever created, idle or checked out. Tracking only the idle ones
   * is not enough: a worker still executing when dispose() runs would keep its
   * thread alive and hold the process open, which in turn holds the ingestion
   * advisory lock and blocks every later run.
   */
  private readonly all = new Set<Worker>();
  private created = 0;
  private available: boolean | null = null;
  private disposed = false;

  constructor(
    private readonly language: string = getConfig().ocr.language,
    private readonly poolSize: number = getConfig().ocr.concurrency,
    private readonly cachePath: string = path.join(getConfig().repoRoot, '.tesseract-cache'),
  ) {}

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const worker = await this.acquire();
      this.release(worker);
      this.available = true;
    } catch (error) {
      // Almost always "could not download traineddata" on an offline machine.
      this.logger.warn({ err: { message: toErrorMessage(error) } }, 'tesseract is unavailable');
      this.available = false;
    }
    return this.available;
  }

  private async createWorkerInstance(): Promise<Worker> {
    return createWorker(this.language, undefined, {
      cachePath: this.cachePath,
      // tesseract.js is chatty on stdout; route it into structured logs at trace.
      logger: () => undefined,
      errorHandler: (error: unknown) => {
        this.logger.debug({ err: { message: toErrorMessage(error) } }, 'tesseract worker error');
      },
    });
  }

  /** Take an idle worker, create one if under the cap, otherwise queue. */
  private async acquire(): Promise<Worker> {
    if (this.disposed) throw new AppError('OCR_ERROR', 'OCR provider has been disposed');

    const idle = this.idle.pop();
    if (idle) return idle;

    if (this.created < this.poolSize) {
      this.created += 1;
      try {
        const worker = await this.createWorkerInstance();
        this.all.add(worker);
        return worker;
      } catch (error) {
        this.created -= 1;
        throw error;
      }
    }

    return new Promise<Worker>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  async extractText(input: OCRInput): Promise<OCRResult> {
    const started = performance.now();
    const worker = await this.acquire();

    try {
      const { data } = await worker.recognize(input.image);
      const durationMs = Math.round(performance.now() - started);

      this.logger.debug(
        { label: input.label, chars: data.text.length, confidence: data.confidence, durationMs },
        'ocr page complete',
      );

      return {
        text: data.text ?? '',
        confidence: typeof data.confidence === 'number' ? data.confidence : null,
        provider: this.name,
        durationMs,
      };
    } catch (error) {
      throw new AppError('OCR_ERROR', `OCR failed for ${input.label ?? 'image'}: ${toErrorMessage(error)}`, {
        cause: error,
      });
    } finally {
      this.release(worker);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const workers = [...this.all];
    this.all.clear();
    this.idle.length = 0;
    this.waiting.length = 0;
    this.created = 0;
    this.available = null;
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}
