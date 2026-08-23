import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, PanelLeft, Plus, Sun, X } from 'lucide-react';
import type {
  ConnectionInfo,
  CurrentUser,
  ExecResponse,
  SessionState,
  StatementResult,
} from '@shared/protocol';
import {
  closeSession,
  getAuthConfig,
  getMe,
  listConnections,
  logout,
  queryKeys,
} from '@/lib/api';
import { connectWs, onServerMessage, onWsStatus, wsStatus } from '@/lib/ws';
import { forgetSessionId } from '@/lib/tabSession';
import { cn, truncateMiddle } from '@/lib/format';
import { Button, DropdownMenu, Kbd, Spinner, TAB_ACTIONS_ID, Toaster, toast } from '@/components/ui';
import CommandLine from '@/components/CommandLine';
import BrowseTab from '@/components/BrowseTab';
import ConnectionDialog from '@/components/ConnectionDialog';
import UsersDialog from '@/components/UsersDialog';
import RolesDialog from '@/components/RolesDialog';
import Login from '@/components/Login';
import QueryTab from '@/components/QueryTab';
import Sidebar from '@/components/Sidebar';
import StatusBar from '@/components/StatusBar';

type Tab = {
  id: string;
  kind: 'query' | 'browse';
  title: string;
  connectionId: string;
  connectionName: string;
  schema?: string;
  name?: string;
  sql?: string;
};

type TabState = { tabs: Tab[]; activeId: string | null };

const TABS_KEY = 'sqlmypg.tabs';
const THEME_KEY = 'sqlmypg.theme';
const WIDTH_KEY = 'sqlmypg.sidebarWidth';
const CONN_KEY = 'sqlmypg.connection';

/** Ctrl-chords Monaco owns inside the editor - never steal these. */
const MONACO_OWNED = new Set(['d', 'f', 'g', 'h', 'k', '/', '[', ']']);

/* The global focus ring is already a bracket in index.css; these keep the shell's own plates
   consistent with the primitives in ui.tsx. */
const selectCls = 'h-8 rounded-md border border-line-strong bg-elevated px-2.5 text-fg';
const iconBtn =
  'grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg';

function loadTabs(): TabState {
  try {
    const raw = sessionStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TabState;
      if (Array.isArray(parsed.tabs)) return parsed;
    }
  } catch {
    /* corrupt storage: start clean */
  }
  return { tabs: [], activeId: null };
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const authConfig = useQuery({ queryKey: queryKeys.authConfig, queryFn: getAuthConfig });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: getMe, retry: false });

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const withToaster = (node: ReactNode) => (
    <>
      {node}
      <Toaster />
    </>
  );

  if (authConfig.isPending || me.isPending) {
    return withToaster(
      <div className="grid h-dvh place-items-center bg-bg">
        <Spinner />
      </div>,
    );
  }
  if (authConfig.data?.needsBootstrap) return withToaster(<Login mode="bootstrap" />);
  if (!me.data) return withToaster(<Login mode="login" />);
  return withToaster(<Shell user={me.data} theme={theme} onToggleTheme={toggleTheme} />);
}

