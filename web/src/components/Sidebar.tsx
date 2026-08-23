import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Plus } from 'lucide-react';
import type { ConnectionInfo } from '@shared/protocol';
import { deleteConnection, listConnections, queryKeys, testConnection } from '@/lib/api';
import { cn } from '@/lib/format';
import { ContextMenu, DropdownMenu, ErrorBanner, Spinner, toast } from '@/components/ui';
import HistoryPanel from '@/components/HistoryPanel';
import SchemaTree from '@/components/SchemaTree';

/* Focus is the global bracket from index.css; nothing here needs to redraw it. */
const focusRing = '';

export default function Sidebar({
  connectionId,
  onSelectConnection,
  onOpenRelation,
  onInsertText,
  onEditConnection,
  onDuplicateConnection,
  onManageRoles,
  onNewConnection,
}: {
  connectionId: string | null;
  onSelectConnection: (id: string) => void;
  onOpenRelation: (schema: string, name: string) => void;
  onInsertText: (text: string) => void;
  onEditConnection: (c: ConnectionInfo) => void;
  onDuplicateConnection: (c: ConnectionInfo) => void;
  onManageRoles: (c: ConnectionInfo) => void;
  onNewConnection: () => void;
}) {
  const qc = useQueryClient();
  const connections = useQuery({ queryKey: queryKeys.connections, queryFn: listConnections });

  const del = useMutation({
    mutationFn: (id: string) => deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });

  async function test(c: ConnectionInfo) {
    const r = await testConnection(c.id);
    toast(r.ok ? `${c.name}: PostgreSQL ${r.serverVersion} in ${r.latencyMs} ms` : `${c.name}: ${r.error}`);
  }

  function remove(c: ConnectionInfo) {
    const ok = window.confirm(
      `Delete "${c.name}"? Live sessions on this connection will be closed and any open transaction rolled back.`,
    );
    if (ok) del.mutate(c.id);
  }

  function copy(c: ConnectionInfo) {
    const url = `postgresql://${c.user}@${c.host}:${c.port}/${c.database}?sslmode=${c.sslMode}`;
    navigator.clipboard.writeText(url).then(
      () => toast('Connection string copied'),
      () => toast('Could not access the clipboard'),
    );
  }

  const menu = (c: ConnectionInfo) => [
    { label: 'Edit', onSelect: () => onEditConnection(c) },
    { label: 'Duplicate', onSelect: () => onDuplicateConnection(c) },
    { label: 'Database roles…', onSelect: () => onManageRoles(c) },
    { label: 'Test', onSelect: () => void test(c) },
    { label: 'Copy connection string', onSelect: () => copy(c) },
    { label: 'Delete', onSelect: () => remove(c) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex h-9 shrink-0 items-center justify-between rule-b px-2">
        <h2 className="panel-title">Connections</h2>
        <button
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg',
            focusRing,
          )}
          aria-label="New connection"
          onClick={onNewConnection}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>

      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line py-1">
        {connections.isPending && (
          <div className="p-2">
            <Spinner />
          </div>
        )}
        {connections.error && <ErrorBanner error={connections.error} />}
        {connections.data?.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted">
            No connections yet. Add one to get started.
          </p>
        )}
        {connections.data?.map((c) => (
          <ContextMenu key={c.id} items={menu(c)}>
            <div
              className={cn(
                'flex items-center gap-2 px-2 py-1',
                c.id === connectionId
                  ? 'bg-accent-soft'
                  : 'hover:bg-surface dark:hover:bg-elevated',
              )}
            >
              <button
                className={cn('flex min-w-0 flex-1 items-center gap-2 text-left', focusRing)}
                onClick={() => onSelectConnection(c.id)}
                aria-current={c.id === connectionId}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full border border-line"
                  style={{ background: c.color ?? 'transparent' }}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block truncate">
                    {c.name}
                    {c.readOnly && (
                      <span className="placard ml-1 text-warn" title="every session on this connection is read only">
                        read only
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {c.host}:{c.port}/{c.database}
                  </span>
                </span>
              </button>
              <DropdownMenu
                trigger={
                  <button
                    className={cn(
                      'grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg',
                      focusRing,
                    )}
                    aria-label={`Actions for ${c.name}`}
                  >
                    <MoreVertical size={14} aria-hidden />
                  </button>
                }
                items={menu(c)}
              />
            </div>
          </ContextMenu>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {connectionId ? (
          <SchemaTree
            connectionId={connectionId}
            onOpenRelation={onOpenRelation}
            onInsertText={onInsertText}
          />
        ) : (
          <p className="px-2 py-3 text-xs text-muted">Select a connection to browse it.</p>
        )}
      </div>

      <div className="shrink-0 border-t border-line">
        <HistoryPanel connectionId={connectionId} onUse={onInsertText} />
      </div>
    </div>
  );
}
