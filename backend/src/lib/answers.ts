import { locatorLabel, type RetrievedPassage } from './retrieval.js';
import type {
  AnswerProvider,
  AnswerTurn,
  CitationMode,
} from './answer-provider.js';

/**
 * Turns retrieved passages plus a provider into an answer, and owns every rule
 * that makes a citation trustworthy — deliberately outside any adapter
 * (wiki-docs/plan/phase-4-assistant/design.md "One passage is one `document`
 * block").
 *
 * The rules, in one place:
 *
 * 1. A citation is kept only if its `documentIndex` addresses a document we
 *    actually sent. Anything else is dropped and counted — never text, just a
 *    count (§17).
 * 2. `sourceId`, `passageId`, `page`, `paragraphRef`, and `sectionHeading` are
 *    copied from the `Passage` row. **No code path turns model output into a
 *    locator.** Only the quote comes from the model's citation.
 * 3. A quote the provider did not extract itself is verified against the passage
 *    text and discarded if it is not in there, so a generated quote can never be
 *    presented as if the source said it.
 * 4. The `[n]` marker is written into the answer text as each citation resolves.
 *    No provider supplies one — a native tier attaches citations out-of-band and
 *    the model is never asked to type them — so this is the only place a claim
 *    and its citation are associated at all (§9, REQ-185).
 *
 * Insufficiency is recognised from the absence of citations rather than from a
 * structured field, because citations and structured outputs cannot both be used
 * on the same request.
 */

export interface ResolvedCitation {
  /** Position in the answer's citation list — the `[n]` the client renders. */
  index: number;
  passageId: string;
  sourceId: string;
  sourceTitle: string;
  quotedText: string;
  page: number | null;
  paragraphRef: string | null;
  sectionHeading: string | null;
  /** The displayed reference (§8/§9 require it shown, not merely honoured). */
  reference: string;
}

export type AnswerRunEvent =
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'citation'; citation: ResolvedCitation }
  | { type: 'complete'; outcome: AnswerOutcome };

export interface AnswerOutcome {
  text: string;
  citations: ResolvedCitation[];
  /** Derived from the citation count, never stored as a second source of truth. */
  grounded: boolean;
  /** True when the token cap bounded thinking plus answer. */
  truncated: boolean;
  refused: boolean;
  citationMode: CitationMode;
  provider: string;
  /** The model that answered, when the provider reported one (a router may map). */
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** Citations the provider returned that addressed nothing we sent. */
  droppedCitations: number;
}

/**
 * Strips citation markers from a prior assistant turn before it is replayed.
 *
 * A `[1]` from three turns ago indexes a document set that no longer exists;
 * leaving it in invites the model to reuse a number that now points somewhere
 * else entirely.
 */
export function stripMarkers(text: string): string {
  return text.replace(/\s*\[\d+\]/g, '');
}

/**
 * The history a follow-up carries: the last `maxTurns` user/assistant pairs,
 * newest-first-trimmed, sent as **conversation** and never as documents. That
 * parameter choice is what enforces §9's "saved assistant answers must not be
 * used as evidence" — a prior answer is not citable because it is not a document.
 */
export function buildHistory(
  turns: { role: 'user' | 'assistant'; content: string }[],
  maxTurns: number,
): AnswerTurn[] {
  const pairs = Math.max(0, maxTurns) * 2;
  return turns
    .slice(-pairs)
    .map((turn) => ({
      role: turn.role,
      text: turn.role === 'assistant' ? stripMarkers(turn.content) : turn.content,
    }))
    .filter((turn) => turn.text.trim().length > 0);
}

/**
 * Runs one answer, yielding events as they arrive and finishing with a
 * `complete` event carrying the outcome the caller persists.
 *
 * Yielding rather than returning is what lets the route forward tokens to the
 * client while the answer is still being produced — §19 measures the first thing
 * the user sees, not the last.
 */
