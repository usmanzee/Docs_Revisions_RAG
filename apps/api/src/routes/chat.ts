/** Chat and conversation endpoints. */

import type { AppInstance } from '../types/fastify.js';
import type { AppContainer } from '../container.js';
import { SseStream } from '../utils/sse.js';
import { chatRequestSchema, createConversationSchema, idParamSchema, parse } from './schemas.js';
import { z } from 'zod';

const conversationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerChatRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  /**
   * POST /api/chat - streamed answer over Server-Sent Events.
   *
   * The reply is taken over manually (`reply.hijack()`) so Fastify does not try
   * to serialise a body after the stream has already started writing.
   */
  app.post('/chat', async (request, reply) => {
    const body = parse(chatRequestSchema, request.body);

    reply.hijack();
    const stream = new SseStream(reply);

    await container.chat.streamTurn(stream, {
      conversationId: body.conversationId ?? null,
      message: body.message,
      ...(body.filters ? { filters: body.filters } : {}),
      requestId: request.id,
    });
  });

  /** Non-streaming variant, for scripts and integrations. */
  app.post('/chat/complete', async (request) => {
    const body = parse(chatRequestSchema, request.body);
    return container.chat.completeTurn({
      conversationId: body.conversationId ?? null,
      message: body.message,
      ...(body.filters ? { filters: body.filters } : {}),
      requestId: request.id,
    });
  });

  app.post('/conversations', async (request, reply) => {
    const body = parse(createConversationSchema, request.body ?? {});
    const conversation = await container.chat.createConversation({
      title: body.title ?? null,
      filters: body.filters ?? {},
    });
    return reply.status(201).send(conversation);
  });

  app.get('/conversations', async (request) => {
    const query = parse(conversationListQuery, request.query);
    return container.chat.listConversations(query.limit);
  });

  app.get('/conversations/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.chat.getConversation(id);
  });

  app.get('/conversations/:id/messages', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.chat.listMessages(id);
  });

  app.delete('/conversations/:id', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params);
    await container.chat.deleteConversation(id);
    return reply.status(204).send();
  });
}
