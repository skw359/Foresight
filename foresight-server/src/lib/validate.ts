/**
 * Validate a request body against a zod schema, turning validation failures
 * into a 400 HttpError with the contract's ApiError shape.
 */
import { z } from "zod";
import { badRequest } from "./errors.js";

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    throw badRequest(path ? `${path}: ${first.message}` : (first?.message ?? "Invalid request body"), "validation_error");
  }
  return result.data;
}
