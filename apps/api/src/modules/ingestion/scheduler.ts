/**
 * Scheduled ingestion.
 *
 * Driven by INGESTION_CRON. An empty value disables scheduling entirely, which
 * is the right default for development: waiting for a cron tick to see whether
 * a change worked is a miserable loop, so `npm run ingestion:run` and the admin
 * endpoint exist and the scheduler is opt-in.
 *
 * Overlap is prevented at two levels: Croner's `protect` stops a tick firing
 * while the previous one is still running in this process, and the advisory
 * lock inside the service stops two processes running concurrently.
 */

import { Cron } from 'croner';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import type { DocumentIngestionService } from './ingestion-service.js';

export class IngestionScheduler {
  private readonly logger = childLogger({ component: 'ingestion-scheduler' });
  private job: Cron | null = null;

  constructor(
    private readonly service: DocumentIngestionService,
    private readonly config: AppConfig = getConfig(),
  ) {}

  get isRunning(): boolean {
    return this.job !== null;
  }

  get nextRun(): Date | null {
    return this.job?.nextRun() ?? null;
  }

  start(): void {
    const expression = this.config.ingestion.cron;

    if (!expression) {
      this.logger.info('INGESTION_CRON is not set; scheduled ingestion is disabled');
      return;
    }

    try {
      this.job = new Cron(expression, { protect: true, name: 'ingestion' }, async () => {
        try {
          const result = await this.service.run({ trigger: 'SCHEDULED' });
          if (result.discovered > 0) {
            this.logger.info(
              { jobId: result.jobId, processed: result.processed, failed: result.failed },
              'scheduled ingestion complete',
            );
          }
        } catch (error) {
          // A scheduled run that throws must not take the process down.
          this.logger.error({ err: { message: toErrorMessage(error) } }, 'scheduled ingestion failed');
        }
      });

      this.logger.info(
        { cron: expression, nextRun: this.job.nextRun()?.toISOString() },
        'scheduled ingestion enabled',
      );
    } catch (error) {
      this.logger.error(
        { cron: expression, err: { message: toErrorMessage(error) } },
        'invalid INGESTION_CRON expression; scheduled ingestion is disabled',
      );
      this.job = null;
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
      this.logger.info('scheduled ingestion stopped');
    }
  }
}

export function createIngestionScheduler(
  service: DocumentIngestionService,
  config: AppConfig = getConfig(),
): IngestionScheduler {
  return new IngestionScheduler(service, config);
}
