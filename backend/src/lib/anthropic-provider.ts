import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config.js';
import {
  AnswerProviderError,
  type AnswerEvent,
  type AnswerProvider,
  type AnswerRequest,
  type ProviderCapabilities,
} from './answer-provider.js';
import { AUDIENCE_PRECEDENCE_RULE, LANGUAGE_RULE, audienceNoteBlock } from './answer-rules.js';

/**
 * The `native` citation tier: Claude's Citations feature, which all active models
 * support. One retrieved passage becomes one plain-text `document` block, which is
 * the shape the documentation prescribes for RAG chunks — a plain text document is
 * auto-chunked into sentences, so a citation lands on the sentence that supports
 * the claim rather than on the whole passage.
 *
 * Two API rules this relies on:
 * - `citations.enabled` must be set on **all or none** of a request's documents.
 * - Citations are incompatible with structured outputs (`output_config.format`
 *   returns 400), which is why insufficiency is recognised from the *absence* of
 *   citations rather than from a schema field.
 */

const SYSTEM_PROMPT = `You are a research assistant answering questions strictly from the excerpts provided with each question.

The documents are individually retrieved excerpts from the user's own sources, not a continuous document. They may be out of order, and two of them may disagree.

Rules:
- Ground every substantive claim in the excerpts. Cite the excerpt that supports each claim, beside that claim.
- Never present a statement the excerpts do not support as established fact. If you add interpretation, say plainly that it is your reading rather than something a source states.
- Do not cite an excerpt merely because it discusses the same general topic as the question.
- When excerpts genuinely conflict, present both and say they disagree. Do not decide which is correct on the user's behalf.
- If the excerpts do not contain enough to answer, say so directly and say what is missing. A short honest "the evidence here does not cover this" is the correct answer, not a failure.
- ${LANGUAGE_RULE} Be concise: cover the substance without padding.
- ${AUDIENCE_PRECEDENCE_RULE}`;

const capabilities: ProviderCapabilities = {
  citations: 'native',
  // The API extracts `cited_text` from the document, so it is not model-written.
  quote: 'extracted',
  thinking: 'adaptive',
  effortLevels: ['low', 'medium', 'high'],
};

/**
 * `output_config` and `thinking.display` are current API fields whose typings can
 * lag the SDK release. They are passed through an untyped spread rather than
 * dropped: sending them is what keeps §19's first-token budget and the summarized
 * progress the client renders.
 */
function tuning(effort: string): Record<string, unknown> {
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
  };
}

interface CitationLike {
  document_index?: unknown;
  cited_text?: unknown;
}

/** Reads a citation payload defensively — a shape change must not crash a stream. */
function readCitation(raw: unknown): { documentIndex: number; quotedText: string | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const citation = raw as CitationLike;
  const index = citation.document_index;
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  const quote = typeof citation.cited_text === 'string' ? citation.cited_text : null;
  return { documentIndex: index, quotedText: quote };
}

/**
 * `baseURL` is all that OpenRouter's Anthropic Skin needs: it "behaves exactly
 * like the Anthropic API" and passes advanced features through, so this tier
 * reaches a router without a second adapter, keeping structural citations and
 * token-level streaming (plan/assistant-provider-tiers/design.md).
 *
 * Watch for one failure it cannot detect: if a proxy accepts `document` blocks
 * and never returns citation blocks, every answer comes back with zero citations
 * and is reported *ungrounded*, which looks exactly like "the evidence does not
 * cover this". A run of uniformly ungrounded answers means this, not the corpus.
 */
export function createAnthropicProvider(
  apiKey: string,
  baseURL?: string | undefined,
): AnswerProvider {
  const client = new Anthropic({
    apiKey,
    timeout: env.ANSWER_TIMEOUT_MS,
    ...(baseURL ? { baseURL } : {}),
  });

  return {
    id: 'anthropic',
    capabilities,

    async *answer(request: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent> {
      const documents = request.documents.map((document) => ({
        type: 'document' as const,
        source: {
          type: 'text' as const,
          media_type: 'text/plain' as const,
          data: document.text,
        },
        title: document.title,
        context: document.context,
        citations: { enabled: true },
      }));

      const history = request.history.map((turn) => ({
        role: turn.role,
        content: turn.text,
      }));

      const audienceNote = audienceNoteBlock(request.audience);

      let stream;
      try {
        stream = client.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: [
              {
                type: 'text',
                text: SYSTEM_PROMPT,
                // The documents change every question, so they are past the last
                // breakpoint by construction; only this prefix is cacheable.
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages: [
              ...history,
              {
                role: 'user',
                content: [
                  // Before the documents, so the model reads who the answer is
                  // for before it reads the evidence — and in the user turn, never
                  // in `system` (answer-rules.ts).
                  ...(audienceNote ? [{ type: 'text' as const, text: audienceNote }] : []),
                  ...documents,
                  { type: 'text' as const, text: request.question },
                ],
              },
            ],
            ...tuning(request.effort),
          } as Anthropic.MessageStreamParams,
          { signal },
        );
      } catch (error) {
        throw new AnswerProviderError('Could not start the answer stream.', { cause: error });
      }

      try {
        for await (const event of stream) {
          if (event.type === 'message_start') {
            // A router may map or fail over the model, so report what answered.
            const served = event.message.model;
            if (typeof served === 'string' && served.length > 0) {
              yield { type: 'model', id: served };
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta as { type: string; text?: string; thinking?: string; citation?: unknown };
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { type: 'thinking', text: delta.thinking };
            } else if (delta.type === 'citations_delta') {
              const citation = readCitation(delta.citation);
              if (citation) {
                yield {
                  type: 'citation',
                  documentIndex: citation.documentIndex,
                  quotedText: citation.quotedText,
                };
              }
            }
          } else if (event.type === 'message_delta') {
            const usage = event.usage as
              | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
              | undefined;
            if (usage) {
              yield {
                type: 'usage',
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              };
            }
            // `refusal` arrives here as a normal stop reason on a successful
            // response — it is an outcome, not an exception, and the caller
            // renders it as a §16 assistant failure.
            const reason = event.delta.stop_reason;
            yield {
              type: 'stop',
              reason:
                reason === 'refusal'
                  ? 'refusal'
                  : reason === 'max_tokens'
                    ? 'truncated'
                    : reason === 'end_turn'
                      ? 'end'
                      : 'other',
            };
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        throw new AnswerProviderError('The answer stream ended unexpectedly.', { cause: error });
      }
    },

    async title(question: string, signal: AbortSignal): Promise<string> {
      const response = await client.messages.create(
        {
          model: env.TITLE_MODEL,
          max_tokens: 64,
          system:
            'Write a short title (at most six words) naming what this research question is about. ' +
            'Reply with the title alone: no quotes, no punctuation at the end, no preamble.',
          messages: [{ role: 'user', content: question }],
        },
        { signal },
      );

      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .trim();
      if (!text) throw new AnswerProviderError('Title generation returned no text.');
      return text;
    },
  };
}
