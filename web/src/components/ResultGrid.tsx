import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FieldMeta, Row } from '@shared/protocol';
import { ArrowDown, Info } from 'lucide-react';
import { cn, truncateMiddle } from '@/lib/format';
import { toCsv, toSqlInsert } from '@/lib/rowFormat';
import { NO_PICK, pickRow, pickedRows, type RowPick } from '@/lib/rowSelect';
import type { MenuItem } from '@/components/ui';
import { Badge, Button, Checkbox, ContextMenu, Dialog, EmptyState, ErrorBanner, Kbd, Textarea, toast } from '@/components/ui';

const ROW_H = 30;
const HEADER_H = 44;
const ROWNUM_W = 60;
const MIN_W = 64;
const MAX_W = 460;
const LOAD_MORE_GAP = 40;

/** int2 int4 int8 oid float4 float8 money numeric */
const NUMERIC_OIDS = new Set([21, 23, 20, 26, 700, 701, 790, 1700]);

// The table instance is the column model only - sizing, resizing, header objects.
// Feeding it 100k rows would build 100k Row/Cell objects on every data change, which is
// exactly the cliff this grid exists to avoid; cells render straight from `rows`.
const NO_DATA: Row[] = [];

type Cursor = { r: number; c: number };
type Selection = { a: Cursor; f: Cursor };

const clampW = (n: number) => Math.max(MIN_W, Math.min(MAX_W, Math.round(n)));

/** Character-count heuristic: ~7.2px per char at 12px monospace, plus padding. */
function widthFor(header: string, sample: Row[], col: number): number {
  let max = header.length + 3;
  for (const row of sample) {
    const v = row[col];
    const len = v == null ? 4 : v.length;
    if (len > max) max = len;
  }
  return clampW(max * 7.2 + 18);
}

