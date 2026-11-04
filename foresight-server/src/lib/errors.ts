/**
 * Typed HTTP errors that serialize to the contract's `ApiError` shape
 * ({ error, message }). Throw these from routes/services; the Fastify error
 * handler in app.ts turns them into the right status + body.
 */
import type { ApiError } from "@foresight/contract";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Optional machine-readable context surfaced in ApiError.details. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): ApiError {
    const body: ApiError = { error: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export const badRequest = (msg: string, code = "bad_request") => new HttpError(400, code, msg);
export const unauthorized = (msg = "Authentication required") => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "Not allowed", details?: unknown) =>
  new HttpError(403, "forbidden", msg, details);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string, details?: unknown) =>
  new HttpError(409, "conflict", msg, details);
