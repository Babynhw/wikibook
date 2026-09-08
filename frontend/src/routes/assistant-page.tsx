import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, type Space } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppShell } from '@/components/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { SpaceRail } from '@/components/space-shell';
import { useSpace } from '@/features/spaces/use-spaces';
import { canEditSpace } from '@/features/spaces/use-space-role';
import { useSource } from '@/features/sources/use-sources';
import { AssistantPane } from '@/features/assistant/assistant-pane';
import { ConversationList } from '@/features/assistant/conversation-list';
import { NewChatComposer } from '@/features/assistant/new-chat-composer';
import { useConversation, useConversations } from '@/features/assistant/use-conversations';
import { ReaderHeader } from '@/features/reader/reader-header';
import { SourceReader } from '@/features/reader/source-reader';

/**
 * `/spaces/:spaceId/assistant/:conversationId?`
 *
 * Two presentations under one route file. With no conversation named this is
 * the **history hub**: a composer that starts a chat with its first question, and
 * every previous conversation in the space, most recent first — §9's "view
 * previous conversations", the "listed" half of REQ-170 that was without a UI
 * from 2026-08-15 until [[plan/assistant-chat-history]]. With one named, it is
 * the thread.
 *
 * On a wide viewport the thread and the reader sit side by side and a citation
 * opens the passage in the pane — the layout the `knowledge_assistant` wireframe
 * shows, and the reason Phase 3 built the reader as a component. Narrower than
 * that, and down to §18's 320 px, the marker navigates to the reader route
 * instead, where Phase 3's back control returns here. One resolution path, two
 * presentations.
 */
