import type { z } from 'zod';
import type { RefusalCode } from '../refusals';

/** Who sees a tool. Admin tools are listed only for admins. */
export const audiences = ['donor', 'maintainer', 'admin'] as const;
export type Audience = (typeof audiences)[number];

/**
 * One MCP tool: what it takes, what it returns, and how its result reads as
 * plain text. Terminal harnesses show only the text, so it has to stand on
 * its own. Input and output are zod objects, which the MCP SDK registers as
 * the tool's JSON Schema.
 */
export interface ToolSpec<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  audience: Audience;
  /** Agent-facing: what the tool does and when to call it. */
  description: string;
  input: I;
  output: O;
  /**
   * Every refusal the tool can answer with. A skill that names the tool says
   * what to do with each one, and a test holds both the skills and the
   * server to this list.
   */
  refusals?: readonly RefusalCode[];
  /** The result as plain text. */
  text(output: z.output<O>): string;
}

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  spec: ToolSpec<I, O>,
): ToolSpec<I, O> {
  return spec;
}
