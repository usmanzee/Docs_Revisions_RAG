/**
 * Persistence for conversations and messages.
 *
 * Citations are stored with the assistant message as a JSONB snapshot built
 * from the retrieved chunk rows. Storing the snapshot rather than only chunk ids
 * means an old answer still renders correctly after its source revision is
 * superseded - and the stored citation is provably the one that was shown.
 */

import type {
  AnswerStatus,
  ChatMessage,
  Citation,
  ConversationSummary,
  ToolActivity,
} from '@docs-rag/shared';
import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { toIso, type ConversationRow, type MessageRow } from './types.js';

export interface MessageInsertInput {
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
  standaloneQuery?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  contextTokens?: number | null;
  retrievalMs?: number | null;
  llmMs?: number | null;
  totalMs?: number | null;
  answerStatus?: AnswerStatus | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export class ConversationRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async create(input: { title?: string | null; userId?: string | null; filters?: unknown } = {}): Promise<
    ConversationRow
  > {
    const row = await queryOne<ConversationRow>(
      `INSERT INTO conversations (title, user_id, filters) VALUES ($1, $2, $3) RETURNING *`,
      [input.title ?? null, input.userId ?? null, JSON.stringify(input.filters ?? {})],
      this.db,
    );
    return row as ConversationRow;
  }

  async findById(id: string): Promise<ConversationRow | null> {
    return queryOne<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id], this.db);
  }

  async list(limit = 50): Promise<ConversationSummary[]> {
    const rows = await queryRows<ConversationRow>(
      'SELECT * FROM conversations ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT $1',
      [limit],
      this.db,
    );
    return rows.map(mapConversationSummary);
  }

  /**
   * Name a conversation from its first user message, so the sidebar is
   * navigable without asking the model for a title.
   */
  async setTitleIfEmpty(id: string, candidate: string): Promise<void> {
    const title = candidate.trim().replace(/\s+/g, ' ').slice(0, 90);
    await this.db.query('UPDATE conversations SET title = $2 WHERE id = $1 AND title IS NULL', [id, title]);
  }

  async updateSummary(id: string, summary: string): Promise<void> {
    await this.db.query('UPDATE conversations SET summary = $2 WHERE id = $1', [id, summary]);
  }

  async addMessage(input: MessageInsertInput): Promise<MessageRow> {
    const row = await queryOne<MessageRow>(
      `INSERT INTO messages (
         conversation_id, role, content, citations, standalone_query, model,
         prompt_tokens, completion_tokens, context_tokens,
         retrieval_ms, llm_ms, total_ms, answer_status, error, metadata
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       RETURNING *`,
      [
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations ?? []),
        input.standaloneQuery ?? null,
        input.model ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.contextTokens ?? null,
        input.retrievalMs ?? null,
        input.llmMs ?? null,
        input.totalMs ?? null,
        input.answerStatus ?? null,
        input.error ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
      this.db,
    );

    await this.db.query(
      `UPDATE conversations
          SET message_count   = message_count + 1,
              last_message_at = now()
        WHERE id = $1`,
      [input.conversationId],
    );

    return row as MessageRow;
  }

  /**
   * Update a message that was inserted before streaming began.
   * The assistant row is created up front so the client receives its id in the
   * `metadata` event and can render into a stable slot.
   */
  async finalizeAssistantMessage(
    messageId: string,
    update: {
      content: string;
      citations: Citation[];
      answerStatus: AnswerStatus;
      model: string | null;
      /** Stored in metadata: a record of what the assistant actually did. */
      toolActivity?: ToolActivity[];
      promptTokens?: number | null;
      completionTokens?: number | null;
      contextTokens?: number | null;
      retrievalMs?: number | null;
      llmMs?: number | null;
      totalMs?: number | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE messages
          SET content           = $2,
              citations         = $3::jsonb,
              answer_status     = $4,
              model             = $5,
              prompt_tokens     = $6,
              completion_tokens = $7,
              context_tokens    = $8,
              retrieval_ms      = $9,
              llm_ms            = $10,
              total_ms          = $11,
              error             = $12,
              metadata          = metadata || $13::jsonb
        WHERE id = $1`,
      [
        messageId,
        update.content,
        JSON.stringify(update.citations),
        update.answerStatus,
        update.model,
        update.promptTokens ?? null,
        update.completionTokens ?? null,
        update.contextTokens ?? null,
        update.retrievalMs ?? null,
        update.llmMs ?? null,
        update.totalMs ?? null,
        update.error ?? null,
        JSON.stringify({ toolActivity: update.toolActivity ?? [] }),
      ],
    );
  }

  async listMessages(conversationId: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await queryRows<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2',
      [conversationId, limit],
      this.db,
    );
    return rows.map(mapChatMessage);
  }

  /**
   * Most recent turns, oldest-first, for query rewriting.
   * Bounded on purpose: conversation context feeds a rewrite prompt, and an
   * unbounded history would grow cost without improving the standalone query.
   */
  async recentTurns(conversationId: string, turns: number): Promise<{ role: string; content: string }[]> {
    if (turns <= 0) return [];
    const rows = await queryRows<{ role: string; content: string }>(
      `SELECT role, content
         FROM (
           SELECT role, content, created_at
             FROM messages
            WHERE conversation_id = $1
              AND role IN ('user', 'assistant')
            ORDER BY created_at DESC
            LIMIT $2
         ) recent
        ORDER BY created_at ASC`,
      [conversationId, turns * 2],
      this.db,
    );
    return rows;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM conversations WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async countAll(): Promise<{ conversations: number; messages: number }> {
    const row = await queryOne<{ conversations: number; messages: number }>(
      `SELECT (SELECT count(*)::int FROM conversations) AS conversations,
              (SELECT count(*)::int FROM messages)      AS messages`,
      [],
      this.db,
    );
    return row ?? { conversations: 0, messages: 0 };
  }
}

export function mapConversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    messageCount: row.message_count,
    lastMessageAt: toIso(row.last_message_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

export function mapChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: Array.isArray(row.citations) ? (row.citations as Citation[]) : [],
    toolActivity: Array.isArray((row.metadata as { toolActivity?: unknown }).toolActivity)
      ? ((row.metadata as { toolActivity: ToolActivity[] }).toolActivity)
      : [],
    standaloneQuery: row.standalone_query,
    model: row.model,
    answerStatus: (row.answer_status as AnswerStatus | null) ?? null,
    retrievalMs: row.retrieval_ms,
    llmMs: row.llm_ms,
    totalMs: row.total_ms,
    createdAt: toIso(row.created_at) as string,
  };
}
