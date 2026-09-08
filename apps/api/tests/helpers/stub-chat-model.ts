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
} from '../../src/modules/chat/chat-model.js';

export interface StubChatModelOptions {
  /** Force every answer to be this text. */
  fixedAnswer?: string;
  /** Throw on the next call, to exercise error handling. */
  failNext?: boolean;
}

export class StubChatModel implements ChatModelProvider {
  readonly name = 'stub';
  readonly model = 'stub-chat-model';

  /** Every prompt this model was given, for assertions about grounding. */
  readonly prompts: ChatCompletionRequest[] = [];

  constructor(private options: StubChatModelOptions = {}) {}

  setOptions(options: StubChatModelOptions): void {
    this.options = options;
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

  async *stream(request: ChatCompletionRequest): AsyncIterable<string> {
    const answer = this.answerFor(request);
    // Emit in several pieces so the SSE assembly is genuinely exercised.
    for (const word of answer.split(' ')) {
      yield `${word} `;
    }
  }
}
