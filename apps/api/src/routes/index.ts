/**
 * Route registration.
 *
 * Handlers stay thin: validate, delegate to a controller, return. Business
 * logic lives in the module services, which is what lets the ingestion and
 * retrieval behaviour be tested without an HTTP server.
 */

import type { AppInstance } from '../types/fastify.js';
import type { AppContainer } from '../container.js';
import { registerChatRoutes } from './chat.js';
import { registerDocumentRoutes } from './documents.js';
import { registerAdminRoutes } from './admin.js';
import { registerDebugRoutes } from './debug.js';
import { registerHealthRoutes } from './health.js';

export async function registerRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  await registerHealthRoutes(app, container);

  await app.register(
    async (api) => {
      await registerChatRoutes(api, container);
      await registerDocumentRoutes(api, container);
      await registerAdminRoutes(api, container);
      await registerDebugRoutes(api, container);
    },
    { prefix: '/api' },
  );
}
