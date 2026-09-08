import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError, type ScopeInput, type Source } from '@/lib/api';
import { useSources } from '@/features/sources/use-sources';
import { ScopeSelector } from './scope-selector';
import { useCreateConversation } from './use-conversations';
import { useUi } from '@/lib/locale';

/**
 * The history hub's composer. One submit creates the conversation and hands the
 * question to the thread, which asks it (see `AssistantPane`'s initial-question
 * effect). Creating on submit rather than on a "New conversation" click is what
 * keeps empty threads out of the list: a conversation exists only once there is
 * a question in it.
 *
 * The scope is chosen here too, with the thread's own selector: the first
 * question is asked with it, so asking about one source no longer costs a
 * space-wide first answer (REQ-171, REQ-239).
 *
 * A failed create keeps the draft and says so beside the field (PRD §16).
 */
export function NewChatComposer({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const navigate = useNavigate();
  const create = useCreateConversation(spaceId);
  const { text } = useUi();
  const sources = useSources(spaceId);
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<ScopeInput>({ scopeType: 'space' });
  const [error, setError] = useState<string | null>(null);

  const scopedSource =
    scope.scopeType === 'source'
      ? sources.data?.find((source) => source.id === scope.scopeSourceId)
      : undefined;
  const placeholder = scopedSource
    ? `${text.assistant.questionPlaceholder.replace('your sources', `“${scopedSource.title}”`)} `
    : `${text.assistant.questionPlaceholder.replace('your sources', spaceName)} `;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || create.isPending) return;
    setError(null);
    try {
      const conversation = await create.mutateAsync(scope);
      navigate(`/spaces/${spaceId}/assistant/${conversation.id}`, {
        state: { initialQuestion: question },
      });
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'We could not start this chat. Your question is still here — try again.',
      );
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <ScopeSelector
        id="new-chat-scope"
        value={scope}
        sources={sources.data ?? ([] as Source[])}
        disabled={create.isPending}
        onChange={setScope}
      />
      <div className="flex items-end gap-2">
        <label htmlFor="new-chat-question" className="sr-only">
          {text.assistant.questionLabel}
        </label>
        <textarea
          id="new-chat-question"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={2000}
          placeholder={placeholder}
          aria-describedby={error ? 'new-chat-error' : undefined}
          className="flex-1 resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-base text-on-surface"
        />
        <Button type="submit" disabled={create.isPending || draft.trim() === ''}>
          {create.isPending ? text.assistant.answeringButton : text.assistant.ask}
        </Button>
      </div>
      {error ? (
        <div id="new-chat-error">
          <Alert>{error}</Alert>
        </div>
      ) : null}
    </form>
  );
}
