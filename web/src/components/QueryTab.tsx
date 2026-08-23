import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal, Play } from 'lucide-react';
import type { Notice, QueryError, SessionState, StatementResult } from '@shared/protocol';
import {
  ApiError,
  cancelSession,
  exec,
  explain,
  fetchCursor,
  getCompletion,
  postExport,
  queryKeys,
  relationsByOid,
  saveQuery,
  updateCell,
} from '@/lib/api';
import { editTarget, keyOf, tableOids } from '@/lib/resultEdit';
import { onServerMessage } from '@/lib/ws';
import { ensureSession, forgetSessionId } from '@/lib/tabSession';
import { cn, duration, rowsEstimate } from '@/lib/format';
import {
  Badge,
  Button,
  DropdownMenu,
  ErrorBanner,
  Spinner,
  TabActions,
  toast,
} from '@/components/ui';
import ResultGrid from '@/components/ResultGrid';
import NoticeLog from '@/components/NoticeLog';
// Monaco is ~4 MB of the bundle and nothing outside this component touches it, so it loads as
// its own chunk after first paint: the login screen and the schema tree must not wait for an
// editor the user has not looked at yet.
const SqlEditor = lazy(() => import('@/components/SqlEditor'));

const MAX_ROWS_KEY = 'sqlmypg.maxRows';
const SPLIT_KEY = 'sqlmypg.querySplit';
const MAX_ROWS = [200, 1000, 5000, 20000];

type Props = {
  tabId: string;
  connectionId: string;
  connectionName: string;
  /** owned by the shell: deriving it here is how the editor ended up on the wrong theme */
  theme: 'light' | 'dark';
  /** hidden tabs stay mounted, so only the active one may claim the shared actions slot */
  active?: boolean;
  /** the connection refuses writes, so the grid must not offer an edit it cannot complete */
  readOnly?: boolean;
  initialSql?: string;
  onDirty?: (tabId: string, sql: string) => void;
  onSessionChange?: (tabId: string, session: SessionState | null) => void;
};

/** live view of a running script, from the stmt-start/stmt-end websocket messages */
type Progress = {
  index: number;
  done: boolean;
  command?: string | null;
  rowCount?: number | null;
  durationMs?: number;
  failed?: boolean;
};

function toQueryError(e: unknown): QueryError {
  const body = (e as { body?: unknown } | null)?.body as Partial<QueryError> | undefined;
  if (body && typeof body === 'object' && typeof body.message === 'string') return body as QueryError;
  return { message: e instanceof Error ? e.message : String(e) };
}

