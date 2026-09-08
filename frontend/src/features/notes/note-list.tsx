import { FileText, Plus, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Note } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { NoteCard } from './note-card';

export function NoteList({
  notes,
  spaceId,
  searchQuery,
  onClearSearch,
  onCreateNote,
  onOpenNote,
  onConvertNote,
  onDeleteNote,
  readOnly = false,
}: {
  notes: Note[];
  spaceId: string;
  searchQuery?: string;
  onClearSearch?: () => void;
  onCreateNote: () => void;
  onOpenNote: (note: Note) => void;
  onConvertNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  /** Archived spaces: write actions are withheld (the page banner says read-only). */
  readOnly?: boolean;
}) {
  if (notes.length === 0) {
    if (searchQuery) {
      return (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant p-8 text-center">
          <div
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant"
          >
            <Search className="size-6" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-on-surface">
            No notes match “{searchQuery}”
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            Try adjusting your search query or clear the filter.
          </p>
          {onClearSearch ? (
            <Button variant="secondary" size="sm" onClick={onClearSearch} className="mt-4">
              Clear search
            </Button>
          ) : null}
        </div>
      );
    }

    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant p-8 text-center bg-surface-container-lowest/50">
        <div
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
        >
          <FileText className="size-7" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-on-surface">No saved notes yet</h2>
        <p className="mt-1 max-w-md text-sm text-on-surface-variant">
          Save useful answers from the Knowledge Assistant or draft your own private working notes to
          organize your research.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {readOnly ? null : (
            <Button onClick={onCreateNote}>
              <Plus className="size-4 mr-1.5" />
              <span>Create a note</span>
            </Button>
          )}

          <Button variant="secondary" render={<Link to={`/spaces/${spaceId}/assistant`} />}>
            <Sparkles className="size-4 mr-1.5" />
            <span>Ask Assistant</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          readOnly={readOnly}
          onOpen={() => onOpenNote(note)}
          onConvert={() => onConvertNote(note)}
          onDelete={() => onDeleteNote(note)}
        />
      ))}
    </div>
  );
}
