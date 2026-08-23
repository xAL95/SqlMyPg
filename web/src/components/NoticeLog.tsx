import { useEffect, useMemo, useRef } from 'react';
import type { Notice, StatementResult } from '@shared/protocol';
import { cn, duration } from '@/lib/format';
import { Button, toast } from '@/components/ui';

type Tone = 'stmt' | 'error' | 'warn' | 'notice' | 'dim';
type Line = { tone: Tone; text: string };

const TONE: Record<Tone, string> = {
  stmt: 'text-fg',
  error: 'text-danger',
  warn: 'text-warn',
  notice: 'text-ident',
  dim: 'text-muted',
};

function toneOf(severity: string): Tone {
  const s = severity.toUpperCase();
  if (s === 'ERROR' || s === 'FATAL' || s === 'PANIC') return 'error';
  if (s === 'WARNING') return 'warn';
  if (s === 'NOTICE' || s === 'INFO') return 'notice';
  return 'dim';
}

function noticeLines(n: Notice): Line[] {
  const out: Line[] = [
    { tone: toneOf(n.severity), text: `${n.severity}:  ${n.message}${n.code ? `  (${n.code})` : ''}` },
  ];
  if (n.detail) out.push({ tone: 'dim', text: `  DETAIL:  ${n.detail}` });
  if (n.hint) out.push({ tone: 'dim', text: `  HINT:    ${n.hint}` });
  return out;
}

export default function NoticeLog({ statements, notices }: { statements: StatementResult[]; notices: Notice[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const lines = useMemo(() => {
    const out: Line[] = [];
    for (const s of statements) {
      const head = s.sql.replace(/\s+/g, ' ').trim().slice(0, 80);
      const tag = s.command ?? (s.error ? 'ERROR' : '—');
      const count = s.rowCount != null ? `  ${s.rowCount.toLocaleString()} row${s.rowCount === 1 ? '' : 's'}` : '';
      out.push({
        tone: 'stmt',
        text: `[${duration(s.durationMs)}]  ${tag}${count}${s.truncated ? '  (truncated)' : ''}  ${head}`,
      });
      for (const n of s.notices) out.push(...noticeLines(n));
      if (s.error) {
        const e = s.error;
        out.push({ tone: 'error', text: `ERROR:  ${e.message}${e.code ? `  (${e.code})` : ''}` });
        if (e.detail) out.push({ tone: 'dim', text: `  DETAIL:  ${e.detail}` });
        if (e.hint) out.push({ tone: 'dim', text: `  HINT:    ${e.hint}` });
        if (e.position != null) out.push({ tone: 'dim', text: `  at character ${e.position}` });
        if (e.where) out.push({ tone: 'dim', text: `  CONTEXT: ${e.where}` });
      }
    }
    for (const n of notices) out.push(...noticeLines(n));
    return out;
  }, [statements, notices]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
        <span className="text-xs text-muted">
          {statements.length} statement{statements.length === 1 ? '' : 's'} · {lines.length} lines
        </span>
        <Button
          className="ml-auto"
          disabled={!lines.length}
          onClick={() => {
            void navigator.clipboard.writeText(lines.map((l) => l.text).join('\n')).then(
              () => toast('Copied log'),
              () => toast('Could not copy log'),
            );
          }}
        >
          Copy all
        </Button>
      </div>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap"
      >
        {lines.length ? (
          lines.map((l, i) => (
            // Index keys: the log is append-only, a line never moves.
            <div key={i} className={cn('break-all', TONE[l.tone])}>
              {l.text}
            </div>
          ))
        ) : (
          <div className="text-muted">no output yet</div>
        )}
      </div>
    </div>
  );
}