export default function QueryTab({
  tabId,
  connectionId,
  connectionName,
  theme,
  active = true,
  readOnly = false,
  initialSql,
  onDirty,
  onSessionChange,
}: Props) {
  const [sql, setSql] = useState(initialSql ?? '');
  const [session, setSession] = useState<SessionState | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [statements, setStatements] = useState<StatementResult[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<QueryError | null>(null);
  const [marker, setMarker] = useState<{ offset: number; length?: number; message: string } | null>(
    null,
  );
  const [bottom, setBottom] = useState<'results' | 'messages' | 'plan'>('results');
  const [explainSql, setExplainSql] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [maxRows, setMaxRows] = useState(
    () => Number(localStorage.getItem(MAX_ROWS_KEY)) || 1000,
  );
  const [ratio, setRatio] = useState(() => Number(localStorage.getItem(SPLIT_KEY)) || 0.45);

  const busy = useRef(false); // one exec / one cursor fetch at a time per session
  const fetching = useRef(false);
  const cursorStmt = useRef<{ sql: string; start: number; end: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const shown = statements.find((s) => s.index === selected) ?? statements[0];

  /* --------------------------------- session -------------------------------- */

  useEffect(() => {
    let live = true;
    setSession(null);
    setAttachError(null);
    ensureSession(connectionId).then(
      (s) => live && setSession(s),
      (e: unknown) => live && setAttachError(toQueryError(e).message),
    );
    return () => {
      live = false;
    };
  }, [connectionId, attempt]);

  const onSessionRef = useRef(onSessionChange);
  const onDirtyRef = useRef(onDirty);
  onSessionRef.current = onSessionChange;
  onDirtyRef.current = onDirty;
  useEffect(() => onSessionRef.current?.(tabId, session), [tabId, session]);
  useEffect(() => onDirtyRef.current?.(tabId, sql), [tabId, sql]);

  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    return onServerMessage((m) => {
      switch (m.type) {
        case 'session-state':
          if (m.session.id === sid) setSession(m.session);
          break;
        case 'session-closed':
          if (m.sessionId === sid) {
            forgetSessionId(connectionId);
            setSession(null);
            setAttachError(`The backend session was closed: ${m.reason}`);
          }
          break;
        case 'notice':
          if (m.sessionId === sid) setNotices((n) => [...n, m.notice]);
          break;
        case 'exec-start':
          if (m.sessionId === sid) setProgress([]);
          break;
        case 'stmt-start':
          if (m.sessionId === sid) setProgress((p) => [...p, { index: m.index, done: false }]);
          break;
        case 'stmt-end':
          if (m.sessionId === sid)
            setProgress((p) =>
              p.map((x) =>
                x.index === m.index
                  ? {
                      ...x,
                      done: true,
                      command: m.command,
                      rowCount: m.rowCount,
                      durationMs: m.durationMs,
                      failed: !!m.error,
                    }
                  : x,
              ),
            );
          break;
      }
    });
  }, [session?.id, connectionId]);

  /* ---------------------------------- run ---------------------------------- */

  const showError = useCallback((e: QueryError) => {
    setError(e);
    setMarker({
      offset: (e.scriptOffset ?? 0) + (e.position ? e.position - 1 : 0),
      message: e.message,
    });
  }, []);

  const run = useCallback(
    async (text: string) => {
      const sid = session?.id;
      if (!sid || busy.current || !text.trim()) return;
      busy.current = true;
      setRunning(true);
      setError(null);
      setMarker(null);
      setNotices([]);
      setProgress([]);
      setStatements([]);
      try {
        const res = await exec(sid, { sql: text, maxRows });
        setStatements(res.statements);
        const failed = res.statements.find((s) => s.error);
        const lastRows = res.statements.filter((s) => s.kind === 'rows').at(-1);
        setSelected((failed ?? lastRows ?? res.statements.at(-1))?.index ?? 0);
        if (failed?.error) showError(failed.error);
      } catch (e) {
        showError(toQueryError(e));
      } finally {
        busy.current = false;
        setRunning(false);
      }
    },
    [session?.id, maxRows, showError],
  );

  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Date.now() - t0), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const cancel = useCallback(async () => {
    const sid = session?.id;
    if (!sid) return;
    try {
      await cancelSession(sid);
      toast('Cancel sent to the backend');
    } catch (e) {
      toast(toQueryError(e).message);
    }
  }, [session?.id]);

  const loadMore = useCallback(async () => {
    const sid = session?.id;
    const st = shown;
    if (!sid || !st?.cursorId || !st.truncated || fetching.current) return;
    fetching.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchCursor(sid, st.cursorId, { count: maxRows });
      setStatements((prev) =>
        prev.map((s) =>
          s.index === st.index
            ? {
                ...s,
                rows: [...s.rows, ...page.rows],
                rowCount: page.totalFetched,
                truncated: !page.done,
              }
            : s,
        ),
      );
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      if (status === 409) {
        // cursor gone (session used elsewhere). Clearing truncated stops the grid asking again,
        // which is also what keeps this toast to exactly one.
        setStatements((prev) =>
          prev.map((s) => (s.index === st.index ? { ...s, truncated: false } : s)),
        );
        toast('The cursor was closed - re-run the query to read further.');
      } else toast(toQueryError(e).message);
    } finally {
      fetching.current = false;
      setLoadingMore(false);
    }
  }, [session?.id, shown, maxRows]);

  /* ------------------------------ side requests ----------------------------- */

  const completion = useQuery({
    queryKey: queryKeys.completion({ connectionId }),
    queryFn: () => getCompletion({ connectionId }),
    staleTime: 5 * 60_000,
  });

  /**
   * Writing back into a query result.
   *
   * A result column carries the oid of the table it came from, so the tables behind the current
   * result are resolved once and each column is then judged on its own - see lib/resultEdit for
   * the rules and why the full key has to be in the projection.
   */
  const oids = useMemo(() => tableOids(shown?.fields ?? []), [shown?.fields]);
  const sources = useQuery({
    queryKey: queryKeys.relationsByOid(connectionId, oids),
    queryFn: () => relationsByOid({ connectionId, oids }),
    enabled: oids.length > 0,
    staleTime: 60_000,
  });
  const relations = useMemo(
    () => new Map((sources.data ?? []).map((r) => [r.oid, r])),
    [sources.data],
  );

  const editReason = (columnIndex: number): string | null => {
    if (readOnly) return 'This connection is read-only.';
    // A grid edit runs on a pooled connection, not on this tab's pinned session. With a
    // transaction open here it would wait on locks this very tab is holding - so it is refused
    // rather than left to hang, and the tab's own UPDATE is the way through.
    if (session && session.txStatus !== 'idle') {
      return (
        'This tab has a transaction open. A grid edit runs on a separate connection, so it would ' +
        'block on the locks this tab is holding - COMMIT or ROLLBACK first, or write the UPDATE here.'
      );
    }
    if (!shown) return 'Nothing has been run in this tab yet.';
    if (oids.length && sources.isPending) return 'Still resolving the table this column came from.';
    if (sources.error) return 'The table this column came from could not be resolved.';
    const v = editTarget(shown.fields, columnIndex, relations);
    return 'reason' in v ? v.reason : null;
  };

  const onEditCell = async (rowIndex: number, columnIndex: number, next: string | null) => {
    if (!shown) throw new Error('nothing to edit');
    const v = editTarget(shown.fields, columnIndex, relations);
    if ('reason' in v) throw new Error(v.reason);
    const row = shown.rows[rowIndex];
    if (!row) throw new Error('that row is no longer in this result; run the query again');

    const res = await updateCell({
      connectionId,
      schema: v.target.schema,
      name: v.target.table,
      key: keyOf(row, v.target),
      column: v.target.column,
      value: next,
    });
    if (res.rowCount === 0) {
      throw new Error('No row matched - it may have changed since this result was fetched');
    }

    // Patch the one cell with what Postgres stored. Re-running the statement would be a different
    // query with different side effects, so a result set is never silently re-executed.
    // ponytail: a join that projects the same table row twice leaves the other copies stale until
    // the query is run again; patching by key across the result would be the fix if it matters.
    setStatements((prev) =>
      prev.map((s) => {
        if (s.index !== shown.index) return s;
        const rows = s.rows.slice();
        const target = rows[rowIndex];
        if (!target) return s;
        const patched = target.slice();
        patched[columnIndex] = res.value;
        rows[rowIndex] = patched;
        return { ...s, rows };
      }),
    );
    toast(`Updated ${v.target.table}.${v.target.column}`);
  };

  const plan = useQuery({
    queryKey: ['explain', session?.id, explainSql],
    queryFn: () => explain({ connectionId, sql: explainSql ?? '' }),
    enabled: !!session?.id && !!explainSql,
    staleTime: 60_000,
    retry: false,
  });

  /** what Run / Explain / Export act on: the shown result, else the statement at the cursor */
  const targetSql = () => shown?.sql ?? cursorStmt.current?.sql ?? sql;
  const cursorSql = () => cursorStmt.current?.sql ?? sql;

  const showPlan = () => {
    setExplainSql(targetSql().trim() || null);
    setBottom('plan');
  };

  const exportCsv = async () => {
    const sid = session?.id;
    const text = targetSql();
    if (!sid || !text.trim()) return;
    try {
      await postExport({ connectionId, sql: text, format: 'csv' });
    } catch (e) {
      toast(toQueryError(e).message);
    }
  };

  const save = async () => {
    if (!sql.trim()) return;
    // ponytail: window.prompt for the name, swap in the ui Dialog when saved queries grow folders
    const name = window.prompt('Save this query as', `${connectionName} query`);
    if (!name) return;
    try {
      await saveQuery({ name, sql, connectionId });
      toast(`Saved "${name}"`);
    } catch (e) {
      toast(toQueryError(e).message);
    }
  };

  /* --------------------------------- layout -------------------------------- */

  useEffect(() => {
    localStorage.setItem(MAX_ROWS_KEY, String(maxRows));
  }, [maxRows]);
  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(ratio));
  }, [ratio]);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) =>
      setRatio(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* --------------------------------- render -------------------------------- */

  if (attachError) {
    return (
      <div className="p-3">
        <ErrorBanner
          message={attachError}
          hint="Each query tab pins its own backend connection."
          onRetry={() => setAttempt((a) => a + 1)}
        />
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted">
        <Spinner /> attaching to a dedicated backend on {connectionName}
      </div>
    );
  }

  const chips = statements.length
    ? statements.map((s) => ({
        index: s.index,
        label: s.command ?? `#${s.index + 1}`,
        rowCount: s.rowCount,
        durationMs: s.durationMs,
        failed: !!s.error,
        done: true,
      }))
    : progress.map((p) => ({
        index: p.index,
        label: p.command ?? `#${p.index + 1}`,
        rowCount: p.rowCount ?? null,
        durationMs: p.durationMs,
        failed: !!p.failed,
        done: p.done,
      }));

  const planRoot = rootPlan(plan.data);

  /* The controls, rendered into the tab strip. The pid and the transaction state are already
     permanent on the status rail, so only the running clock and the transaction warning repeat
     here - and the warning repeats because it is the one that costs something to miss. */
  const controls = (
    <>
      {running ? (
        <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted">
          <Spinner /> {duration(elapsed)}
        </span>
      ) : null}
      {session.txStatus !== 'idle' ? (
        <span title="Uncommitted work is pinned to this tab. COMMIT or ROLLBACK to release it.">
          {session.txStatus === 'in_transaction' ? (
            <Badge tone="accent">In transaction</Badge>
          ) : (
            <Badge tone="danger">Transaction aborted</Badge>
          )}
        </span>
      ) : null}

      <Button
        size="sm"
        variant="primary"
        onClick={() => run(cursorSql())}
        disabled={running || !sql.trim()}
        title="Run the statement the cursor is in (Ctrl+Enter)"
      >
        <Play className="size-4" aria-hidden />
        Run
      </Button>
      <Button
        size="sm"
        onClick={() => run(sql)}
        disabled={running || !sql.trim()}
        title="Run every statement in the editor, in order (Ctrl+Shift+Enter)"
      >
        Run all
      </Button>
      {/* Only ever usable while a statement is in flight, so it appears then rather than sitting
          dead on the strip. */}
      {running ? (
        <Button size="sm" variant="danger" onClick={cancel} title="pg_cancel_backend on this session">
          Cancel
        </Button>
      ) : null}

      <label className="flex shrink-0 items-center gap-1.5 text-sm text-muted">
        Rows
        <select
          className="h-7 rounded-md border border-line-strong bg-elevated px-2 text-sm text-fg"
          value={maxRows}
          onChange={(e) => setMaxRows(Number(e.target.value))}
        >
          {MAX_ROWS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()}
            </option>
          ))}
        </select>
      </label>

      <DropdownMenu
        trigger={
          <button
            type="button"
            aria-label="More query actions"
            title="More actions"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        }
        items={[
          { label: 'Explain this statement', disabled: running, onSelect: showPlan },
          { label: 'Export the result as CSV', disabled: running, onSelect: exportCsv },
          { label: 'Save this query', onSelect: save },
        ]}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {active ? <TabActions>{controls}</TabActions> : null}

      <div ref={boxRef} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0" style={{ flex: `0 0 ${ratio * 100}%` }}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-muted">
                <Spinner /> Loading editor
              </div>
            }
          >
          <SqlEditor
            value={sql}
            onChange={setSql}
            connectionId={connectionId}
            completion={completion.data ?? null}
            running={running}
            onRun={(text) => void run(text)}
            onCancel={() => void cancel()}
            onSave={() => void save()}
            marker={marker}
            theme={theme}
            onStatementChange={(s) => {
              cursorStmt.current = s;
            }}
          />
          </Suspense>
        </div>

        <div
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="horizontal"
          className="h-1.5 shrink-0 cursor-row-resize bg-elevated hover:bg-accent"
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {error && (
            <div className="p-2">
              <ErrorBanner
                message={error.message}
                code={error.code}
                hint={error.hint ?? error.detail}
                onDismiss={() => setError(null)}
              />
            </div>
          )}

          {chips.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1">
              {chips.map((c) => (
                <button
                  key={c.index}
                  onClick={() => setSelected(c.index)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 border px-2 py-0.5 text-xs',
                    c.index === selected
                      ? 'border-accent bg-accent-soft'
                      : 'border-line text-muted',
                  )}
                >
                  {c.failed && <span className="size-1.5 bg-danger" />}
                  {!c.done && <Spinner />}
                  <span className="font-medium">{c.label}</span>
                  {c.rowCount != null && <span>{c.rowCount.toLocaleString()}</span>}
                  {c.durationMs != null && <span>{duration(c.durationMs)}</span>}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1 border-b border-line px-2">
            {(['results', 'messages', 'plan'] as const).map((t) => (
              <button
                key={t}
                onClick={() => (t === 'plan' ? showPlan() : setBottom(t))}
                className={cn(
                  'px-2 py-1 text-xs capitalize',
                  bottom === t
                    ? 'border-b border-accent text-fg'
                    : 'text-muted hover:text-fg dark:hover:text-fg',
                )}
              >
                {t === 'messages' && notices.length ? `messages (${notices.length})` : t}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {bottom === 'results' && (
              <ResultGrid
                fields={shown?.fields ?? []}
                rows={shown?.rows ?? []}
                rowCount={shown?.rowCount ?? null}
                truncated={!!shown?.truncated}
                loadingMore={loadingMore}
                onLoadMore={shown?.cursorId && shown.truncated ? loadMore : undefined}
                emptyLabel={
                  running ? 'running' : shown ? 'no rows' : 'Ctrl+Enter runs the statement at the cursor'
                }
                sql={shown?.sql}
                onEditCell={onEditCell}
                editReason={editReason}
              />
            )}
            {bottom === 'messages' && <NoticeLog statements={statements} notices={notices} />}
            {bottom === 'plan' && (
              <div className="p-2">
                {plan.isFetching && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Spinner /> planning
                  </div>
                )}
                {plan.error && <ErrorBanner message={toQueryError(plan.error).message} />}
                {!plan.isFetching && !plan.error && planRoot && (
                  <PlanNode node={planRoot} depth={0} />
                )}
                {!plan.isFetching && !plan.error && !planRoot && (
                  <div className="text-sm text-muted">
                    No plan yet - press Explain for the current statement.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- plan ---------------------------------- */

type Plan = {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Plan Rows'?: number;
  'Total Cost'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  Plans?: Plan[];
};

/** tolerant of raw EXPLAIN (FORMAT JSON) output and of a { plan } wrapper around it */
function rootPlan(raw: unknown): Plan | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== 'object') return null;
  const o = first as Record<string, unknown>;
  if (o['Plan']) return o['Plan'] as Plan;
  if (o['plan']) return rootPlan(o['plan']);
  if (o['Node Type']) return o as Plan;
  return null;
}

function PlanNode({ node, depth }: { node: Plan; depth: number }) {
  return (
    <div>
      <div
        className="flex flex-wrap items-baseline gap-x-3 py-0.5 font-mono text-xs"
        style={{ paddingLeft: depth * 16 }}
      >
        <span className="font-semibold">
          {depth > 0 && <span className="text-faint">-&gt; </span>}
          {node['Node Type'] ?? 'Node'}
        </span>
        {(node['Relation Name'] || node['Index Name']) && (
          <span className="text-muted">
            on {node['Relation Name'] ?? ''}
            {node['Index Name'] ? ` using ${node['Index Name']}` : ''}
          </span>
        )}
        <span className="text-muted">rows~{rowsEstimate(node['Plan Rows'] ?? 0)}</span>
        <span className="text-muted">cost {(node['Total Cost'] ?? 0).toFixed(2)}</span>
        {node['Actual Rows'] != null && (
          <span className="text-ok">
            actual {node['Actual Rows'].toLocaleString()}
            {node['Actual Total Time'] != null ? ` in ${duration(node['Actual Total Time'])}` : ''}
          </span>
        )}
      </div>
      {(node.Plans ?? []).map((child, i) => (
        <PlanNode key={i} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
