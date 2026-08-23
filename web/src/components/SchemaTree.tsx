import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelKind, RelationDetail, RelationInfo, SchemaInfo } from '@shared/protocol';
import { dropTable, getRelation, getRelations, getRoutines, getSchemas, queryKeys, truncateTable } from '@/lib/api';
import {
  ChevronDown,
  ChevronRight,
  DatabaseZap,
  ExternalLink,
  Eye,
  KeyRound,
  Parentheses,
  Rows3,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { bytes, cn, rowsEstimate } from '@/lib/format';
import { Button, Checkbox, ContextMenu, Dialog, EmptyState, ErrorBanner, Input, Spinner, toast } from '@/components/ui';
import AlterTableDialog from '@/components/AlterTableDialog';
import PrivilegesDialog from '@/components/PrivilegesDialog';
import NewTableDialog from '@/components/NewTableDialog';

/** Always quote: a table called "order" or "Users" is legal and unquoted output would break. */
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

const RELATION_CAP = 500;

const GROUPS = [
  { key: 'tables', label: 'Tables', kinds: ['table', 'partitioned'] as RelKind[] },
  { key: 'views', label: 'Views', kinds: ['view'] as RelKind[] },
  { key: 'matviews', label: 'Materialized views', kinds: ['matview'] as RelKind[] },
  { key: 'foreign', label: 'Foreign tables', kinds: ['foreign'] as RelKind[] },
] as const;

/** Drawn marks, not letters: a relation kind is an icon like every other affordance here. */
const GLYPH: Record<RelKind, LucideIcon> = {
  table: Table2,
  partitioned: Rows3,
  view: Eye,
  matview: DatabaseZap,
  foreign: ExternalLink,
};

function selectStatement(detail: RelationDetail): string {
  // ponytail: first 100 columns only, so a 900-column table gets a partial SELECT; widen the
  // slice or emit `*` if anyone actually browses tables that wide.
  const cols = detail.columns.slice(0, 100).map((c) => q(c.name));
  return `SELECT ${cols.join(', ')}\nFROM ${q(detail.relation.schema)}.${q(detail.relation.name)}\nLIMIT 100;`;
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-accent text-accent-fg">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function TreeRow({
  id,
  level,
  expandable,
  expanded,
  onActivate,
  onOpen,
  className,
  children,
  title,
}: {
  id: string;
  level: number;
  expandable: boolean;
  expanded?: boolean;
  onActivate: () => void;
  /** double-click: open the thing rather than just expand it */
  onOpen?: () => void;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div
      role="treeitem"
      tabIndex={-1}
      data-node-id={id}
      data-level={level}
      data-expandable={expandable ? '1' : '0'}
      aria-level={level}
      aria-expanded={expandable ? !!expanded : undefined}
      title={title}
      onClick={onActivate}
      onDoubleClick={onOpen}
      className={cn(
        'flex cursor-default items-center gap-1.5 py-1.5 pr-2 text-[13px] hover:bg-hover',
        className,
      )}
      style={{ paddingLeft: 6 + level * 14 }}
    >
      <span className="grid w-4 shrink-0 place-items-center text-muted" aria-hidden>
        {expandable ? (
          expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )
        ) : null}
      </span>
      {children}
    </div>
  );
}

