import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { useSpace } from '@/features/spaces/use-spaces';
import { useSpaceRole } from '@/features/spaces/use-space-role';
import { useNotes, useNote } from '@/features/notes/use-notes';
import { NoteList } from '@/features/notes/note-list';
import { NoteViewer } from '@/features/notes/note-viewer';
import { CreateNoteDialog } from '@/features/notes/create-note-dialog';
import { DeleteNoteDialog } from '@/features/notes/delete-note-dialog';
import { ConvertNoteDialog } from '@/features/notes/convert-note-dialog';

/** Long enough that a typed word is one request, short enough to feel live —
 * the same 250 ms `use-source-search.ts` settled on for the library. */
const SEARCH_DEBOUNCE_MS = 250;

export function NotesPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId ?? '';
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<Note | null>(null);
  const [noteToConvert, setNoteToConvert] = useState<Note | null>(null);

  const activeNoteId = searchParams.get('noteId');

  const spaceQuery = useSpace(spaceId);
  // Filtering is the list route's job (the `?q=` it already implements for
  // phase 3's source search precedent): the request is debounced so the settled
  // query costs one request, and the client never filters in memory.
  const notesQuery = useNotes(spaceId, debouncedQuery || undefined);
  const activeNoteQuery = useNote(activeNoteId);

  const space = spaceQuery.data;
  const permissions = useSpaceRole(space);
  const isArchived = permissions.archived;
  // One condition for every write affordance: archived *or* viewer (shared-spaces-v1).
  const readOnly = !permissions.canEdit;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleOpenNote = (note: Note) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('noteId', note.id);
      return next;
    });
  };

  const handleCloseNote = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('noteId');
      return next;
    });
  };

  return (
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space} />}>
      {/* Not a <main>: `AppShell`'s inset already is the page's main landmark,
          and a second one nested inside it fails axe `landmark-no-duplicate-main`. */}
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Top Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-on-surface">Saved Notes</h1>
              {/* The space's total, not the filtered list length: a badge beside
                  the page title that shrinks while you search reads as though
                  the space lost notes. The filtered count is announced under the
                  search box, where it means what it says. */}
              {space && space.noteCount > 0 ? (
                <span className="rounded-full bg-surface-container-high px-2.5 py-0.5 text-xs font-medium text-on-surface-variant">
                  {space.noteCount}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-on-surface-variant">
              Private working materials and answers saved from the Knowledge Assistant.
            </p>
          </div>

          {permissions.canEdit ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4 mr-1.5" />
              <span>New note</span>
            </Button>
          ) : null}
        </div>

        {/* Read-only banner for archived space */}
        {isArchived ? (
          <Alert>
            This space is archived. Notes are read-only until you restore the space.
          </Alert>
        ) : permissions.isViewer ? (
          <Alert variant="info">You can read every note here; writing notes needs an editor role.</Alert>
        ) : null}

        {/* A ?noteId= that no longer resolves (deleted, foreign, mistyped) must
            not silently render an empty page — PRD §16 wants a state, not a
            blank. */}
        {activeNoteId && activeNoteQuery.isError ? (
          <Alert>
            {activeNoteQuery.error instanceof ApiError
              ? activeNoteQuery.error.message
              : 'That note could not be found. It may have been deleted.'}
          </Alert>
        ) : null}

        {/* Search bar once the space has anything to search (or a search is active,
          so a no-match query does not make the input vanish) */}
        {notesQuery.data && (notesQuery.data.length > 0 || searchQuery) ? (
          <div className="max-w-md">
            <label htmlFor="notes-search" className="sr-only">
              Search notes
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-on-surface-variant pointer-events-none" />
              <Input
                id="notes-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search notes..."
                className="pl-9"
              />
            </div>
            {/* A search that silently rewrites a list is invisible to a screen
                reader (PRD §18), so the count is announced, not only rendered —
                the same reason `source-filters.tsx` announces its own. */}
            <p aria-live="polite" className="mt-1.5 font-mono text-xs text-outline">
              {notesQuery.data.length} {notesQuery.data.length === 1 ? 'note' : 'notes'}
              {debouncedQuery ? ` · matching “${debouncedQuery}”` : ''}
            </p>
          </div>
        ) : null}

        {/* Notes content */}
        {notesQuery.isPending ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-lg" />
            ))}
          </div>
        ) : notesQuery.isError ? (
          <Alert>
            {notesQuery.error instanceof ApiError
              ? notesQuery.error.message
              : 'Could not load saved notes.'}
          </Alert>
        ) : (
          <NoteList
            notes={notesQuery.data ?? []}
            spaceId={spaceId}
            searchQuery={searchQuery}
            onClearSearch={() => setSearchQuery('')}
            readOnly={readOnly}
            onCreateNote={() => setCreating(true)}
            onOpenNote={handleOpenNote}
            onConvertNote={(n) => setNoteToConvert(n)}
            onDeleteNote={(n) => setNoteToDelete(n)}
          />
        )}

        {/* Create Note Dialog */}
        {creating ? (
          <CreateNoteDialog
            spaceId={spaceId}
            onClose={() => setCreating(false)}
            onCreated={(newNoteId) => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('noteId', newNoteId);
                return next;
              });
            }}
          />
        ) : null}

        {/* Delete Note Confirmation Dialog */}
        {noteToDelete ? (
          <DeleteNoteDialog
            note={noteToDelete}
            onClose={() => setNoteToDelete(null)}
            onDeleted={() => {
              if (activeNoteId === noteToDelete.id) {
                handleCloseNote();
              }
            }}
          />
        ) : null}

        {/* Convert Note Confirmation Dialog */}
        {noteToConvert ? (
          <ConvertNoteDialog
            note={noteToConvert}
            onClose={() => setNoteToConvert(null)}
          />
        ) : null}

        {/* Active Note Viewer Drawer */}
        {activeNoteQuery.data ? (
          <NoteViewer
            note={activeNoteQuery.data}
            readOnly={readOnly}
            onClose={handleCloseNote}
            onConvert={() => setNoteToConvert(activeNoteQuery.data)}
            onDelete={() => setNoteToDelete(activeNoteQuery.data)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
