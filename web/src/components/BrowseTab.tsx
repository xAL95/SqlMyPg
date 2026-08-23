import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { BrowseResponse, Row } from '@shared/protocol';
import { browse, deleteRows, postExport, queryKeys, updateCell } from '@/lib/api';
import { cn } from '@/lib/format';
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, RotateCw, Search, X } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  ErrorBanner,
  Select,
  Spinner,
  TabActions,
  toast,
} from '@/components/ui';
import ResultGrid from '@/components/ResultGrid';
import NewRowDialog from '@/components/NewRowDialog';

const PAGE = 500;

/* Icon-only controls in the tab strip: square, quiet, and 28px so they line up with the sm button
   beside them. */
const ICON_BTN =
  'grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg ' +
  'disabled:screened disabled:hover:bg-transparent disabled:hover:text-muted';

export default function BrowseTab({
  connectionId,
  schema,
  name,
  tabId,
  active = true,
  onEstimate,
}: {
  connectionId: string;
  schema: string;
  name: string;
  tabId?: string;
  /** hidden tabs stay mounted, so only the active one may claim the shared actions slot */
  active?: boolean;
  /** the planner's estimate for this relation, for the status rail */
  onEstimate?: (tabId: string, rows: number | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [where, setWhere] = useState('');
  const [orderBy, setOrderBy] = useState<{ column: string; desc: boolean }[] | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);
  const qc = useQueryClient();

  const browseKey = queryKeys.browse({ connectionId, schema, name, where: where || undefined, orderBy });

  const q = useInfiniteQuery({
    queryKey: browseKey,
    // Keyset (seek) pagination: the page param is the previous page's last ORDER BY values,
    // never a page number. OFFSET n makes the server walk and throw away n rows, so page
    // 10 000 of a billion-row table never comes back.
    queryFn: ({ pageParam }) =>
      browse({
        connectionId,
        schema,
        name,
        limit: PAGE,
        where: where || undefined,
        orderBy,
        after: pageParam ?? undefined,
      }),
    initialPageParam: null as (string | null)[] | null,
    getNextPageParam: (last: BrowseResponse) => (last.done ? undefined : last.cursorKey),
    // Keeps the previous result on screen while a new WHERE / ORDER BY is in flight or fails.
    placeholderData: keepPreviousData,
  });

  const pages = q.data?.pages ?? [];
  const first = pages[0];
  const last = pages[pages.length - 1];
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const fields = first?.fields ?? [];
  const effectiveOrderBy = orderBy ?? first?.orderBy ?? [];
  const primary = effectiveOrderBy[0];

  const applyWhere = () => setWhere(draft.trim());
  const clearWhere = () => {
    setDraft('');
    setWhere('');
  };

  const setOrder = (column: string, desc: boolean) => setOrderBy(column ? [{ column, desc }] : undefined);
  const toggleOrder = (column: string) =>
    setOrder(column, primary?.column === column ? !primary.desc : false);

  // A row is addressed by its unique key, never by its position or its ctid - see deleteRows
  // on the server for why. No key means the table cannot be edited from the grid at all.
  const keyColumns = first?.keyColumns ?? [];
  const noKeyReason =
    keyColumns.length === 0
      ? 'This table has no primary key or unique index, so a row cannot be addressed safely. Edit or delete it from a query tab with a WHERE you control.'
      : null;

  // The key values as the row was read, which is how the server finds that one row again.
  // Null when the key columns are not in this result at all - possible if the relation changed
  // under us, and never something to guess at when the next step is a write.
  const keyFor = (rowIndex: number): Record<string, string | null> | null => {
    const row = rows[rowIndex];
    if (!row || keyColumns.length === 0) return null;
    const idx = keyColumns.map((c) => fields.findIndex((f) => f.name === c));
    if (idx.some((i) => i < 0)) return null;
    return Object.fromEntries(keyColumns.map((c, k) => [c, row[idx[k] as number] ?? null]));
  };

  const onEditCell = async (rowIndex: number, columnIndex: number, next: string | null) => {
    const key = keyFor(rowIndex);
    const column = fields[columnIndex]?.name;
    if (!key || !column) throw new Error('Could not identify this row; refresh and try again');
    const res = await updateCell({ connectionId, schema, name, key, column, value: next });
    if (res.rowCount === 0) throw new Error('No row matched - it may have changed since this page loaded');

    // Patch the one cell in place with what Postgres stored. Refetching would re-run every
    // loaded page for a single value, which is exactly what makes editing a column of cells
    // feel slow, and it would throw away the scroll position too. Refresh re-reads everything.
    qc.setQueryData<InfiniteData<BrowseResponse>>(browseKey, (old) => {
      if (!old) return old;
      let offset = rowIndex;
      let target = -1;
      for (let i = 0; i < old.pages.length; i++) {
        const len = old.pages[i]?.rows.length ?? 0;
        if (offset < len) {
          target = i;
          break;
        }
        offset -= len;
      }
      if (target < 0) return old;
      return {
        ...old,
        pages: old.pages.map((page, i) => {
          if (i !== target) return page;
          const rows = page.rows.slice();
          const row = rows[offset];
          if (!row) return page;
          const patched: Row = row.slice();
          patched[columnIndex] = res.value;
          rows[offset] = patched;
          return { ...page, rows };
        }),
      };
    });
    toast('Value updated');
  };

  const confirmDelete = () => {
    const indexes = pendingDelete;
    if (!indexes) return;
    const keys = indexes.flatMap((i) => {
      const k = keyFor(i);
      return k ? [k] : [];
    });
    if (keys.length !== indexes.length) {
      toast('Could not identify every selected row; refresh and try again', 'error');
      setPendingDelete(null);
      return;
    }
    setDeleting(true);
    deleteRows({ connectionId, schema, name, keys })
      .then(
        (res) => {
          toast(`Deleted ${res.rowCount} row${res.rowCount === 1 ? '' : 's'}`);
          setPendingDelete(null);
          void q.refetch();
        },
        (e: unknown) => toast(message(e), 'error'),
      )
      .finally(() => setDeleting(false));
  };

  // Report the estimate up whenever a page lands, and withdraw it when the tab goes away.
  const estimate = first?.estimatedRows ?? null;
  useEffect(() => {
    if (!tabId || !onEstimate) return;
    onEstimate(tabId, estimate);
    return () => onEstimate(tabId, null);
  }, [tabId, onEstimate, estimate]);

  const onExport = () => {
    setExporting(true);
    void postExport({ connectionId, schema, name, where: where || undefined, orderBy: effectiveOrderBy, format: 'csv' })
      .then(
        () => toast('Export started'),
        (e: unknown) => toast(message(e)),
      )
      .finally(() => setExporting(false));
  };

  /* Everything that used to sit on the second bar. The relation name and the row estimate are not
     here: the tab already prints the name, and the status rail already carries the estimate. */
  const controls = (
    <>
      {q.isFetching && !q.isFetchingNextPage ? <Spinner /> : null}

      {noKeyReason ? (
        <span title={noKeyReason}>
          <Badge tone="warn">Read-only</Badge>
        </span>
      ) : null}

      {/* Filtering is the first thing anyone reaches for, so it is a real search field with its own
          icon - not a bare box labelled WHERE that you have to already know the syntax of. */}
      <div className="relative shrink-0">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyWhere();
            if (e.key === 'Escape' && where) clearWhere();
          }}
          placeholder="Filter rows…"
          aria-label="Filter rows with a SQL WHERE predicate"
          title="A SQL WHERE predicate, for example: status = 'open'. Press Enter to apply, Escape to clear."
          className={cn(
            'h-7 w-60 rounded-md border bg-elevated pl-8 pr-7 font-mono text-sm text-fg',
            'placeholder:font-sans placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/30',
            where ? 'border-accent' : 'border-line-strong focus:border-accent',
          )}
        />
        {where ? (
          <button
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={clearWhere}
            className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* Column headers sort on click. This stays because a table can be wider than the screen, and
          the column you want to sort by may not be on it. */}
      <div className="w-36 shrink-0">
        <Select
          aria-label="Sort by"
          value={primary?.column ?? ''}
          onChange={(e) => setOrder(e.target.value, primary?.desc ?? false)}
          className="h-7 text-sm"
        >
          <option value="">Sort: default</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              Sort: {f.name}
            </option>
          ))}
        </Select>
      </div>
      <button
        type="button"
        disabled={!primary}
        onClick={() => primary && setOrder(primary.column, !primary.desc)}
        aria-label="Reverse sort direction"
        title={
          primary
            ? `Sorted ${primary.desc ? 'descending' : 'ascending'}, click to reverse`
            : 'Choose a column to sort by first'
        }
        className={ICON_BTN}
      >
        {primary?.desc ? <ArrowDown className="size-4" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
      </button>

      <Button size="sm" variant="primary" onClick={() => setAdding(true)} title="Insert a new row">
        <Plus className="size-4" aria-hidden />
        Row
      </Button>

      <button
        type="button"
        onClick={() => void q.refetch()}
        aria-label="Refresh"
        title="Re-read this table"
        className={ICON_BTN}
      >
        <RotateCw className="size-4" aria-hidden />
      </button>

      <DropdownMenu
        trigger={
          <button type="button" aria-label="More table actions" title="More actions" className={ICON_BTN}>
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        }
        items={[
          { label: exporting ? 'Exporting…' : 'Export as CSV', disabled: exporting, onSelect: onExport },
          { label: 'Show the SQL behind this view', onSelect: () => setSqlOpen(true) },
        ]}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {active ? <TabActions>{controls}</TabActions> : null}

      {q.error ? <ErrorBanner message={message(q.error)} className="m-2" /> : null}

      <div className="min-h-0 flex-1">
        <ResultGrid
          fields={fields}
          rows={rows}
          rowCount={rows.length}
          truncated={q.hasNextPage}
          loadingMore={q.isFetchingNextPage}
          onLoadMore={() => void q.fetchNextPage()}
          emptyLabel={where ? 'No rows match that WHERE' : 'Table is empty'}
          sql={last?.sql}
          sort={primary}
          onSort={toggleOrder}
          tableName={{ schema, name }}
          onDeleteRows={setPendingDelete}
          onEditCell={onEditCell}
          editReason={() => noKeyReason}
          onNewRow={() => setAdding(true)}
          deleteDisabledReason={noKeyReason}
        />
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.length ?? 0} row${pendingDelete?.length === 1 ? '' : 's'}?`}
        description={`From ${schema}.${name}, matched on ${keyColumns.join(', ')}. This cannot be undone.`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      />

      <NewRowDialog
        open={adding}
        onOpenChange={setAdding}
        connectionId={connectionId}
        schema={schema}
        name={name}
        onInserted={() => void q.refetch()}
      />

      {/* The statement the grid is actually showing. Worth reading: it is also the thing to paste
          into a query tab when the filter needs more than one predicate. */}
      <Dialog
        open={sqlOpen}
        onOpenChange={setSqlOpen}
        title="SQL behind this view"
        description="Generated from the filter and sort above. Keyset pagination, so the next page continues from the last row rather than counting past it."
        width={720}
        footer={<Button onClick={() => setSqlOpen(false)}>Close</Button>}
      >
        <pre className="max-h-80 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-sm whitespace-pre-wrap">
          {last?.sql ?? '(nothing run yet)'}
        </pre>
      </Dialog>
    </div>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
