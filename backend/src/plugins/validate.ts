import { z } from 'zod';
import { HttpError } from './errors.js';

/** Parse untrusted input with a Zod schema; failures become a 400 with per-field messages. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'Validation failed', z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}