function rect(sel: Selection) {
  return {
    r0: Math.min(sel.a.r, sel.f.r),
    r1: Math.max(sel.a.r, sel.f.r),
    c0: Math.min(sel.a.c, sel.f.c),
    c1: Math.max(sel.a.c, sel.f.c),
  };
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${what}`),
    () => toast(`Could not copy ${what}`),
  );
}

export default function ResultGrid({
  fields,
  rows,
  rowCount,
  truncated,
  loadingMore,
  onLoadMore,
  emptyLabel,
  sql,
  sort,
  onSort,
  tableName,
  onDeleteRows,
  onEditCell,
  onNewRow,
  editReason,
  deleteDisabledReason,
}: {
  fields: FieldMeta[];
  rows: Row[];
  rowCount: number | null;
  truncated: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  emptyLabel?: string;
  sql?: string;
  /** current server-side sort, when the caller can re-query (browse); omit for a fixed result */
  sort?: { column: string; desc: boolean };
  /** click a header to sort by it; first click ASC, clicking the sorted column flips it */
  onSort?: (column: string) => void;
  /** the relation these rows came from; enables "copy as INSERT", which needs a table to name */
  tableName?: { schema: string; name: string };
  /** given the selected row indexes, delete them; omit to hide the menu item entirely */
  onDeleteRows?: (rowIndexes: number[]) => void;
  /** write one cell; omit to keep the value viewer read-only. Rejects with a message on failure. */
  onEditCell?: (rowIndex: number, columnIndex: number, next: string | null) => Promise<void>;
  /** insert into the relation this grid is browsing; absent for an arbitrary query result */
  onNewRow?: () => void;
  /**
   * Why this column cannot be written, or null when it can. Asked per column because a query
   * result mixes columns from different tables with computed ones, and each has its own answer.
   */
  editReason?: (columnIndex: number) => string | null;
  /** when set, deleting is offered but disabled, with this as the explanation */
  deleteDisabledReason?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const [sel, setSel] = useState<Selection | null>(null);
  // A rectangle cannot express "rows 2, 5 and 9", so picked rows are their own set. Exactly one
  // of the two is in charge at a time: a non-empty pick means row mode and drives the highlight;
  // anything cell-level (arrow keys, clicking a cell) empties it and hands control back.
  const [pick, setPick] = useState<RowPick>(NO_PICK);
  const [viewer, setViewer] = useState<{ field: FieldMeta; value: string | null; r: number; c: number } | null>(null);

  // ponytail: widths are measured from the first loaded page only, so wider values that
  // arrive later stay clipped; double-click a header edge to auto-fit, or measure
  // incrementally per page if that ever becomes annoying.
  const columns = useMemo(() => {
    const sample = rowsRef.current.slice(0, 100);
    return fields.map((f, i) => ({
      id: String(i),
      size: widthFor(f.name, sample, i),
      minSize: MIN_W,
      maxSize: MAX_W * 4,
    }));
  }, [fields]);

  const table = useReactTable({
    columns,
    data: NO_DATA,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
  });
  const leafCols = table.getAllLeafColumns();
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const totalColWidth = table.getTotalSize();

  const rowVirt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    // Rows start below the sticky header; scrollPaddingStart keeps scrollToIndex from
    // parking the selected row underneath it.
    paddingStart: HEADER_H,
    scrollPaddingStart: HEADER_H,
  });
  const colVirt = useVirtualizer({
    horizontal: true,
    count: leafCols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => leafCols[i]?.getSize() ?? MIN_W,
    overscan: 3,
    paddingStart: ROWNUM_W,
    scrollPaddingStart: ROWNUM_W,
  });

  // The horizontal virtualizer caches item sizes; a resize has to invalidate that cache.
  useEffect(() => {
    colVirt.measure();
  }, [colVirt, totalColWidth]);

  const virtualRows = rowVirt.getVirtualItems();
  const virtualCols = colVirt.getVirtualItems();
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? 0;

  useEffect(() => {
    if (truncated && !loadingMore && onLoadMore && rows.length - lastVisible < LOAD_MORE_GAP) onLoadMore();
  }, [truncated, loadingMore, onLoadMore, rows.length, lastVisible]);

  const rowCountRef = useRef(rows.length);
  useEffect(() => {
    if (rows.length < rowCountRef.current) {
      setPick(NO_PICK);
      setSel(null);
    }
    rowCountRef.current = rows.length;
  }, [rows.length]);

  useEffect(() => {
    setPick(NO_PICK);
    setSel(null);
  }, [fields]);

  const rowIndexes = useCallback((): number[] => pickedRows(pick, sel ? rect(sel) : null), [pick, sel]);

  const copySelection = useCallback(() => {
    // In row mode the whole row is what was selected, so copy every column of it.
    if (pick.rows.size > 0) {
      const idx = [...pick.rows].sort((a, b) => a - b);
      const lines = idx.map((i) => fields.map((_, c) => rows[i]?.[c] ?? '').join('\t'));
      return copy(lines.join('\n'), idx.length + ' row' + (idx.length === 1 ? '' : 's'));
    }
    if (!sel) return;
    const { r0, r1, c0, c1 } = rect(sel);
    const tsv: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const row = rows[r];
      if (!row) continue;
      const line: string[] = [];
      for (let c = c0; c <= c1; c++) line.push(row[c] ?? '');
      tsv.push(line.join('\t'));
    }
    copy(tsv.join('\n'), `${r1 - r0 + 1}x${c1 - c0 + 1} selection`);
  }, [sel, rows, fields, pick]);

  const selectRow = useCallback(
    (row: number, mods: { shift?: boolean; ctrl?: boolean }) => {
      const lastCol = Math.max(0, fields.length - 1);
      const next = pickRow(pick, row, mods);
      setPick(next);
      // Keep the keyboard cursor on the row just touched, spanning every column, so the arrow
      // keys carry on from somewhere sensible once the pick is dropped. Ctrl-clicking the last
      // picked row empties the pick, and a rectangle over that same row would still look
      // selected, so clear it instead.
      setSel(next.rows.size === 0 ? null : { a: { r: row, c: 0 }, f: { r: row, c: lastCol } });
    },
    [fields.length, pick],
  );

  const copyRowsAs = useCallback(
    (kind: 'csv' | 'sql') => {
      const idx = rowIndexes();
      const chosen = idx.flatMap((i) => (rows[i] ? [rows[i] as Row] : []));
      if (!chosen.length) return;
      const what = `${chosen.length} row${chosen.length === 1 ? '' : 's'}`;
      if (kind === 'csv') return copy(toCsv(fields, chosen), `${what} as CSV`);
      if (tableName) copy(toSqlInsert(tableName, fields, chosen), `${what} as SQL`);
    },
    [rowIndexes, rows, fields, tableName],
  );

  const autoFit = useCallback(
    (col: number) => {
      const f = fields[col];
      if (!f) return;
      // ponytail: auto-fit scans the first 5000 loaded rows, not the whole result; drag the
      // edge by hand if a later row is wider, or measure in a worker if that ever matters.
      const w = widthFor(f.name, rows.slice(0, 5000), col);
      table.setColumnSizing((prev: Record<string, number>) => ({ ...prev, [String(col)]: w }));
    },
    [fields, rows, table],
  );

  const move = useCallback(
    (dr: number, dc: number, extend: boolean, absolute?: Partial<Cursor>) => {
      const cur = sel?.f ?? { r: 0, c: 0 };
      const r = Math.max(0, Math.min(rows.length - 1, absolute?.r ?? cur.r + dr));
      const c = Math.max(0, Math.min(fields.length - 1, absolute?.c ?? cur.c + dc));
      setPick(NO_PICK);
      setSel((prev) => (extend && prev ? { a: prev.a, f: { r, c } } : { a: { r, c }, f: { r, c } }));
      rowVirt.scrollToIndex(r, { align: 'auto' });
      colVirt.scrollToIndex(c, { align: 'auto' });
    },
    [sel, rows.length, fields.length, rowVirt, colVirt],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (rows.length && fields.length) {
        setPick(NO_PICK);
        setSel({ a: { r: 0, c: 0 }, f: { r: rows.length - 1, c: fields.length - 1 } });
      }
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H * 20) / ROW_H) - 1);
    const moves: Record<string, () => void> = {
      ArrowDown: () => move(1, 0, e.shiftKey),
      ArrowUp: () => move(-1, 0, e.shiftKey),
      ArrowRight: () => move(0, 1, e.shiftKey),
      ArrowLeft: () => move(0, -1, e.shiftKey),
      PageDown: () => move(page, 0, e.shiftKey),
      PageUp: () => move(-page, 0, e.shiftKey),
      Home: () => move(0, 0, e.shiftKey, mod ? { r: 0, c: 0 } : { c: 0 }),
      End: () => move(0, 0, e.shiftKey, mod ? { r: rows.length - 1, c: fields.length - 1 } : { c: fields.length - 1 }),
      Enter: () => {
        const cur = sel?.f;
        const f = cur ? fields[cur.c] : undefined;
        if (cur && f) setViewer({ field: f, value: rows[cur.r]?.[cur.c] ?? null, r: cur.r, c: cur.c });
      },
    };
    const fn = moves[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  if (!rows.length) {
    const empty = (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title={emptyLabel ?? 'No rows'}
          description={rowCount != null ? `${rowCount.toLocaleString()} rows affected` : undefined}
        />
      </div>
    );
    // An empty table has no row to right-click, which is exactly when inserting is the only thing
    // you want. The menu is offered on the empty field itself.
    return onNewRow ? (
      <ContextMenu items={[{ label: 'Insert a new row…', onSelect: onNewRow }]}>{empty}</ContextMenu>
    ) : (
      empty
    );
  }

  const r = sel ? rect(sel) : null;
  const chosen = rowIndexes();

  const rowMenu = (index: number): MenuItem[] => {
    // the handler runs after onMouseDown has re-pointed the selection, so this is only a label
    const count = chosen.includes(index) ? chosen.length : 1;
    const n = `${count} row${count === 1 ? '' : 's'}`;
    return [
      // First, because it is the one thing here that is not about the rows you already have, and
      // it is the only entry that cannot destroy or overwrite anything.
      ...(onNewRow ? [{ label: 'Insert a new row…', onSelect: onNewRow }] : []),
      { label: `Copy ${n} as CSV`, onSelect: () => copyRowsAs('csv') },
      ...(tableName ? [{ label: `Copy ${n} as INSERT`, onSelect: () => copyRowsAs('sql') }] : []),
      { label: `Copy ${n} as TSV`, onSelect: copySelection },
      ...(onDeleteRows
        ? [
            {
              label: `Delete ${n}…`,
              disabled: deleteDisabledReason != null,
              title: deleteDisabledReason ?? undefined,
              onSelect: () => {
                const idx = rowIndexes();
                if (idx.length) onDeleteRows(idx);
              },
            },
          ]
        : []),
    ];
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The field below the last row belongs to no row, so the scroll container owns the menu
          there. Row and header triggers sit inside it and stop the bubble, so they still win. */}
      <ContextMenu items={onNewRow ? [{ label: 'Insert a new row…', onSelect: onNewRow }] : []}>
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="relative min-h-0 flex-1 overflow-auto font-mono text-[13px]"
        >
          {/* getTotalSize() already includes the HEADER_H paddingStart, so rows sit below the header. */}
          <div
            className="relative"
            style={{ width: ROWNUM_W + totalColWidth, height: rowVirt.getTotalSize() }}
          >
            <div
              className="sticky top-0 z-20 bg-surface"
              style={{ height: HEADER_H, width: ROWNUM_W + totalColWidth }}
            >
              <div
                className="sticky left-0 z-30 flex h-full items-center justify-end border-r border-b border-line bg-surface pr-2 text-xs text-muted"
                style={{ width: ROWNUM_W }}
              >
                #
              </div>
              {virtualCols.map((vc) => {
                const f = fields[vc.index];
                const header = headers[vc.index];
                if (!f) return null;
                return (
                  <ContextMenu
                    key={vc.key}
                    items={[
                      { label: 'Copy column name', onSelect: () => copy(f.name, 'column name') },
                      {
                        label: 'Copy column values',
                        onSelect: () =>
                          copy(rows.map((row) => row[vc.index] ?? '').join('\n'), `${rows.length} values`),
                      },
                      onSort
                        ? {
                            label:
                              sort?.column === f.name && !sort.desc ? `Sort by ${f.name} DESC` : `Sort by ${f.name} ASC`,
                            onSelect: () => onSort(f.name),
                          }
                        : {
                            label: 'Sort (not available here)',
                            disabled: true,
                            title:
                              'This result set is already materialised on the server. Re-run the query with ORDER BY to sort it.',
                          },
                    ]}
                  >
                    <div
                      className={cn(
                        'absolute top-0 flex select-none flex-col justify-center border-r border-b border-line px-1.5',
                        onSort && 'cursor-pointer hover:bg-hover',
                      )}
                      style={{ left: vc.start, width: vc.size, height: HEADER_H }}
                      title={
                        onSort
                          ? `${f.name} : ${f.typeName} - click to sort`
                          : `${f.name} : ${f.typeName}`
                      }
                      {...(onSort
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            'aria-sort':
                              sort?.column !== f.name ? 'none' : sort.desc ? 'descending' : 'ascending',
                            // the resize handle is a child, so ignore clicks that started on it
                            onClick: (e: ReactMouseEvent) => {
                              if ((e.target as HTMLElement).getAttribute('role') !== 'separator') onSort(f.name);
                            },
                            onKeyDown: (e: ReactKeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onSort(f.name);
                              }
                            },
                          }
                        : {})}
                    >
                      <span className="flex items-center gap-1">
                        <span className="truncate font-sans text-sm font-semibold text-fg">{f.name}</span>
                        {sort?.column === f.name ? (
                          <ArrowDown
                            aria-hidden
                            className={cn('size-3.5 shrink-0 text-accent-text', !sort.desc && 'rotate-180')}
                          />
                        ) : null}
                      </span>
                      <span className="truncate font-sans text-[11px] text-muted">{f.typeName}</span>
                      {header ? (
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => autoFit(vc.index)}
                          title="Drag to resize, double-click to auto-fit"
                          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent"
                        />
                      ) : null}
                    </div>
                  </ContextMenu>
                );
              })}
            </div>

            {virtualRows.map((vr) => {
              const row = rows[vr.index];
              if (!row) return null;
              const rowSelected = pick.rows.size > 0 ? pick.rows.has(vr.index) : r != null && vr.index >= r.r0 && vr.index <= r.r1;
              return (
                <div
                  key={vr.key}
                  className={cn('absolute left-0', rowSelected && 'bg-accent-soft/40')}
                  style={{ top: vr.start, height: ROW_H, width: ROWNUM_W + totalColWidth }}
                >
                  {/* One trigger for the gutter and every cell in the row: the menu belongs to the
                      row, and a right-click inside the data used to fall through to the browser. */}
                  <ContextMenu items={rowMenu(vr.index)}>
                    <div
                      role="button"
                      tabIndex={-1}
                      aria-label={`Select row ${vr.index + 1}`}
                      title="Click to select the row, Shift+click to extend"
                      onMouseDown={(e) => {
                        if (e.button === 0) {
                          return selectRow(vr.index, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
                        }
                        // a right-click outside the selection re-targets it, so the menu acts on
                        // what the user just pointed at rather than a stale range
                        if (e.button === 2 && !rowSelected) selectRow(vr.index, {});
                      }}
                      className={cn(
                        'sticky left-0 z-10 flex h-full cursor-pointer items-center justify-end border-r border-line pr-2 text-xs',
                        rowSelected
                          ? 'bg-accent font-medium text-accent-fg'
                          : 'bg-surface text-faint hover:bg-hover',
                      )}
                      style={{ width: ROWNUM_W }}
                    >
                      {vr.index + 1}
                    </div>
                    {virtualCols.map((vc) => {
                      const f = fields[vc.index];
                      if (!f) return null;
                      const value = row[vc.index] ?? null;
                      // a picked row is selected across every column; a rectangle only spans its own
                      const selected =
                        pick.rows.size > 0
                          ? rowSelected
                          : rowSelected && r != null && vc.index >= r.c0 && vc.index <= r.c1;
                      return (
                        <div
                          key={vc.key}
                          onMouseDown={(e) => {
                            const cur = { r: vr.index, c: vc.index };
                            // Same rule the gutter follows: a right-click outside the current selection
                            // re-points it, so the menu acts on the cell you pointed at rather than a
                            // stale range. Inside it, the selection is left alone.
                            if (e.button === 2) {
                              if (!selected) {
                                setPick(NO_PICK);
                                setSel({ a: cur, f: cur });
                              }
                              return;
                            }
                            if (e.button !== 0) return;
                            setPick(NO_PICK);
                            setSel((prev) => (e.shiftKey && prev ? { a: prev.a, f: cur } : { a: cur, f: cur }));
                          }}
                          onDoubleClick={() => setViewer({ field: f, value, r: vr.index, c: vc.index })}
                          className={cn(
                            'absolute top-0 flex items-center overflow-hidden border-r border-b border-line px-1.5 whitespace-pre',
                            NUMERIC_OIDS.has(f.dataTypeId) ? 'justify-end tabular-nums' : 'justify-start',
                            selected && 'bg-accent-soft',
                          )}
                          style={{ left: vc.start, width: vc.size, height: ROW_H }}
                          title={value === null ? 'NULL' : value}
                        >
                          <CellValue value={value} />
                        </div>
                      );
                    })}
                  </ContextMenu>
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenu>

      <div className="h-[3px] shrink-0 overflow-hidden">
        {loadingMore ? <div className="scanner-bar h-full w-1/3 bg-accent" /> : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface px-3 py-1.5 text-xs text-muted">
        <span>
          {rows.length.toLocaleString()} rows loaded
          {rowCount != null && rowCount !== rows.length ? ` of ${rowCount.toLocaleString()}` : ''}
        </span>
        {truncated ? <Badge>more rows available</Badge> : <span>complete</span>}
        {sql ? (
          <button
            type="button"
            className="max-w-[28ch] truncate underline decoration-dotted"
            title={sql}
            onClick={() => copy(sql, 'SQL')}
          >
            SQL
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1">
            <Kbd>{'←↑↓→'}</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Ctrl</Kbd>+click rows
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> view
          </span>
        </span>
      </div>

      {viewer ? (
        <ValueViewer
          field={viewer.field}
          value={viewer.value}
          onClose={() => setViewer(null)}
          readOnlyReason={editReason?.(viewer.c) ?? deleteDisabledReason}
          onSave={
            onEditCell && (editReason?.(viewer.c) ?? null) === null
              ? async (next) => {
                  await onEditCell(viewer.r, viewer.c, next);
                  setViewer(null);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function CellValue({ value }: { value: string | null }) {
  if (value === null)
    return (
      <span aria-label="NULL" title="NULL" className="select-none text-faint">
        ·
      </span>
    );
  if (value === '')
    return <span className="rounded-full border border-line px-1.5 text-[11px] text-faint">empty</span>;
  const oneLine = value.replace(/[\n\r\t]+/g, ' ⏎ ');
  return <>{oneLine.length > 200 ? truncateMiddle(oneLine, 200) : oneLine}</>;
}

function ValueViewer({
  field,
  value,
  onClose,
  onSave,
  readOnlyReason,
}: {
  field: FieldMeta;
  value: string | null;
  onClose: () => void;
  /** omit to keep the viewer read-only */
  onSave?: (next: string | null) => Promise<void>;
  /** shown instead of the editor when the value cannot be written */
  readOnlyReason?: string | null;
}) {
  const pretty = useMemo(() => {
    if (value === null) return null;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return null;
    }
  }, [value]);
  const [asJson, setAsJson] = useState(true);
  const [editing, setEditing] = useState(onSave != null);
  const [draft, setDraft] = useState(value ?? '');
  const [isNull, setIsNull] = useState(value === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = asJson && pretty != null ? pretty : value;

  const startEdit = () => {
    // the raw value is what gets written, never the pretty-printed rendering of it
    setDraft(value ?? '');
    setIsNull(value === null);
    setError(null);
    setEditing(true);
  };

  const changed = isNull ? value !== null : value === null || draft !== value;

  const save = () => {
    if (!onSave) return;
    setSaving(true);
    setError(null);
    onSave(isNull ? null : draft)
      .then(
        () => setEditing(false),
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${field.name} : ${field.typeName}`}
      footer={
        editing ? (
          <>
            <span className="mr-auto text-sm text-muted">
              <Kbd>Ctrl+Enter</Kbd> save · <Kbd>Esc</Kbd> close
            </span>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !changed}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2 pb-2">
        <Button onClick={() => copy(value ?? '', 'value')} disabled={value === null}>
          Copy
        </Button>
        {pretty != null && !editing ? (
          <Button onClick={() => setAsJson((v) => !v)}>{asJson ? 'Raw text' : 'Pretty JSON'}</Button>
        ) : null}
        {onSave ? (
          <Button onClick={() => (editing ? setEditing(false) : startEdit())}>
            {editing ? 'View' : 'Edit'}
          </Button>
        ) : null}
        {!onSave && readOnlyReason ? <Badge tone="warn">Read-only</Badge> : null}
        <span className="text-sm text-muted">
          {value === null ? 'NULL' : `${value.length.toLocaleString()} chars`}
        </span>
      </div>

      {/* The reason a cell cannot be written is the useful part - often it names the column to add
          to the SELECT - so it is stated on the panel rather than hidden in a tooltip. */}
      {!onSave && readOnlyReason ? (
        <p className="mb-2 flex gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>{readOnlyReason}</span>
        </p>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {editing ? (
        <>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-muted">
            <Checkbox checked={isNull} onChange={(e) => setIsNull(e.target.checked)} />
            NULL
          </label>
          <Textarea
            autoFocus
            value={isNull ? '' : draft}
            disabled={isNull}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && changed && !saving) {
                e.preventDefault();
                save();
              }
            }}
            className="max-h-[60vh] min-h-[12rem] min-w-[40ch] font-mono text-[13px]"
          />
        </>
      ) : (
        <pre className="max-h-[60vh] min-w-[40ch] overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[13px] whitespace-pre-wrap">
          {value === null ? <span className="text-faint">NULL</span> : text}
        </pre>
      )}
    </Dialog>
  );
}
