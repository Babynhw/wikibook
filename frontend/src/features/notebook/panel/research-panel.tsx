import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  ExternalLink,
  FileText,
  PlusCircle,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type Note, type NoteCitation } from '@/lib/api';
import { extractDocText } from '@/features/notes/doc-text';
import { extractSnippet } from '@/features/notes/note-card';
import { useNote, useNotes } from '@/features/notes/use-notes';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * The `research_notebook` wireframe's right-hand panel: the space's notes, and
 * one note readable in place with **Insert citation** on each of its citations.
 * Read-only on purpose — the notes page owns editing; this panel exists so a
 * note can be read and cited "without leaving the notebook" (PRD §13). It is
 * sibling state to the editor, never a route change, so the editor stays
 * mounted (§19 "must not reload the notebook").
 */
export function ResearchPanel({
  spaceId,
  canInsert,
  onInsertCitation,
  onClose,
}: {
  spaceId: string;
  /** False on an archived space: the notebook cannot take a citation there. */
  canInsert: boolean;
  onInsertCitation: (citation: NoteCitation) => void;
  onClose?: () => void;
}) {
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const notes = useNotes(spaceId, debounced || undefined);
  const openNote = useNote(openNoteId);

  return (
    <section aria-label="Research panel" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-outline-variant px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {openNoteId ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to notes"
              onClick={() => setOpenNoteId(null)}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Button>
          ) : (
            <BookOpen className="size-4 text-primary" aria-hidden="true" />
          )}
          <h2 className="truncate font-mono text-sm font-semibold text-on-surface">
            {openNoteId ? 'Note' : 'Saved notes'}
          </h2>
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Close research panel" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {openNoteId ? (
          openNote.isPending ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : openNote.isError || !openNote.data ? (
            <div className="p-4">
              <Alert>
                {openNote.error instanceof ApiError
                  ? openNote.error.message
                  : 'That note could not be found. It may have been deleted.'}
              </Alert>
            </div>
          ) : (
            <NoteDetail note={openNote.data} canInsert={canInsert} onInsertCitation={onInsertCitation} />
          )
        ) : (
          <NoteListPane
            spaceId={spaceId}
            notes={notes.data}
            isPending={notes.isPending}
            error={notes.isError ? notes.error : null}
            query={query}
            debounced={debounced}
            onQuery={setQuery}
            onOpen={(id) => setOpenNoteId(id)}
          />
        )}
      </div>
    </section>
  );
}

function OriginBadge({ note }: { note: Note }) {
  const saved = note.originType === 'saved_answer';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        saved ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-container-high text-on-surface-variant'
      }`}
    >
      {saved ? <Sparkles className="size-3" aria-hidden="true" /> : <FileText className="size-3" aria-hidden="true" />}
      <span>{saved ? 'Saved Answer' : 'User Note'}</span>
    </span>
  );
}

function NoteListPane({
  spaceId,
  notes,
  isPending,
  error,
  query,
  debounced,
  onQuery,
  onOpen,
}: {
  spaceId: string;
  notes: Note[] | undefined;
  isPending: boolean;
  error: unknown;
  query: string;
  debounced: string;
  onQuery: (value: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="space-y-3 p-4">
      <div>
        <label htmlFor="panel-notes-search" className="sr-only">
          Search notes
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-on-surface-variant"
            aria-hidden="true"
          />
          <Input
            id="panel-notes-search"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search notes..."
            className="pl-9"
          />
        </div>
      </div>

      {isPending ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Alert>{error instanceof ApiError ? error.message : 'Could not load saved notes.'}</Alert>
      ) : !notes || notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-outline-variant p-4 text-center text-sm text-on-surface-variant">
          {debounced ? `No notes match “${debounced}”.` : 'No saved notes yet. Save an answer from the assistant, or create one on the notes page.'}
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Notes">
          {notes.map((note) => {
            const snippet = extractSnippet(note.contentRich);
            return (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => onOpen(note.id)}
                  className="block w-full rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-left hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                >
                  <div className="flex items-center justify-between gap-2">
                    <OriginBadge note={note} />
                    {note.citationCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-on-surface-variant">
                        <BookOpen className="size-3" aria-hidden="true" />
                        {note.citationCount}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-semibold text-on-surface">{note.title}</p>
                  {snippet ? <p className="mt-1 line-clamp-2 text-xs text-on-surface-variant">{snippet}</p> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        to={`/spaces/${spaceId}/notes`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        Manage notes
        <ExternalLink className="size-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

function NoteDetail({
  note,
  canInsert,
  onInsertCitation,
}: {
  note: Note;
  canInsert: boolean;
  onInsertCitation: (citation: NoteCitation) => void;
}) {
  const parsed = useMemo(() => extractDocText(note.contentRich), [note.contentRich]);
  return (
    <article className="space-y-4 p-4" aria-label={note.title}>
      <div className="space-y-2">
        <OriginBadge note={note} />
        <h3 className="text-base font-bold leading-snug text-on-surface">{note.title}</h3>
      </div>

      {parsed.question ? (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <p className="text-xs font-semibold tracking-wider text-on-surface-variant uppercase">Question</p>
          <p className="mt-1 text-sm text-on-surface">{parsed.question}</p>
        </div>
      ) : null}

      {/* Selectable prose: "copy text from a note into the notebook manually" (§13) is exactly this. */}
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-on-surface">
        {parsed.text || <span className="italic text-on-surface-variant">No content</span>}
      </div>

      {note.citations.length > 0 ? (
        <div className="space-y-2 border-t border-outline-variant pt-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-on-surface-variant uppercase">
            <BookOpen className="size-3.5" aria-hidden="true" />
            Citations ({note.citations.length})
          </p>
          <ul className="space-y-2">
            {note.citations.map((citation, index) => {
              const readerUrl = `/spaces/${note.spaceId}/sources/${citation.sourceId}?cite=${citation.id}&from=/spaces/${note.spaceId}/notebook`;
              return (
                <li
                  key={citation.id}
                  className="space-y-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-on-surface">
                      [{index + 1}] {citation.sourceTitle}
                    </span>
                    {citation.stale ? (
                      <span className="inline-flex items-center gap-1 rounded bg-error-container px-2 py-0.5 text-[11px] font-medium text-on-error-container">
                        <AlertTriangle className="size-3" aria-hidden="true" />
                        Stale
                      </span>
                    ) : (
                      <span className="text-on-surface-variant">
                        {citation.page ? `Page ${citation.page}` : citation.paragraphRef || ''}
                      </span>
                    )}
                  </div>
                  <p className="border-l-2 border-primary/40 pl-2 text-on-surface-variant italic">“{citation.quotedText}”</p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {canInsert ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2 text-xs"
                        aria-label={`Insert citation: ${citation.sourceTitle}`}
                        onClick={() => onInsertCitation(citation)}
                      >
                        <PlusCircle className="size-3.5" aria-hidden="true" />
                        Insert citation
                      </Button>
                    ) : null}
                    <Link to={readerUrl} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      Open in reader
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