export async function* runAnswer(options: {
  provider: AnswerProvider;
  question: string;
  passages: RetrievedPassage[];
  history: AnswerTurn[];
  /** The space's audience note, passed through to the user turn (answer-rules.ts). */
  audience?: string;
  model: string;
  effort: string;
  maxTokens: number;
  signal: AbortSignal;
}): AsyncGenerator<AnswerRunEvent, void, undefined> {
  const { provider, passages, signal } = options;

  // The ordered array a `documentIndex` indexes into. Built once, here, so the
  // mapping back cannot disagree with what was sent.
  const documents = passages.map((passage) => ({
    title: passage.sourceTitle,
    context: locatorLabel(passage),
    text: passage.text,
  }));

  let text = '';
  const citations: ResolvedCitation[] = [];
  // A model may cite the same passage for several claims; the marker should be
  // the same number each time rather than a new one.
  const indexByPassage = new Map<string, number>();
  let dropped = 0;
  let truncated = false;
  let refused = false;
  let servedModel: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  for await (const event of provider.answer(
    {
      question: options.question,
      documents,
      history: options.history,
      ...(options.audience ? { audience: options.audience } : {}),
      model: options.model,
      effort: options.effort,
      maxTokens: options.maxTokens,
    },
    signal,
  )) {
    switch (event.type) {
      case 'thinking':
        yield { type: 'thinking', text: event.text };
        break;

      case 'delta':
        text += event.text;
        yield { type: 'delta', text: event.text };
        break;

      case 'citation': {
        const passage = passages[event.documentIndex];
        // Rule 1. An index outside the set we sent addresses nothing, so there is
        // nothing to persist — this is the branch that makes a fabricated
        // citation unpersistable rather than merely unlikely.
        if (!passage) {
          dropped += 1;
          break;
        }

        const existing = indexByPassage.get(passage.passageId);
        const index = existing ?? citations.length + 1;

        // Rule 4. **The marker is written into the answer here**, at the position
        // the citation arrived, because that is the only place the association
        // between a claim and its citation exists.
        //
        // Neither tier hands one over: a native provider attaches citations
        // out-of-band, and the model is never asked to type `[1]` — so without
        // this the answer text carries no markers at all, the client renders
        // nothing clickable, and §9's "citations beside the claims they support"
        // is not met (REQ-185). Citations arrive after the text they support, so
        // appending is the faithful position. It goes into the accumulated `text`
        // as well as the stream, so a reload renders what the user first saw.
        const marker = `${text === '' || /\s$/.test(text) ? '' : ' '}[${index}]`;
        text += marker;
        yield { type: 'delta', text: marker };

        // A repeat citation of an already-cited passage reuses its number and adds
        // no second row — emitting the marker above is the whole point of getting
        // here at all.
        if (existing !== undefined) break;

        // Rule 3. An extracted quote comes from the document; a generated one is
        // the model's own words and must be found in the passage to be shown.
        let quotedText = event.quotedText ?? '';
        if (quotedText && provider.capabilities.quote === 'generated') {
          if (!passage.text.includes(quotedText)) quotedText = '';
        }

        const citation: ResolvedCitation = {
          index,
          passageId: passage.passageId,
          sourceId: passage.sourceId,
          sourceTitle: passage.sourceTitle,
          quotedText,
          // Rule 2. Every one of these comes from the row, not from the model.
          page: passage.page,
          paragraphRef: passage.paragraphRef,
          sectionHeading: passage.sectionHeading,
          reference: locatorLabel(passage),
        };
        indexByPassage.set(passage.passageId, index);
        citations.push(citation);
        yield { type: 'citation', citation };
        break;
      }

      case 'model':
        servedModel = event.id;
        break;

      case 'usage':
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
        };
        break;

      case 'stop':
        if (event.reason === 'truncated') truncated = true;
        if (event.reason === 'refusal') refused = true;
        break;
    }
  }

  yield {
    type: 'complete',
    outcome: {
      text,
      citations,
      // An answer with no citation is an insufficiency answer, however confident
      // its prose sounds. Derived, not stored: the citation count already says it.
      grounded: citations.length > 0,
      truncated,
      refused,
      citationMode: provider.capabilities.citations,
      provider: provider.id,
      servedModel,
      usage,
      droppedCitations: dropped,
    },
  };
}
