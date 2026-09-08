import { useState, useEffect, useId, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  Edit2,
  ExternalLink,
  FileText,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, type Note } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUpdateNote } from './use-notes';
import { extractDocText } from './doc-text';

export function NoteViewer({
  note,
  onClose,
  onConvert,
  onDelete,
  readOnly = false,
}: {
  note: Note;
  onClose: () => void;
  onConvert: () => void;
  onDelete: () => void;
  /** Archived spaces: Edit, Convert, and Delete are withheld — the banner says read-only. */
  readOnly?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  // Two viewers must never collide on a hard-coded id; every other labelled
  // control in the app derives its id the same way.
  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const contentId = `${fieldId}-content`;

  const parsed = useMemo(() => extractDocText(note.contentRich), [note.contentRich]);
  const isSavedAnswer = note.originType === 'saved_answer';
  const update = useUpdateNote(note.spaceId);
  const saveError = update.error instanceof ApiError ? update.error : null;

  /**
   * Focus management for a drawer (PRD §18): focus moves to Close when it
   * opens and back to whatever opened it — the card's Open button — when it
   * unmounts. Once per mount, not per note: switching notes inside the open
   * drawer must not yank focus off what the user is reading.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Read through refs so the listener below is registered once and still sees
  // the current callbacks and edit state.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const editingRef = useRef(isEditing);
  editingRef.current = isEditing;
  const dirtyRef = useRef(false);

  // The walk hit its depth bound, so `parsed.text` is a lossy view of the
  // document. Saving would rewrite `contentRich` from that truncated text and
  // destroy whatever the walk could not reach — so editing is refused instead.
  const tooDeepToEdit = parsed.truncated;

  // Reseed the editor copy on note identity change only. `contentRich` is a
  // fresh object identity on every refetch, so depending on it would reset the
  // draft the instant a background refetch landed — discarding whatever the
  // user has typed mid-edit.
  useEffect(() => {
    setTitle(note.title);
    setContent(parsed.text);
    setIsEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const handleSave = () => {
    if (!title.trim() || tooDeepToEdit) return;

    update.mutate(
      {
        id: note.id,
        input: {
          title: title.trim(),
          contentRich: {
            type: 'doc',
            ...(parsed.question ? { question: parsed.question } : {}),
            // Round-trip the structure the editor shows: `\n\n` is exactly what
            // the text walk emits between blocks, so split on it and rebuild one
            // paragraph per blank-line-separated run. Flattening into a single
            // paragraph would destroy the document on the first save.
            content: content
              .split(/\n{2,}/)
              .map((text) => text.trim())
              .filter(Boolean)
              .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
          },
        },
      },
      {
        onSuccess: () => {
          setIsEditing(false);
        },
      },
    );
  };

  // Discarding edits re-seeds the editor from the current server view (the
  // `parsed` memo) — abandoning the draft must not leave it to resurface on
  // the next click of Edit.
  const handleCancel = () => {
    setTitle(note.title);
    setContent(parsed.text);
    setIsEditing(false);
  };
  const cancelRef = useRef(handleCancel);
  cancelRef.current = handleCancel;
  dirtyRef.current = isEditing && (title !== note.title || content !== parsed.text);

  /**
   * Escape closes the drawer. Two exceptions, both deliberate: a modal dialog
   * stacked on top (Delete, Convert) owns Escape and must not take the drawer
   * with it; and while editing, Escape leaves edit mode only if nothing has
   * been typed — with unsaved changes it does nothing, because one keystroke
   * in a text field must never discard a draft (PRD §16 "typed content
   * survives"); Cancel and Save remain the explicit ways out.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (editingRef.current) {
        if (dirtyRef.current) return;
        event.preventDefault();
        cancelRef.current();
        return;
      }
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const updatedDate = new Date(note.updatedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    // A side drawer, not a modal: claiming aria-modal without a focus trap and
    // focus restore would be worse than not claiming it (PRD §18). The page's
    // real dialogs use the `Dialog` component; this one stays complementary.
    <div
      role="complementary"
      aria-label={note.title}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-surface-container-lowest border-l border-outline-variant shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-outline-variant p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isSavedAnswer
                ? 'bg-primary-fixed text-on-primary-fixed'
                : 'bg-surface-container-high text-on-surface-variant'
            }`}
          >
            {isSavedAnswer ? (
              <>
                <Sparkles className="size-3" />
                <span>Saved Answer</span>
              </>
            ) : (
              <>
                <FileText className="size-3" />
                <span>User Note</span>
              </>
            )}
          </span>

          {note.originConversationId ? (
            <Link
              to={`/spaces/${note.spaceId}/assistant/${note.originConversationId}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <span>View Conversation</span>
              <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </div>

        <Button
          ref={closeRef}
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-8 w-8 shrink-0 p-0"
          aria-label="Close note viewer"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* The save state, announced (PRD §18): the buttons' own labels change,
          but a label change on a focused control is not reliably read. The
          word changes only when the state does. */}
      <p role="status" aria-live="polite" className="sr-only">
        {update.isPending ? 'Saving note' : update.isSuccess ? 'Note saved' : update.isError ? 'Save failed' : ''}
      </p>

      {/* Main scrollable body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* A failed save says why and keeps the draft (PRD §16). */}
        {saveError ? <Alert>{saveError.message}</Alert> : null}

        {note.convertedSource ? (
          <div className="rounded-lg border border-primary/30 bg-primary-fixed/20 p-3.5 text-xs text-on-surface-variant flex items-center justify-between">
            <div>
              <p className="font-semibold text-primary">Converted Evidence Source</p>
              <p className="mt-0.5">
                This note was converted to a manual source ({note.convertedSource.state}).
              </p>
            </div>
            <Link
              to={`/spaces/${note.spaceId}/sources/${note.convertedSource.id}`}
              className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:bg-primary/90"
            >
              <span>View Source</span>
              <ExternalLink className="size-3" />
            </Link>
          </div>
        ) : null}

        {/* Title area */}
        <div>
          {isEditing ? (
            <div className="space-y-1">
              <label htmlFor={titleId} className="text-xs font-medium text-on-surface-variant">
                Note Title
              </label>
              <Input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                className="text-base font-semibold"
              />
            </div>
          ) : (
            <h2 className="text-xl font-bold text-on-surface leading-snug">{note.title}</h2>
          )}
          <p className="mt-1 text-xs text-on-surface-variant">Last updated {updatedDate}</p>
        </div>

        {/* Saved Answer distinction: Original Question */}
        {isSavedAnswer && parsed.question ? (
          <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              Original Question
            </p>
            <p className="mt-1.5 text-sm font-medium text-on-surface">{parsed.question}</p>
          </div>
        ) : null}

        {/* A document the walk could not reach the bottom of shows what it read
            and says why editing is withheld — silently offering an Edit that
            would truncate the note on save is the failure to avoid (PRD §16). */}
        {tooDeepToEdit ? (
          <Alert>
            This note is nested too deeply to show in full. What is below is partial, so editing
            is withheld — saving it would discard the rest.
          </Alert>
        ) : null}

        {/* Note Content / Answer */}
        <div className="space-y-2">
          {isSavedAnswer ? (
            <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              Assistant Answer
            </p>
          ) : null}

          {isEditing ? (
            <div className="space-y-1">
              <label htmlFor={contentId} className="text-xs font-medium text-on-surface-variant">
                Note content
              </label>
              <textarea
                id={contentId}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                className="w-full rounded-md border border-input bg-transparent p-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              />
            </div>
          ) : (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-on-surface">
              {parsed.text || <span className="italic text-on-surface-variant">No content</span>}
            </div>
          )}
        </div>

        {/* Citations section for saved answers */}
        {note.citations.length > 0 ? (
          <div className="space-y-3 border-t border-outline-variant pt-5">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              <BookOpen className="size-3.5" />
              <span>Attached Citations ({note.citations.length})</span>
            </div>

            <div className="space-y-2.5">
              {note.citations.map((citation, index) => {
                const readerUrl = `/spaces/${note.spaceId}/sources/${citation.sourceId}?cite=${citation.id}&from=/spaces/${note.spaceId}/notes`;

                return (
                  <div
                    key={citation.id}
                    className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3.5 text-xs space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-on-surface">
                        [{index + 1}] {citation.sourceTitle}
                      </span>
                      {citation.stale ? (
                        <span className="inline-flex items-center gap-1 rounded bg-error-container px-2 py-0.5 text-[11px] font-medium text-on-error-container">
                          <AlertTriangle className="size-3" />
                          <span>Stale / Unavailable</span>
                        </span>
                      ) : (
                        <span className="text-on-surface-variant">
                          {citation.page ? `Page ${citation.page}` : citation.paragraphRef || ''}
                        </span>
                      )}
                    </div>

                    <p className="text-on-surface-variant italic border-l-2 border-primary/40 pl-2">
                      “{citation.quotedText}”
                    </p>

                    <div className="pt-1">
                      <Link
                        to={readerUrl}
                        className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                      >
                        <span>Open cited passage in reader</span>
                        <ExternalLink className="size-3" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer Actions — wraps at 320 px rather than pushing Save off the drawer. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant bg-surface-container-low p-4">
        <div className="flex flex-wrap items-center gap-2">
          {readOnly ? null : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                className="text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5 mr-1" />
                <span>Delete</span>
              </Button>

              <Button variant="secondary" size="sm" onClick={onConvert}>
                <Upload className="size-3.5 mr-1" />
                <span>Convert to source</span>
              </Button>
            </>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {readOnly ? null : isEditing ? (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={update.isPending || !title.trim()}>
                <Save className="size-3.5 mr-1" />
                <span>{update.isPending ? 'Saving…' : 'Save changes'}</span>
              </Button>
            </>
          ) : tooDeepToEdit ? null : (
            <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
              <Edit2 className="size-3.5 mr-1" />
              <span>Edit</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
