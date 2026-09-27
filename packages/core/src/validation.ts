import type { z } from 'zod';

/** One reason an input was rejected, with the field it belongs to. */
export interface FieldProblem {
  /** The field, as a path like `claimsPerIssue`, `disclosure.trailer`, or `tags[1]`. */
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; problems: FieldProblem[] };

/**
 * Checks `input` against `schema`. Every problem names its field, so a person
 * or an agent can tell what to fix. `root` names the input as a whole, for a
 * problem with no field, like a list where an object belongs.
 */
export function validate<S extends z.ZodType>(
  schema: S,
  input: unknown,
  root = 'input',
): Validated<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, problems: result.error.issues.flatMap((issue) => toProblems(issue, root)) };
}

/**
 * Checks `input` against `schema` and returns the parsed value, or throws a
 * TypeError that names every problem. For values that must already be valid,
 * like a row read from the database, where a problem is a bug.
 */
export function mustParse<S extends z.ZodType>(schema: S, input: unknown, root = 'input'): z.output<S> {
  const result = validate(schema, input, root);
  if (!result.ok) throw new TypeError(`Malformed ${root}.\n${describeProblems(result.problems)}`);
  return result.value;
}

/** One line per problem, like `claimsPerIssue: must be a whole number from 1 to 10`. */
export function describeProblems(problems: readonly FieldProblem[]): string {
  return problems.map((p) => `${p.field}: ${p.message}`).join('\n');
}

function toProblems(issue: z.core.$ZodIssue, root: string): FieldProblem[] {
  const path = formatPath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      field: path ? `${path}.${key}` : key,
      message: 'is not a known field',
    }));
  }
  return [{ field: path || root, message: issue.message }];
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${String(part)}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}
