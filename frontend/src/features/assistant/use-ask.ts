import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { askUrl, type ConversationMessage, type MessageCitation } from '@/lib/api';
import { asAskEvent, readEventStream } from './sse';
import { conversationKeys } from './use-conversations';

const NETWORK_MESSAGE =
  'We could not reach the server. Your question is still here — try again.';

/** The answer being streamed right now, or null between questions. */
export interface PendingAnswer {
  question: string;
  /** Progress text while the model thinks, so §19's "begin displaying" is honest. */
  thinking: string;
  text: string;
  citations: MessageCitation[];
  sourcesUsed: { id: string; title: string }[];
  truncated: boolean;
}

export type AskStatus = 'idle' | 'asking' | 'error';

/**
 * Asks a question and streams the answer.
 *
 * Two behaviours the §16 states depend on: the question stays in `lastQuestion`
 * until the answer is stored, so a failure leaves something for Retry to
 * re-send; and a partial answer is *discarded* on failure rather than shown as if
 * it were complete — the server persists nothing partial either, so there is
 * nothing to reconcile.
 */
export function useAsk(conversationId: string, spaceId: string) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AskStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAnswer | null>(null);
  const [lastQuestion, setLastQuestion] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  // A closed tab must stop paying for tokens: the abort reaches the server, which
  // cancels generation and persists nothing.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || status === 'asking') return;

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setStatus('asking');
      setError(null);
      setLastQuestion(trimmed);
      setPending({
        question: trimmed,
        thinking: '',
        text: '',
        citations: [],
        sourcesUsed: [],
        truncated: false,
      });

      let failure: string | null = null;
      // A stream that ends with neither `done` nor `error` is a failure, not a
      // success: the server died or the connection dropped mid-answer, and it
      // persisted nothing. Without this the answer would vanish silently on the
      // refetch, with no Retry offered (§16).
      let settled = false;
      let finished = false;

      /**
       * Hands off to the stored thread and releases the composer.
       *
       * Called on `done` rather than after the loop, because **the stream stays
       * open past `done`**: the server generates the conversation title on it, a
       * second provider call that can outlast the answer itself. Settling only on
       * close left a finished answer on screen with Ask disabled for as long as
       * titling took — the client half of REQ-232, and the reason sending `done`
       * earlier on the server did nothing on its own.
       */
      const finish = async () => {
        if (finished) return;
        finished = true;
        setPending(null);
        setStatus('idle');
        setLastQuestion('');
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(conversationId) });
        await queryClient.invalidateQueries({ queryKey: conversationKeys.lists(spaceId) });
      };

      try {
        const response = await fetch(askUrl(conversationId), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: trimmed }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // A refusal before the stream opens (archived space, unusable scope) is
          // an ordinary error envelope, not a stream.
          let message = NETWORK_MESSAGE;
          try {
            const envelope = (await response.json()) as { error?: { message?: string } };
            if (envelope.error?.message) message = envelope.error.message;
          } catch {
            /* keep the generic message */
          }
          throw new Error(message);
        }

        for await (const payload of readEventStream(response.body, controller.signal)) {
          const event = asAskEvent(payload);
          if (!event) continue;

          if (event.type === 'thinking') {
            setPending((current) =>
              current ? { ...current, thinking: current.thinking + event.text } : current,
            );
          } else if (event.type === 'delta') {
            setPending((current) => (current ? { ...current, text: current.text + event.text } : current));
          } else if (event.type === 'citation') {
            setPending((current) =>
              current
                ? {
                    ...current,
                    citations: [
                      ...current.citations,
                      {
                        id: event.citationId ?? '',
                        index: event.index,
                        sourceId: event.sourceId,
                        sourceTitle: event.sourceTitle,
                        quotedText: event.quotedText,
                        reference: event.reference,
                        stale: false,
                      },
                    ],
                  }
                : current,
            );
          } else if (event.type === 'sources') {
            setPending((current) => (current ? { ...current, sourcesUsed: event.sources } : current));
          } else if (event.type === 'title') {
            void queryClient.invalidateQueries({ queryKey: conversationKeys.lists(spaceId) });
          } else if (event.type === 'error') {
            failure = event.message;
            settled = true;
          } else if (event.type === 'done') {
            settled = true;
            setPending((current) => (current ? { ...current, truncated: event.truncated } : current));
            await finish();
          }
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        failure = caught instanceof Error ? caught.message : NETWORK_MESSAGE;
      }

      if (controller.signal.aborted) return;

      if (!failure && !settled) failure = NETWORK_MESSAGE;

      if (failure) {
        setError(failure);
        setStatus('error');
        // The partial answer goes: showing it would present an unfinished thought
        // as an answer, and the server stored none of it either.
        setPending(null);
        return;
      }

      // Ordinarily already done, on `done`. This covers a stream that settled and
      // then closed without one — the handoff must happen exactly once either way.
      await finish();
    },
    [conversationId, spaceId, queryClient, status],
  );

  const retry = useCallback(() => {
    if (lastQuestion) void ask(lastQuestion);
  }, [ask, lastQuestion]);

  return { ask, retry, status, error, pending, lastQuestion };
}

/** The optimistic user turn shown while an answer streams. */
export function pendingUserMessage(question: string): ConversationMessage {
  return {
    id: 'pending-question',
    role: 'user',
    content: question,
    feedback: null,
    grounded: null,
    passagesSent: null,
    sourcesUsed: [],
    citations: [],
    savedNoteId: null,
    createdAt: new Date().toISOString(),
  };
}
