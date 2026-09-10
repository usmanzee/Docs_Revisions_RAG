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
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import type { AnyAssistantTool } from './tools/types.js';
import type { ProposedToolCall } from './tools/executor.js';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { ConfigurationError, LlmError, toErrorMessage } from '../../utils/errors.js';

export interface ChatCompletionRequest {
  system: string;
  user: string;
}

/**
 * A turn's message history, including any tool exchange so far.
 *
 * Kept as a discriminated list rather than raw LangChain messages so the RAG
 * service never has to import the framework's message classes - the same
 * separation that keeps retrieval logic independent of LangChain.
 */
export type ConversationTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ProposedToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolAwareRequest {
  system: string;
  turns: ConversationTurn[];
  tools: AnyAssistantTool[];
}

export interface ToolDecision {
  /** Text the model produced. Empty when it only asked for tools. */
  content: string;
  toolCalls: ProposedToolCall[];
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

  /**
   * One step of a tool-calling exchange: the model either answers or asks for
   * tools. Streamed, so an answer that needs no tools arrives progressively.
   */
  streamWithTools(
    request: ToolAwareRequest,
  ): AsyncIterable<{ type: 'token'; text: string } | { type: 'decision'; decision: ToolDecision }>;
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


  /**
   * Stream one tool-calling step.
   *
   * Text and tool calls are accumulated separately as chunks arrive. Text is
   * yielded immediately - so an answer that needs no tools streams normally -
   * while tool-call fragments are assembled and reported once at the end. The
   * caller decides what to do when both appear, which OpenAI occasionally does.
   */
  async *streamWithTools(
    request: ToolAwareRequest,
  ): AsyncIterable<{ type: 'token'; text: string } | { type: 'decision'; decision: ToolDecision }> {
    const client = this.require();

    const bound =
      request.tools.length > 0
        ? client.bindTools(
            request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                // Zod 4 emits JSON Schema natively. `io: 'input'` describes what
                // the model must send rather than what parsing returns, and
                // inlining refs keeps the provider's validator happy.
                parameters: z.toJSONSchema(tool.schema, {
                  io: 'input',
                  target: 'draft-7',
                }) as Record<string, unknown>,
              },
            })),
          )
        : client;

    const messages = toLangChainMessages(request.system, request.turns);

    let content = '';
    // Keyed by the index OpenAI assigns, because arguments arrive as fragments
    // spread across many chunks and only the index ties them together.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    try {
      const stream = await bound.stream(messages);

      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        if (text.length > 0) {
          content += text;
          yield { type: 'token', text };
        }

        for (const fragment of chunk.tool_call_chunks ?? []) {
          const index = fragment.index ?? 0;
          const existing = partial.get(index) ?? { id: '', name: '', args: '' };

          partial.set(index, {
            id: fragment.id ?? existing.id,
            name: fragment.name ?? existing.name,
            args: existing.args + (fragment.args ?? ''),
          });
        }
      }
    } catch (error) {
      throw new LlmError(`tool-calling stream failed: ${toErrorMessage(error)}`, { cause: error });
    }

    const toolCalls: ProposedToolCall[] = [];
    for (const [index, entry] of partial) {
      if (entry.name.length === 0) continue;
      toolCalls.push({
        id: entry.id || `call_${index}`,
        name: entry.name,
        // Malformed argument JSON is handed on as an empty object; the executor
        // will reject it against the schema with a message the model can act on,
        // which is more useful than throwing here.
        arguments: parseArguments(entry.args),
      });
    }

    yield { type: 'decision', decision: { content, toolCalls } };
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

/** Translate the transport-neutral turn list into LangChain messages. */
function toLangChainMessages(system: string, turns: ConversationTurn[]): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(system)];

  for (const turn of turns) {
    switch (turn.role) {
      case 'user':
        messages.push(new HumanMessage(turn.content));
        break;

      case 'assistant':
        messages.push(
          new AIMessage({
            content: turn.content,
            // The provider requires the assistant's tool calls to be echoed back
            // alongside their results, or the exchange does not type-check on
            // their side.
            tool_calls: (turn.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.name,
              args: call.arguments,
            })),
          }),
        );
        break;

      case 'tool':
        messages.push(
          new ToolMessage({ tool_call_id: turn.toolCallId, name: turn.name, content: turn.content }),
        );
        break;
    }
  }

  return messages;
}

function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
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
