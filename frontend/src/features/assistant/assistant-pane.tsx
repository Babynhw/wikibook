import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Conversation, Source } from '@/lib/api';
import { useSources } from '@/features/sources/use-sources';
import { AnswerMessage } from './answer-message';
import { ScopeSelector } from './scope-selector';
import { pendingUserMessage, useAsk } from './use-ask';
import { useSmoothedText } from './use-smoothed-text';
import { useConversation, useFeedback, useSetScope } from './use-conversations';
import { useUi } from '@/lib/locale';

/**
 * The assistant thread and composer (PRD §9).
 *
 * A component rather than only a route, for the same reason Phase 3 made the
 * reader one: on a wide viewport this pane sits beside the reader, and a citation
 * opens the passage in place rather than navigating away.
 */
export function AssistantPane({
  conversation,
  spaceId,
  readOnly = false,
  canSaveNotes = true,
  onOpenInPane,
}: {
  conversation: Conversation;
  spaceId: string;
  /** True in an archived space: the thread stays readable, asking does not. */
  readOnly?: boolean;
  /** False for a viewer: saving an answer writes a shared note (shared-spaces-v1). */
  canSaveNotes?: boolean;
  onOpenInPane?: (target: { sourceId: string; passageId: string | null; page: number | null }) => void;
}) {
  const { text } = useUi();
  const thread = useConversation(conversation.id);
  const sources = useSources(spaceId);
  const setScope = useSetScope(conversation.id, spaceId);
  const feedback = useFeedback(conversation.id);
  const { ask, retry, status, error, pending } = useAsk(conversation.id, spaceId);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // A question typed on the history hub arrives here through router state: the
  // hub cannot ask itself because `useAsk` needs a conversation that did not
  // exist until the hub created it. Asked once, then the state is cleared with a
  // `replace`, so Back, a refresh, or a re-render never asks it again — and a
  // copied URL carries no question at all, which is why this is state and not
  // `?q=`.
  const initialQuestion = readInitialQuestion(location.state);
  const askedInitialRef = useRef(false);
  useEffect(() => {
    if (!initialQuestion || askedInitialRef.current) return;
    askedInitialRef.current = true;
    // Cleared in every case — a question that could not be asked must not sit in
    // the history entry waiting for the space to be restored.
    navigate(location.pathname, { replace: true, state: null });
    if (!readOnly) void ask(initialQuestion);
  }, [ask, initialQuestion, location.pathname, navigate, readOnly]);

  const messages = thread.data?.messages ?? [];
  const returnTo = `/spaces/${spaceId}/assistant/${conversation.id}`;

  // Segments arrive a sentence at a time and roughly a second apart; this paces
  // them out so the answer reads as it is written rather than appearing in slabs.
  const streamed = useSmoothedText(pending?.text ?? '', status === 'asking');

  // Follows the text the user can actually see, not the text that has arrived —
  // otherwise the thread jumps to the end of a segment that is still revealing.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, streamed]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    // The composer is cleared only once the question is in flight; a failure keeps
    // it recoverable through Retry, which re-sends the same question (§16).
    setDraft('');
    void ask(question);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ScopeSelector
          value={{
            scopeType: conversation.scopeType,
            ...(conversation.scopeSourceId ? { scopeSourceId: conversation.scopeSourceId } : {}),
          }}
          sources={sources.data ?? ([] as Source[])}
          disabled={readOnly || status === 'asking'}
          onChange={(input) => setScope.mutate(input)}
        />
      </div>

      {/* Status, not tokens. A token-by-token live region reads one sentence to a
          screen reader eight times; §18 asks for state changes to be announced,
          not for the content to be re-read as it arrives. */}
      <p role="status" aria-live="polite" className="sr-only">
        {status === 'asking'
          ? pending?.text
            ? text.assistant.answering
            : pending?.thinking
              ? text.assistant.thinking
              : text.assistant.searching
          : status === 'error'
            ? text.assistant.failed
            : messages.length > 0
              ? text.assistant.complete
              : ''}
      </p>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {thread.isPending ? (
          <p className="text-sm text-on-surface-variant">{text.assistant.loading}</p>
        ) : null}

        {!thread.isPending && messages.length === 0 && !pending ? (
          <Card>
            <h2 className="text-base font-semibold text-on-surface">{text.assistant.askSources}</h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              {text.assistant.askSourcesDescription}
            </p>
          </Card>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <p
              key={message.id}
              className="ml-auto max-w-[85%] rounded-lg bg-surface-container px-3 py-2 text-base text-on-surface"
            >
              {message.content}
            </p>
          ) : (
            <AnswerMessage
              canSave={canSaveNotes}
              key={message.id}
              message={message}
              spaceId={spaceId}
              conversationId={conversation.id}
              returnTo={returnTo}
              {...(onOpenInPane ? { onOpenInPane } : {})}
              onFeedback={(value) => feedback.mutate({ messageId: message.id, feedback: value })}
            />
          ),
        )}

        {pending ? (
          <>
            <p className="ml-auto max-w-[85%] rounded-lg bg-surface-container px-3 py-2 text-base text-on-surface">
              {pendingUserMessage(pending.question).content}
            </p>
            {pending.text ? (
              <AnswerMessage
                message={{
                  id: 'pending-answer',
                  role: 'assistant',
                  content: streamed,
                  feedback: null,
                  grounded: pending.citations.length > 0,
                  // Unknown while streaming; the stored answer carries the count.
                  passagesSent: null,
                  sourcesUsed: pending.sourcesUsed,
                  citations: pending.citations,
                  savedNoteId: null,
                  createdAt: new Date().toISOString(),
                }}
                spaceId={spaceId}
                conversationId={conversation.id}
                returnTo={returnTo}
                truncated={pending.truncated}
                canSave={false}
              />
            ) : pending.thinking ? (
              <ThinkingBlock reasoning={pending.thinking} />
            ) : (
              <p className="text-sm italic text-on-surface-variant">{text.assistant.searching}…</p>
            )}
          </>
        ) : null}

        {status === 'error' && error ? (
          <div>
            <Alert>{error}</Alert>
            <div className="mt-2">
              <Button variant="secondary" onClick={retry}>
                {text.assistant.tryAgain}
              </Button>
            </div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      {readOnly ? (
        <Alert>{text.assistant.archived}</Alert>
      ) : (
        <form onSubmit={submit} className="flex items-end gap-2">
          <label htmlFor="assistant-question" className="sr-only">
            {text.assistant.questionLabel}
          </label>
          <textarea
            id="assistant-question"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={text.assistant.questionPlaceholder}
            className="flex-1 resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-base text-on-surface"
          />
          <Button type="submit" disabled={status === 'asking' || draft.trim() === ''}>
            {status === 'asking' ? text.assistant.answeringButton : text.assistant.ask}
          </Button>
        </form>
      )}
    </div>
  );
}

