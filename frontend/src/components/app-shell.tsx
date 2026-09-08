import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useCurrentUser, useLogout } from '@/features/auth/use-auth';

function Header({ trigger }: { trigger?: ReactNode }) {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  return (
    // `fixed` at a known 4rem, which is what the rail's `top-16` measures
    // against — the generated sidebar positions itself `fixed` too, so a header
    // that participated in scrolling would slide out from under it. Out of flow,
    // so both layouts below pad themselves by the same 4rem.
    <header className="fixed inset-x-0 top-0 z-20 h-16 border-b border-outline-variant bg-surface-container-lowest">
      <div className="mx-auto flex h-full max-w-(--container-workspace) items-center justify-between px-6">
        <div className="flex shrink-0 items-center gap-2">
          {trigger}
          <Link
            to="/"
            className="font-mono text-xs tracking-widest text-on-surface-variant uppercase"
          >
            WikiBookLM
          </Link>
        </div>
        {/* `min-w-0` + `truncate`: at 320 px the email would otherwise be the one
            thing on the page wider than the viewport (PRD §18). */}
        <div className="flex min-w-0 items-center gap-4">
          <span className="min-w-0 truncate text-sm text-on-surface-variant" title={user?.email}>
            {user?.email}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => navigate('/login', { replace: true }),
              })
            }
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * The frame every authenticated screen sits in: brand, account, sign out.
 *
 * `rail` is the space-scoped sidebar, and only the three space routes pass one —
 * every item in it needs a `spaceId` that the home and auth routes cannot supply.
 * It lives here rather than inside the page body because the generated `Sidebar`
 * positions itself `fixed`, so it has to be a sibling of the header, not a
 * descendant of the `<main>` beside it. Exactly one `<main>` renders either way:
 * `SidebarInset` is one.
 *
 * `fill` switches the frame from **document-scroll** to **app-scroll**: the shell
 * takes exactly the viewport height and never scrolls, and `children` become a
 * flex column that owns the leftover space. A screen that opts in is responsible
 * for putting `overflow-y-auto` on whichever of its own regions should scroll —
 * that is the whole point, and it is why this is opt-in rather than the default.
 * Every other route keeps growing the document, which is right for a library or a
 * reader and wrong for a chat thread whose composer belongs at the bottom.
 *
 * `svh` rather than `vh`: on mobile the URL bar makes `vh` taller than what is
 * actually visible, which puts a pinned composer *under* the browser chrome —
 * the exact failure this layout exists to avoid.
 *
 * `overflow-clip`, never `overflow-hidden`. `hidden` still creates a **scroll
 * container** — it only hides the scrollbar and blocks the *user*, while
 * `scrollIntoView` scrolls it happily from script. The reader scrolls a cited
 * passage into view, which walked up and scrolled this frame by 66 px, sliding
 * the page heading up under the fixed header and taking "Close reader" with it.
 * `clip` is not a scroll container at all, so there is nothing for an inner
 * `scrollIntoView` to find.
 */
export function AppShell({
  children,
  rail,
  fill = false,
}: {
  children: ReactNode;
  rail?: ReactNode;
  /** Fit the viewport and let a region inside `children` scroll instead. */
  fill?: boolean;
}) {
  if (!rail) {
    return (
      // `pt-16` clears the fixed header. `box-sizing: border-box` (Tailwind's
      // preflight) means the padding counts inside the height, so this adds no
      // scroll of its own.
      <div className={cn('pt-16', fill ? 'h-svh overflow-clip' : 'min-h-dvh')}>
        <Header />
        <main
          className={cn(
            'mx-auto max-w-(--container-workspace) px-6',
            fill ? 'flex h-full min-h-0 flex-col py-6' : 'py-12',
          )}
        >
          {children}
        </main>
      </div>
    );
  }

  return (
    // DESIGN.md § Layout & Spacing: a fixed 280px panel. The generated default
    // is 16rem, and the provider's style prop is the supported way to say so.
    //
    // The generated wrapper is `min-h-svh`, which grows with content. `h-svh`
    // pins it instead — both land, because one sets `min-height` and the other
    // `height`, so no edit to the generated file is needed to bound it.
    <SidebarProvider
      className={cn('flex-col pt-16', fill && 'h-svh overflow-clip')}
      style={{ '--sidebar-width': '17.5rem' } as React.CSSProperties}
    >
      {/* The mobile sheet hides its own close button (`[&>button]:hidden` in the
          generated sidebar), so this header trigger is the sheet's only opener.
          On desktop the rail's own header carries the expand/collapse control. */}
      <Header trigger={<SidebarTrigger className="-ml-2 md:hidden" />} />
      <div className={cn('flex w-full flex-1', fill && 'min-h-0')}>
        {rail}
        <SidebarInset className={cn(fill && 'min-h-0')}>
          <div
            className={cn(
              'mx-auto w-full max-w-(--container-workspace) px-6',
              fill ? 'flex min-h-0 flex-1 flex-col py-6' : 'py-12',
            )}
          >
            {children}
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
