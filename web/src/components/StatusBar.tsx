import type { ExecResponse, SessionState } from '@shared/protocol';
import { cn, duration, rowsEstimate, truncateMiddle } from '@/lib/format';
import { Kbd } from '@/components/ui';

const WS_LABEL = { connecting: 'sync', open: 'live', closed: 'offline' } as const;

/**
 * The status rail. Every fact here is a permanent annotation rather than something you hover to
 * discover: a quiet label and a value in tabular figures, sitting on the panel it
 * describes. Nothing on this rail reflows when a query starts, so the eye can rest on a position
 * and read it as a gauge.
 */
function Annot({
  k,
  children,
  className,
  title,
  width,
}: {
  k: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
  width?: string;
}) {
  return (
    <span className={cn('annot shrink-0', width, className)} title={title}>
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </span>
  );
}

export default function StatusBar({
  session,
  lastExec,
  wsState,
  /** what the active tab is, so an absent session can be explained rather than left blank */
  scope,
  /** planner estimate for the relation being browsed; never a COUNT(*) */
  rowEstimate,
}: {
  session: SessionState | null;
  lastExec: ExecResponse | null;
  wsState: 'connecting' | 'open' | 'closed';
  scope?: 'query' | 'browse' | null;
  rowEstimate?: number | null;
}) {
  // Browsing deliberately runs on a pool so it can never block the pinned connection.
  const pooled = !session && scope === 'browse';
  // Nothing open at all: no pid, session, estimate or last statement exists to report.
  const idle = !session && !pooled;
  const tx = session?.txStatus ?? 'idle';
  const stmt = lastExec?.statements.at(-1);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 rule-t bg-surface px-3">
      <Annot k="Conn" className="min-w-0 shrink" title={session ? `PostgreSQL ${session.serverVersion}` : undefined}>
        {session ? (
          <span className="truncate">
            <span className="text-ident">{session.connectionName}</span>
            <span className="text-faint">/</span>
            {session.database}
          </span>
        ) : pooled ? (
          <span className="text-muted">pooled</span>
        ) : (
          <span className="text-faint">none</span>
        )}
      </Annot>

      {idle ? (
        <span className="flex items-center gap-1.5 text-sm text-muted">
          Nothing open. <Kbd>Ctrl+T</Kbd> opens a session, <Kbd>Ctrl+P</Kbd> jumps to a table
        </span>
      ) : null}

      {idle ? null : (
        <>
      <Annot k="PID" width="w-24" title={session ? `session ${session.id}` : undefined}>
        {session ? (
          session.backendPid
        ) : (
          <span className="text-faint" title={pooled ? 'browsing runs on a pooled connection' : undefined}>
            {pooled ? 'pool' : '—'}
          </span>
        )}
      </Annot>

      <Annot k="Session" width="w-32">
        {session ? (
          <span className="text-muted">{truncateMiddle(session.id, 12)}</span>
        ) : (
          <span className="text-faint">{pooled ? 'not pinned' : '—'}</span>
        )}
      </Annot>

      {/* The transaction state is the headline fact of this product, so it is the one place on
          the rail that fills with colour: the accent while a transaction is open, red once it has
          aborted. The wording changes too, so the state survives colour being removed. */}
      <span
        role="status"
        aria-live="polite"
        hidden={idle}
        className={cn(
          'shrink-0 rounded-full border px-2 text-xs font-medium',
          tx === 'idle' && 'border-line text-faint',
          tx === 'in_transaction' && 'border-accent bg-accent text-accent-fg',
          tx === 'failed' && 'border-danger bg-danger text-white',
        )}
      >
        {tx === 'idle' && (pooled ? 'No transaction (pooled)' : 'No transaction')}
        {tx === 'in_transaction' && 'In transaction'}
        {tx === 'failed' && 'Transaction aborted'}
      </span>

      <Annot
        k="Est"
        width="w-28"
        title="Planner estimate from pg_class.reltuples - never COUNT(*)"
      >
        {rowEstimate == null ? <span className="text-faint">—</span> : rowsEstimate(rowEstimate)}
      </Annot>

        </>
      )}

      {session?.hasOpenCursor ? (
        <span className="shrink-0 rounded-full border border-warn/50 bg-warn/12 px-2 text-xs font-medium text-warn">
          Cursor open
        </span>
      ) : null}

      <span className="flex-1" />

      {/* Fixed width: the row must not reflow when a query starts or finishes. */}
      {idle ? null : (
      <Annot k="Last" width="w-64" className="justify-end">
        {session?.busy ? (
          <span className="text-accent-text">running</span>
        ) : stmt ? (
          <span className={cn('truncate', stmt.error && 'text-danger')}>
            {[
              stmt.error ? 'error' : stmt.command,
              stmt.rowCount === null ? null : `${stmt.rowCount.toLocaleString()} rows`,
              duration(lastExec?.totalDurationMs ?? stmt.durationMs),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </Annot>
      )}

      {/* The socket is a lamp: a filled square rather than a dot, and it carries its own word. */}
      <Annot k="WS" width="w-20" className="justify-end" title={`WebSocket ${wsState}`}>
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              wsState === 'open' && 'bg-ok',
              wsState === 'connecting' && 'bg-warn',
              wsState === 'closed' && 'bg-danger',
            )}
          />
          {WS_LABEL[wsState]}
        </span>
      </Annot>
    </footer>
  );
}