function Shell({
  user,
  theme,
  onToggleTheme,
}: {
  user: CurrentUser;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const qc = useQueryClient();
  const connections = useQuery({ queryKey: queryKeys.connections, queryFn: listConnections });
  const conns = connections.data ?? [];

  const [connectionId, setConnectionId] = useState<string | null>(() =>
    localStorage.getItem(CONN_KEY),
  );
  const [{ tabs, activeId }, setTabState] = useState<TabState>(loadTabs);
  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const [sessions, setSessions] = useState<Record<string, SessionState | null>>({});
  const [estimates, setEstimates] = useState<Record<string, number | null>>({});
  const [execs, setExecs] = useState<Record<string, ExecResponse>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem(WIDTH_KEY)) || 280,
  );
  const [dialog, setDialog] = useState<{
    open: boolean;
    existing: ConnectionInfo | null;
    prefill?: ConnectionInfo | null;
  }>({ open: false, existing: null });
  const [usersOpen, setUsersOpen] = useState(false);
  const [rolesFor, setRolesFor] = useState<string | null>(null);
  const [ws, setWs] = useState(() => wsStatus());

  const active = conns.find((c) => c.id === connectionId) ?? null;

  useEffect(() => {
    if (!conns.length || active) return;
    setConnectionId(conns[0]?.id ?? null);
  }, [conns, active]);
  useEffect(() => {
    if (connectionId) localStorage.setItem(CONN_KEY, connectionId);
  }, [connectionId]);
  useEffect(() => localStorage.setItem(WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);

  // sessionStorage, not localStorage: one tab list per browser tab, like the sessions.
  useEffect(() => {
    const t = setTimeout(
      () => sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId })),
      150,
    );
    return () => clearTimeout(t);
  }, [tabs, activeId]);

  useEffect(() => {
    connectWs();
    const offStatus = onWsStatus(setWs);
    const off = onServerMessage((m) => {
      switch (m.type) {
        case 'hello':
          qc.invalidateQueries({ queryKey: queryKeys.sessions });
          break;
        case 'session-state': {
          qc.invalidateQueries({ queryKey: queryKeys.sessions });
          setSessions((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const [tabId, s] of Object.entries(prev)) {
              if (s && s.id === m.session.id) {
                next[tabId] = m.session;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          break;
        }
        case 'session-closed': {
          qc.invalidateQueries({ queryKey: queryKeys.sessions });
          let ours = false;
          setSessions((prev) => {
            const next = { ...prev };
            for (const [tabId, s] of Object.entries(prev)) {
              if (s && s.id === m.sessionId) {
                next[tabId] = null;
                ours = true;
              }
            }
            return ours ? next : prev;
          });
          if (ours && m.reason !== 'client' && m.reason !== 'closed') {
            toast(`Session ended: ${m.reason}. Any open transaction was rolled back.`);
          }
          break;
        }
        // ponytail: lastExec is synthesised from ws events because QueryTab exposes no
        // onExec callback, so only timing/rowCount/error reach the StatusBar (sql, fields
        // and rows stay empty). Upgrade path: add an onExec prop to QueryTab, drop this.
        case 'exec-start':
          setExecs((p) => ({
            ...p,
            [m.sessionId]: {
              executionId: m.executionId,
              statements: [],
              txStatus: 'idle',
              totalDurationMs: 0,
              aborted: false,
            },
          }));
          break;
        case 'stmt-end':
          setExecs((p) => {
            const cur = p[m.sessionId];
            if (!cur || cur.executionId !== m.executionId) return p;
            const stmt: StatementResult = {
              index: m.index,
              sql: '',
              offset: 0,
              kind: m.rowCount === null ? 'command' : 'rows',
              command: m.command,
              fields: [],
              rows: [],
              rowCount: m.rowCount,
              truncated: false,
              durationMs: m.durationMs,
              notices: [],
              error: m.error,
            };
            return {
              ...p,
              [m.sessionId]: {
                ...cur,
                statements: [...cur.statements, stmt],
                totalDurationMs: cur.totalDurationMs + m.durationMs,
              },
            };
          });
          break;
        case 'exec-end':
          setExecs((p) => {
            const cur = p[m.sessionId];
            if (!cur || cur.executionId !== m.executionId) return p;
            return { ...p, [m.sessionId]: { ...cur, txStatus: m.txStatus, aborted: m.aborted } };
          });
          break;
      }
    });
    return () => {
      off();
      offStatus();
    };
  }, [qc]);

  const onDirty = useCallback((tabId: string, sql: string) => {
    setTabState((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, sql } : t)) }));
  }, []);
  const onSessionChange = useCallback((tabId: string, s: SessionState | null) => {
    setSessions((p) => (p[tabId] === s ? p : { ...p, [tabId]: s }));
  }, []);

  // Stable, so the browse tab's reporting effect does not re-fire on every shell render.
  const onEstimate = useCallback((tabId: string, rows: number | null) => {
    setEstimates((p) => (p[tabId] === rows ? p : { ...p, [tabId]: rows }));
  }, []);

  const select = (id: string) => setTabState((p) => ({ ...p, activeId: id }));

  function newQueryTab(sql?: string) {
    if (!active) {
      toast('Add a connection first.');
      return;
    }
    const id = crypto.randomUUID();
    setTabState((p) => ({
      tabs: [
        ...p.tabs,
        {
          id,
          kind: 'query',
          title: `Query ${p.tabs.filter((t) => t.kind === 'query').length + 1}`,
          connectionId: active.id,
          connectionName: active.name,
          sql,
        },
      ],
      activeId: id,
    }));
  }

  function closeTab(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    const s = sessions[tabId];
    if (tab?.sql?.trim() && s && s.txStatus !== 'idle') {
      const ok = window.confirm(
        `"${tab.title}" has unsaved SQL and an open transaction. Closing it rolls the transaction back. Close anyway?`,
      );
      if (!ok) return;
    }
    setTabState((p) => {
      const idx = p.tabs.findIndex((t) => t.id === tabId);
      const left = p.tabs.filter((t) => t.id !== tabId);
      const nextActive =
        p.activeId === tabId ? (left[Math.max(0, idx - 1)]?.id ?? null) : p.activeId;
      return { tabs: left, activeId: nextActive };
    });
    setSessions((p) => {
      const next = { ...p };
      delete next[tabId];
      return next;
    });
    forgetSessionId(tabId);
    // Closing the tab must not leave a pinned server connection behind.
    if (s) void closeSession(s.id).catch(() => {});
  }

  function openRelation(schema: string, name: string) {
    if (!active) return;
    const found = tabs.find(
      (t) =>
        t.kind === 'browse' &&
        t.connectionId === active.id &&
        t.schema === schema &&
        t.name === name,
    );
    if (found) return select(found.id);
    const id = crypto.randomUUID();
    setTabState((p) => ({
      tabs: [
        ...p.tabs,
        {
          id,
          kind: 'browse',
          title: truncateMiddle(`${schema}.${name}`, 28),
          connectionId: active.id,
          connectionName: active.name,
          schema,
          name,
        },
      ],
      activeId: id,
    }));
  }

  // QueryTab has no imperative handle, so pushing text in means remounting it with a fresh
  // initialSql; the server session survives because tabSession re-attaches by stored id.
  // ponytail: insert = remount, which drops the on-screen result grid. Upgrade path: an
  // insertText ref handle on QueryTab.
  function insertText(text: string) {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.kind !== 'query') return newQueryTab(text);
    const merged = tab.sql?.trim() ? `${tab.sql.replace(/\s+$/, '')}\n${text}` : text;
    setTabState((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t.id === tab.id ? { ...t, sql: merged } : t)),
    }));
    setEpochs((p) => ({ ...p, [tab.id]: (p[tab.id] ?? 0) + 1 }));
  }

  // No dep array on purpose: the handler closes over tabs/sessions and must not go stale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const key = e.key.toLowerCase();
      const inMonaco = !!(e.target as HTMLElement | null)?.closest?.('.monaco-editor');
      if (inMonaco && MONACO_OWNED.has(key)) return;
      if (key === 't') {
        e.preventDefault();
        newQueryTab();
      } else if (key === 'w') {
        e.preventDefault();
        if (activeId) closeTab(activeId);
      } else if (key === 'b') {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (key >= '1' && key <= '9') {
        const t = tabs[Number(key) - 1];
        if (t) {
          e.preventDefault();
          select(t.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function startDrag(e: ReactPointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const move = (ev: PointerEvent) =>
      setSidebarWidth(Math.min(640, Math.max(200, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const activeSession = activeId ? (sessions[activeId] ?? null) : null;
  const activeExec = activeSession ? (execs[activeSession.id] ?? null) : null;

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      {/* The top bar: what you are connected to, how to find things, and who you are. Everything
          that acts on data lives further down - on the tab strip, or in the grid itself. */}
      <header className="flex h-10 shrink-0 items-center gap-2 rule-b bg-surface px-2">
        <button
          className={iconBtn}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarOpen}
          title="Toggle sidebar (Ctrl+B)"
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <PanelLeft size={16} aria-hidden />
        </button>
        {/* Three ascending bars in a filled tile: rows in a table, and the product's only piece
            of identity. */}
        <span className="flex shrink-0 items-center gap-2 pr-1">
          <span className="grid size-6 place-items-center rounded-md bg-accent">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="text-accent-fg">
              <rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor" />
              <rect x="4.5" y="4" width="3" height="8" rx="1" fill="currentColor" />
              <rect x="9" y="0" width="3" height="12" rx="1" fill="currentColor" />
            </svg>
          </span>
          <span className="font-display text-base font-semibold text-fg">SqlMyPg</span>
        </span>

        <span aria-hidden className="h-4 w-px shrink-0 bg-line" />

        {/* The active connection is the one piece of global state, so it looks like what it is:
            a control you can open, not a label you have to guess at. */}
        <label className="sr-only" htmlFor="conn-select">
          Active connection
        </label>
        <select
          id="conn-select"
          className={cn(selectCls, 'max-w-52 shrink-0 font-medium', connectionId ? 'text-ident' : 'text-muted')}
          value={connectionId ?? ''}
          onChange={(e) => setConnectionId(e.target.value || null)}
        >
          {!conns.length && <option value="">no connections</option>}
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <span aria-hidden className="h-4 w-px shrink-0 bg-line" />

        <CommandLine
          connectionId={connectionId}
          connections={conns}
          actions={[
            { id: 'new-query', label: 'New query tab', hint: 'Ctrl+T' },
            { id: 'new-connection', label: 'Add a connection' },
            { id: 'toggle-sidebar', label: 'Toggle schema register', hint: 'Ctrl+B' },
            { id: 'toggle-theme', label: theme === 'dark' ? 'Light rendition' : 'Dark rendition' },
            { id: 'close-tab', label: 'Close this tab', hint: 'Ctrl+W' },
          ]}
          onOpenRelation={openRelation}
          onSelectConnection={setConnectionId}
          onAction={(id) => {
            if (id === 'new-query') newQueryTab();
            else if (id === 'new-connection') setDialog({ open: true, existing: null });
            else if (id === 'toggle-sidebar') setSidebarOpen((o) => !o);
            else if (id === 'toggle-theme') onToggleTheme();
            else if (id === 'close-tab' && activeId) closeTab(activeId);
          }}
        />

        <button
          className={iconBtn}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>

        <DropdownMenu
          trigger={
            <button
              className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-fg"
              aria-label={`Account menu for ${user.email}`}
            >
              <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
                {(user.name ?? user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="max-w-32 truncate">{user.name ?? user.email}</span>
            </button>
          }
          items={[
            ...(user.isAdmin ? [{ label: 'Manage users…', onSelect: () => setUsersOpen(true) }] : []),
            {
              label: 'Log out',
              onSelect: async () => {
                await logout();
                qc.clear();
              },
            },
          ]}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <aside
              className="flex min-h-0 shrink-0 flex-col overflow-hidden rule-r bg-surface"
              style={{ width: sidebarWidth }}
            >
              <Sidebar
                connectionId={connectionId}
                onSelectConnection={setConnectionId}
                onOpenRelation={openRelation}
                onInsertText={insertText}
                onEditConnection={(c) => setDialog({ open: true, existing: c })}
                onDuplicateConnection={(c) => setDialog({ open: true, existing: null, prefill: c })}
                onManageRoles={(c) => setRolesFor(c.id)}
                onNewConnection={() => setDialog({ open: true, existing: null })}
              />
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              tabIndex={0}
              onPointerDown={startDrag}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSidebarWidth((w) => Math.max(200, w - 16));
                if (e.key === 'ArrowRight') setSidebarWidth((w) => Math.min(640, w + 16));
              }}
              className="w-px shrink-0 cursor-col-resize bg-line outline-none hover:bg-accent focus-visible:bg-accent"
            />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {/* One bar instead of two. Tabs on the left; on the right, the slot the active tab
              fills with its own controls. The browse toolbar that used to sit under this strip is
              gone, and the grid now starts directly beneath the tabs. */}
          <div className="flex h-10 shrink-0 items-center gap-2 rule-b bg-surface pr-2">
            <div
              className="flex min-w-0 flex-1 items-center gap-1 self-stretch overflow-x-auto px-1"
              onDoubleClick={(e) => {
                if (e.target === e.currentTarget) newQueryTab();
              }}
            >
            {tabs.map((t) => {
              const busy = sessions[t.id]?.busy;
              const color = conns.find((c) => c.id === t.connectionId)?.color;
              return (
                <div
                  key={t.id}
                  className={cn(
                    // The active tab is a raised chip, the way this tool class draws it: it
                    // sits on the strip rather than being cut out of it.
                    'group relative flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm',
                    t.id === activeId
                      ? 'border-line bg-elevated text-fg shadow-sm'
                      : 'border-transparent text-muted hover:bg-hover hover:text-fg',
                  )}
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeTab(t.id);
                  }}
                >
                  <button
                    className="flex min-w-0 items-center gap-1.5"
                    onClick={() => select(t.id)}
                    aria-current={t.id === activeId}
                    title={`${t.connectionName} - ${t.title}`}
                  >
                    {/* Busy takes over the spot the connection's colour dot occupies at rest, so
                        the tab never changes width while a query runs. */}
                    {busy ? (
                      <Spinner />
                    ) : (
                      <span
                        className="size-2.5 shrink-0 rounded-full border border-line-strong"
                        style={color ? { background: color, borderColor: color } : undefined}
                        aria-hidden
                      />
                    )}
                    {t.title}
                  </button>
                  <button
                    className="-mr-1 grid size-5 place-items-center rounded-sm text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-danger focus-visible:opacity-100"
                    aria-label={`Close ${t.title}`}
                    onClick={() => closeTab(t.id)}
                  >
                    <X size={13} aria-hidden />
                  </button>
                </div>
              );
            })}
              <button
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
                aria-label="New query tab"
                title="New query tab (Ctrl+T)"
                onClick={() => newQueryTab()}
              >
                <Plus size={16} aria-hidden />
              </button>
            </div>

            {/* Filled by the active tab through a portal - see TAB_ACTIONS_ID in BrowseTab. */}
            <div id={TAB_ACTIONS_ID} className="flex shrink-0 items-center gap-1.5" />
          </div>

          <div className="relative min-h-0 flex-1">
            {/* Hidden tabs stay mounted: a running query and its open server-side cursor
                must survive a tab switch - that is the whole point of the session model. */}
            {tabs.map((t) => (
              <div
                key={t.id}
                className={cn('absolute inset-0', t.id !== activeId && 'hidden')}
                aria-hidden={t.id !== activeId}
              >
                {t.kind === 'query' ? (
                  <QueryTab
                    key={`${t.id}:${epochs[t.id] ?? 0}`}
                    tabId={t.id}
                    connectionId={t.connectionId}
                    connectionName={t.connectionName}
                    theme={theme}
                    active={t.id === activeId}
                    readOnly={!!conns.find((c) => c.id === t.connectionId)?.readOnly}
                    initialSql={t.sql}
                    onDirty={onDirty}
                    onSessionChange={onSessionChange}
                  />
                ) : t.schema && t.name ? (
                  <BrowseTab
                    connectionId={t.connectionId}
                    schema={t.schema}
                    name={t.name}
                    tabId={t.id}
                    active={t.id === activeId}
                    onEstimate={onEstimate}
                  />
                ) : null}
              </div>
            ))}
            {!tabs.length && (
              <div className="flex h-full items-center justify-center overflow-auto p-8">
                <div className="flex w-full max-w-2xl flex-col gap-6">
                  <div className="flex flex-col gap-3">
                    <h2 className="text-balance font-display text-[26px] leading-[34px] font-semibold text-fg">
                      Every tab holds one real Postgres backend for as long as it lives.
                    </h2>
                    <p className="text-sm text-muted">
                      A <span className="font-medium text-fg">BEGIN</span> in one of these tabs opens a transaction
                      on a pinned connection and keeps it, so temp tables,{' '}
                      <span className="font-medium text-fg">SET LOCAL</span>, advisory locks and cursors behave
                      exactly as they do in psql. Close the tab and the backend goes with it.
                    </p>
                  </div>

                  {conns.length ? (
                    <Button variant="primary" className="h-10 self-start" onClick={() => newQueryTab()}>
                      <Plus size={16} aria-hidden />
                      New query tab
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      className="h-10 self-start"
                      onClick={() => setDialog({ open: true, existing: null })}
                    >
                      <Plus size={16} aria-hidden />
                      Add a connection
                    </Button>
                  )}

                  <div className="rounded-lg border border-line bg-surface p-4">
                    <h3 className="panel-title">Ways in</h3>
                    <dl className="mt-3 flex flex-col gap-2 text-sm">
                      {[
                        ['Ctrl+T', 'open a query tab on this connection'],
                        ['Ctrl+P', 'jump to any table, or type > for commands'],
                        ['Ctrl+B', 'show or hide the schema register'],
                        ['dbl-click', 'a relation in the register browses it'],
                      ].map(([k, v]) => (
                        <div key={k} className="flex items-center gap-3">
                          <dt className="w-24 shrink-0">
                            <Kbd>{k}</Kbd>
                          </dt>
                          <dd className="text-muted">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>

                  {active ? (
                    <div className="rounded-lg border border-line bg-surface p-4">
                      <h3 className="panel-title">Connection on the wire</h3>
                      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
                        {[
                          ['Name', active.name],
                          ['Host', `${active.host}:${active.port}`],
                          ['Database', active.database],
                          ['Role', active.user],
                          ['SSL', active.sslMode],
                          ['Mode', active.readOnly ? 'read only' : 'read / write'],
                        ].map(([k, v]) => (
                          <div key={k} className="annot">
                            <dt className="k">{k}</dt>
                            <dd className="v">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      <StatusBar
        session={activeSession}
        lastExec={activeExec}
        wsState={ws}
        scope={tabs.find((t) => t.id === activeId)?.kind ?? null}
        rowEstimate={activeId ? (estimates[activeId] ?? null) : null}
      />

      <UsersDialog open={usersOpen} onOpenChange={setUsersOpen} me={user} />

      {rolesFor ? (
        <RolesDialog
          open
          onOpenChange={(o) => !o && setRolesFor(null)}
          connectionId={rolesFor}
          onEmit={insertText}
        />
      ) : null}

      <ConnectionDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        existing={dialog.existing}
        prefill={dialog.prefill}
      />
    </div>
  );
}
