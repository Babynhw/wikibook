import { useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ApiError, type FieldErrors } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, TextareaField } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { useCreateSource, useUploadSource } from '@/features/sources/use-sources';
import { useUi } from '@/lib/locale';

type Tab = 'pdf' | 'web' | 'manual';

/**
 * Client-side validation mirrors the server's messages, so a rejection reads the
 * same whichever side catches it (PRD §16). The server stays the authority — the
 * character and byte caps are `AppConfig` limits this bundle cannot know.
 */
const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function validateWeb(url: string, messages: { empty: string; protocol: string; invalid: string }): FieldErrors {
  const value = url.trim();
  if (value === '') return { url: messages.empty };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: messages.protocol };
    }
  } catch {
    return { url: messages.invalid };
  }
  return {};
}

function validateManual(title: string, content: string, author: string, messages: { title: string; content: string; long200: string; long120: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (title.trim() === '') errors.title = messages.title;
  else if (title.trim().length > 200) errors.title = messages.long200;
  if (content.trim() === '') errors.content = messages.content;
  if (author.trim().length > 120) errors.author = messages.long120;
  return errors;
}

/**
 * One dialog, three tabs. PRD §5.3 is explicit that the interface must not offer
 * separate entry points per source kind, and three top-level buttons would
 * recreate that split by another name.
 *
 * Each tab keeps its own state for the life of the dialog: a failed submit — and
 * a switch away and back — preserves what the user typed (PRD §16).
 */
export function AddSourceDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { text } = useUi();
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'pdf', label: 'PDF' },
    { id: 'web', label: text.source.webLink },
    { id: 'manual', label: text.source.text },
  ];
  const [tab, setTab] = useState<Tab>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [author, setAuthor] = useState('');
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const create = useCreateSource(spaceId);
  const upload = useUploadSource(spaceId);
  const pending = create.isPending || upload.isPending;

  const active = tab === 'pdf' ? upload : create;
  const apiError = active.error instanceof ApiError ? active.error : null;
  // Local validation wins where both have something to say: it is the message
  // for the input as it stands now.
  const errorFor = (field: string) => localErrors[field] ?? apiError?.fields[field];

  const chooseTab = (next: Tab) => {
    setTab(next);
    setLocalErrors({});
    create.reset();
    upload.reset();
  };

  const takeFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (!isPdf(candidate)) {
      setFile(null);
      setLocalErrors({ file: text.source.onlyPdf });
      return;
    }
    setFile(candidate);
    setLocalErrors({});
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    takeFile(event.dataTransfer.files[0]);
  };

  const submit = () => {
    if (tab === 'pdf') {
      if (!file) {
        setLocalErrors({ file: text.source.choosePdfError });
        return;
      }
      setLocalErrors({});
      upload.mutate(file, { onSuccess: onClose });
      return;
    }

    if (tab === 'web') {
      const errors = validateWeb(url, { empty: text.source.webAddress, protocol: text.source.httpOnly, invalid: text.source.validUrl });
      setLocalErrors(errors);
      if (Object.keys(errors).length > 0) return;
      create.mutate({ type: 'web', url: url.trim() }, { onSuccess: onClose });
      return;
    }

    const errors = validateManual(title, content, author, { title: text.source.titleError, content: text.source.contentError, long200: text.source.tooLong200, long120: text.source.tooLong120 });
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    create.mutate(
      {
        type: 'manual',
        title: title.trim(),
        content,
        ...(author.trim() === '' ? {} : { author: author.trim() }),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open
      title={text.source.add}
      description={text.source.addDescription}
      onClose={onClose}
    >
      <div role="tablist" aria-label={text.source.kind} className="mt-4 flex gap-1 border-b border-outline-variant">
        {tabs.map(({ id, label }, index) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${baseId}-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface',
            )}
            onClick={() => chooseTab(id)}
            onKeyDown={(event) => {
              // The ARIA tabs pattern: arrows move between tabs, Tab leaves the list.
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = tabs[(index + step + tabs.length) % tabs.length]!;
              chooseTab(next.id);
              document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        noValidate
        id={`${baseId}-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* Field-level messages render next to their field; this is for the rest. */}
        {apiError && Object.keys(apiError.fields).length === 0 ? (
          <Alert>{apiError.message}</Alert>
        ) : null}

        {tab === 'pdf' ? (
          <div className="flex flex-col gap-1.5">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'rounded border border-dashed p-6 text-center',
                dragging ? 'border-primary bg-surface-container-low' : 'border-outline-variant',
              )}
            >
              {/* A real file input behind a label: the keyboard path is the native
                  one, and the drop target is an addition to it, not a substitute. */}
              <label
                htmlFor={`${baseId}-file`}
                className="cursor-pointer font-medium text-primary underline"
              >
                {text.source.choosePdf}
              </label>
              <input
                ref={fileInputRef}
                id={`${baseId}-file`}
                type="file"
                accept="application/pdf,.pdf"
                aria-invalid={errorFor('file') ? true : undefined}
                aria-describedby={errorFor('file') ? `${baseId}-file-error` : undefined}
                className="sr-only"
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  takeFile(event.target.files?.[0])
                }
              />
              <p className="mt-1 text-sm text-on-surface-variant">
                {file ? file.name : text.source.dropPdf}
              </p>
            </div>
            {errorFor('file') ? (
              <p id={`${baseId}-file-error`} className="text-sm text-on-error-container">
                {errorFor('file')}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === 'web' ? (
          <Field
            label={text.source.webAddress}
            name="url"
            value={url}
            autoComplete="off"
            placeholder="https://"
            hint={text.source.webHint}
            error={errorFor('url')}
            onChange={(event) => setUrl(event.target.value)}
          />
        ) : null}

        {tab === 'manual' ? (
          <>
            <Field
              label={text.common.title}
              name="title"
              value={title}
              autoComplete="off"
              error={errorFor('title')}
              onChange={(event) => setTitle(event.target.value)}
            />
            <TextareaField
              label={text.source.text}
              name="content"
              rows={6}
              value={content}
              hint={text.source.textHint}
              error={errorFor('content')}
              onChange={(event) => setContent(event.target.value)}
            />
            <Field
              label={text.common.author}
              name="author"
              value={author}
              autoComplete="off"
              hint={text.source.optional}
              error={errorFor('author')}
              onChange={(event) => setAuthor(event.target.value)}
            />
          </>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {text.common.cancel}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? text.common.saving : text.source.add}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
