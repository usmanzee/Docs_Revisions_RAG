/**
 * Chat orchestration at the HTTP boundary.
 *
 * The assistant message row is created *before* streaming starts so its id can
 * be sent in the opening `metadata` event: the client then renders into a
 * stable slot, and the row is updated in place when the answer completes. A
 * dropped connection therefore leaves a persisted, partially-filled message
 * rather than nothing at all.
 */

import type {
  ChatMessage,
  ChatStreamEvent,
  ConversationSummary,
  RetrievalFilters,
} from '@docs-rag/shared';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import { mapChatMessage, mapConversationSummary } from '../repositories/conversation-repository.js';
import type { RagService } from '../modules/chat/rag-service.js';
import { NotFoundError, toErrorMessage } from '../utils/errors.js';
import { childLogger } from '../utils/logger.js';
import { toErrorEvent } from '../middleware/error-handler.js';
import type { SseStream } from '../utils/sse.js';

export interface ChatControllerDependencies {
  conversations: ConversationRepository;
  rag: RagService;
}

export interface ChatStreamRequest {
  conversationId?: string | null;
  message: string;
  filters?: RetrievalFilters;
  requestId: string;
}

export class ChatController {
  private readonly logger = childLogger({ component: 'chat' });

  constructor(private readonly deps: ChatControllerDependencies) {}

  async createConversation(input: { title?: string | null; filters?: unknown }): Promise<ConversationSummary> {
    const row = await this.deps.conversations.create({
      title: input.title ?? null,
      filters: input.filters ?? {},
    });
    return mapConversationSummary(row);
  }

  async listConversations(limit: number): Promise<ConversationSummary[]> {
    return this.deps.conversations.list(limit);
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    const row = await this.deps.conversations.findById(id);
    if (!row) throw new NotFoundError('Conversation', id);
    return mapConversationSummary(row);
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const conversation = await this.deps.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundError('Conversation', conversationId);
    return this.deps.conversations.listMessages(conversationId);
  }

  async deleteConversation(id: string): Promise<void> {
    const deleted = await this.deps.conversations.delete(id);
    if (!deleted) throw new NotFoundError('Conversation', id);
  }

