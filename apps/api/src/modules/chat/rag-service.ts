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

import { randomUUID } from 'node:crypto';
import type { AnswerStatus, Citation, RetrievalFilters } from '@docs-rag/shared';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import type { ConversationRepository } from '../../repositories/conversation-repository.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { countTokens, truncateToTokens } from '../../utils/tokens.js';
import {
  buildRewritePrompt,
  buildTemporalContext,
  buildUserPrompt,
  LEAVE_TOOLS_INSTRUCTIONS,
  QUERY_REWRITE_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
} from '../../prompts/rag-prompts.js';
import { ToolExecutor } from './tools/executor.js';
import type { AnyAssistantTool, ToolContext, ToolInvocation } from './tools/types.js';
import type { ConversationTurn } from './chat-model.js';
import { buildContext } from '../retrieval/context-builder.js';
import { cleanRewrittenQuery, needsRewrite } from '../retrieval/query-analysis.js';
import type { RetrievalService } from '../retrieval/retrieval-service.js';
import type { RetrievalResult } from '../retrieval/types.js';
import type { ChatModelProvider } from './chat-model.js';

export interface RagRequest {
  question: string;
  /** Whose records the tools may touch. Never model-supplied. */
  employeeId?: string;
  /** Stable per turn, so a retried write is idempotent. */
  turnId?: string;
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
  /** Tools the model called this turn, with their outcomes. */
  toolInvocations: ToolInvocation[];
  citations: Citation[];
  answerStatus: AnswerStatus;
  standaloneQuery: string;
  model: string;
  contextTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  retrievalMs: number;
  llmMs: number;
  toolMs: number;
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

export function classifyAnswer(
  answer: string,
  hasContext: boolean,
  citations: Citation[],
  /**
   * True when the answer was grounded in a live system rather than documents.
   * "You have 14 days left" is fully grounded and legitimately has no citation,
   * so the no-citation rule must not label it as unanswered.
   */
  groundedInTools = false,
): AnswerStatus {
  const normalized = answer.toLowerCase();
  if (REFUSAL_MARKERS.some((marker) => normalized.includes(marker))) return 'INSUFFICIENT_CONTEXT';
  if (groundedInTools) return 'ANSWERED';
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
  /** Empty when no HCM is configured; the assistant then omits leave tools. */
  tools?: AnyAssistantTool[];
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
      systemPrompt: this.buildSystemPrompt(),
      userPrompt: buildUserPrompt(request.question, built.text),
    };
  }

  /**
   * Recent conversation, as messages the model can actually see.
   *
   * Retrieval has always used history to build a standalone query, but the model
   * itself only ever received the current question. That was adequate while every
   * turn was a self-contained document lookup; it is not adequate once the
   * assistant can act. "Yes, go ahead and book it" is meaningless without the
   * turn that proposed something to book.
   *
   * Only prior text is replayed - not the document context those turns were
   * given, which would multiply the prompt for no benefit.
   */
  private async recentConversationTurns(conversationId: string | null | undefined): Promise<ConversationTurn[]> {
    if (!conversationId || !this.deps.conversations) return [];

    const history = await this.deps.conversations.recentTurns(conversationId, this.config.chat.historyTurns);
    if (history.length === 0) return [];

    // Bounded from the most recent backwards, so a long conversation cannot
    // inflate the prompt without limit.
    const bounded: ConversationTurn[] = [];
    let used = 0;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const turn = history[index] as { role: string; content: string };
      if (turn.content.trim().length === 0) continue;

      const content = truncateToTokens(turn.content, 600);
      const cost = countTokens(content);
      if (used + cost > this.config.chat.historyTokenBudget) break;

      bounded.unshift(
        turn.role === 'user'
          ? { role: 'user', content }
          : { role: 'assistant', content },
      );
      used += cost;
    }

    return bounded;
  }

  /** Tools available to the assistant, or none when no HCM is configured. */
  private get availableTools(): AnyAssistantTool[] {
    return this.config.hcm.toolsEnabled ? (this.deps.tools ?? []) : [];
  }

  /**
   * System prompt for the turn.
   *
   * The grounding rules are constant. The leave instructions are appended only
   * when the tools actually exist - describing capabilities the assistant does
   * not have is how it ends up promising to book leave and then failing.
   *
   * Today's date is included so relative dates ("next Monday") can be resolved
   * rather than guessed.
   */
  private buildSystemPrompt(): string {
    const parts = [RAG_SYSTEM_PROMPT, buildTemporalContext()];
    if (this.availableTools.length > 0) parts.push(LEAVE_TOOLS_INSTRUCTIONS);
    return parts.join('\n\n');
  }

  /**
   * Run the model, letting it call tools, and stream the final answer.
   *
   * Each iteration streams one model step. If the step produced only text, the
   * turn is done and that text was already delivered token by token. If it asked
   * for tools, they run and the loop goes round again with the results appended.
   *
   * When a step produces text *and* tool calls - which providers occasionally do
   * - the partial text is discarded and `onReset` fires, because that text was
   * written before the model knew what the tools would say.
   */
  private async *runToolLoop(
    systemPrompt: string,
    initialTurns: ConversationTurn[],
    toolContext: ToolContext,
  ): AsyncGenerator<
    | { type: 'token'; text: string }
    | { type: 'reset' }
    | { type: 'tool'; invocation: ToolInvocation }
    | { type: 'done'; content: string; invocations: ToolInvocation[]; toolMs: number },
    void,
    void
  > {
    const tools = this.availableTools;
    const executor = new ToolExecutor(tools);
    const turns = [...initialTurns];
    const invocations: ToolInvocation[] = [];

    let toolMs = 0;
    let finalContent = '';

    for (let iteration = 0; iteration < this.config.hcm.maxToolIterations; iteration += 1) {
      let emittedText = false;
      let decision: { content: string; toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] } | null =
        null;

      // Tools stay available across iterations, because a legitimate action is
      // two steps: validate, then apply. Withdrawing them after the first round
      // would make the intended flow impossible and would strand the model after
      // a refused call, unable to correct itself.
      //
      // On the final permitted iteration they are withdrawn, which forces an
      // answer rather than another request the loop has no room to serve.
      const isFinalIteration = iteration === this.config.hcm.maxToolIterations - 1;

      for await (const event of this.deps.chatModel.streamWithTools({
        system: systemPrompt,
        turns,
        tools: isFinalIteration ? [] : tools,
      })) {
        if (event.type === 'token') {
          emittedText = true;
          yield { type: 'token', text: event.text };
        } else {
          decision = event.decision;
        }
      }

      if (!decision) break;

      if (decision.toolCalls.length === 0) {
        finalContent = decision.content;
        break;
      }

      // Text alongside tool calls: what was shown was written before the model
      // had the answers, so retract it.
      if (emittedText) yield { type: 'reset' };

      turns.push({ role: 'assistant', content: decision.content, toolCalls: decision.toolCalls });

      const toolStarted = performance.now();
      for (const call of decision.toolCalls) {
        const invocation = await executor.execute(call, toolContext);
        invocations.push(invocation);
        yield { type: 'tool', invocation };

        turns.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: invocation.result.content,
        });
      }
      toolMs += Math.round(performance.now() - toolStarted);
    }

    yield { type: 'done', content: finalContent, invocations, toolMs };
  }

  /**
   * Non-streaming answer. Used by evaluation and by clients that want JSON.
   *
   * Runs the same loop as the streaming path and discards the token events, so
   * the two cannot drift apart in behaviour.
   */
  async answer(request: RagRequest): Promise<RagAnswer> {
    const started = performance.now();
    const prepared = await this.prepare(request);

    const llmStarted = performance.now();
    let content = '';
    let invocations: ToolInvocation[] = [];
    let toolMs = 0;

    const history = await this.recentConversationTurns(request.conversationId);

    for await (const event of this.runToolLoop(
      prepared.systemPrompt,
      [...history, { role: 'user', content: prepared.userPrompt }],
      this.toolContextFor(request),
    )) {
      if (event.type === 'token') content += event.text;
      else if (event.type === 'reset') content = '';
      else if (event.type === 'done') {
        // A step that only produced text has already been accumulated above;
        // `content` from the loop is authoritative when it is non-empty.
        if (event.content.length > 0) content = event.content;
        invocations = event.invocations;
        toolMs = event.toolMs;
      }
    }

    const llmMs = Math.round(performance.now() - llmStarted) - toolMs;
    const citations = selectUsedCitations(content, prepared.citations);

    return {
      answer: content,
      toolInvocations: invocations,
      citations,
      answerStatus: classifyAnswer(content, prepared.hasContext, citations, invocations.length > 0),
      standaloneQuery: prepared.standaloneQuery,
      model: this.deps.chatModel.model,
      contextTokens: prepared.contextTokens,
      promptTokens: null,
      completionTokens: null,
      retrievalMs: prepared.retrieval.timings.totalMs,
      llmMs: Math.max(0, llmMs),
      toolMs,
      totalMs: Math.round(performance.now() - started),
      retrievalLogId: prepared.retrieval.retrievalLogId,
    };
  }

  /** Identity and turn scope for tools. Never derived from model output. */
  private toolContextFor(request: RagRequest): ToolContext {
    return {
      employeeId: request.employeeId ?? this.config.hcm.defaultEmployeeId,
      conversationId: request.conversationId ?? null,
      turnId: request.turnId ?? randomUUID(),
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
    | { type: 'reset' }
    | { type: 'tool'; invocation: ToolInvocation }
    | { type: 'final'; answer: RagAnswer },
    void,
    void
  > {
    const started = performance.now();
    const prepared = await this.prepare(request);
    yield { type: 'prepared', preparation: prepared };

    const llmStarted = performance.now();
    let content = '';
    let invocations: ToolInvocation[] = [];
    let toolMs = 0;

    const history = await this.recentConversationTurns(request.conversationId);

    for await (const event of this.runToolLoop(
      prepared.systemPrompt,
      [...history, { role: 'user', content: prepared.userPrompt }],
      this.toolContextFor(request),
    )) {
      switch (event.type) {
        case 'token':
          content += event.text;
          yield { type: 'token', text: event.text };
          break;

        case 'reset':
          // The model wrote before it had tool results. Retract what was shown.
          content = '';
          yield { type: 'reset' };
          break;

        case 'tool':
          yield { type: 'tool', invocation: event.invocation };
          break;

        case 'done':
          if (event.content.length > 0) content = event.content;
          invocations = event.invocations;
          toolMs = event.toolMs;
          break;
      }
    }

    const llmMs = Math.max(0, Math.round(performance.now() - llmStarted) - toolMs);
    const citations = selectUsedCitations(content, prepared.citations);

    yield {
      type: 'final',
      answer: {
        answer: content,
        toolInvocations: invocations,
        citations,
        answerStatus: classifyAnswer(content, prepared.hasContext, citations, invocations.length > 0),
        standaloneQuery: prepared.standaloneQuery,
        model: this.deps.chatModel.model,
        contextTokens: prepared.contextTokens,
        promptTokens: null,
        completionTokens: null,
        retrievalMs: prepared.retrieval.timings.totalMs,
        llmMs,
        toolMs,
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
