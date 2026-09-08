/**
 * Errors that are safe to show a user. Anything else is logged server-side and
 * reported as a generic message — no stack traces, no provider details (PRD §16).
 */
export interface AppErrorFields {
  [field: string]: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields: AppErrorFields | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    fields?: AppErrorFields,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    // Only a truthy map is set so the error handler can distinguish "no fields"
    // from "empty fields" when choosing whether to include the key.
    this.fields = fields && Object.keys(fields).length > 0 ? fields : undefined;
  }
}

/**
 * A 400 that names the offending field. Keeps a runtime-limit failure shaped
 * like a validation failure so the form can anchor the message (PRD §16).
 */
export const badRequest = (message: string, code = 'bad_request', fields?: AppErrorFields) =>
  new AppError(400, code, message, fields);

export const unauthorized = (message = 'You need to sign in to continue.') =>
  new AppError(401, 'unauthorized', message);

/** Used for foreign resources too — 404 rather than 403, so existence isn't leaked (PRD §17). */
export const notFound = (message = 'We could not find that.') =>
  new AppError(404, 'not_found', message);

/**
 * A member who is in the space but below the role a route needs. Never used
 * for a non-member — that is a 404, so existence isn't leaked (PRD §17).
 */
export const forbidden = (message: string, code = 'forbidden') =>
  new AppError(403, code, message);

export const conflict = (message: string, code = 'conflict') =>
  new AppError(409, code, message);

/** A request body over a byte limit (PRD §5 `pdf_max_bytes`). */
export const payloadTooLarge = (message = 'That file is too large to upload.') =>
  new AppError(413, 'payload_too_large', message);

export const tooManyRequests = (message = 'Too many attempts. Please try again shortly.') =>
  new AppError(429, 'too_many_requests', message);

/**
 * A dependency the request needs is not usable — no answer provider configured,
 * or the provider could not be reached (PRD §16 "assistant request failure").
 * The message says what the user can do; the cause is logged, never sent.
 */
export const serviceUnavailable = (message: string, code = 'service_unavailable') =>
  new AppError(503, code, message);
