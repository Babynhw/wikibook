import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Notebook } from '@/lib/api';
import { type CitationAttrs } from './citation-node';
import { clearDraft, readDraft, type NotebookDraft } from './draft-storage';
import { notebookExtensions } from './extensions';
import { SaveStatus } from './save-status';
import { Toolbar } from './toolbar';
import { useAutosave } from './use-autosave';

export interface NotebookEditorHandle {
  /** Inserts a citation chip at the caret — or at the end if the editor was never focused. */
  insertCitation: (attrs: CitationAttrs) => void;
  /** The Tiptap instance — the seam the tests drive edits through. */
  getEditor: () => Editor | null;
}

/**
 * The notebook editor: Tiptap seeded once from the loaded notebook, autosave
 * on every change, the toolbar above and the save state beside it.
 *
 * Seeded *once*: the editor owns the document after mount, and a refetched
 * `notebook` must not re-seed it (that would discard what is being typed).
 * The only replacement is an explicit Reload after a conflict.
 */
export const NotebookEditor = forwardRef<
  NotebookEditorHandle,
  {
    spaceId: string;
    notebook: Notebook;
    editable: boolean;
    /** Rendered in the header row beside the save state, e.g. the Export menu. */
    actions?: React.ReactNode;
  }
>(function NotebookEditor({ spaceId, notebook, editable, actions }, ref) {
  const hadFocusRef = useRef(false);
  const [pendingDraft, setPendingDraft] = useState<NotebookDraft | null>(null);
  // Declared before `useEditor` so its callbacks never read it in a TDZ; filled
  // in once `useAutosave` has run below.
  const autosaveRef = useRef<ReturnType<typeof useAutosave> | null>(null);

  const editor = useEditor({
    extensions: notebookExtensions(),
    content: notebook.contentRich as object,
    editable,
    // Mounting in jsdom and rendering synchronously keeps the suite deterministic;
    // Tiptap 3 defaults to rendering on the next frame.
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        // The reading column (REQ-236's face) — a writing surface reads the same.
        class:
          'prose-notebook min-h-[60svh] outline-none font-serif text-base leading-7 text-on-surface',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Notebook',
      },
      handleKeyDown: (_view, event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === 'b') {
          // The generated sidebar binds ⌘/Ctrl+B on `window` to toggle the rail.
          // Bold wins while the caret is here; the event stops before it gets
          // there (design "Cmd+B stops at the editor"). `false` lets Tiptap's own
          // keymap still handle the chord.
          event.stopPropagation();
          return false;
        }
        if (mod && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          autosaveRef.current?.flush();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => autosaveRef.current?.markDirty(e.getJSON()),
    onBlur: () => autosaveRef.current?.flush(),
    onFocus: () => {
      hadFocusRef.current = true;
    },
  });

  const replaceDocument = useCallback(
    (doc: unknown) => {
      editor?.commands.setContent(doc as object, { emitUpdate: false });
    },
    [editor],
  );

  const autosave = useAutosave({ spaceId, notebook, enabled: editable, onReplaceDocument: replaceDocument });
  autosaveRef.current = autosave;

  // A draft left by a closed tab. Same base as the server: the server has not
  // moved, the draft is simply newer — applied silently and saved. Older base:
  // offered, never applied on its own (design "The draft outlives the tab").
  useEffect(() => {
    if (!editor || !editable) return;
    const draft = readDraft(notebook.id);
    if (!draft) return;
    if (draft.baseUpdatedAt === notebook.updatedAt) {
      editor.commands.setContent(draft.doc as object, { emitUpdate: false });
      autosaveRef.current?.adoptDraft(draft.doc);
    } else {
      setPendingDraft(draft);
    }
    // Once per notebook identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, notebook.id]);

  useEffect(() => {
    // `false`: Tiptap's `setEditable` emits `update` by default even when the
    // value is unchanged, which would mark the document dirty on every mount
    // and PUT an identical copy — bumping `updatedAt` under any other tab.
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useImperativeHandle(
    ref,
    () => ({
      insertCitation: (attrs) => {
        if (!editor || !editable) return;
        const chain = hadFocusRef.current ? editor.chain().focus() : editor.chain().focus('end');
        chain.insertContent([{ type: 'citation', attrs }, { type: 'text', text: ' ' }]).run();
        hadFocusRef.current = true;
      },
      getEditor: () => editor,
    }),
    [editor, editable],
  );

  if (!editor) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SaveStatus
          state={autosave.state}
          frozen={!editable}
          onRetry={autosave.flush}
          onReload={autosave.reload}
          onKeepMine={autosave.keepMine}
        />
        {actions}
      </div>

      {pendingDraft ? (
        <Alert>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              You have unsaved changes from{' '}
              {pendingDraft.savedAt ? new Date(pendingDraft.savedAt).toLocaleString() : 'an earlier session'}{' '}
              that were never saved. Restore them, or discard them and keep what is saved.
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  editor.commands.setContent(pendingDraft.doc as object, { emitUpdate: false });
                  autosave.adoptDraft(pendingDraft.doc);
                  setPendingDraft(null);
                }}
              >
                Restore
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  clearDraft(notebook.id);
                  setPendingDraft(null);
                }}
              >
                Discard
              </Button>
            </span>
          </div>
        </Alert>
      ) : null}

      {editable ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
});
