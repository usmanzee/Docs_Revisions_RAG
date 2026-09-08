/**
 * The RAG pipeline.
 *
 *   history -> standalone query -> hybrid retrieval -> context -> LLM -> answer
 *
 * Two properties are enforced here rather than trusted to the model:
 *
 *   * Citations are built from retrieved chunk rows, never parsed out of the
 *     model's output. The model chooses which bracket to write; it cannot
 *     invent what that bracket points at.
 *   * When retrieval returns nothing usable, the model is told so explicitly
 *     and the answer is marked INSUFFICIENT_CONTEXT. Silently answering from
 *     parametric knowledge is the failure this whole system exists to prevent.
 */

import type { AnswerStatus, Citation, RetrievalFilters } from '@docs-rag/shared';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import type { ConversationRepository } from '../../repositories/conversation-repository.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { countTokens, truncateToTokens } from '../../utils/tokens.js';
import {
  buildRewritePrompt,
  buildUserPrompt,
  QUERY_REWRITE_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
} from '../../prompts/rag-prompts.js';
import { buildContext } from '../retrieval/context-builder.js';
import { cleanRewrittenQuery, needsRewrite } from '../retrieval/query-analysis.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { RetrievalResult } from '../retrieval/types.js';
import type { ChatModelProvider } from './chat-model.js';

export interface RagRequest {
  question: string;
  conversationId?: string | null;
  messageId?: string | null;
  filters?: RetrievalFilters;
  source?: 'CHAT' | 'DEBUG' | 'EVALUATION';
  /** Skip retrieval logging (used by benchmarks). */
  log?: boolean;
}

export interface RagPreparation {
  standaloneQuery: string;
  retrieval: RetrievalResult;
  context: string;
  citations: Citation[];
  contextTokens: number;
  hasContext: boolean;
  systemPrompt: string;
  userPrompt: string;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  answerStatus: AnswerStatus;
  standaloneQuery: string;
  model: string;
  contextTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  retrievalMs: number;
  llmMs: number;
  totalMs: number;
  retrievalLogId: string | null;
}

/**
 * Phrases that indicate the model declined for lack of grounding. Used to label
 * the answer, not to alter it - the classification feeds evaluation and the UI.
 */
const REFUSAL_MARKERS = [
  'could not find enough information',
  "couldn't find enough information",
  'not enough information',
  'do not contain enough information',
  "don't contain enough information",
  'no information about',
  'does not appear in the available documents',
  'not covered by the available documents',
  'unable to find',
];

export function classifyAnswer(answer: string, hasContext: boolean, citations: Citation[]): AnswerStatus {
  const normalized = answer.toLowerCase();
  if (REFUSAL_MARKERS.some((marker) => normalized.includes(marker))) return 'INSUFFICIENT_CONTEXT';
  if (!hasContext) return 'INSUFFICIENT_CONTEXT';
  if (citations.length === 0) return 'INSUFFICIENT_CONTEXT';
  return 'ANSWERED';
}

/**
 * Keep only the citations the answer actually referenced.
 *
 * The context may carry eight sources while the answer uses two. Returning all
 * eight trains users to ignore citations, because most of them do not support
 * anything that was said. If the model cited nothing, all sources are returned
 * so the answer remains inspectable.
 */
export function selectUsedCitations(answer: string, citations: readonly Citation[]): Citation[] {
  const referenced = new Set<number>();
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const index = Number.parseInt(match[1] as string, 10);
    if (Number.isFinite(index)) referenced.add(index);
  }

  if (referenced.size === 0) return [...citations];

  const used = citations.filter((citation) => referenced.has(citation.index));
  return used.length > 0 ? used : [...citations];
}

export interface RagServiceDependencies {
  retrieval: RetrievalService;
  chatModel: ChatModelProvider;
  conversations?: ConversationRepository;
  config?: AppConfig;
}

export class RagService {
  private readonly logger = childLogger({ component: 'rag' });
  private readonly config: AppConfig;

  constructor(private readonly deps: RagServiceDependencies) {
    this.config = deps.config ?? getConfig();
  }

  /**
   * Turn a possibly-referential question into a standalone retrieval query.
   *
   * Only called when the question looks like a follow-up, so an ordinary
   * question costs nothing. A rewrite failure falls back to the original
   * question rather than failing the turn.
   */
  async buildStandaloneQuery(question: string, conversationId: string | null | undefined): Promise<string> {
    if (!this.config.chat.queryRewriteEnabled || !conversationId || !this.deps.conversations) {
      return question;
    }

    const history = await this.deps.conversations.recentTurns(conversationId, this.config.chat.historyTurns);
    if (history.length === 0) return question;
    if (!needsRewrite(question, true)) return question;

    // Bound the history so a long conversation cannot inflate the rewrite cost.
    const budget = this.config.chat.historyTokenBudget;
    const bounded: { role: string; content: string }[] = [];
    let used = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const turn = history[index] as { role: string; content: string };
      const content = truncateToTokens(turn.content, 400);
      const cost = countTokens(content);
      if (used + cost > budget) break;
      bounded.unshift({ role: turn.role, content });
      used += cost;
    }

