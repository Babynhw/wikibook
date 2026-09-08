import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from './use-auth';
import { useUi } from '@/lib/locale';

/**
 * Route guard for the authenticated shell.
 *
 * Three outcomes, deliberately kept apart: while the session is being hydrated
 * nothing is rendered — redirecting first would bounce a signed-in user who
 * simply refreshed the page. A *failed* `/auth/me` is not a signed-out user
 * either: `useCurrentUser` resolves a 401 to `null` precisely so a network
 * failure or a 500 stays an error here instead of silently logging someone out.
 */
export function RequireAuth() {
  const location = useLocation();
  const { text } = useUi();
  const { data: user, isPending, isError, error, refetch, isFetching } = useCurrentUser();

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-on-surface-variant">
        <p role="status">{text.authExtra.sessionLoading}</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-md text-center">
          <Alert>
            {error instanceof ApiError
              ? error.message
              : text.authExtra.sessionFailed}
          </Alert>
          <Button className="mt-4" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? text.common.retrying : text.common.tryAgain}
          </Button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: locationHref(location) }} />;
  }

  return <Outlet />;
}

/** The whole target, so a deep link survives the trip through /login. */
function locationHref({
  pathname,
  search,
  hash,
}: {
  pathname: string;
  search: string;
  hash: string;
}) {
  return `${pathname}${search}${hash}`;
}
