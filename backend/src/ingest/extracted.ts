import type { LocatedBlock } from './chunk.js';

/** The located text blocks a source type produces, plus the plain text form. */
export interface ExtractionResult {
  text: string;
  blocks: LocatedBlock[];
}

/** A web extraction also surfaces what §5.2 asks to capture when available. */
export interface WebExtractionResult extends ExtractionResult {
  /** Best-effort per §5.2: the Readability title, falling back to meta tags. */
  title: string;
  /** The byline when Readability found one; otherwise null. */
  author: string | null;
  /** Best-effort site name (publisher), dropped at persist — no Source column. */
  publisher: string | null;
  /** Best-effort from OpenGraph / article:published_time; otherwise null. */
  publishedAt: string | null;
  /** The URL as the user entered it, after the SSRF-safe fetch succeeded. */
  url: string;
}