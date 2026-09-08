import { useState } from 'react';
import {
  Archive,
  BookOpen,
  CalendarDays,
  Download,
  ExternalLink,
  FileText,
  Globe,
  MoreVertical,
  Pencil,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { ApiError, type SourceDetail, type SourceType } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteSourceDialog } from '@/features/sources/delete-source-dialog';
import { EditSourceDialog } from '@/features/sources/edit-source-dialog';
import { ArchiveSourceDialog } from '@/features/sources/archive-source-dialog';
import { useRestoreSource } from '@/features/sources/use-sources';
import { useCurrentUser } from '@/features/auth/use-auth';
import { useSpace } from '@/features/spaces/use-spaces';
import { useUi } from '@/lib/locale';

const TYPE_ICON: Record<SourceType, typeof FileText> = {
  pdf: FileText,
  web: Globe,
  manual: StickyNote,
};

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

/** The host is only used for the original-link label. */
/** The host is only used for the original-link label. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

type Dialog = 'edit' | 'archive' | 'delete' | null;

/**
 * PRD §8's required metadata: title, author or publisher, type, the original URL
 * or file, and the date added — plus the actions that belong to a source rather
 * than to reading it.
 *
 * What it deliberately does not have: reading-status controls, highlight and
 * annotation tools, Save Cited Passage, a Summarize action, or source comparison
 * (§8's "must not include" list and §20). §8's highlight is drawn by the system
 * for a citation, which is not a user tool.
 *
 * Two shapes. `full` is the `source_detail` wireframe's ruled-off header for the
 * reader route. `compact` is the `knowledge_assistant` wireframe's one-row pane
 * header — icon, a truncated title over a truncated metadata line, the original
 * link as an icon — for the reader beside an answer, where the header used to
 * take ~40 % of the pane. Compact draws no rule of its own: the host's wrapper
 * owns the border, so there is exactly one line under the header.
 */
