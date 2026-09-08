/**
 * Chat model abstraction.
 *
 * Wraps LangChain's ChatOpenAI, which gives streaming, message typing and a
 * consistent interface if the provider changes. The abstraction is thin on
 * purpose: retrieval, grounding and citation logic live in the RAG service, not
 * in a framework chain, so the interesting behaviour stays testable without a
 * model.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { ConfigurationError, LlmError, toErrorMessage } from '../../utils/errors.js';

export interface ChatCompletionRequest {
  system: string;
  user: string;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ChatModelProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  /**
   * Short, deterministic auxiliary calls - query rewriting and titling.
   * Separated from `complete` because they want temperature 0 and a tight
   * output cap, and because a failure here should never fail an answer.
   */
  completeUtility(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  stream(request: ChatCompletionRequest): AsyncIterable<string>;
}

export class OpenAIChatModelProvider implements ChatModelProvider {
  readonly name = 'openai';
  readonly model: string;

  private readonly client: ChatOpenAI | null;
  private readonly utilityClient: ChatOpenAI | null;

  constructor(config: AppConfig = getConfig()) {
    this.model = config.openai.chatModel;

    const base = {
      apiKey: config.openai.apiKey ?? '',
      model: config.openai.chatModel,
      timeout: config.openai.requestTimeoutMs,
      maxRetries: config.openai.retryLimit,
      ...(config.openai.baseUrl ? { configuration: { baseURL: config.openai.baseUrl } } : {}),
    };

    this.client = config.openai.apiKey
      ? new ChatOpenAI({
          ...base,
          temperature: config.chat.temperature,
          maxTokens: config.chat.maxOutputTokens,
        })
      : null;

    // Utility calls are rewrites and titles: deterministic and short. A
    // separate instance keeps those parameters explicit rather than smuggling
    // per-call overrides through the answer path.
    this.utilityClient = config.openai.apiKey
      ? new ChatOpenAI({ ...base, temperature: 0, maxTokens: 160 })
      : null;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private require(client: ChatOpenAI | null = this.client): ChatOpenAI {
    if (!client) {
      throw new ConfigurationError(
        'OPENAI_API_KEY is not set. Chat requires a chat model; set the key to enable it. ' +
          '(Ingestion and retrieval can still run with EMBEDDING_PROVIDER=mock.)',
      );
    }
    return client;
  }

  private async invoke(client: ChatOpenAI, request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    try {
      const response = await client.invoke([
        new SystemMessage(request.system),
        new HumanMessage(request.user),
      ]);

      const usage = response.usage_metadata;

      return {
        content: typeof response.content === 'string' ? response.content : String(response.content),
        model: this.model,
        promptTokens: usage?.input_tokens ?? null,
        completionTokens: usage?.output_tokens ?? null,
      };
    } catch (error) {
      throw new LlmError(`chat completion failed: ${toErrorMessage(error)}`, { cause: error });
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.invoke(this.require(), request);
  }

  async completeUtility(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.invoke(this.require(this.utilityClient), request);
  }

  async *stream(request: ChatCompletionRequest): AsyncIterable<string> {
    const client = this.require();

    try {
      const stream = await client.stream([new SystemMessage(request.system), new HumanMessage(request.user)]);
      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        if (text.length > 0) yield text;
      }
    } catch (error) {
      throw new LlmError(`chat streaming failed: ${toErrorMessage(error)}`, { cause: error });
    }
  }
}

let cached: ChatModelProvider | null = null;

export function createChatModelProvider(config: AppConfig = getConfig()): ChatModelProvider {
  return new OpenAIChatModelProvider(config);
}

export function getChatModelProvider(): ChatModelProvider {
  cached ??= createChatModelProvider();
  return cached;
}

export function setChatModelProvider(provider: ChatModelProvider | null): void {
  cached = provider;
}