function readInitialQuestion(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const question = (state as { initialQuestion?: unknown }).initialQuestion;
  return typeof question === 'string' && question.trim() !== '' ? question : null;
}

/**
 * The model's reasoning, while it reasons.
 *
 * On a reasoning model the first thing that arrives is thinking, and on the
 * endpoint this was measured against it arrives twenty seconds before any answer
 * text (wiki-docs/plan/assistant-reasoning-visibility/proposal.md). Without a
 * label those seconds read as a hang; without the reasoning underneath, a static
 * label reads as one too. So: both, with the reasoning clamped.
 *
 * Two things it must stay. **Subordinate** — the answer renders through
 * `AnswerMessage`, and this is a status affordance with no card, no citations,
 * and no actions, because the failure mode is a user reading reasoning as the
 * answer. And **transient** — the moment the first segment of text arrives this
 * is replaced, and nothing about it is persisted or citable.
 *
 * `flex-col-reverse` inside a clamped, hidden box is what pins the view to the
 * *newest* reasoning: `line-clamp` would show the opening lines and then sit
 * still for the rest of the wait, which is the wrong end of a growing text.
 */
function ThinkingBlock({ reasoning }: { reasoning: string }) {
  const { text } = useUi();
  return (
    <div className="max-w-[85%] rounded-lg border border-outline-variant px-3 py-2">
      <p className="flex items-center gap-2 text-sm font-medium text-on-surface-variant">
        <span aria-hidden="true" className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
        {text.assistant.thinking}…
      </p>
      <div className="mt-2 flex max-h-18 flex-col-reverse overflow-hidden border-t border-outline-variant pt-2">
        <p className="text-sm italic text-on-surface-variant">{reasoning}</p>
      </div>
    </div>
  );
}