  /**
   * Run one chat turn, emitting SSE events as the answer is produced.
   *
   * Errors after streaming has begun are reported as an `error` event rather
   * than an HTTP status - the status line was already sent - and the assistant
   * message is persisted with the failure recorded.
   */
  async streamTurn(stream: SseStream, request: ChatStreamRequest): Promise<void> {
    const logger = this.logger.child({ requestId: request.requestId });

    let conversationId = request.conversationId ?? null;
    let assistantMessageId: string | null = null;

    try {
      if (conversationId) {
        const existing = await this.deps.conversations.findById(conversationId);
        if (!existing) throw new NotFoundError('Conversation', conversationId);
      } else {
        const created = await this.deps.conversations.create({ filters: request.filters ?? {} });
        conversationId = created.id;
      }

      await this.deps.conversations.addMessage({
        conversationId,
        role: 'user',
        content: request.message,
      });
      await this.deps.conversations.setTitleIfEmpty(conversationId, request.message);

      const assistant = await this.deps.conversations.addMessage({
        conversationId,
        role: 'assistant',
        content: '',
      });
      assistantMessageId = assistant.id;

      let content = '';

      for await (const event of this.deps.rag.streamAnswer({
        question: request.message,
        conversationId,
        messageId: assistant.id,
        ...(request.filters ? { filters: request.filters } : {}),
        source: 'CHAT',
      })) {
        if (stream.isClosed) {
          logger.info({ conversationId }, 'client disconnected mid-answer');
          break;
        }

        switch (event.type) {
          case 'prepared': {
            const metadata: ChatStreamEvent = {
              type: 'metadata',
              conversationId,
              messageId: assistant.id,
              standaloneQuery: event.preparation.standaloneQuery,
              retrievedChunks: event.preparation.retrieval.selected.length,
            };
            stream.send('metadata', metadata);
            break;
          }

          case 'token': {
            content += event.text;
            const token: ChatStreamEvent = { type: 'token', text: event.text };
            stream.send('token', token);
            break;
          }

          case 'final': {
            // Citations are emitted individually so the client can render the
            // source panel incrementally, then repeated in `complete` so a
            // client that missed one still ends with the full set.
            for (const citation of event.answer.citations) {
              const citationEvent: ChatStreamEvent = { type: 'citation', citation };
              stream.send('citation', citationEvent);
            }

            await this.deps.conversations.finalizeAssistantMessage(assistant.id, {
              content: event.answer.answer,
              citations: event.answer.citations,
              answerStatus: event.answer.answerStatus,
              model: event.answer.model,
              contextTokens: event.answer.contextTokens,
              retrievalMs: event.answer.retrievalMs,
              llmMs: event.answer.llmMs,
              totalMs: event.answer.totalMs,
            });

            const complete: ChatStreamEvent = {
              type: 'complete',
              messageId: assistant.id,
              answerStatus: event.answer.answerStatus,
              citations: event.answer.citations,
              timings: {
                retrievalMs: event.answer.retrievalMs,
                llmMs: event.answer.llmMs,
                totalMs: event.answer.totalMs,
              },
            };
            stream.send('complete', complete);

            logger.info(
              {
                conversationId,
                messageId: assistant.id,
                answerStatus: event.answer.answerStatus,
                citations: event.answer.citations.length,
                retrievalMs: event.answer.retrievalMs,
                llmMs: event.answer.llmMs,
              },
              'chat turn complete',
            );
            break;
          }
        }
      }

      // Client vanished before the answer finished: persist what was produced.
      if (stream.isClosed && content.length > 0 && assistantMessageId) {
        await this.deps.conversations
          .finalizeAssistantMessage(assistantMessageId, {
            content,
            citations: [],
            answerStatus: 'ERROR',
            model: null,
            error: 'client disconnected before the answer completed',
          })
          .catch(() => undefined);
      }
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error({ conversationId, err: { message } }, 'chat turn failed');

      if (assistantMessageId) {
        await this.deps.conversations
          .finalizeAssistantMessage(assistantMessageId, {
            content: '',
            citations: [],
            answerStatus: 'ERROR',
            model: null,
            error: message,
          })
          .catch(() => undefined);
      }

      const errorEvent: ChatStreamEvent = { type: 'error', ...toErrorEvent(error) };
      stream.send('error', errorEvent);
    } finally {
      stream.end();
    }
  }

  /** Non-streaming turn, for clients that would rather have one JSON response. */
  async completeTurn(request: ChatStreamRequest): Promise<{ conversationId: string; message: ChatMessage }> {
    let conversationId = request.conversationId ?? null;

    if (conversationId) {
      const existing = await this.deps.conversations.findById(conversationId);
      if (!existing) throw new NotFoundError('Conversation', conversationId);
    } else {
      const created = await this.deps.conversations.create({ filters: request.filters ?? {} });
      conversationId = created.id;
    }

    await this.deps.conversations.addMessage({
      conversationId,
      role: 'user',
      content: request.message,
    });
    await this.deps.conversations.setTitleIfEmpty(conversationId, request.message);

    const answer = await this.deps.rag.answer({
      question: request.message,
      conversationId,
      ...(request.filters ? { filters: request.filters } : {}),
      source: 'CHAT',
    });

    const row = await this.deps.conversations.addMessage({
      conversationId,
      role: 'assistant',
      content: answer.answer,
      citations: answer.citations,
      standaloneQuery: answer.standaloneQuery,
      model: answer.model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      contextTokens: answer.contextTokens,
      retrievalMs: answer.retrievalMs,
      llmMs: answer.llmMs,
      totalMs: answer.totalMs,
      answerStatus: answer.answerStatus,
    });

    return { conversationId, message: mapChatMessage(row) };
  }
}
