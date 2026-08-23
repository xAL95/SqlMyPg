import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RoleAttributes } from '@shared/protocol';
import { getRoles, queryKeys } from '@/lib/api';
import { alterRole, asTransaction, createRole, dropRole, grantRole, revokeRole, type RoleAttrs } from '@/lib/acl';
import { cn } from '@/lib/format';
import { Button, Checkbox, Dialog, ErrorBanner, Field, Input, Select, Spinner, toast } from '@/components/ui';

/** The attribute matrix: the flags Postgres prints in \du, shortest labels that stay unambiguous. */
const FLAGS = [
  ['canLogin', 'login', 'LOGIN'],
  ['superuser', 'super', 'SUPERUSER'],
  ['createdb', 'cdb', 'CREATEDB'],
  ['createrole', 'crol', 'CREATEROLE'],
  ['inherit', 'inh', 'INHERIT'],
  ['replication', 'repl', 'REPLICATION'],
  ['bypassrls', 'rls', 'BYPASSRLS'],
] as const;

/** Maps a matrix cell back onto the attribute name lib/acl expects. */
const ATTR: Record<string, keyof RoleAttrs> = {
  canLogin: 'login',
  superuser: 'superuser',
  createdb: 'createdb',
  createrole: 'createrole',
  inherit: 'inherit',
  replication: 'replication',
  bypassrls: 'bypassrls',
};

/**
 * Cluster roles: attributes, memberships and lifecycle.
 *
 * Nothing here executes. A role is cluster-wide - it outlives the database you are connected to and
 * can hold privileges everywhere on the server - so every change is written into a query tab and
 * runs in your own session, where you read it first. That is the same rule CREATE TABLE and ALTER
 * follow; only privilege toggles on a single object act immediately.
 *
 * Passwords appear in the generated statement because Postgres has no other way to set one. The
 * server redacts them out of query history before storing it.
 */
export default function RolesDialog({
  open,
  onOpenChange,
  connectionId,
  onEmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  onEmit: (sql: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newLogin, setNewLogin] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [newInherit, setNewInherit] = useState(true);
  const [member, setMember] = useState('');
  const [ofRole, setOfRole] = useState('');

  const roles = useQuery({ queryKey: queryKeys.roles(connectionId), queryFn: () => getRoles({ connectionId }), enabled: open });
  const rows = roles.data ?? [];

  const emit = (sql: string, note: string) => {
    onEmit(sql);
    onOpenChange(false);
    toast(note);
  };

  const toggle = (r: RoleAttributes, key: keyof typeof ATTR, next: boolean) => {
    const stmt = alterRole(r.name, { [ATTR[key] as string]: next } as RoleAttrs);
    if (stmt) emit(stmt, 'ALTER ROLE written to the editor');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Database roles"
      description="Cluster-wide, so nothing here runs on its own. Every change is written into a query tab for you to read and run."
      width={860}
      footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        {roles.isPending ? (
          <Spinner />
        ) : roles.error ? (
          <ErrorBanner error={roles.error} onRetry={() => void roles.refetch()} />
        ) : (
          <>
            <div
              className="grid items-center gap-x-2"
              style={{ gridTemplateColumns: `minmax(8rem,1fr) repeat(${FLAGS.length}, 2.5rem) 4rem minmax(7rem,auto) auto` }}
            >
              <span className="placard rule-b pb-1.5">Role</span>
              {FLAGS.map(([key, short, full]) => (
                <span key={key} className="placard rule-b pb-1 text-center" title={full}>
                  {short}
                </span>
              ))}
              <span className="placard rule-b pb-1 text-center" title="a password is set">
                pw
              </span>
              <span className="placard rule-b pb-1.5">Member of</span>
              <span className="rule-b pb-1" />

              {rows.map((r) => (
                <Fragment key={r.name}>
                  <span className="truncate rule-b py-1">{r.name}</span>
                  {FLAGS.map(([key]) => {
                    const on = r[key] as boolean;
                    return (
                      <span key={key} className="grid place-items-center rule-b py-1">
                        <button
                          type="button"
                          aria-label={`${key} for ${r.name}`}
                          aria-pressed={on}
                          title={`${on ? 'Remove' : 'Add'}: writes an ALTER ROLE into the editor`}
                          onClick={() => toggle(r, key, !on)}
                          className={cn(
                            'size-4 rounded-xs border',
                            on ? 'border-accent bg-accent' : 'border-line-strong hover:border-accent',
                          )}
                        />
                      </span>
                    );
                  })}
                  <span className="grid place-items-center rule-b py-1 text-xs">
                    {r.hasPassword ? <span className="text-ok">set</span> : <span className="text-faint">—</span>}
                  </span>
                  <span className="truncate rule-b py-1 text-xs text-muted" title={r.memberOf.join(', ')}>
                    {r.memberOf.length ? r.memberOf.join(', ') : <span className="text-faint">—</span>}
                  </span>
                  <span className="flex items-center gap-1 rule-b py-1 pl-1">
                    <Button
                      size="sm"
                      title="Write an ALTER ROLE … PASSWORD into the editor"
                      onClick={() =>
                        emit(
                          alterRole(r.name, { password: 'CHANGE-ME' }) ?? '',
                          'Replace CHANGE-ME in the editor before running',
                        )
                      }
                    >
                      Password
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      title="Write a DROP ROLE into the editor"
                      onClick={() => emit(dropRole(r.name), 'DROP ROLE written to the editor')}
                    >
                      Drop
                    </Button>
                  </span>
                </Fragment>
              ))}
            </div>

            {/* Membership is the mechanism that fixed the cross-database case: a role inherits every
                privilege of a role it belongs to, existing and future objects alike. */}
            <div className="flex items-end gap-2 rule-t pt-3">
              <Field label="Grant role" className="flex-1">
                <Select value={ofRole} onChange={(e) => setOfRole(e.target.value)}>
                  <option value="">pick a role…</option>
                  {rows.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" className="flex-1">
                <Select value={member} onChange={(e) => setMember(e.target.value)}>
                  <option value="">pick a member…</option>
                  {rows.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                disabled={ofRole === '' || member === '' || ofRole === member}
                onClick={() => emit(grantRole(ofRole, member), 'GRANT written to the editor')}
              >
                Grant
              </Button>
              <Button
                disabled={ofRole === '' || member === '' || ofRole === member}
                onClick={() => emit(revokeRole(ofRole, member), 'REVOKE written to the editor')}
              >
                Revoke
              </Button>
            </div>

            <form
              className="flex items-end gap-2 rule-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                const attrs: RoleAttrs = { login: newLogin, inherit: newInherit };
                if (newPassword) attrs.password = newPassword;
                emit(
                  asTransaction([createRole(newName.trim(), attrs)]),
                  'CREATE ROLE written to the editor. Read it before running.',
                );
                setNewName('');
                setNewPassword('');
              }}
            >
              <Field label="New role" htmlFor="r-name" className="flex-1">
                <Input id="r-name" required value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Password" htmlFor="r-pw" className="w-48">
                <Input
                  id="r-pw"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-muted">
                <Checkbox checked={newLogin} onChange={(e) => setNewLogin(e.target.checked)} />
                Login
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-muted">
                <Checkbox checked={newInherit} onChange={(e) => setNewInherit(e.target.checked)} />
                Inherit
              </label>
              <Button type="submit" variant="primary" className="mb-px" disabled={newName.trim() === ''}>
                Build CREATE
              </Button>
            </form>
          </>
        )}
      </div>
    </Dialog>
  );
}
