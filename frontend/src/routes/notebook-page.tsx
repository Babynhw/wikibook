import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { ApiError, type NoteCitation } from '@/lib/api';
import { useSpace } from '@/features/spaces/use-spaces';
import { useSpaceRole } from '@/features/spaces/use-space-role';
import { usePresence } from '@/features/notebook/use-presence';
import { useSources } from '@/features/sources/use-sources';
import { CitationContext, citationAttrsFrom } from '@/features/notebook/citation-node';
import { ExportMenu } from '@/features/notebook/export-menu';
import { NotebookEditor, type NotebookEditorHandle } from '@/features/notebook/notebook-editor';
import { ResearchPanel } from '@/features/notebook/panel/research-panel';
import { useNotebook } from '@/features/notebook/use-notebook';
import { useUi } from '@/lib/locale';

/** Below this the panel is a sheet; at and above it, a side column. */
const NARROW_QUERY = '(max-width: 1023px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * `/spaces/:spaceId/notebook` — the `research_notebook` wireframe: one
 * continuous document in a reading-width column, the Research panel beside it.
 * The editor is mounted once the notebook has loaded and never remounts for
 * anything the panel does (PRD §13, §19).
 */
export function NotebookPage() {
  const { text } = useUi();
  const { spaceId = '' } = useParams<{ spaceId: string }>();
  const space = useSpace(spaceId);
  const notebook = useNotebook(spaceId);
  const editorRef = useRef<NotebookEditorHandle>(null);
  const narrow = useNarrow();
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Which sources still exist, so a chip can say "(source removed)". Archived
  // sources still exist and still open in the reader, so both lists count.
  const active = useSources(spaceId);
  const archived = useSources(spaceId, { archived: 'only' });
  const sourceIds = useMemo(() => {
    if (!active.data || !archived.data) return null;
    return new Set([...active.data, ...archived.data].map((s) => s.id));
  }, [active.data, archived.data]);
  const citationContext = useMemo(() => ({ spaceId, sourceIds }), [spaceId, sourceIds]);

  const permissions = useSpaceRole(space.data);
  const isArchived = permissions.archived;
  const loadError = notebook.error ?? space.error;

  // Presence (shared-spaces-v1): if someone else is already editing when I
  // arrive, I step back into read mode with an explicit way past it. Decided
  // once, from the first presence answer — a name appearing later must not yank
  // the editor out from under me mid-sentence — and optimistically: the editor
  // opens editable, so a solo owner never sees a read-only flash. Nothing is
  // locked server-side; the compare-and-set save stays the arbiter.
  const [stance, setStance] = useState<'edit' | 'yield' | 'edit-anyway'>('edit');
  const decided = useRef(false);
  const editable = permissions.canEdit && stance !== 'yield';
  const presence = usePresence(spaceId, editable);
  useEffect(() => {
    if (decided.current || !presence.loaded) return;
    decided.current = true;
    if (presence.others.length > 0) setStance('yield');
  }, [presence.loaded, presence.others.length]);
  const othersEditing = presence.others.map((user) => user.name);
  const presenceLine =
    othersEditing.length === 0
      ? ''
      : text.notebook.isEditing.replace('{names}', othersEditing.join(', '));

  const insert = (citation: NoteCitation) => {
    editorRef.current?.insertCitation(citationAttrsFrom(citation));
    if (narrow) setSheetOpen(false);
  };

  const panel = (onClose?: () => void) => (
    <ResearchPanel spaceId={spaceId} canInsert={editable} onInsertCitation={insert} onClose={onClose} />
  );

  return (
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
      <CitationContext.Provider value={citationContext}>
        <div className="flex items-start gap-8">
          <div className="min-w-0 flex-1">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-on-surface">{text.notebook.title}</h1>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {text.notebook.description}
                </p>
                {/* Announced once per change of the set, not per heartbeat: the text
                    only changes when a name arrives or leaves (REQ-187 pattern). */}
                <p role="status" aria-live="polite" className="mt-1 font-mono text-xs text-primary">
                  {presenceLine}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={narrow ? sheetOpen : panelOpen}
                onClick={() => (narrow ? setSheetOpen(true) : setPanelOpen((open) => !open))}
              >
                {!narrow && panelOpen ? (
                  <PanelRightClose className="size-4" aria-hidden="true" />
                ) : (
                  <PanelRightOpen className="size-4" aria-hidden="true" />
                )}
                {text.notebook.researchPanel}
              </Button>
            </div>

            {isArchived ? (
              <Alert>{text.notebook.archivedNotice}</Alert>
            ) : permissions.isViewer ? (
              <Alert variant="info">{text.notebook.viewerNotice}</Alert>
            ) : permissions.canEdit && stance === 'yield' ? (
              <Alert variant="info" className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {presenceLine || text.notebook.someoneElseEditing} {text.notebook.editingNotice}
                </span>
                <Button size="sm" onClick={() => setStance('edit-anyway')}>
                  {text.notebook.editAnyway}
                </Button>
              </Alert>
            ) : null}

            {notebook.isPending || space.isPending ? (
              <div className="space-y-3" aria-busy="true" aria-label={text.notebook.loading}>
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : notebook.isError || space.isError ? (
              <Alert>
                {loadError instanceof ApiError ? loadError.message : text.notebook.loadFailed}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-3"
                  onClick={() => {
                    void notebook.refetch();
                    void space.refetch();
                  }}
                >
                  {text.common.retry}
                </Button>
              </Alert>
            ) : (
              <div className="mx-auto max-w-2xl">
                <NotebookEditor
                  ref={editorRef}
                  spaceId={spaceId}
                  notebook={notebook.data}
                  editable={editable}
                  actions={<ExportMenu spaceId={spaceId} />}
                />
              </div>
            )}
          </div>

          {!narrow && panelOpen ? (
            <aside className="sticky top-20 hidden max-h-[calc(100svh-6rem)] w-[22.5rem] shrink-0 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low lg:block">
              {panel(() => setPanelOpen(false))}
            </aside>
          ) : null}
        </div>

        {narrow ? (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="right" className="w-full p-0 sm:max-w-md">
              <SheetHeader className="sr-only">
                <SheetTitle>{text.notebook.researchPanelTitle}</SheetTitle>
                <SheetDescription>{text.notebook.researchPanelDescription}</SheetDescription>
              </SheetHeader>
              {panel(() => setSheetOpen(false))}
            </SheetContent>
          </Sheet>
        ) : null}
      </CitationContext.Provider>
    </AppShell>
  );
}
