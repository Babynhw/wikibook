import { ArrowRight, BookOpen, FileText, Sparkles, Trash2, Upload } from 'lucide-react';
import type { Note } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { extractDocText } from './doc-text';
import { useUi } from '@/lib/locale';

/** Snippet join rules: prose runs with spaces, no paragraph breaks. */
export function extractSnippet(contentRich: unknown): string {
  return extractDocText(contentRich, { inline: ' ', block: '' }).text;
}

export function NoteCard({
  note,
  onOpen,
  onConvert,
  onDelete,
  readOnly = false,
}: {
  note: Note;
  onOpen: () => void;
  onConvert: () => void;
  onDelete: () => void;
  /** Archived spaces: Convert and Delete are withheld — the banner says read-only. */
  readOnly?: boolean;
}) {
  const { text } = useUi();
  const isSavedAnswer = note.originType === 'saved_answer';
  const snippet = extractSnippet(note.contentRich);
  const updatedDate = new Date(note.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="group relative flex flex-col justify-between rounded-lg border border-outline-variant bg-surface-container-lowest p-5 shadow-xs transition-shadow hover:shadow-md">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                isSavedAnswer
                  ? 'bg-primary-fixed text-on-primary-fixed'
                  : 'bg-surface-container-high text-on-surface-variant'
              }`}
            >
              {isSavedAnswer ? (
                <>
                  <Sparkles className="size-3" />
                  <span>{text.notes.savedAnswer}</span>
                </>
              ) : (
                <>
                  <FileText className="size-3" />
                  <span>{text.notes.userNote}</span>
                </>
              )}
            </span>

            {note.convertedSource ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-xs text-on-surface-variant">
                <span>{text.notes.convertedSource}</span>
                <span className="text-[10px] uppercase font-semibold text-primary">
                  ({note.convertedSource.state})
                </span>
              </span>
            ) : null}
          </div>

          {note.citationCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs text-on-surface-variant">
              <BookOpen className="size-3" />
              <span>{note.citationCount} {note.citationCount === 1 ? text.notes.citation : text.notes.citations}</span>
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="mt-3 block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
        >
          {/* h2, not h3: the page's h1 is "Saved Notes" and there is no h2 between (axe heading-order). */}
          <h2 className="line-clamp-2 text-base font-semibold text-on-surface group-hover:text-primary transition-colors">
            {note.title}
          </h2>
        </button>

        {snippet ? (
          <p className="mt-2 line-clamp-3 text-sm text-on-surface-variant leading-relaxed">
            {snippet}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant/60 pt-3 text-xs text-on-surface-variant">
        <span>
          {text.notes.updated} {updatedDate}
          {note.author ? ` · ${text.notes.by} ${note.author.name}` : note.author === null ? ` · ${text.notes.by} ${text.notes.formerMember}` : ''}
        </span>

        <div className="flex flex-wrap items-center gap-1">
          {readOnly ? null : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onConvert}
                title={text.notes.convert}
                aria-label={`Convert note: ${note.title}`}
                className="h-8 px-2 text-xs"
              >
                <Upload className="size-3.5 mr-1" />
                <span>{text.notes.convert}</span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                title={text.notes.delete}
                aria-label={`Delete note: ${note.title}`}
                className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only">{text.notes.delete}</span>
              </Button>
            </>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={onOpen}
            className="h-8 px-2.5 text-xs font-medium ml-1"
          >
            <span>{text.notes.open}</span>
            <ArrowRight className="size-3 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
