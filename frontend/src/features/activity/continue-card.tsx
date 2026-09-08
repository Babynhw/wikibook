import { Link } from 'react-router-dom';
import type { Space } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { RelativeTime } from '@/components/relative-time';
import { useUi } from '@/lib/locale';

/**
 * The most recently opened active space (PRD §15 "most recently opened space",
 * §3 resume). `GET /spaces` already orders by `lastOpenedAt`, so the caller
 * hands over the first row; the card is not shown when there is none.
 */
export function ContinueCard({ space }: { space: Space }) {
  const { text } = useUi();
  return (
    <section aria-labelledby="continue-heading">
      <Card className="border-primary">
        <p className="font-mono text-xs tracking-widest text-primary uppercase">{text.activity.continue}</p>
        <h2 id="continue-heading" className="mt-1 truncate text-lg font-semibold text-on-surface">
          {space.name}
        </h2>
        {space.objective ? (
          <p className="mt-1 line-clamp-2 text-sm text-on-surface-variant">{space.objective}</p>
        ) : null}
        <p className="mt-2 font-mono text-xs text-outline">
          {space.sourceCount} {space.sourceCount === 1 ? text.common.source : text.common.sources} · {space.noteCount}{' '}
          {space.noteCount === 1 ? text.common.note : text.common.notes} · <RelativeTime iso={space.updatedAt} />
        </p>
        <Link to={`/spaces/${space.id}`} className={buttonVariants({ size: 'sm', className: 'mt-4' })}>
          {text.common.open}
        </Link>
      </Card>
    </section>
  );
}
