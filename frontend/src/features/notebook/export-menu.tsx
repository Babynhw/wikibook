import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FileDown, Printer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError, notebookApi } from '@/lib/api';

/**
 * PRD §14's three outputs. Download and Copy both read the server's Markdown —
 * one serialiser — and Print is a route with `@media print`. Export never
 * touches the notebook; a failure is a state with Retry (§16), not a toast.
 */
export function ExportMenu({ spaceId }: { spaceId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    setCopyState('copying');
    setMessage(null);
    try {
      const markdown = await notebookApi.exportMarkdown(spaceId);
      await navigator.clipboard.writeText(markdown);
      setCopyState('copied');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopyState('idle'), 2500);
    } catch (error) {
      setCopyState('failed');
      setMessage(
        error instanceof ApiError
          ? error.message
          : 'The notebook could not be copied to the clipboard. Try again, or download it instead.',
      );
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="secondary" size="sm" />}>
          <FileDown className="size-4" aria-hidden="true" />
          Export
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => void copy()} disabled={copyState === 'copying'}>
            {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy to clipboard'}
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={notebookApi.exportPath(spaceId)} download />}>
            <Download aria-hidden="true" />
            Download Markdown
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to={`/spaces/${spaceId}/notebook/print`} />}>
            <Printer aria-hidden="true" />
            Print
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Announced: a copy that silently fails leaves the user pasting nothing. */}
      <p aria-live="polite" className="sr-only">
        {copyState === 'copied' ? 'Notebook copied to the clipboard' : ''}
      </p>
      {copyState === 'failed' && message ? (
        <Alert>
          <span className="flex flex-wrap items-center gap-2">
            {message}
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              Retry
            </Button>
          </span>
        </Alert>
      ) : null}
    </div>
  );
}
