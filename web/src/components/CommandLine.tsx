import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectionInfo } from '@shared/protocol';
import { getCompletion, queryKeys } from '@/lib/api';
import { Search } from 'lucide-react';
import { cn } from '@/lib/format';

/**
 * The one control that reconfigures the whole workspace.
 *
 * A dealing terminal is driven from its command line, not from a chrome of buttons, so this is
 * the top rail itself rather than a floating palette: it expands in place and its hits drop
 * below as a ruled register. Everything it offers is real - relations come from the catalog
 * snapshot the editor's completion already caches, so opening one costs no extra request.
 */
export type Hit =
  | { kind: 'relation'; schema: string; name: string; relkind: string }
  | { kind: 'connection'; id: string; name: string }
  | { kind: 'action'; id: string; label: string; hint?: string };

const MAX_HITS = 9;

export default function CommandLine({
  connectionId,
  connections,
  actions,
  onOpenRelation,
  onSelectConnection,
  onAction,
}: {
  connectionId: string | null;
  connections: ConnectionInfo[];
  actions: { id: string; label: string; hint?: string }[];
  onOpenRelation: (schema: string, name: string) => void;
  onSelectConnection: (id: string) => void;
  onAction: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Ctrl+P: Monaco owns d f g h k / [ ], and the shell already took t w b and 1-9.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clicking away closes the register without clearing what was typed.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const snapshot = useQuery({
    queryKey: queryKeys.completion({ connectionId: connectionId ?? '' }),
    queryFn: () => getCompletion({ connectionId: connectionId as string }),
    enabled: !!connectionId && open,
    staleTime: 5 * 60_000,
  });

  const hits = useMemo((): Hit[] => {
    const needle = q.trim().toLowerCase();
    // A leading > asks for actions only, the way a terminal separates commands from names.
    if (needle.startsWith('>')) {
      const rest = needle.slice(1).trim();
      return actions
        .filter((a) => !rest || a.label.toLowerCase().includes(rest))
        .slice(0, MAX_HITS)
        .map((a) => ({ kind: 'action', ...a }));
    }
    if (!needle) {
      return actions.slice(0, MAX_HITS).map((a) => ({ kind: 'action', ...a }));
    }
    const out: Hit[] = [];
    for (const c of connections) {
      if (c.id !== connectionId && c.name.toLowerCase().includes(needle)) {
        out.push({ kind: 'connection', id: c.id, name: c.name });
      }
    }
    for (const r of snapshot.data?.relations ?? []) {
      if (out.length >= MAX_HITS + 4) break;
      // match on the bare name first, then the qualified one, so "users" beats "public.u"
      if (r.name.toLowerCase().includes(needle) || `${r.schema}.${r.name}`.toLowerCase().includes(needle)) {
        out.push({ kind: 'relation', schema: r.schema, name: r.name, relkind: r.kind });
      }
    }
    for (const a of actions) {
      if (a.label.toLowerCase().includes(needle)) out.push({ kind: 'action', ...a });
    }
    return out.slice(0, MAX_HITS);
  }, [q, actions, connections, connectionId, snapshot.data]);

  useEffect(() => setCursor(0), [q]);

  const run = (hit: Hit | undefined) => {
    if (!hit) return;
    if (hit.kind === 'relation') onOpenRelation(hit.schema, hit.name);
    else if (hit.kind === 'connection') onSelectConnection(hit.id);
    else onAction(hit.id);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      {/* A search field with an edge, because a bare caret on a bar is not an affordance - the
          previous world could get away with a bare prompt, this one cannot. */}
      <div className="flex h-8 max-w-2xl items-center gap-2 rounded-md border border-line-strong bg-elevated px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              inputRef.current?.blur();
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(hits[cursor]);
            }
          }}
          aria-label="Command line"
          aria-expanded={open}
          role="combobox"
          aria-controls="cmd-register"
          placeholder={
            connectionId ? 'Search tables, connections, or type > for commands' : 'Add a connection to begin'
          }
          className="h-8 w-full min-w-0 border-0 bg-transparent px-0 text-fg outline-none placeholder:text-faint"
        />
        <kbd className="hidden shrink-0 rounded-xs border border-line-strong bg-surface px-1.5 font-mono text-xs text-muted xl:inline-flex">
          Ctrl+P
        </kbd>
      </div>

      {open && hits.length > 0 ? (
        <div
          id="cmd-register"
          role="listbox"
          // The register drops out of the rail as part of the same field, bounded by the same
          // hairline: it is the rail extending, not a card floating above it.
          className="absolute top-full left-0 z-50 mt-1.5 w-full max-w-[44ch] overflow-hidden rounded-md border border-line-strong bg-elevated p-1 shadow-lg sm:max-w-[56ch]"
        >
          {hits.map((h, i) => {
            const active = i === cursor;
            const key = h.kind === 'relation' ? `${h.schema}.${h.name}` : h.kind === 'connection' ? h.id : h.id;
            return (
              <button
                key={`${h.kind}:${key}`}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setCursor(i)}
                onClick={() => run(h)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-sm',
                  active ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'w-16 shrink-0 text-xs font-medium',
                    active ? 'text-accent-fg' : 'text-faint',
                  )}
                >
                  {h.kind === 'relation' ? h.relkind : h.kind}
                </span>
                {h.kind === 'relation' ? (
                  <span className="truncate">
                    <span className={active ? 'opacity-70' : 'text-faint'}>{h.schema}.</span>
                    {h.name}
                  </span>
                ) : h.kind === 'connection' ? (
                  <span className="truncate">{h.name}</span>
                ) : (
                  <>
                    <span className="truncate">{h.label}</span>
                    {h.hint ? (
                      <span className={cn('ml-auto shrink-0 text-xs', active ? 'text-accent-fg' : 'text-faint')}>
                        {h.hint}
                      </span>
                    ) : null}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
