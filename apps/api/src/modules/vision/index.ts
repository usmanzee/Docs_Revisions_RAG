/**
 * Vision enrichment.
 *
 * Off by default. When enabled, images extracted during parsing are described
 * and the description is appended to the page as an `image` element, so it
 * becomes part of the chunked, embedded and citable content rather than living
 * in a side channel nothing reads.
 */

import { getConfig, type AppConfig } from '../../config/index.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { elementsToText, type ParsedDocument } from '../parsing/types.js';
import { OpenAIVisionProvider } from './openai-vision-provider.js';
import type { VisionProvider } from './types.js';

export * from './types.js';
export { OpenAIVisionProvider } from './openai-vision-provider.js';

export interface VisionEnrichmentResult {
  imagesDescribed: number;
  tokens: number;
  durationMs: number;
}

export class VisionDocumentEnricher {
  private readonly logger = childLogger({ component: 'vision' });

  constructor(
    private readonly provider: VisionProvider,
    private readonly config: AppConfig = getConfig(),
  ) {}

  /**
   * Describe a document's images in place.
   *
   * Failures are logged and swallowed: an enrichment that cannot run must not
   * fail a revision whose text extracted perfectly well.
   */
  async enrich(document: ParsedDocument): Promise<VisionEnrichmentResult> {
    const started = performance.now();
    const result: VisionEnrichmentResult = { imagesDescribed: 0, tokens: 0, durationMs: 0 };

    if (!this.config.vision.enabled || document.images.length === 0) {
      result.durationMs = Math.round(performance.now() - started);
      return result;
    }

    if (!(await this.provider.isAvailable())) {
      this.logger.warn('vision is enabled but the provider is unavailable; skipping enrichment');
      result.durationMs = Math.round(performance.now() - started);
      return result;
    }

    const budget = this.config.vision.maxImagesPerDocument;
    const candidates = document.images.filter((image) => image.data).slice(0, budget);

    for (const image of candidates) {
      try {
        const page = document.pages.find((entry) => entry.pageNumber === image.pageNumber);
        const described = await this.provider.describe({
          image: image.data as Buffer,
          mimeType: 'image/png',
          contextText: page ? elementsToText(page.elements) : undefined,
          label: `page-${image.pageNumber}`,
        });

        if (described.description.length === 0) continue;

        image.description = described.description;
        result.imagesDescribed += 1;
        result.tokens += described.tokens;

        // Fold the description into the page so it is chunked and retrievable.
        page?.elements.push({
          type: 'image',
          description: described.description,
          assetIndex: image.assetIndex,
        });
      } catch (error) {
        this.logger.warn(
          { pageNumber: image.pageNumber, err: { message: toErrorMessage(error) } },
          'vision enrichment failed for an image',
        );
      }
    }

    result.durationMs = Math.round(performance.now() - started);
    return result;
  }
}

/** Never used when VISION_ENABLED=false; keeps the pipeline free of null checks. */
export class NoopVisionProvider implements VisionProvider {
  readonly name = 'none';
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async describe(): Promise<never> {
    throw new Error('vision provider is disabled');
  }
}

export function createVisionEnricher(config: AppConfig = getConfig()): VisionDocumentEnricher {
  const provider: VisionProvider =
    config.vision.enabled && config.vision.provider === 'openai'
      ? new OpenAIVisionProvider(config)
      : new NoopVisionProvider();
  return new VisionDocumentEnricher(provider, config);
}
