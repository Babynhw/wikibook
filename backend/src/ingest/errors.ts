/**
 * The worker's only branch point (wiki-docs/plan/phase-2-ingestion/design.md
 * "Transient failures retry; permanent ones fail immediately").
 *
 * A permanent failure (corrupted PDF, password-protected file, no text layer,
 * page-limit exceeded, no article found) must not burn BullMQ attempts with
 * backoff — the source goes `failed` with a plain-language message and the user
 * gets a Retry action. Everything else is left to `attempts: 3`.
 */
export class UnretryableIngestError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.name = 'UnretryableIngestError';
    this.userMessage = userMessage;
  }
}

export function isUnretryable(error: unknown): error is UnretryableIngestError {
  return error instanceof UnretryableIngestError;
}

/**
 * Detection branches for `extract-pdf.ts`, kept here so the mapping from a pdf.js
 * error to a human message has one home (PRD §16: plain language, no stack traces).
 */
export function pdfDetection(error: unknown): UnretryableIngestError {
  if (error instanceof Error && error.name === 'PasswordException') {
    return new UnretryableIngestError('This PDF is password protected.', { cause: error });
  }
  return new UnretryableIngestError('This file could not be read as a PDF.', { cause: error });
}