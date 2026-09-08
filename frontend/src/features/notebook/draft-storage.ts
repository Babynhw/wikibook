/**
 * The unsaved draft outlives the tab (design "The draft outlives the tab").
 *
 * While the document is dirty it is mirrored here with the `updatedAt` it was
 * based on; a successful save clears it. Every access is wrapped: storage can
 * be absent, full, or throwing (private mode), and the notebook must work
 * without it.
 */
export interface NotebookDraft {
  doc: unknown;
  baseUpdatedAt: string;
  savedAt: string;
}

const key = (notebookId: string) => `notebook-draft:${notebookId}`;

export function readDraft(notebookId: string): NotebookDraft | null {
  try {
    const raw = window.localStorage.getItem(key(notebookId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NotebookDraft>;
    if (!parsed || typeof parsed.baseUpdatedAt !== 'string' || parsed.doc === undefined) return null;
    return { doc: parsed.doc, baseUpdatedAt: parsed.baseUpdatedAt, savedAt: parsed.savedAt ?? '' };
  } catch {
    return null;
  }
}

export function writeDraft(notebookId: string, draft: NotebookDraft): void {
  try {
    window.localStorage.setItem(key(notebookId), JSON.stringify(draft));
  } catch {
    // Quota or a blocked store: the retry loop is still there; only the
    // across-tab safety net is missing.
  }
}

export function clearDraft(notebookId: string): void {
  try {
    window.localStorage.removeItem(key(notebookId));
  } catch {
    // Nothing to do — a draft that cannot be removed could not have been written.
  }
}