export function AssistantPage() {
  const { spaceId = '', conversationId = '' } = useParams();
  const space = useSpace(spaceId);
  const active = useConversation(conversationId);
  const [pane, setPane] = useState<{
    sourceId: string;
    passageId: string | null;
    page: number | null;
  } | null>(null);

  const archived = space.data?.archivedAt !== null && space.data?.archivedAt !== undefined;

  // The pane's header needs the source's metadata to render the title beside the
  // Close control. Reused with SourceReader's own `useSource` by query key, so the
  // request is fetched once and `enabled: sourceId !== ''` keeps it dormant while
  // the pane is closed.
  const paneSource = useSource(pane?.sourceId ?? '');

  if (space.isError) {
    return (
      <AppShell>
        <Alert>
          {space.error instanceof ApiError ? space.error.message : 'We could not load this space.'}
        </Alert>
      </AppShell>
    );
  }

  if (conversationId === '') {
    return (
      <AssistantHub spaceId={spaceId} space={space.data} />
    );
  }

  return (
    // The rail waits for the space it names; until then this renders as before.
    //
    // `fill`: a thread is a chat screen, so the page takes the viewport and the
    // *messages* scroll, leaving the composer where the user last saw it. Without
    // it the document grows and the composer walks off the bottom of a long
    // answer — you have to scroll down to type, then scroll again to read.
    <AppShell fill rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/spaces/${spaceId}/assistant`}
            className="text-sm text-on-surface-variant hover:underline"
          >
            ← Chats
          </Link>
          <h1 className="truncate text-xl font-semibold text-on-surface">
            {active.data?.conversation.title ?? 'Assistant'}
          </h1>
        </div>
        {!archived ? (
          // The composer that starts a chat lives on the hub, so a conversation is
          // created only once it has a question — this is a link, not a create.
          <Button variant="secondary" render={<Link to={`/spaces/${spaceId}/assistant`} />}>
            New chat
          </Button>
        ) : null}
      </div>

      {/* Flex, not grid, and `flex-1` on the cards rather than `h-full`.
          A grid row defaults to `auto`, so `height: 100%` inside it resolves
          against an indefinite height, falls back to content height, and the row
          then grows to match — a long source made this frame 1861 px inside a
          900 px viewport. `flex-1` asks for a share of a known size instead, so
          there is no percentage to resolve and nothing to grow.

          `min-h-0` at every level down to the thread, because a flex item
          defaults to `min-height: auto` — "as tall as my content" — which is what
          would push the composer off screen instead of scrolling inside. The
          thread's own `overflow-y-auto` opts it out of that rule, so it is the
          one place that does not need it spelled. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
        <Card className="flex min-h-0 min-w-0 flex-1 flex-col">
          {active.data ? (
            <AssistantPane
              conversation={active.data.conversation}
              spaceId={spaceId}
              readOnly={archived}
                    canSaveNotes={canEditSpace(space.data)}
              onOpenInPane={
                // Only wide viewports get the pane; below that the marker
                // navigates, which is what keeps the screen usable at 320 px.
                typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1280px)').matches
                  ? setPane
                  : undefined
              }
            />
          ) : active.isError ? (
            <Alert>
              {active.error instanceof ApiError
                ? active.error.message
                : 'We could not load this conversation.'}
            </Alert>
          ) : (
            <p className="text-sm text-on-surface-variant">Loading this conversation…</p>
          )}
        </Card>

        {pane ? (
          // The reader scrolls on its own, beside the thread rather than with it.
          <Card className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* The header and Close share one pinned line, outside the scroller.
                The reader opens scrolled to the cited passage, so a control
                inside it would start out of view — the header stays, the body
                scrolls. The header is the compact variant (one row, no rule of
                its own), so this wrapper's `border-b` is the only line under it
                and `items-center` beds Close with the title row. */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-outline-variant px-4 py-3">
              <div className="min-w-0 flex-1">
                {paneSource.data ? (
                  <ReaderHeader
                    source={paneSource.data}
                    readOnly={archived}
                    // Reading in the pane is not where a source is managed:
                    // compact hides Edit / Archive / Delete and fits one row.
                    variant="compact"
                    // Deleting from the pane leaves nothing to read there.
                    onDeleted={() => setPane(null)}
                  />
                ) : (
                  <p className="pt-1 text-sm text-on-surface-variant">
                    Loading this source…
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setPane(null)}
              >
                Close
              </Button>
            </div>
            {/* `relative` is load-bearing, not decoration. Each cited block
                carries a `sr-only` label, and `sr-only` is `position: absolute` —
                with no positioned ancestor it anchored to `SidebarInset` instead,
                escaping this scroll container and stretching the frame's
                `scrollHeight` to 1861 px on a 900 px viewport. One clipped pixel,
                parked wherever the reader happened to be scrolled to, was enough
                to make the whole frame scrollable.

                `overflow-x-hidden`, because `overflow-y-auto` alone computes
                `overflow-x` to `auto` too: anything wider than the pane became a
                horizontal scrollbar instead of being clipped. The blocks wrap
                (`wrap-anywhere`), so nothing legitimate is hidden. */}
            <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
              <SourceReader
                sourceId={pane.sourceId}
                link={{
                  ...(pane.passageId ? { passageId: pane.passageId } : {}),
                  ...(pane.page !== null ? { page: pane.page } : {}),
                }}
                showHeader={false}
              />
            </div>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}

/**
 * The bare assistant route: what ChatGPT's project page does for a project,
 * for a space. Composer first — a chat starts with its question — then the
 * list. In an archived space the composer gives way to the read-only notice and
 * the list stays: reading a conversation is always allowed (REQ-174).
 */
function AssistantHub({ spaceId, space }: { spaceId: string; space: Space | undefined }) {
  const conversations = useConversations(spaceId);
  const archived = space !== undefined && space.archivedAt !== null;

  return (
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space} />}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div>
          <Link to={`/spaces/${spaceId}`} className="text-sm text-on-surface-variant hover:underline">
            ← {space?.name ?? 'Space'}
          </Link>
          <h1 className="text-xl font-semibold text-on-surface">Assistant</h1>
        </div>

        {/* No composer until the space is known: one that mounted for an
            archived space would be swapped for the notice mid-sentence, and
            the draft would go with it (§16). */}
        {space === undefined ? (
          <Skeleton className="h-20 w-full" data-testid="composer-loading" />
        ) : archived ? (
          <Alert>This space is archived. Restore it to ask new questions.</Alert>
        ) : (
          <NewChatComposer spaceId={spaceId} spaceName={space.name} />
        )}

        <section aria-labelledby="chats-heading">
          <h2 id="chats-heading" className="mb-2 text-sm font-medium text-on-surface-variant">
            Chats
          </h2>
          <ConversationList
            conversations={conversations.data}
            spaceId={spaceId}
            isPending={conversations.isPending}
            error={conversations.error}
            archived={archived}
          />
        </section>
      </div>
    </AppShell>
  );
}
