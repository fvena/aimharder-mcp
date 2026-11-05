import { z } from 'zod';
import { gymIdSchema, weekdays } from '../config.js';
import type { Context } from './context.js';

/**
 * One MCP tool: what a client sees (name, description, schemas, hints) and what it runs. `run` must return what the output
 * schema describes, so the compiler keeps the published contract and the feature's result together.
 */
export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: typeof readOnly;
  run(ctx: Context, input: z.output<I>): Promise<z.input<O>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodObject>(tool: ToolDefinition<I, O>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/** Tool hints: plain reads, previews that issue a single-use reference, and writes. */
export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const preview = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const destructiveWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** The selected gym, as every result reports it. */
export const gymSchema = z.object({
  id: gymIdSchema, name: z.string(), timeZone: z.string(), timeZoneStatus: z.enum(['assumed', 'user-confirmed']),
});
/** A weekly booking plan entry. */
export const planEntryOutput = z.object({ day: z.enum(weekdays), className: z.string(), startTime: z.string() });
/** The query that accepts only an optional gym. */
export const gymQuerySchema = z.object({ gymId: gymIdSchema.optional() }).strict();
