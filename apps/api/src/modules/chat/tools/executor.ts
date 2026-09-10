/**
 * Tool execution.
 *
 * The model proposes; this decides. Everything that protects the user from a
 * confidently wrong or manipulated model lives here rather than in the prompt,
 * because a prompt is a request and this is a rule:
 *
 *   - arguments are validated against the tool's schema before anything runs
 *   - identity is injected, never accepted from the model
 *   - a write whose prerequisite has not succeeded this turn is refused
 *   - a repeated identical write in one turn is refused
 *   - a tool that throws returns an explainable message, never a crash
 */

import { z } from 'zod';
import { childLogger } from '../../../utils/logger.js';
import { toErrorMessage } from '../../../utils/errors.js';
import type { AnyAssistantTool, ToolContext, ToolInvocation, ToolResult } from './types.js';

export interface ProposedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class ToolExecutor {
  private readonly logger = childLogger({ component: 'tool-executor' });
  private readonly byName: Map<string, AnyAssistantTool>;

  /** Tools that completed successfully this turn, for prerequisite checks. */
  private readonly succeeded = new Set<string>();
  /** Signatures of writes already performed this turn, to stop repeats. */
  private readonly performedWrites = new Set<string>();

  constructor(tools: AnyAssistantTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get tools(): AnyAssistantTool[] {
    return [...this.byName.values()];
  }

  /** Reset per-turn state. The executor is created per turn, so this is belt and braces. */
  reset(): void {
    this.succeeded.clear();
    this.performedWrites.clear();
  }

  async execute(call: ProposedToolCall, context: ToolContext): Promise<ToolInvocation> {
    const started = performance.now();
    const finish = (result: ToolResult): ToolInvocation => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result,
      durationMs: Math.round(performance.now() - started),
    });

    const tool = this.byName.get(call.name);
    if (!tool) {
      // A hallucinated tool name. Tell the model plainly rather than failing the
      // turn - it can recover by using one that exists.
      return finish({
        content: `There is no tool called "${call.name}". Available tools: ${[...this.byName.keys()].join(', ')}.`,
        error: 'unknown tool',
      });
    }

    // --- argument validation ------------------------------------------------
    const parsed = tool.schema.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = (parsed.error as z.ZodError).issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');

      return finish({
        content: `Those arguments are not valid for ${tool.name}: ${issues}. Correct them and try again.`,
        error: 'invalid arguments',
      });
    }

    // --- prerequisite -------------------------------------------------------
    if (tool.requiresPriorTool && !this.succeeded.has(tool.requiresPriorTool)) {
      this.logger.warn(
        { tool: tool.name, requires: tool.requiresPriorTool },
        'refused a write whose prerequisite has not run',
      );

      return finish({
        content:
          `${tool.name} was not run: ${tool.requiresPriorTool} must succeed first. ` +
          `Call ${tool.requiresPriorTool} now with the same details, and if it passes and the user has ` +
          `already asked you to proceed, call ${tool.name} again in this same turn.`,
        error: 'prerequisite not satisfied',
      });
    }

    // --- duplicate write ----------------------------------------------------
    if (tool.mutates) {
      const signature = `${tool.name}:${JSON.stringify(parsed.data)}`;
      if (this.performedWrites.has(signature)) {
        return finish({
          content: `${tool.name} has already been carried out in this turn with exactly these details. It was not repeated.`,
          error: 'duplicate write',
        });
      }
      this.performedWrites.add(signature);
    }

    // --- run ----------------------------------------------------------------
    try {
      const result = await tool.execute(parsed.data, context);

      // A refusal is a valid outcome, but it must not satisfy a prerequisite:
      // a failed validation cannot unlock a booking.
      if (!result.error && !result.refused) this.succeeded.add(tool.name);

      this.logger.info(
        {
          tool: tool.name,
          mutates: tool.mutates,
          refused: result.refused ?? false,
          failed: Boolean(result.error),
          conversationId: context.conversationId,
        },
        'tool executed',
      );

      return finish(result);
    } catch (error) {
      // A tool must never take down a turn.
      const message = toErrorMessage(error);
      this.logger.error({ tool: tool.name, err: { message } }, 'tool threw');
      return finish({ content: `${tool.name} failed: ${message}`, error: message });
    }
  }
}
