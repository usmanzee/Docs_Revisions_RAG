/**
 * Stub chat model.
 *
 * Tests must never call a paid API, but the chat path - streaming, citation
 * resolution, message persistence, refusal classification - still needs to be
 * exercised end to end. This stub answers from the retrieved context using
 * simple rules, so an assertion failure points at the pipeline rather than at a
 * model's mood.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatModelProvider,
  ToolAwareRequest,
  ToolDecision,
} from '../../src/modules/chat/chat-model.js';
import type { ProposedToolCall } from '../../src/modules/chat/tools/executor.js';

export interface StubChatModelOptions {
  /** Force every answer to be this text. */
  fixedAnswer?: string;
  /** Throw on the next call, to exercise error handling. */
  failNext?: boolean;
  /**
   * Tool calls to emit, one batch per model step.
   *
   * Scripting the tool exchange keeps the assertions about the *pipeline* -
   * gating, identity injection, event ordering - rather than about whether a
   * real model happened to choose the right tool that day.
   */
  toolCallScript?: ProposedToolCall[][];
}

export class StubChatModel implements ChatModelProvider {
  readonly name = 'stub';
  readonly model = 'stub-chat-model';

  /** Every prompt this model was given, for assertions about grounding. */
  readonly prompts: ChatCompletionRequest[] = [];
  /** Every tool-aware request, so tests can inspect what the model was offered. */
  readonly toolRequests: ToolAwareRequest[] = [];

  private scriptStep = 0;

  constructor(private options: StubChatModelOptions = {}) {}

  setOptions(options: StubChatModelOptions): void {
    this.options = options;
    this.scriptStep = 0;
  }

  isAvailable(): boolean {
    return true;
  }

  private answerFor(request: ChatCompletionRequest): string {
    this.prompts.push(request);

    if (this.options.failNext) {
      this.options.failNext = false;
      throw new Error('stub chat model failure');
    }

    if (this.options.fixedAnswer) return this.options.fixedAnswer;

    // No context supplied means the prompt carried the no-context instruction:
    // refuse, exactly as the real system prompt requires.
    if (!request.user.includes('BEGIN DOCUMENT CONTEXT')) {
      return 'I could not find enough information in the available documents to answer that question.';
    }

    // Otherwise quote the first figure from the first source and cite it, which
    // is enough for the citation-resolution assertions to be meaningful.
    const firstSource = request.user.split('---')[0] ?? '';
    const figure = /\$[\d,]+|\d+\s*(?:calendar days|business days|days|hours|minutes|months|years|%)/.exec(
      firstSource,
    );

    return figure
      ? `According to the retrieved policy, the applicable value is ${figure[0]} [1].`
      : 'The retrieved documents cover this topic [1].';
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return {
      content: this.answerFor(request),
      model: this.model,
      promptTokens: 100,
      completionTokens: 20,
    };
  }

  async completeUtility(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.prompts.push(request);
    // Query rewriting: echo the follow-up with a marker so tests can see that
    // the rewrite path ran without depending on a model's phrasing.
    const question = request.user.split('Follow-up question:')[1]?.split('\n')[0]?.trim();
    return {
      content: question ? `${question} (rewritten)` : 'rewritten query',
      model: this.model,
      promptTokens: 10,
      completionTokens: 5,
    };
  }

  /**
   * One scripted tool-calling step.
   *
   * Emits the next batch from `toolCallScript`, if any; otherwise produces a
   * normal answer built from the retrieved context, exactly as `stream` does.
   */
  async *streamWithTools(
    request: ToolAwareRequest,
  ): AsyncIterable<{ type: 'token'; text: string } | { type: 'decision'; decision: ToolDecision }> {
    this.toolRequests.push(request);

    const scripted = this.options.toolCallScript?.[this.scriptStep];
    this.scriptStep += 1;

    if (scripted && scripted.length > 0) {
      yield { type: 'decision', decision: { content: '', toolCalls: scripted } };
      return;
    }

    // No tools wanted: answer from whatever the turn contains. Tool results are
    // summarised so tests can assert the model actually saw them.
    const toolOutput = request.turns
      .filter((turn) => turn.role === 'tool')
      .map((turn) => (turn as { content: string }).content)
      .join('\n');

    // The last user turn is the current question; earlier ones are replayed
    // conversation history and carry no document context.
    const userTurn = request.turns.findLast((turn) => turn.role === 'user') as
      | { content: string }
      | undefined;

    // Echo the whole tool output, flattened. A real model would summarise it;
    // reproducing it verbatim lets a test assert the model actually received
    // the data rather than that the stub happened to pick the right line.
    const answer =
      toolOutput.length > 0
        ? `Based on the leave system: ${toolOutput.replace(/\s*\n\s*/g, ' ')}`
        : this.answerFor({ system: request.system, user: userTurn?.content ?? '' });

    for (const word of answer.split(' ')) {
      yield { type: 'token', text: `${word} ` };
    }

    yield { type: 'decision', decision: { content: answer, toolCalls: [] } };
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<string> {
    const answer = this.answerFor(request);
    // Emit in several pieces so the SSE assembly is genuinely exercised.
    for (const word of answer.split(' ')) {
      yield `${word} `;
    }
  }
}
