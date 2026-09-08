/**
 * OpenAI vision provider.
 *
 * The prompt asks for a literal transcription of structure rather than an
 * interpretation, because the output is fed back into the retrieval index. A
 * description that invents a step would put a fabricated process step into the
 * corpus, where it would be indistinguishable from the document's own text.
 */

import OpenAI from 'openai';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { retry } from '../../utils/async.js';
import { AppError, toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import type { VisionInput, VisionProvider, VisionResult } from './types.js';

const SYSTEM_PROMPT = `You transcribe diagrams and figures found in enterprise policy and procedure documents.

Rules:
- Describe only what is visibly present. Never infer a step, condition or role that is not drawn or labelled.
- For a flowchart, transcribe the sequence using arrows, e.g. "Purchase Request -> Manager Approval -> Finance Review".
- For a table rendered as an image, transcribe it row by row.
- Preserve exact labels, numbers, thresholds and role names as written.
- If the image is decorative, a logo, or unreadable, reply with exactly: NO_MEANINGFUL_CONTENT
- Reply with the transcription only. No preamble, no commentary.`;

export class OpenAIVisionProvider implements VisionProvider {
  readonly name = 'openai';

  private readonly client: OpenAI | null;
  private readonly logger = childLogger({ component: 'vision', provider: 'openai' });

  constructor(private readonly config: AppConfig = getConfig()) {
    this.client = config.openai.apiKey
      ? new OpenAI({
          apiKey: config.openai.apiKey,
          ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
          timeout: config.openai.requestTimeoutMs,
          maxRetries: 0,
        })
      : null;
  }

  async isAvailable(): Promise<boolean> {
    return this.client !== null;
  }

  async describe(input: VisionInput): Promise<VisionResult> {
    if (!this.client) {
      throw new AppError('CONFIGURATION_ERROR', 'VISION_ENABLED=true requires OPENAI_API_KEY');
    }

    const started = performance.now();
    const dataUrl = `data:${input.mimeType};base64,${input.image.toString('base64')}`;

    const response = await retry(
      async () =>
        (this.client as OpenAI).chat.completions.create({
          model: this.config.vision.model,
          temperature: 0,
          max_tokens: 600,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: input.contextText
                    ? `Transcribe this figure. Surrounding page text for terminology only:\n\n${input.contextText.slice(0, 1200)}`
                    : 'Transcribe this figure.',
                },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
            },
          ],
        }),
      {
        retries: this.config.openai.retryLimit,
        baseDelayMs: 900,
        onRetry: (error, attempt, delayMs) => {
          this.logger.warn(
            { attempt, delayMs, err: { message: toErrorMessage(error) } },
            'retrying vision request',
          );
        },
      },
    );

    const description = response.choices[0]?.message?.content?.trim() ?? '';

    return {
      description: description === 'NO_MEANINGFUL_CONTENT' ? '' : description,
      model: this.config.vision.model,
      durationMs: Math.round(performance.now() - started),
      tokens: response.usage?.total_tokens ?? 0,
    };
  }
}