export default function SchemaTree({
  connectionId,
  onOpenRelation,
  onInsertText,
}: {
  connectionId: string;
  onOpenRelation: (schema: string, name: string) => void;
  onInsertText: (text: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = useCallback((id: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = force ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const schemasQ = useQuery({
    queryKey: queryKeys.schemas({ connectionId }),
    queryFn: () => getSchemas({ connectionId }),
  });

  // Keyboard nav reads the rendered rows straight out of the DOM: document order is already
  // correct there, so no parallel flat model of the tree has to be maintained.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    if (!rows.length) return;
    const active = document.activeElement as HTMLElement | null;
    const i = active ? rows.indexOf(active) : -1;
    const cur = i >= 0 ? rows[i] : undefined;
    const focus = (n: number) => rows[Math.max(0, Math.min(rows.length - 1, n))]?.focus();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(i < 0 ? 0 : i - 1);
        break;
      case 'ArrowRight': {
        if (!cur) return;
        e.preventDefault();
        const id = cur.dataset.nodeId;
        if (cur.dataset.expandable === '1' && cur.getAttribute('aria-expanded') === 'false' && id) toggle(id, true);
        else focus(i + 1);
        break;
      }
      case 'ArrowLeft': {
        if (!cur) return;
        e.preventDefault();
        const id = cur.dataset.nodeId;
        if (cur.getAttribute('aria-expanded') === 'true' && id) {
          toggle(id, false);
          break;
        }
        const level = Number(cur.dataset.level ?? '1');
        for (let j = i - 1; j >= 0; j--) {
          if (Number(rows[j]?.dataset.level ?? '1') < level) {
            rows[j]?.focus();
            break;
          }
        }
        break;
      }
      case 'Enter':
        if (!cur) return;
        e.preventDefault();
        cur.click();
        break;
      default:
        break;
    }
  };

  const all = schemasQ.data ?? [];
  const user = all.filter((s) => !s.isSystem);
  const system = all.filter((s) => s.isSystem);
  const needle = filter.trim();
  const visible = (s: SchemaInfo) =>
    !needle || s.name.toLowerCase().includes(needle.toLowerCase()) || expanded.has(`s:${s.name}`);

  const shared = { connectionId, expanded, toggle, needle, onOpenRelation, onInsertText };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-1.5">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter loaded objects…"
          aria-label="Filter schema tree"
        />
      </div>
      {schemasQ.error ? <ErrorBanner message={message(schemasQ.error)} /> : null}
      <div
        ref={rootRef}
        role="tree"
        aria-label="Database objects"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto pb-4 select-none"
      >
        {schemasQ.isPending ? (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted">
            <Spinner /> loading schemas…
          </div>
        ) : null}
        {user.filter(visible).map((s) => (
          <SchemaNode key={s.name} schema={s.name} level={1} {...shared} />
        ))}
        {system.length ? (
          <>
            <TreeRow
              id="sys"
              level={1}
              expandable
              expanded={expanded.has('sys')}
              onActivate={() => toggle('sys')}
              title="Catalog and extension schemas"
            >
              <span className="text-muted">System</span>
              <span className="text-[11px] text-faint">({system.length})</span>
            </TreeRow>
            {expanded.has('sys') ? (
              <div role="group">
                {system.filter(visible).map((s) => (
                  <SchemaNode key={s.name} schema={s.name} level={2} {...shared} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {!schemasQ.isPending && !all.length ? <EmptyState title="No schemas" /> : null}
      </div>
    </div>
  );
}

type Shared = {
  connectionId: string;
  expanded: ReadonlySet<string>;
  toggle: (id: string, force?: boolean) => void;
  needle: string;
  onOpenRelation: (schema: string, name: string) => void;
  onInsertText: (text: string) => void;
};

function SchemaNode({ schema, level, ...s }: Shared & { schema: string; level: number }) {
  const id = `s:${schema}`;
  const [newTable, setNewTable] = useState(false);
  const [acl, setAcl] = useState(false);
  const open = s.expanded.has(id);
  const relationsWanted = GROUPS.some((g) => s.expanded.has(`g:${schema}:${g.key}`));
  const routinesWanted = s.expanded.has(`g:${schema}:functions`);

  const relQ = useQuery({
    queryKey: queryKeys.relations({ connectionId: s.connectionId, schema }),
    queryFn: () => getRelations({ connectionId: s.connectionId, schema }),
    enabled: relationsWanted,
  });
  const routQ = useQuery({
    queryKey: queryKeys.routines({ connectionId: s.connectionId, schema }),
    queryFn: () => getRoutines({ connectionId: s.connectionId, schema }),
    enabled: routinesWanted,
  });

  return (
    <>
      <ContextMenu
        items={[
          { label: 'New table…', onSelect: () => setNewTable(true) },
          { label: 'Privileges…', onSelect: () => setAcl(true) },
        ]}
      >
        <TreeRow id={id} level={level} expandable expanded={open} onActivate={() => s.toggle(id)}>
          <span className="font-medium">
            <Highlight text={schema} needle={s.needle} />
          </span>
        </TreeRow>
      </ContextMenu>
      {newTable ? (
        <NewTableDialog open onOpenChange={setNewTable} schema={schema} onEmit={s.onInsertText} />
      ) : null}
      {acl ? (
        <PrivilegesDialog
          open
          onOpenChange={setAcl}
          connectionId={s.connectionId}
          schema={schema}
          onEmit={s.onInsertText}
        />
      ) : null}
      {open ? (
        <div role="group">
          {GROUPS.map((g) => {
            const gid = `g:${schema}:${g.key}`;
            const gopen = s.expanded.has(gid);
            const items = (relQ.data ?? []).filter((r) => g.kinds.includes(r.kind));
            return (
              <div key={g.key}>
                <TreeRow id={gid} level={level + 1} expandable expanded={gopen} onActivate={() => s.toggle(gid)}>
                  <span className="text-muted">{g.label}</span>
                  {gopen && relQ.data ? <span className="text-[11px] text-faint">({items.length})</span> : null}
                  {gopen && relQ.isFetching ? <Spinner /> : null}
                </TreeRow>
                {gopen ? (
                  <div role="group">
                    {relQ.error ? <ErrorBanner message={message(relQ.error)} /> : null}
                    <RelationList items={items} level={level + 2} schema={schema} {...s} />
                  </div>
                ) : null}
              </div>
            );
          })}
          <TreeRow
            id={`g:${schema}:functions`}
            level={level + 1}
            expandable
            expanded={routinesWanted}
            onActivate={() => s.toggle(`g:${schema}:functions`)}
          >
            <span className="text-muted">Functions</span>
            {routinesWanted && routQ.isFetching ? <Spinner /> : null}
          </TreeRow>
          {routinesWanted ? (
            <div role="group">
              {routQ.error ? <ErrorBanner message={message(routQ.error)} /> : null}
              {(routQ.data ?? [])
                .filter((r) => !s.needle || r.name.toLowerCase().includes(s.needle.toLowerCase()))
                .slice(0, RELATION_CAP)
                .map((r) => (
                  <TreeRow
                    key={`${r.name}(${r.args})`}
                    id={`fn:${schema}:${r.name}:${r.args}`}
                    level={level + 2}
                    expandable={false}
                    onActivate={() => s.onInsertText(`${q(schema)}.${q(r.name)}`)}
                    title={`${r.kind} ${r.name}(${r.args}) returns ${r.returns}`}
                  >
                    <span className="grid w-4 shrink-0 place-items-center text-faint" aria-hidden>
                      <Parentheses className="size-4" />
                    </span>
                    <span className="truncate">
                      <Highlight text={r.name} needle={s.needle} />
                    </span>
                    <span className="truncate text-[11px] text-faint">({r.args})</span>
                  </TreeRow>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function RelationList({
  items,
  level,
  schema,
  ...s
}: Shared & { items: RelationInfo[]; level: number; schema: string }) {
  const matched = s.needle
    ? items.filter((r) => r.name.toLowerCase().includes(s.needle.toLowerCase()))
    : items;
  // ponytail: hard cap at 500 rendered relations instead of virtualising this level - a schema
  // with 100k tables is unusable as a list anyway; virtualise here if that ever stops being true.
  const shown = matched.slice(0, RELATION_CAP);
  return (
    <>
      {shown.map((r) => (
        <RelationNode key={r.name} rel={r} level={level} schema={schema} {...s} />
      ))}
      {matched.length > shown.length ? (
        <div className="py-1 text-xs text-muted italic" style={{ paddingLeft: 6 + level * 14 + 16 }}>
          showing {RELATION_CAP} of {matched.length.toLocaleString()}, refine the filter
        </div>
      ) : null}
    </>
  );
}

function RelationNode({
  rel,
  level,
  schema,
  ...s
}: Shared & { rel: RelationInfo; level: number; schema: string }) {
  const id = `r:${schema}:${rel.name}`;
  const open = s.expanded.has(id);
  const [details, setDetails] = useState(false);
  const [alter, setAlter] = useState(false);
  const [relAcl, setRelAcl] = useState(false);
  // 'clear' and 'drop' are the two that run on their own, so each needs a confirmation
  const [confirm, setConfirm] = useState<null | 'clear' | 'drop'>(null);
  const [cascade, setCascade] = useState(false);
  const [restartIdentity, setRestartIdentity] = useState(true);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const isTable = rel.kind === 'table' || rel.kind === 'partitioned';

  const args = { connectionId: s.connectionId, schema, name: rel.name };
  const detailQ = useQuery({
    queryKey: queryKeys.relation(args),
    queryFn: () => getRelation(args),
    enabled: open || details,
  });

  const fetchDetail = () =>
    qc.fetchQuery({ queryKey: queryKeys.relation(args), queryFn: () => getRelation(args) });

  const qualified = `${q(schema)}.${q(rel.name)}`;
  const estimate = `Planner estimates (never COUNT(*)): ${rowsEstimate(rel.estimatedRows)}, ${bytes(
    rel.totalBytes,
  )} on disk`;

  return (
    <>
      <ContextMenu
        items={[
          { label: 'Browse data', onSelect: () => s.onOpenRelation(schema, rel.name) },
          { label: 'Insert name into editor', onSelect: () => s.onInsertText(qualified) },
          {
            label: 'Insert SELECT statement',
            onSelect: () => {
              void fetchDetail().then(
                (d) => s.onInsertText(selectStatement(d)),
                (e: unknown) => toast(message(e)),
              );
            },
          },
          {
            label: 'Copy qualified name',
            onSelect: () => {
              void navigator.clipboard.writeText(qualified).then(() => toast('Copied name'));
            },
          },
          { label: 'Show details', onSelect: () => setDetails(true) },
          { label: 'Privileges…', onSelect: () => setRelAcl(true) },
          ...(isTable
            ? [
                { label: 'Alter table…', onSelect: () => setAlter(true) },
                {
                  label: 'Clear (TRUNCATE)…',
                  onSelect: () => {
                    setCascade(false);
                    setRestartIdentity(true);
                    setConfirm('clear');
                  },
                },
                {
                  label: 'Drop table…',
                  onSelect: () => {
                    setCascade(false);
                    setConfirm('drop');
                  },
                },
              ]
            : []),
        ]}
      >
        <TreeRow
          id={id}
          level={level}
          expandable
          expanded={open}
          onActivate={() => s.toggle(id)}
          onOpen={() => s.onOpenRelation(schema, rel.name)}
          title={`${rel.kind} ${qualified}\n${estimate}${
            rel.comment ? `\n${rel.comment}` : ''
          }\nDouble-click to browse data`}
        >
          <span className="grid w-4 shrink-0 place-items-center text-faint" title={rel.kind} aria-hidden>
            {(() => {
              const Glyph = GLYPH[rel.kind];
              return <Glyph className="size-4" />;
            })()}
          </span>
          <span className="truncate">
            <Highlight text={rel.name} needle={s.needle} />
          </span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint tabular-nums">
            {rowsEstimate(rel.estimatedRows)} · {bytes(rel.totalBytes)}
          </span>
        </TreeRow>
      </ContextMenu>
      {open ? (
        <div role="group">
          {detailQ.isPending ? (
            <div className="py-1 text-xs text-muted" style={{ paddingLeft: 6 + (level + 1) * 14 }}>
              loading columns…
            </div>
          ) : null}
          {detailQ.error ? <ErrorBanner message={message(detailQ.error)} /> : null}
          {(detailQ.data?.columns ?? []).map((c) => (
            <TreeRow
              key={c.name}
              id={`c:${schema}:${rel.name}:${c.name}`}
              level={level + 1}
              expandable={false}
              onActivate={() => s.onInsertText(q(c.name))}
              title={`${c.typeName}${c.notNull ? ' NOT NULL' : ''}${c.defaultExpr ? ` DEFAULT ${c.defaultExpr}` : ''}${
                c.comment ? `\n${c.comment}` : ''
              }`}
            >
              <span className="grid w-4 shrink-0 place-items-center" aria-hidden>
                {c.isPrimaryKey ? (
                  <KeyRound className="size-3.5 text-accent-text" />
                ) : (
                  <span className="h-px w-1.5 bg-line-strong" />
                )}
              </span>
              <span className="truncate">
                <Highlight text={c.name} needle={s.needle} />
              </span>
              <span className="truncate pl-1 font-mono text-[11px] text-faint">{c.typeName}</span>
            </TreeRow>
          ))}
        </div>
      ) : null}
      {details ? (
        <Dialog open onClose={() => setDetails(false)} title={`${schema}.${rel.name}`}>
          {detailQ.data ? <RelationDetails detail={detailQ.data} /> : <Spinner />}
        </Dialog>
      ) : null}
      {relAcl ? (
        <PrivilegesDialog
          open
          onOpenChange={setRelAcl}
          connectionId={s.connectionId}
          schema={schema}
          name={rel.name}
          onEmit={s.onInsertText}
        />
      ) : null}
      {alter ? (
        <AlterTableDialog
          open
          onOpenChange={setAlter}
          connectionId={s.connectionId}
          schema={schema}
          name={rel.name}
          onEmit={s.onInsertText}
        />
      ) : null}
      {confirm ? (
        <Dialog
          open
          onOpenChange={(next) => !next && setConfirm(null)}
          title={confirm === 'clear' ? `Clear ${schema}.${rel.name}?` : `Drop ${schema}.${rel.name}?`}
          description={
            confirm === 'clear'
              ? `Deletes every row. The planner estimates ${rowsEstimate(rel.estimatedRows)}. This cannot be undone.`
              : 'Removes the table and all of its data. This cannot be undone.'
          }
          footer={
            <>
              <Button onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  const args = { connectionId: s.connectionId, schema, name: rel.name, cascade };
                  const run =
                    confirm === 'clear'
                      ? truncateTable({ ...args, restartIdentity })
                      : dropTable(args);
                  void run
                    .then(
                      () => {
                        toast(confirm === 'clear' ? 'Table cleared' : 'Table dropped');
                        setConfirm(null);
                        // the tree still lists a dropped table, and a cleared one still shows its
                        // old row estimate, until the relation list is re-read
                        void qc.invalidateQueries({
                          queryKey: queryKeys.relations({ connectionId: s.connectionId, schema }),
                        });
                        void qc.invalidateQueries({ queryKey: queryKeys.relation(args) });
                      },
                      (e: unknown) => toast(message(e), 'error'),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? 'Working…' : confirm === 'clear' ? 'Clear table' : 'Drop table'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            {confirm === 'clear' ? (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <Checkbox checked={restartIdentity} onChange={(e) => setRestartIdentity(e.target.checked)} />
                RESTART IDENTITY - reset the table's identity and serial sequences
              </label>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <Checkbox checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
              CASCADE -{' '}
              {confirm === 'clear'
                ? 'also clear tables whose foreign keys point here'
                : 'also drop views and foreign keys that depend on this table'}
            </label>
            <p className="text-xs text-faint">
              Without CASCADE, Postgres refuses outright if anything depends on this table rather than
              applying half of it.
            </p>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function RelationDetails({ detail }: { detail: RelationDetail }) {
  const { relation, columns, indexes, constraints, referencedBy } = detail;
  return (
    <div className="max-h-[70vh] max-w-[80ch] space-y-3 overflow-auto text-xs">
      <p className="text-muted">
        {relation.kind} · {rowsEstimate(relation.estimatedRows)} (planner estimate) · {bytes(relation.totalBytes)}
        {relation.comment ? ` · ${relation.comment}` : ''}
      </p>
      <Section title={`Columns (${columns.length})`}>
        <table className="w-full font-mono">
          <tbody>
            {columns.map((c) => (
              <tr key={c.name} className="border-b border-line">
                <td className="pr-2">
                  {c.isPrimaryKey ? (
                    <KeyRound className="size-3.5 text-accent-text" aria-label="primary key" />
                  ) : null}
                </td>
                <td className="pr-2">{c.name}</td>
                <td className="pr-2 text-muted">{c.typeName}</td>
                <td className="pr-2 text-muted">{c.notNull ? 'NOT NULL' : ''}</td>
                <td className="text-muted">{c.defaultExpr ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title={`Indexes (${indexes.length})`}>
        {indexes.map((i) => (
          <div key={i.name} className="font-mono break-all">
            <span className="text-muted">{bytes(i.totalBytes)}</span> {i.definition}
            {i.isValid ? '' : ' (INVALID)'}
          </div>
        ))}
      </Section>
      <Section title={`Constraints (${constraints.length})`}>
        {constraints.map((c) => (
          <div key={c.name} className="font-mono break-all">
            {c.name}: {c.definition}
          </div>
        ))}
      </Section>
      <Section title={`Referenced by (${referencedBy.length})`}>
        {referencedBy.map((r) => (
          <div key={`${r.schema}.${r.name}.${r.constraint}`} className="font-mono">
            {r.schema}.{r.name} ({r.constraint})
          </div>
        ))}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="panel-title pb-1">{title}</h3>
      {children}
    </div>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
