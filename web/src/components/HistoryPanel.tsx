import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import {
  clearHistory,
  deleteSaved,
  getHistory,
  listSaved,
  queryKeys,
  updateSaved,
} from '@/lib/api';
import { cn, duration, truncateMiddle } from '@/lib/format';
import { onServerMessage } from '@/lib/ws';

/* Focus is the global bracket from index.css; nothing here needs to redraw it. */
const focusRing = '';
const rowCls = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover';
const iconBtn = cn(
  'grid size-6 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg',
  focusRing,
);
const summaryCls =
  'panel-title marker-none flex h-9 cursor-pointer items-center justify-between px-2 select-none hover:text-accent-text';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

function ago(iso: string) {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
  }
  return rtf.format(Math.round(sec), 'second');
}

export default function HistoryPanel({
  connectionId,
  onUse,
}: {
  connectionId: string | null;
  onUse: (sql: string) => void;
}) {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: queryKeys.saved, queryFn: listSaved });
  const history = useQuery({
    queryKey: queryKeys.history(connectionId ?? ''),
    queryFn: () => getHistory(connectionId ?? undefined),
  });

  // Queries are 30s stale-while-fresh and nothing refetches on focus, so without this the list
  // sat there for half a minute after a statement ran. The server emits once the row has landed.
  useEffect(
    () =>
      onServerMessage((m) => {
        if (m.type === 'history') {
          void qc.invalidateQueries({ queryKey: queryKeys.history(connectionId ?? '') });
        }
      }),
    [qc, connectionId],
  );

  const invalidateSaved = () => qc.invalidateQueries({ queryKey: queryKeys.saved });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => updateSaved(v.id, { name: v.name }),
    onSuccess: invalidateSaved,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSaved(id),
    onSuccess: invalidateSaved,
  });
  const wipe = useMutation({
    mutationFn: () => clearHistory(connectionId ?? undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.history(connectionId ?? '') }),
  });

  // A saved query with no connection is global; otherwise show it on its own connection.
  const mine = (saved.data ?? []).filter(
    (s) => s.connectionId === null || s.connectionId === connectionId,
  );
  const entries = history.data ?? [];

  return (
    <div className="text-sm">
      <details open>
        <summary className={summaryCls}>Saved queries ({mine.length})</summary>
        <div className="max-h-44 overflow-y-auto pb-1">
          {!mine.length && <p className="px-2 py-1 text-xs text-muted">Nothing saved yet.</p>}
          {mine.map((s) => (
            <div key={s.id} className={rowCls}>
              <button
                className={cn('min-w-0 flex-1 truncate text-left', focusRing)}
                title={s.sql}
                onClick={() => onUse(s.sql)}
              >
                {s.name}
              </button>
              <button
                className={iconBtn}
                aria-label={`Rename ${s.name}`}
                onClick={() => {
                  const name = window.prompt('Name', s.name)?.trim();
                  if (name && name !== s.name) rename.mutate({ id: s.id, name });
                }}
              >
                <Pencil size={14} aria-hidden />
              </button>
              <button
                className={iconBtn}
                aria-label={`Delete ${s.name}`}
                onClick={() => {
                  if (window.confirm(`Delete saved query "${s.name}"?`)) remove.mutate(s.id);
                }}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </details>

      <details open className="border-t border-line">
        <summary className={summaryCls}>History ({entries.length})</summary>
        <div className="max-h-64 overflow-y-auto pb-1">
          {!entries.length && <p className="px-2 py-1 text-xs text-muted">No queries yet.</p>}
          {entries.map((h) => (
            <button
              key={h.id}
              className={cn(rowCls, focusRing)}
              title={h.error ? `${h.error}\n\n${h.sql}` : h.sql}
              onClick={() => onUse(h.sql)}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0',
                  h.error ? 'bg-danger' : 'bg-transparent',
                )}
                aria-hidden
              />
              {/* `.struck` was written for exactly this and nothing used it: a statement that
                  failed is spent, and the printed mark says so without leaning on the red lamp. */}
              <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', h.error && 'struck')}>
                {truncateMiddle(h.sql.replace(/\s+/g, ' ').trim(), 44)}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                {h.error ? 'failed' : h.rowCount === null ? '' : `${h.rowCount.toLocaleString()}r`}{' '}
                {h.durationMs === null ? '' : duration(h.durationMs)} {ago(h.ranAt)}
              </span>
            </button>
          ))}
          {!!entries.length && (
            <button
              className={cn('px-2 py-1.5 text-xs text-muted hover:underline', focusRing)}
              onClick={() => {
                if (window.confirm('Clear the query history?')) wipe.mutate();
              }}
            >
              Clear history
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
