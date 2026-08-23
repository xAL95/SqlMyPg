import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelationAcl, SchemaAcl } from '@shared/protocol';
import { applyPrivilege, getPrivileges, getRoles, queryKeys } from '@/lib/api';
import { alterDefaultPrivileges, asTransaction, grant, revoke } from '@/lib/acl';
import { cn } from '@/lib/format';
import { Button, Dialog, ErrorBanner, Select, Spinner, toast } from '@/components/ui';

const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const SCHEMA_PRIVS = ['USAGE', 'CREATE'] as const;

/** Column heads have to fit a matrix, so each privilege gets the shortest unambiguous label. */
const SHORT: Record<string, string> = {
  SELECT: 'SEL',
  INSERT: 'INS',
  UPDATE: 'UPD',
  DELETE: 'DEL',
  TRUNCATE: 'TRN',
  REFERENCES: 'REF',
  TRIGGER: 'TRG',
  USAGE: 'USE',
  CREATE: 'CRT',
};

/**
 * Who holds what on one object, as a matrix of roles against privileges.
 *
 * The distinction the whole dialog exists for: a filled cell is a privilege granted *to this role
 * on this object*; a hollow one is a privilege the role can still exercise, through membership or
 * ownership. Only the first kind can be revoked here - taking away an inherited privilege means
 * changing the membership, which lives in the Roles dialog, so those cells say so instead of
 * offering a control that would not work.
 *
 * One cell acts immediately. Anything that spans a whole schema is written into a query tab, because
 * "every table in this schema" deserves to be read before it runs.
 */
