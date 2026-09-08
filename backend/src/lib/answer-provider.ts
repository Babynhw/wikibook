/**
 * The port the assistant depends on, shaped by what an answer needs rather than
 * by what any one SDK returns
 * (wiki-docs/plan/phase-4-assistant/design.md "The provider is a port, not an
 * SDK wrapper").
 *
 * The adapter's only obligation is to say **which document it cited**. Resolving
 * that to a `Passage`, dropping an index outside the set we sent, and copying the
 * locator from the row all happen in `answers.ts`, outside every adapter — so the
 * invariant that makes a citation trustworthy is written once instead of once per
 * provider.
 */

/**
 * How a provider returns citations. Native citations are the one part of this
 * that is not portable, and naming the tier is what stops a provider swap from
 * quietly downgrading a structural guarantee into a convention:
 *
 * - `native`     — a separate citation channel indexing the documents we sent,
 *                  with the quote extracted by the API (Anthropic).
 * - `structured` — a strict JSON schema of our own design whose passage-id field
 *                  is an enum of the ids we sent, so an unknown id cannot be
 *                  generated; the quote is model-written and must be verified.
 * - `marker`     — sentinel labels the model types into the prose, parsed back
 *                  out. No quote, and nothing to check the label against.
 */
export type CitationMode = 'native' | 'structured' | 'marker';

export interface ProviderCapabilities {
  citations: CitationMode;
  /** `extracted` can be trusted; `generated` must be substring-verified. */
  quote: 'extracted' | 'generated' | 'none';
  thinking: 'adaptive' | 'none';
  effortLevels: readonly string[];
}

/** One retrieved passage, as the provider should present it to the model. */
export interface AnswerDocument {
  /** Source title — what §9 requires every citation to name. */
  title: string;
  /** The locator label, shown to the model so it can see what it is citing. */
  context: string;
  text: string;
}

export interface AnswerTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AnswerRequest {
  question: string;
  /** Ordered. A citation's `documentIndex` is a position in this array. */
  documents: AnswerDocument[];
  /** Prior turns as *conversation*, never as evidence (PRD §9). */
  history: AnswerTurn[];
  /**
   * The space's "Audience & style" note, when its owner has set one.
   *
   * An adapter MUST render it into the **user turn** — beside the documents,
   * through `audienceNoteBlock()` — and MUST NOT place it in `system`, whose
   * text is the product's own and must not vary by space
   * (`answer-rules.ts`; wiki-docs/plan/space-audience-style/design.md).
   */
  audience?: string;
  model: string;
  effort: string;
  maxTokens: number;
}

export type AnswerEvent =
  /**
   * The model that actually served the request, which a router may map or fail
   * over to something other than the one asked for. Recorded so the stored
   * snapshot names what produced the answer rather than what we requested.
   */
  | { type: 'model'; id: string }
  /** A reasoning summary, for §19 progress. Never treated as answer text. */
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'citation'; documentIndex: number; quotedText: string | null }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  /**
   * `refusal` is a successful response on current models, not an exception, and
   * `truncated` means the token cap bounded thinking plus answer. Both are
   * outcomes the caller renders, not errors it throws.
   */
  | { type: 'stop'; reason: 'end' | 'refusal' | 'truncated' | 'other' };

export interface AnswerProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  answer(request: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent>;
  /** A short conversation title from the first question (PRD §9). */
  title(question: string, signal: AbortSignal): Promise<string>;
}

/** Thrown by an adapter when the provider could not be reached or replied badly. */
export class AnswerProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnswerProviderError';
  }
}