export function ReaderHeader({
  source,
  onDeleted,
  readOnly,
  hideActions = false,
  variant = 'full',
}: {
  source: SourceDetail;
  onDeleted: () => void;
  readOnly: boolean;
  /** `compact` implies `hideActions`: the pane is where a source is read, not managed. */
  variant?: 'full' | 'compact';
  /**
   * Hides the Edit details / Archive / Delete controls. Used when the header is
   * shown outside the reader route (the assistant's reader pane), where those
   * actions don't belong to the context. The "Open the original" links remain.
   */
  hideActions?: boolean;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const restore = useRestoreSource(source.spaceId);
  const restoreError = restore.error instanceof ApiError ? restore.error : null;
  const archived = source.archivedAt !== null;
  const host = source.url ? hostOf(source.url) : null;
  const compact = variant === 'compact';
  // Delete is permanent: an editor may delete only what they added, the owner
  // anything (shared-spaces-v1 "Three roles"). Both queries are already cached.
  const { data: me } = useCurrentUser();
  const { data: space } = useSpace(source.spaceId);
  const { text } = useUi();
  const mine = source.addedBy != null && me != null && source.addedBy.id === me.id;
  const canDelete = space?.myRole === 'owner' || (space?.myRole === 'editor' && mine);
  const actionsHidden = hideActions || compact;

  // The Download / open-the-original affordance is a link, but it sits in the
  // button row and reads as one of them (secondary, wireframe "Download").
  const linkClass = compact
    ? buttonVariants({ variant: 'ghost', size: 'icon-sm' })
    : buttonVariants({ variant: 'secondary', size: 'sm' });
  const TypeIcon = TYPE_ICON[source.type];

  // Compact: every REQ-141 field on one truncated line, in reading order.
  const meta = [
    source.author,
    source.type === 'web' ? host : null,
    source.pageCount !== null ? `${source.pageCount} pages` : null,
    `Added ${formatDate(source.createdAt)}`,
    archived ? 'Archived' : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const originalLink =
    source.type === 'web' && source.url ? (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className={linkClass}
        // The visible text is the accessible name (WCAG 2.5.3); the host
        // is extra context, not a different name. Compact keeps the same
        // name through `aria-label`, so the control reads the same either way.
        aria-label={compact ? 'Open original' : undefined}
        title={host ? `Open the original at ${host}` : undefined}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        {compact ? null : 'Open original'}
      </a>
    ) : source.type === 'pdf' ? (
      <a
        // Proxied per request through the API, never a presigned URL (PRD §17).
        href={`/api/sources/${source.id}/file`}
        target="_blank"
        rel="noreferrer noopener"
        className={linkClass}
        aria-label={compact ? 'Download' : undefined}
        title={text.source.originalPdf}
      >
        <Download className="size-4" aria-hidden="true" />
        {compact ? null : 'Download'}
      </a>
    ) : null;

  const dialogs = (
    <>
      {dialog === 'edit' ? (
        <EditSourceDialog source={source} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'archive' ? (
        <ArchiveSourceDialog source={source} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteSourceDialog
          source={source}
          onClose={() => setDialog(null)}
          onDeleted={onDeleted}
        />
      ) : null}
    </>
  );

  const archivedNotice = (
    <>
      {archived ? (
          <Alert variant="info" className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span>{text.reader.archiveNotice}</span>
          {readOnly ? null : (
            <Button
              size="sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate(source.id)}
            >
              {restore.isPending ? text.common.restoring : text.common.restore}
            </Button>
          )}
                  </Alert>
      ) : null}
      {restoreError ? <Alert className="mt-3">{restoreError.message}</Alert> : null}
    </>
  );

  if (compact) {
    return (
      // knowledge_assistant wireframe, `#source-panel` header: icon · title over
      // `author • publisher` · one control on the right, all on an `h-16` row.
      <header className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TypeIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <span className="sr-only">{source.type === 'pdf' ? 'PDF' : source.type === 'web' ? text.source.webLink : text.source.text}</span>
            <div className="min-w-0">
              <h1
                className="truncate font-mono text-base font-bold text-on-surface"
                title={source.title}
              >
                {source.title}
              </h1>
              <p className="truncate text-xs text-on-surface-variant" title={meta}>
                {meta}
              </p>
            </div>
          </div>
          {originalLink ? <div className="shrink-0">{originalLink}</div> : null}
        </div>
        {archivedNotice}
      </header>
    );
  }

  return (
    // source_detail wireframe: the header is ruled off from the viewer below it.
    <header className="border-b border-outline-variant pb-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight text-on-surface sm:text-5xl">
            {source.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-on-surface-variant">
            {/* The type is a chip — DESIGN.md: small-scale, mono, a quiet fill. */}
            <span className="inline-flex items-center gap-1.5 rounded bg-surface-container-highest px-2 py-1 font-mono text-xs font-medium text-on-surface">
              <TypeIcon className="size-4 shrink-0" aria-hidden="true" />
              {source.type === 'pdf' ? 'PDF' : source.type === 'web' ? text.source.webLink : text.source.text}
            </span>

            {source.author ? (
              <span className="font-medium text-on-surface">{source.author}</span>
            ) : null}

            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
              {text.reader.added} {formatDate(source.createdAt)}
              {source.addedBy ? ` ${text.common.by} ${mine ? text.common.you : source.addedBy.name}` : ''}
            </span>

            {source.pageCount !== null ? (
              <span className="inline-flex items-center gap-1.5">
                <BookOpen className="size-4 shrink-0" aria-hidden="true" />
                {text.common.pages.replace('{count}', String(source.pageCount))}
              </span>
            ) : null}

            {source.type === 'web' && host ? (
              <span className="inline-flex items-center gap-1.5">
                <Globe className="size-4 shrink-0" aria-hidden="true" />
                {host}
              </span>
            ) : null}

            {archived ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-on-surface">
                <Archive className="size-4 shrink-0" aria-hidden="true" />
                {text.common.archived}
              </span>
            ) : null}
          </div>
        </div>

        {/* Wireframe: `Edit details · Download · ⋮`. Archive and Delete are the
            rarer, heavier actions, so they live behind the overflow menu. */}
        <div className="flex flex-wrap items-center gap-2">
          {actionsHidden || readOnly ? null : (
            <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>
              <Pencil className="size-4" aria-hidden="true" />
              {text.common.editDetails}
            </Button>
          )}

          {originalLink}

          {actionsHidden ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label={text.common.editDetails} />}
              >
                <MoreVertical className="size-4" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {readOnly || archived ? null : (
                  <DropdownMenuItem onClick={() => setDialog('archive')}>
                    <Archive aria-hidden="true" />
                    {text.common.archive}
                  </DropdownMenuItem>
                )}
                {readOnly || archived || !canDelete ? null : <DropdownMenuSeparator />}
                {canDelete ? (
                  <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
                    <Trash2 aria-hidden="true" />
                    {text.common.delete}
                </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {archivedNotice}
      {dialogs}
    </header>
  );
}
