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
import { useUi } from '@/lib/locale';

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
  const { text } = useUi();

  if (session.isPending) {
    return (
      <AppShell>
        <Skeleton className="h-32 w-full max-w-lg" aria-label={text.authExtra.checkingInvite} />
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
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">{text.authExtra.invite}</h1>

        {preview.isPending ? (
          <Skeleton className="mt-4 h-32 w-full" aria-label={text.authExtra.loadingInvite} />
        ) : invalid || acceptError?.status === 404 ? (
          <Card className="mt-4">
            <h2 className="text-lg font-semibold text-on-surface">{text.authExtra.invalidInvite}</h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              {text.authExtra.invalidInviteDescription.replace('{email}', session.data?.email ?? '')}
            </p>
            <Link to="/" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'mt-4' })}>
              {text.authExtra.backToSpaces}
            </Link>
          </Card>
        ) : (
          <Card className="mt-4">
            <p className="text-sm text-on-surface-variant">
              {text.authExtra.invitedToJoin.replace('{name}', preview.data.inviterName)}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-on-surface">{preview.data.spaceName}</h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-on-surface-variant">
              {text.authExtra.as} <RoleBadge role={preview.data.role} />
              {preview.data.role === 'viewer'
                ? text.authExtra.viewerInvite
                : text.authExtra.editorInvite}
            </p>
            {preview.data.alreadyMember ? (
              <Alert variant="info" className="mt-4">
                {text.authExtra.alreadyMember}
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
                {accept.isPending ? text.authExtra.joining : preview.data.alreadyMember ? text.authExtra.openSpace : text.authExtra.acceptOpen}
              </Button>
              <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
                {text.authExtra.notNow}
              </Link>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
