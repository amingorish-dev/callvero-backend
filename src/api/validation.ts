import { ZodSchema } from "zod";
import { ApiError } from "../core/errors";

export function parseOrThrow<T>(schema: ZodSchema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, "validation failed", { issues: parsed.error.issues });
  }
  return parsed.data;
}