    if (bounded.length === 0) return question;

    try {
      const result = await this.deps.chatModel.completeUtility({
        system: QUERY_REWRITE_SYSTEM_PROMPT,
        user: buildRewritePrompt(bounded, question),
      });
      const rewritten = cleanRewrittenQuery(result.content, question);
      if (rewritten !== question) {
        this.logger.debug({ conversationId, question, rewritten }, 'rewrote follow-up question');
      }
      return rewritten;
    } catch (error) {
      this.logger.warn(
        { conversationId, err: { message: toErrorMessage(error) } },
        'query rewrite failed; using the original question',
      );
      return question;
    }
  }

  /**
   * Everything up to the model call. Separated so the streaming and
   * non-streaming paths share one implementation, and so the debug endpoint can
   * inspect exactly what would have been sent.
   */
  async prepare(request: RagRequest): Promise<RagPreparation> {
    const standaloneQuery = await this.buildStandaloneQuery(request.question, request.conversationId);

    const retrieval = await this.deps.retrieval.retrieve({
      query: request.question,
      standaloneQuery,
      filters: request.filters ?? {},
      conversationId: request.conversationId ?? null,
      messageId: request.messageId ?? null,
      source: request.source ?? 'CHAT',
      ...(request.log !== undefined ? { log: request.log } : {}),
    });

    const built = buildContext(retrieval.selected, {
      tokenBudget: this.config.retrieval.contextTokenBudget,
      maxChunks: this.config.retrieval.finalContextChunks,
    });

    return {
      standaloneQuery,
      retrieval,
      context: built.text,
      citations: built.citations,
      contextTokens: built.tokenCount,
      hasContext: built.included.length > 0,
      systemPrompt: RAG_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(request.question, built.text),
    };
  }

  /** Non-streaming answer. Used by evaluation and by clients that want JSON. */
  async answer(request: RagRequest): Promise<RagAnswer> {
    const started = performance.now();
    const prepared = await this.prepare(request);
    const retrievalMs = prepared.retrieval.timings.totalMs;

    const llmStarted = performance.now();
    const completion = await this.deps.chatModel.complete({
      system: prepared.systemPrompt,
      user: prepared.userPrompt,
    });
    const llmMs = Math.round(performance.now() - llmStarted);

    const citations = selectUsedCitations(completion.content, prepared.citations);

    return {
      answer: completion.content,
      citations,
      answerStatus: classifyAnswer(completion.content, prepared.hasContext, citations),
      standaloneQuery: prepared.standaloneQuery,
      model: completion.model,
      contextTokens: prepared.contextTokens,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      retrievalMs,
      llmMs,
      totalMs: Math.round(performance.now() - started),
      retrievalLogId: prepared.retrieval.retrievalLogId,
    };
  }

  /**
   * Streaming answer.
   *
   * Yields tokens as they arrive, then a final summary once the answer is
   * complete. Citations are resolved at the end because which sources were
   * actually used is only knowable once the full answer exists.
   */
  async *streamAnswer(request: RagRequest): AsyncGenerator<
    | { type: 'prepared'; preparation: RagPreparation }
    | { type: 'token'; text: string }
    | { type: 'final'; answer: RagAnswer },
    void,
    void
  > {
    const started = performance.now();
    const prepared = await this.prepare(request);
    yield { type: 'prepared', preparation: prepared };

    const llmStarted = performance.now();
    let content = '';

    for await (const token of this.deps.chatModel.stream({
      system: prepared.systemPrompt,
      user: prepared.userPrompt,
    })) {
      content += token;
      yield { type: 'token', text: token };
    }

    const llmMs = Math.round(performance.now() - llmStarted);
    const citations = selectUsedCitations(content, prepared.citations);

    yield {
      type: 'final',
      answer: {
        answer: content,
        citations,
        answerStatus: classifyAnswer(content, prepared.hasContext, citations),
        standaloneQuery: prepared.standaloneQuery,
        model: this.deps.chatModel.model,
        contextTokens: prepared.contextTokens,
        promptTokens: null,
        completionTokens: null,
        retrievalMs: prepared.retrieval.timings.totalMs,
        llmMs,
        totalMs: Math.round(performance.now() - started),
        retrievalLogId: prepared.retrieval.retrievalLogId,
      },
    };
  }

  /** Short conversation title. Failure is non-fatal - the title stays null. */
  async suggestTitle(question: string): Promise<string | null> {
    try {
      const result = await this.deps.chatModel.completeUtility({
        system: TITLE_SYSTEM_PROMPT,
        user: question,
      });
      const title = result.content.trim().replace(/^["']|["']$/g, '').slice(0, 90);
      return title.length > 0 ? title : null;
    } catch {
      return null;
    }
  }
}
