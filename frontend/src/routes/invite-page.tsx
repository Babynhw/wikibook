import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '@/components/app-shell';
import { useCurrentUser } from '@/features/auth/use-auth';
import { RoleBadge } from '@/features/spaces/role-badge';
import { useAcceptInvite, useInvitePreview } from '@/features/members/use-members';

/**
 * `/invite/:token` — where an invite link lands (shared-spaces-v1). Signed out,
 * it hands the visitor to sign-in with a way back here; signed in with the
 * invited email, it shows the space and accepts on one click. Every other case
 * — expired, revoked, used, unknown, a different account — is one neutral page,
 * because the server answers all of them with the same 404 on purpose.
 */
export function InvitePage() {
  const { token = '' } = useParams<{ token: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const session = useCurrentUser();
  const preview = useInvitePreview(session.data ? token : '');
  const accept = useAcceptInvite();

  if (session.isPending) {
    return (
      <AppShell>
        <Skeleton className="h-32 w-full max-w-lg" aria-label="Checking your invite" />
      </AppShell>
    );
  }

  if (session.data === null) {
    // The same `from` the login page honours, so accepting resumes here.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const invalid = preview.isError;
  const acceptError = accept.error instanceof ApiError ? accept.error : null;

  return (
    <AppShell>
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">Space invite</h1>

        {preview.isPending ? (
          <Skeleton className="mt-4 h-32 w-full" aria-label="Loading the invite" />
        ) : invalid || acceptError?.status === 404 ? (
          <Card className="mt-4">
            <h2 className="text-lg font-semibold text-on-surface">This invite link isn’t valid</h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              It may have expired, been used already, or been sent to a different email address than
              the one you are signed in with ({session.data?.email}). Ask the person who invited you
              for a new link.
            </p>
            <Link to="/" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'mt-4' })}>
              Back to your spaces
            </Link>
          </Card>
        ) : (
          <Card className="mt-4">
            <p className="text-sm text-on-surface-variant">
              {preview.data.inviterName} invited you to join
            </p>
            <h2 className="mt-1 text-lg font-semibold text-on-surface">{preview.data.spaceName}</h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-on-surface-variant">
              as <RoleBadge role={preview.data.role} />
              {preview.data.role === 'viewer'
                ? '— read everything, export, and ask the assistant.'
                : '— add sources, write notes, and edit the notebook.'}
            </p>
            {preview.data.alreadyMember ? (
              <Alert variant="info" className="mt-4">
                You are already a member of this space.
              </Alert>
            ) : null}
            {acceptError && acceptError.status !== 404 ? <Alert className="mt-4">{acceptError.message}</Alert> : null}
            <div className="mt-6 flex gap-2">
              <Button
                disabled={accept.isPending}
                onClick={() =>
                  accept.mutate(token, {
                    onSuccess: ({ spaceId }) => navigate(`/spaces/${spaceId}`, { replace: true }),
                  })
                }
              >
                {accept.isPending ? 'Joining…' : preview.data.alreadyMember ? 'Open the space' : 'Accept and open'}
              </Button>
              <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
                Not now
              </Link>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
