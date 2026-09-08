import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Plus } from 'lucide-react';
import { ApiError, type GrantableRole, type SpaceInvite, type SpaceMember, type SpaceRole } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '@/components/app-shell';
import { SpaceRail } from '@/components/space-shell';
import { RelativeTime } from '@/components/relative-time';
import { useCurrentUser } from '@/features/auth/use-auth';
import { RoleBadge } from '@/features/spaces/role-badge';
import { useSpace } from '@/features/spaces/use-spaces';
import { useSpaceRole } from '@/features/spaces/use-space-role';
import {
  useInvite,
  useLeaveSpace,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
  useRotateInvite,
  useSetRole,
  useTransferOwnership,
} from '@/features/members/use-members';
import { useUi } from '@/lib/locale';

/**
 * Copies to the clipboard where the browser allows it; the link is also shown
 * as text, so a refused clipboard still leaves it selectable.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: GrantableRole;
  onChange: (role: GrantableRole) => void;
  disabled?: boolean;
}) {
  const { text } = useUi();
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as GrantableRole)}
      className="h-9 rounded-md border border-outline-variant bg-surface-container-lowest px-2 text-sm text-on-surface"
    >
      <option value="editor">{text.members.editor}</option>
      <option value="viewer">{text.members.viewer}</option>
    </select>
  );
}

/** Invite by email: the link comes back once (design "Invites are email-bound links"). */
function InviteDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { text } = useUi();
  const invite = useInvite(spaceId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantableRole>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const error = invite.error instanceof ApiError ? invite.error : null;

  return (
    <Dialog
      open
      title={link ? text.members.inviteLink : text.members.inviteSomeone}
      description={
        link
          ? text.members.sendLinkDescription
          : text.members.emailBoundDescription
      }
      onClose={onClose}
    >
      {link ? (
        <div className="mt-4 space-y-3">
          <p className="rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs break-all text-on-surface select-all">
            {link}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                setCopied(await copyText(link));
              }}
            >
              <Copy className="size-4" aria-hidden="true" />
              {text.members.copy}
            </Button>
            <span role="status" aria-live="polite" className="text-xs text-on-surface-variant">
              {copied === true ? text.members.copied : copied === false ? text.members.copy : ''}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant">
            {text.members.linkShownOnce}
          </p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              {text.common.save}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate(
              { email: email.trim(), role },
              { onSuccess: ({ url }) => setLink(url) },
            );
          }}
        >
          <Field label={text.common.email} error={error?.fields.email} type="email" autoComplete="off" required>
            <Input value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <div>
            <label htmlFor="invite-role" className="block text-sm font-medium text-on-surface">
              {text.common.role}
            </label>
            <div className="mt-1 flex items-center gap-3">
              <RoleSelect id="invite-role" value={role} onChange={setRole} />
              <span className="text-xs text-on-surface-variant">{role === 'editor' ? text.members.editorHelp : text.members.viewerHelp}</span>
            </div>
          </div>
          {error && !error.fields.email ? <Alert>{error.message}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {text.common.cancel}
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? text.authExtra.joining : text.members.createInvite}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  error: ApiError | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { text } = useUi();
  return (
    <Dialog open title={title} description={description} onClose={onClose}>
      {error ? <Alert className="mt-4">{error.message}</Alert> : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {text.common.cancel}
        </Button>
        <Button disabled={pending} onClick={onConfirm}>
          {pending ? text.common.saving : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

function MemberRow({
  spaceId,
  member,
  isOwner,
  isMe,
  onRemove,
  onTransfer,
}: {
  spaceId: string;
  member: SpaceMember;
  isOwner: boolean;
  isMe: boolean;
  onRemove: () => void;
  onTransfer: () => void;
}) {
  const { text } = useUi();
  const setRole = useSetRole(spaceId);
  const error = setRole.error instanceof ApiError ? setRole.error : null;
  const manageable = isOwner && member.role !== 'owner';
  const selectId = `role-${member.userId}`;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-on-surface">
          {member.name}
          {isMe ? <span className="text-on-surface-variant"> ({text.common.you})</span> : null}
        </p>
        <p className="truncate font-mono text-xs text-outline">
          {member.email} · {text.members.joined} <RelativeTime iso={member.joinedAt} />
        </p>
        {error ? <p className="mt-1 text-xs text-error">{error.message}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {manageable ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              {text.members.roleFor.replace('{name}', member.name)}
            </label>
            <RoleSelect
              id={selectId}
              value={member.role as GrantableRole}
              disabled={setRole.isPending}
              onChange={(role) => setRole.mutate({ userId: member.userId, role })}
            />
            {member.role === 'editor' ? (
              <Button size="sm" variant="ghost" onClick={onTransfer}>
                {text.members.makeOwner}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onRemove} aria-label={text.members.remove.replace('{name}', member.name)}>
              {text.members.removeLabel}
            </Button>
          </>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </div>
    </li>
  );
}

function InviteRow({ spaceId, invite }: { spaceId: string; invite: SpaceInvite }) {
  const { text } = useUi();
  const rotate = useRotateInvite(spaceId);
  const revoke = useRevokeInvite(spaceId);
  const [status, setStatus] = useState<string>('');
  const error = (rotate.error ?? revoke.error) instanceof ApiError ? ((rotate.error ?? revoke.error) as ApiError) : null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-on-surface">{invite.email}</p>
        <p className="font-mono text-xs text-outline">
          <RoleBadge role={invite.role} /> · {text.members.expires} <RelativeTime iso={invite.expiresAt} />
        </p>
        {error ? <p className="mt-1 text-xs text-error">{error.message}</p> : null}
        {status ? (
          <p role="status" aria-live="polite" className="mt-1 text-xs text-on-surface-variant">
            {status}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={rotate.isPending}
          onClick={() =>
            rotate.mutate(invite.id, {
              onSuccess: async ({ url }) => {
                const copied = await copyText(url);
                setStatus(copied ? 'A new link was copied. The previous link no longer works.' : `New link (the previous one no longer works): ${url}`);
              },
            })
          }
        >
          <Copy className="size-4" aria-hidden="true" />
          {text.members.copyLink}
        </Button>
        <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(invite.id)}>
          {text.members.revoke}
        </Button>
      </div>
    </li>
  );
}

/**
 * `/spaces/:spaceId/members` — the roster, and for the owner the controls:
 * invite, change role, remove, transfer. Any other member sees the list and a
 * way to leave (shared-spaces-v1).
 */
export function MembersPage() {
  const { text } = useUi();
  const { spaceId = '' } = useParams<{ spaceId: string }>();
  const navigate = useNavigate();
  const space = useSpace(spaceId);
  const permissions = useSpaceRole(space.data);
  const { data: me } = useCurrentUser();
  const members = useMembers(spaceId);
  const remove = useRemoveMember(spaceId);
  const transfer = useTransferOwnership(spaceId);
  const leave = useLeaveSpace(spaceId);

  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: 'remove'; member: SpaceMember }
    | { kind: 'transfer'; member: SpaceMember }
    | { kind: 'leave' }
    | null
  >(null);

  const asError = (error: unknown) => (error instanceof ApiError ? error : null);
  const roleOf = (role: SpaceRole | undefined) => role ?? 'viewer';

  return (
    <AppShell rail={<SpaceRail spaceId={spaceId} space={space.data} />}>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-on-surface">{text.members.title}</h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              {space.data
                ? permissions.isOwner
                  ? text.members.ownerDescription
                  : text.members.memberDescription.replace('{name}', space.data.ownerName)
                : text.members.generalDescription}
            </p>
          </div>
          {permissions.isOwner ? (
            <Button onClick={() => setInviting(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {text.members.invite}
            </Button>
          ) : space.data ? (
            <Button variant="secondary" onClick={() => setConfirm({ kind: 'leave' })}>
              {text.members.leave}
            </Button>
          ) : null}
        </div>

        {members.isPending || space.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label={text.members.loading}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : members.isError || space.isError ? (
          <Alert>
            {asError(members.error ?? space.error)?.message ?? 'The members could not be loaded.'}
            <Button
              size="sm"
              variant="secondary"
              className="ml-3"
              onClick={() => {
                void members.refetch();
                void space.refetch();
              }}
            >
              {text.common.retry}
            </Button>
          </Alert>
        ) : (
          <>
            <Card>
              <h2 className="text-base font-semibold text-on-surface">
                {text.members.memberCount.replace('{count}', String(members.data.members.length))}
              </h2>
              <ul className="mt-2 divide-y divide-outline-variant">
                {members.data.members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    spaceId={spaceId}
                    member={member}
                    isOwner={permissions.isOwner}
                    isMe={member.userId === me?.id}
                    onRemove={() => setConfirm({ kind: 'remove', member })}
                    onTransfer={() => setConfirm({ kind: 'transfer', member })}
                  />
                ))}
              </ul>
            </Card>

            {permissions.isOwner ? (
              <Card>
                <h2 className="text-base font-semibold text-on-surface">{text.members.pendingInvites}</h2>
                {members.data.invites.length === 0 ? (
                  <p className="mt-2 text-sm text-on-surface-variant">
                    {text.members.noInvites}
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-outline-variant">
                    {members.data.invites.map((invite) => (
                      <InviteRow key={invite.id} spaceId={spaceId} invite={invite} />
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}
          </>
        )}
      </div>

      {inviting ? <InviteDialog spaceId={spaceId} onClose={() => setInviting(false)} /> : null}

      {confirm?.kind === 'remove' ? (
        <ConfirmDialog
          title={text.members.removeQuestion.replace('{name}', confirm.member.name)}
          description="They lose access immediately. Sources and notes they added stay, with their name on them; their conversations with the assistant in this space are deleted."
          confirmLabel={text.members.remove.replace('{name}', '')}
          pending={remove.isPending}
          error={asError(remove.error)}
          onConfirm={() => remove.mutate(confirm.member.userId, { onSuccess: () => setConfirm(null) })}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm?.kind === 'transfer' ? (
        <ConfirmDialog
          title={text.members.transferQuestion.replace('{name}', confirm.member.name)}
          description="They will manage members and be the only one who can archive or delete the space. You stay as an editor."
          confirmLabel={text.members.transfer}
          pending={transfer.isPending}
          error={asError(transfer.error)}
          onConfirm={() => transfer.mutate(confirm.member.userId, { onSuccess: () => setConfirm(null) })}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm?.kind === 'leave' ? (
        <ConfirmDialog
          title={text.members.leaveQuestion}
          description={`You will lose access as ${roleOf(permissions.role)}. Anything you added stays; your conversations with the assistant here are deleted. Rejoining needs a new invite.`}
          confirmLabel={text.members.leaveSpace}
          pending={leave.isPending}
          error={asError(leave.error)}
          onConfirm={() => leave.mutate(undefined, { onSuccess: () => navigate('/', { replace: true }) })}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </AppShell>
  );
}
