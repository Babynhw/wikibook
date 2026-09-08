import { useState } from 'react';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type Conversation,
  type ConversationMessage,
  type MessageCitation,
} from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CitationMarker } from './citation-marker';
import { useSaveAnswerAsNote } from '@/features/notes/use-notes';
import { conversationKeys } from './use-conversations';
import { useUi } from '@/lib/locale';

/**
 * Splits answer text on `[n]` markers so each one renders as a real control
 * beside the claim it supports, rather than as a footnote list at the end — §9
 * requires a citation to sit next to the specific statement it supports.
 *
 * A marker naming a citation the answer does not have is left as plain text: the
 * number would resolve to nothing, and inventing a target for it is exactly the
 * thing this phase exists to prevent.
 */
export function renderWithMarkers(
  text: string,
  citations: MessageCitation[],
  marker: (citation: MessageCitation) => React.ReactNode,
): React.ReactNode[] {
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const parts: React.ReactNode[] = [];
  const pattern = /\[(\d+)\]/g;
  let cursor = 0;
  let match = pattern.exec(text);
  let key = 0;

  while (match) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const citation = byIndex.get(Number(match[1]));
    if (citation) {
      parts.push(<span key={`marker-${key++}`}>{marker(citation)}</span>);
    } else {
      parts.push(match[0]);
    }
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function AnswerMessage({
  message,
  spaceId,
  conversationId,
  returnTo,
  onFeedback,
  onOpenInPane,
  truncated = false,
  canSave = true,
}: {
  message: ConversationMessage;
  spaceId: string;
  conversationId: string;
  returnTo: string;
  onFeedback?: (feedback: 'useful' | 'not_useful' | null) => void;
  onOpenInPane?: (target: { sourceId: string; passageId: string | null; page: number | null }) => void;
  truncated?: boolean;
  /**
   * False for the synthetic streaming answer (`pending-answer`): it has no
   * persisted message id, so "Save as note" would call a route that cannot
   * exist. The real, stored answer gets the button.
   */
  canSave?: boolean;
}) {
  const { text } = useUi();
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const saveNote = useSaveAnswerAsNote(spaceId);
  const ungrounded = message.grounded === false;

  // Saved state lives on the message itself (savedNoteId), not in component
  // state, so it survives a remount, a reload, and a background refetch — a
  // component-local flag reset with every mount and offered "Save as note"
  // again, then 409'd, which is the bug this replaced.
  const saved = message.savedNoteId !== null;

  const markSaved = (savedNoteId: string) => {
    queryClient.setQueryData<{
      conversation: Conversation;
      messages: ConversationMessage[];
    }>(conversationKeys.detail(conversationId), (current) => {
      if (!current) return current;
      return {
        ...current,
        messages: current.messages.map((m) =>
          m.id === message.id ? { ...m, savedNoteId } : m,
        ),
      };
    });
  };

  const handleSaveAsNote = () => {
    if (saved || saveNote.isPending) return;
    setSaveError(null);
    saveNote.mutate(
      { messageId: message.id },
      {
        onSuccess: (data) => {
          markSaved(data.note.id);
        },
        onError: (err: unknown) => {
          // api.ts throws a flat ApiError — the old nested `err.error?.code`
          // arm could never fire. Real failures (archived space, rate limit,
          // network) surface instead of being silently swallowed.
          if (err instanceof ApiError && err.code === 'note_already_saved') {
            // The answer is already a note somewhere; let the server supply the
            // real note id rather than inventing a marker.
            void queryClient.invalidateQueries({
              queryKey: conversationKeys.detail(conversationId),
            });
            return;
          }
          setSaveError(
            err instanceof ApiError ? err : new ApiError(0, 'save_note_failed', 'Could not save this answer.'),
          );
        },
      },
    );
  };

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <p className="whitespace-pre-wrap text-base leading-relaxed text-on-surface">
        {renderWithMarkers(message.content, message.citations, (citation) => (
          <CitationMarker
            citation={citation}
            spaceId={spaceId}
            returnTo={returnTo}
            {...(onOpenInPane ? { onOpenInPane } : {})}
          />
        ))}
      </p>

      {truncated ? (
        <p className="mt-3 text-sm text-on-surface-variant">
          Câu trả lời đã dừng sớm vì đạt giới hạn độ dài. Hãy đặt câu hỏi cụ thể hơn để xem phần còn lại.
        </p>
      ) : null}

      {/* §9 requires an answer to identify the sources it used. An ungrounded
          answer has none to name, and saying "Sources: none" would be noise. */}
      {message.sourcesUsed.length > 0 ? (
        <p className="mt-3 border-t border-outline-variant pt-3 text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">{text.assistant.sourcesUsed}: </span>
          {message.sourcesUsed.map((source) => source.title).join(' · ')}
        </p>
      ) : ungrounded ? (
        <p className="mt-3 border-t border-outline-variant pt-3 text-sm text-on-surface-variant">
          {/* Saying "no source supported this" when excerpts *were* searched is a
              claim about the evidence that we cannot make: an answer citing none of
              twelve excerpts can equally mean the citation channel is broken. Say
              what actually happened and let the reader judge. */}
          {message.passagesSent && message.passagesSent > 0
            ? text.assistant.excerptsSearched.replace('{count}', String(message.passagesSent))
            : text.assistant.noMatchingSource}
        </p>
      ) : null}

      {saveError ? <Alert className="mt-3">{saveError.message}</Alert> : null}

      {(canSave || onFeedback) ? (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant/60 pt-3">
        {onFeedback ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-on-surface-variant">{text.assistant.usefulQuestion}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={message.feedback === 'useful'}
              onClick={() => onFeedback(message.feedback === 'useful' ? null : 'useful')}
            >
              {message.feedback === 'useful' ? `✓ ${text.assistant.useful}` : text.assistant.useful}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={message.feedback === 'not_useful'}
              onClick={() => onFeedback(message.feedback === 'not_useful' ? null : 'not_useful')}
            >
              {message.feedback === 'not_useful' ? `✓ ${text.assistant.notUseful}` : text.assistant.notUseful}
            </Button>
          </div>
        ) : null}

        {/* The action pins to the right edge whether or not feedback is shown;
            `ml-auto` does the spacing that an invisible spacer <div /> faked. */}
        {canSave ? (
        <div className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={saved || saveNote.isPending}
            onClick={handleSaveAsNote}
            className="text-xs"
          >
            {saved ? (
              <>
                <BookmarkCheck className="size-3.5 mr-1 text-primary" />
                  <span className="text-primary font-medium">{text.assistant.savedToNotes}</span>
              </>
            ) : (
              <>
                <BookmarkPlus className="size-3.5 mr-1" />
                <span>{saveNote.isPending ? text.assistant.savingNote : text.assistant.saveAsNote}</span>
              </>
            )}
          </Button>
          </div>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}
