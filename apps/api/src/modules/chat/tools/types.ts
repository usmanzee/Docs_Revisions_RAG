/**
 * Tool contracts for the assistant.
 *
 * Two rules shape every tool here, and both exist because the arguments come
 * from a language model that may have been influenced by document content:
 *
 *   1. No tool takes an employee identifier. Identity comes from the session
 *      and is injected by the executor. A model cannot be talked into reading
 *      somebody else's leave balance, because it has no way to name them.
 *
 *   2. Write tools declare themselves as writes, and the executor gates them.
 *      Reads are free; actions are not.
 */

import type { z } from 'zod';

export interface ToolContext {
  /** Whose data this turn may touch. Never model-supplied. */
  employeeId: string;
  conversationId: string | null;
  /** Stable per turn, so a retried write is idempotent. */
  turnId: string;
}

export interface ToolResult {
  /** Serialised back to the model. Keep it compact - it costs context. */
  content: string;
  /** Structured payload for the UI, not sent to the model. */
  data?: unknown;
  /** True when the tool ran but the answer was "no". Not a failure. */
  refused?: boolean;
  error?: string;
}

export interface AssistantTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  /** Writes change state in an external system and are gated by the executor. */
  mutates: boolean;
  /**
   * Names a tool that must have succeeded earlier in this turn before this one
   * may run. Used to force a dry-run validation before a booking.
   */
  requiresPriorTool?: string;
  execute(args: z.infer<TSchema>, context: ToolContext): Promise<ToolResult>;
}

/**
 * A tool with its schema type erased, for storing them in a homogeneous list.
 * Method-style `execute` gives bivariant parameter checking, which is what makes
 * a specifically-typed tool assignable here.
 */
export type AnyAssistantTool = AssistantTool<z.ZodTypeAny>;

/**
 * Identity helper that preserves schema inference.
 *
 * Annotating `const tool: AssistantTool = {...}` collapses the generic to
 * `ZodTypeAny` and `args` becomes `unknown` inside `execute`. Passing the object
 * through this function lets TypeScript infer the schema first.
 */
export function defineTool<TSchema extends z.ZodTypeAny>(
  tool: AssistantTool<TSchema>,
): AssistantTool<TSchema> {
  return tool;
}

/** One tool invocation and its outcome, for the trace and the UI. */
export interface ToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
}
