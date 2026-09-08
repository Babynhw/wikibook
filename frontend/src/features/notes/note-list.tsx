import { FileText, Plus, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Note } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { NoteCard } from './note-card';
import { useUi } from '@/lib/locale';

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
  const { text } = useUi();
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
            {text.notes.noMatch.replace('{query}', searchQuery)}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {text.notes.adjustSearch}
          </p>
          {onClearSearch ? (
            <Button variant="secondary" size="sm" onClick={onClearSearch} className="mt-4">
              {text.notes.clearSearch}
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
        <h2 className="mt-4 text-lg font-semibold text-on-surface">{text.notes.noSaved}</h2>
        <p className="mt-1 max-w-md text-sm text-on-surface-variant">
          {text.notes.noSavedDescription}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {readOnly ? null : (
            <Button onClick={onCreateNote}>
              <Plus className="size-4 mr-1.5" />
              <span>{text.notes.createNote}</span>
            </Button>
          )}

          <Button variant="secondary" render={<Link to={`/spaces/${spaceId}/assistant`} />}>
            <Sparkles className="size-4 mr-1.5" />
            <span>{text.notes.askAssistant}</span>
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