export default function PrivilegesDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  name,
  onEmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema: string;
  /** omit for the schema itself */
  name?: string;
  onEmit: (sql: string) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [pick, setPick] = useState('');

  const onRelation = name !== undefined;
  const privs = onRelation ? TABLE_PRIVS : SCHEMA_PRIVS;
  const args = { connectionId, schema, ...(onRelation ? { name } : {}) };

  const acl = useQuery({
    queryKey: [...queryKeys.relation({ connectionId, schema, name: name ?? '' }), 'acl'] as const,
    queryFn: () => getPrivileges(args),
    enabled: open,
  });
  // The schema's own USAGE gates every table privilege under it; without it a full GRANT still
  // reads as permission denied, which is the single most common false trail.
  const schemaAcl = useQuery({
    queryKey: [...queryKeys.relation({ connectionId, schema, name: '' }), 'schema-acl'] as const,
    queryFn: () => getPrivileges({ connectionId, schema }),
    enabled: open && onRelation,
  });
  const roles = useQuery({ queryKey: queryKeys.roles(connectionId), queryFn: () => getRoles({ connectionId }), enabled: open });

  const apply = useMutation({
    mutationFn: (v: { action: 'grant' | 'revoke'; privileges: string[]; roles: string[] }) =>
      applyPrivilege({ ...args, ...v }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: queryKeys.relation({ connectionId, schema, name: name ?? '' }) });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  // Superuser and ownership are the two ways every box is filled without a single grant; naming
  // them is the difference between a legible matrix and a row of dead controls.
  const superusers = new Set((roles.data ?? []).filter((r) => r.superuser).map((r) => r.name));
  const data = acl.data as RelationAcl | SchemaAcl | undefined;
  const owner = data?.owner;

  // Roles with nothing at all are absent from the ACL, which is exactly the case that needs a
  // grant - so they can be added to the matrix by hand.
  const rows = useMemo(() => {
    const present = data?.roles ?? [];
    const seen = new Set(present.map((r) => r.role));
    const added = extra
      .filter((r) => !seen.has(r))
      .map((r) => ({ role: r, direct: [] as string[], effective: [] as string[], isOwner: false }));
    return [...present, ...added];
  }, [data, extra]);

  const addable = (roles.data ?? [])
    .map((r) => r.name)
    .concat('PUBLIC')
    .filter((n) => !rows.some((r) => r.role === n));

  const target = onRelation
    ? ({ kind: 'table', schema, name: name as string } as const)
    : ({ kind: 'schema', schema } as const);

  const missingUsage =
    onRelation && schemaAcl.data
      ? rows
          .filter((r) => r.effective.length > 0 && !r.isOwner)
          .filter((r) => {
            const s = (schemaAcl.data as SchemaAcl).roles.find((x) => x.role === r.role);
            return !s || !s.effective.includes('USAGE');
          })
          .map((r) => r.role)
      : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setExtra([]);
        }
        onOpenChange(next);
      }}
      title={onRelation ? `Privileges on ${schema}.${name}` : `Privileges on schema ${schema}`}
      description="A filled cell is granted directly here and can be revoked. A hollow one is inherited through membership or ownership."
      width={820}
      footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

        {acl.isPending ? (
          <Spinner />
        ) : acl.error ? (
          <ErrorBanner error={acl.error} onRetry={() => void acl.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-4">
              <span className="annot">
                <span className="k">Owner</span>
                <span className="v text-ident">{owner}</span>
              </span>
              {onRelation ? (
                <span className="annot">
                  <span className="k">Kind</span>
                  <span className="v">{(data as RelationAcl).kind}</span>
                </span>
              ) : null}
            </div>

            {/* One grid for head and rows: separate containers compute their own auto tracks and
                the labels drift off their columns. */}
            <div
              className="grid items-center gap-x-2"
              style={{ gridTemplateColumns: `minmax(9rem,1fr) repeat(${privs.length}, 2.5rem) auto` }}
            >
              <span className="placard rule-b pb-1.5">Role</span>
              {privs.map((p) => (
                <span key={p} className="placard rule-b pb-1 text-center" title={p}>
                  {SHORT[p] ?? p}
                </span>
              ))}
              <span className="rule-b pb-1" />

              {rows.map((r) => (
                <Fragment key={r.role}>
                  <span className="truncate rule-b py-1">
                    {r.role === 'PUBLIC' ? <span className="text-warn">PUBLIC</span> : r.role}
                    {r.isOwner ? (
                      <span className="pl-1.5 text-xs text-faint" title="owns the object, so holds everything on it">
                        owner
                      </span>
                    ) : superusers.has(r.role) ? (
                      <span className="pl-1.5 text-xs text-faint" title="a superuser bypasses every privilege check">
                        superuser
                      </span>
                    ) : r.direct.length === 0 && r.effective.length > 0 ? (
                      <span className="pl-1.5 text-xs text-faint" title="held through membership in another role">
                        inherited
                      </span>
                    ) : null}
                    {r.direct.filter((p) => !(privs as readonly string[]).includes(p)).length > 0 ? (
                      <span
                        className="pl-1.5 text-xs text-warn"
                        title="granted on this object but outside the portable column set, so it is shown rather than hidden"
                      >
                        +{r.direct.filter((p) => !(privs as readonly string[]).includes(p)).join(' +')}
                      </span>
                    ) : null}
                  </span>
                  {privs.map((p) => {
                    const direct = r.direct.includes(p);
                    const inherited = !direct && r.effective.includes(p);
                    return (
                      <span key={p} className="grid place-items-center rule-b py-1">
                        <button
                          type="button"
                          aria-label={`${p} for ${r.role}`}
                          aria-pressed={direct}
                          disabled={inherited || apply.isPending}
                          title={
                            inherited
                              ? r.isOwner
                                ? 'held by owning the object; change the owner to alter it'
                                : 'inherited through role membership; change it in the Roles dialog'
                              : direct
                                ? `REVOKE ${p}`
                                : `GRANT ${p}`
                          }
                          onClick={() =>
                            apply.mutate({ action: direct ? 'revoke' : 'grant', privileges: [p], roles: [r.role] })
                          }
                          className={cn(
                            'size-4 rounded-xs border',
                            direct
                              ? 'border-accent bg-accent'
                              : inherited
                                ? 'border-line-strong bg-transparent screened'
                                : 'border-line-strong bg-transparent hover:border-accent',
                          )}
                        />
                      </span>
                    );
                  })}
                  {/* The bulk gesture: the same privileges across every table in the schema, as a
                      script rather than a burst of single requests. */}
                  <span className="rule-b py-1 pl-1">
                    {onRelation ? (
                      <Button
                        size="sm"
                        title={`Write a GRANT for every table in ${schema}, plus future ones, into the editor`}
                        onClick={() => {
                          onEmit(
                            asTransaction([
                              grant(['USAGE'], { kind: 'schema', schema }, [r.role]),
                              grant([...TABLE_PRIVS], { kind: 'allTables', schema }, [r.role]),
                              alterDefaultPrivileges(owner ?? r.role, schema, 'TABLES', [...TABLE_PRIVS], [r.role]),
                            ]),
                          );
                          onOpenChange(false);
                          toast('Script written to the editor');
                        }}
                      >
                        whole schema…
                      </Button>
                    ) : null}
                  </span>
                </Fragment>
              ))}
            </div>

            {missingUsage.length > 0 ? (
              <p className="rule-l pl-2 text-sm text-warn">
                {missingUsage.join(', ')} {missingUsage.length === 1 ? 'holds' : 'hold'} privileges on this table but
                not <span className="text-fg">USAGE</span> on schema {schema}, so reading it still fails. The
                whole-schema script grants that first.
              </p>
            ) : null}

            <div className="flex items-end gap-2 rule-t pt-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="placard">Add a role to the matrix</span>
                <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">
                    {addable.length ? 'pick a role…' : 'every role is already listed'}
                  </option>
                  {addable.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                disabled={pick === ''}
                onClick={() => {
                  setExtra((p) => [...p, pick]);
                  setPick('');
                }}
              >
                Add
              </Button>
              <Button
                title="Write the current matrix as GRANT statements into the editor"
                onClick={() => {
                  const out = rows.flatMap((r) =>
                    r.direct.length ? [grant(r.direct, target, [r.role])] : [],
                  );
                  onEmit(out.length ? asTransaction(out) : '-- no direct grants on this object');
                  onOpenChange(false);
                }}
              >
                Export as SQL
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
