import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentUser } from '@shared/protocol';
import { createUser, deleteUser, listUsers, queryKeys, updateUser } from '@/lib/api';
import { Button, Checkbox, Dialog, ErrorBanner, Field, Input, Spinner, toast } from '@/components/ui';

/**
 * Admin user management.
 *
 * The server side has existed all along - list, create, patch and delete, all behind requireAdmin -
 * and nothing in the UI called any of it; the account menu pointed at a `/users` route that does
 * not exist in an app with no router. This is a dialog for the same reason every other
 * configuration surface here is: it belongs beside the work, not at a URL.
 *
 * The server owns the rules and states them plainly, so they are surfaced rather than duplicated:
 * the last admin cannot be demoted or deleted, and nobody can delete themselves.
 */
export default function UsersDialog({
  open,
  onOpenChange,
  me,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: CurrentUser;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const users = useQuery({ queryKey: queryKeys.users, queryFn: listUsers, enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.users });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const add = useMutation({
    mutationFn: () =>
      createUser({ email: email.trim(), password, name: name.trim() || undefined, isAdmin }),
    onSuccess: (u) => {
      toast(`Created ${u.email}`);
      setEmail('');
      setName('');
      setPassword('');
      setIsAdmin(false);
      setError(null);
      void refresh();
    },
    onError: fail,
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; body: { isAdmin?: boolean; password?: string } }) =>
      updateUser(v.id, v.body),
    onSuccess: () => {
      setError(null);
      setResetting(null);
      setNewPassword('');
      void refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: fail,
  });

  const rows = users.data ?? [];
  const admins = rows.filter((u) => u.isAdmin).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title="Users"
      description="Accounts on this server. Password sign-in only; an OIDC account is created on first sign-in."
      width={760}
      footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

        {users.isPending ? (
          <Spinner />
        ) : users.error ? (
          <ErrorBanner error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <div className="grid grid-cols-[1fr_10rem_4rem_4rem_auto] items-center gap-x-3">
            <span className="placard rule-b pb-1.5">Email</span>
            <span className="placard rule-b pb-1.5">Name</span>
            <span className="placard rule-b pb-1.5 text-center">Admin</span>
            <span className="placard rule-b pb-1.5">Auth</span>
            <span className="rule-b pb-1" />
            {rows.map((u) => {
              const self = u.id === me.id;
              // The server refuses these; saying so up front beats a 409 the user has to read.
              const lastAdmin = u.isAdmin && admins === 1;
              return (
                <Fragment key={u.id}>
                  <span className="truncate rule-b py-1">
                    {u.email}
                    {self ? <span className="pl-1.5 text-xs text-faint">you</span> : null}
                  </span>
                  <span className="truncate rule-b py-1 text-muted">
                    {u.name ?? <span className="text-faint">—</span>}
                  </span>
                  <span className="grid place-items-center rule-b py-1">
                    <Checkbox
                      checked={u.isAdmin}
                      disabled={lastAdmin || patch.isPending}
                      title={lastAdmin ? 'The last admin cannot be demoted' : 'Toggle admin'}
                      aria-label={`${u.email} is an admin`}
                      onChange={(e) => patch.mutate({ id: u.id, body: { isAdmin: e.target.checked } })}
                    />
                  </span>
                  <span className="rule-b py-1 text-xs text-faint">{u.provider}</span>
                  <span className="flex items-center gap-1 rule-b py-1">
                    <Button
                      size="sm"
                      onClick={() => {
                        setResetting(resetting === u.id ? null : u.id);
                        setNewPassword('');
                      }}
                      disabled={u.provider === 'oidc'}
                      title={u.provider === 'oidc' ? 'This account signs in through the provider' : undefined}
                    >
                      Password
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={self || lastAdmin || remove.isPending}
                      title={
                        self
                          ? 'You cannot delete yourself'
                          : lastAdmin
                            ? 'The last admin cannot be deleted'
                            : 'Delete this account'
                      }
                      onClick={() => {
                        if (window.confirm(`Delete ${u.email}? Their saved connections and history go with them.`)) {
                          remove.mutate(u.id);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </span>

                  {resetting === u.id ? (
                    <div className="col-span-5 flex items-end gap-2 pt-1 pb-2">
                      <Field label={`new password for ${u.email}`} htmlFor="u-pw" className="flex-1">
                        <Input
                          id="u-pw"
                          type="password"
                          autoFocus
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                      </Field>
                      <Button
                        variant="primary"
                        disabled={newPassword === '' || patch.isPending}
                        onClick={() => patch.mutate({ id: u.id, body: { password: newPassword } })}
                      >
                        Set
                      </Button>
                      <Button onClick={() => setResetting(null)}>Cancel</Button>
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        )}

        <form
          className="flex flex-col gap-2 rule-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <span className="placard">Add an account</span>
          <div className="flex items-end gap-2">
            <Field label="Email" htmlFor="u-new-email" className="flex-1">
              <Input
                id="u-new-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Name" htmlFor="u-new-name" className="w-40">
              <Input id="u-new-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Password" htmlFor="u-new-pw" className="w-44">
              <Input
                id="u-new-pw"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <label className="flex items-center gap-1.5 pb-1 text-sm text-muted">
              <Checkbox checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
              admin
            </label>
            <Button type="submit" variant="primary" className="mb-px" loading={add.isPending}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
