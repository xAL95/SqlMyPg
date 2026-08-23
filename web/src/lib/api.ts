import type {
  AclChange,
  RelationAcl,
  RelationByOid,
  RoleAttributes,
  SchemaAcl,
  AuthConfig,
  BrowseRequest,
  BrowseResponse,
  CompletionSnapshot,
  ConnectionInfo,
  ConnectionInput,
  CreateSessionRequest,
  CurrentUser,
  ExecRequest,
  ExecResponse,
  FetchRequest,
  FetchResponse,
  HistoryEntry,
  RelationDetail,
  RelationInfo,
  RoutineInfo,
  SavedQuery,
  SchemaInfo,
  SessionState,
  TestConnectionResult,
} from '@shared/protocol';

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const payload: unknown = await res.json().catch(() => undefined);
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const seg = encodeURIComponent;

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

/* ---------------------------------- auth ---------------------------------- */

export const getAuthConfig = () => request<AuthConfig>('GET', '/auth/config');
export const getMe = () => request<CurrentUser>('GET', '/auth/me');
export const login = (body: { email: string; password: string }) =>
  request<CurrentUser>('POST', '/auth/login', body);
export const logout = () => request<void>('POST', '/auth/logout');
/** first-run signup; only accepted while AuthConfig.needsBootstrap is true */
export const bootstrap = (body: { email: string; password: string; name?: string }) =>
  request<CurrentUser>('POST', '/auth/bootstrap', body);

export const listUsers = () => request<CurrentUser[]>('GET', '/auth/users');
export const createUser = (body: { email: string; password: string; name?: string; isAdmin?: boolean }) =>
  request<CurrentUser>('POST', '/auth/users', body);
export const updateUser = (id: string, body: { name?: string; password?: string; isAdmin?: boolean }) =>
  request<CurrentUser>('PATCH', `/auth/users/${seg(id)}`, body);
export const deleteUser = (id: string) => request<void>('DELETE', `/auth/users/${seg(id)}`);

/* ------------------------------- connections ------------------------------ */

export const listConnections = () => request<ConnectionInfo[]>('GET', '/connections');
export const createConnection = (body: ConnectionInput) => request<ConnectionInfo>('POST', '/connections', body);
export const updateConnection = (id: string, body: ConnectionInput) =>
  request<ConnectionInfo>('PATCH', `/connections/${seg(id)}`, body);
export const deleteConnection = (id: string) => request<void>('DELETE', `/connections/${seg(id)}`);
/** dry-run a form the user has not saved yet */
export const testConnectionInput = (body: ConnectionInput) =>
  request<TestConnectionResult>('POST', '/connections/test', body);
export const testConnection = (id: string) =>
  request<TestConnectionResult>('POST', `/connections/${seg(id)}/test`);

/* -------------------------------- sessions -------------------------------- */

export const listSessions = () => request<SessionState[]>('GET', '/sessions');
export const createSession = (body: CreateSessionRequest) => request<SessionState>('POST', '/sessions', body);
export const getSessionState = (id: string) => request<SessionState>('GET', `/sessions/${seg(id)}`);
export const closeSession = (id: string) => request<void>('DELETE', `/sessions/${seg(id)}`);
export const exec = (sessionId: string, body: ExecRequest) =>
  request<ExecResponse>('POST', `/sessions/${seg(sessionId)}/exec`, body);
export const fetchCursor = (sessionId: string, cursorId: string, body: FetchRequest = {}) =>
  request<FetchResponse>('POST', `/sessions/${seg(sessionId)}/cursor/${seg(cursorId)}/fetch`, body);
export const closeCursor = (sessionId: string) =>
  request<void>('DELETE', `/sessions/${seg(sessionId)}/cursor`);
/** pg_cancel_backend on the session's pinned backend; harmless when the session is idle */
export const cancelSession = (sessionId: string) => request<void>('POST', `/sessions/${seg(sessionId)}/cancel`);

/* ------------------------------ introspection ----------------------------- */

/** every introspection call is scoped to one connection, which is one database */
export type Target = { connectionId: string };

/** flat key/value bag out of version()/pg_settings - rendered as a table, nothing more */
export type ServerInfo = Record<string, string>;

export type ExplainRequest = { sql: string; analyze?: boolean; buffers?: boolean };
export type ExplainResponse = { plan: string };

export const getSchemas = ({ connectionId }: Target) =>
  request<SchemaInfo[]>('GET', `/connections/${seg(connectionId)}/schemas`);

export const getRelations = ({ connectionId, schema }: Target & { schema: string }) =>
  request<RelationInfo[]>('GET', `/connections/${seg(connectionId)}/relations${qs({ schema })}`);

export const getRelation = ({ connectionId, schema, name }: Target & { schema: string; name: string }) =>
  request<RelationDetail>('GET', `/connections/${seg(connectionId)}/relation${qs({ schema, name })}`);

export const getRoutines = ({ connectionId, schema }: Target & { schema: string }) =>
  request<RoutineInfo[]>('GET', `/connections/${seg(connectionId)}/routines${qs({ schema })}`);

export const getCompletion = ({ connectionId }: Target) =>
  request<CompletionSnapshot>('GET', `/connections/${seg(connectionId)}/completion`);

export const getServerInfo = ({ connectionId }: Target) =>
  request<ServerInfo>('GET', `/connections/${seg(connectionId)}/info`);

/** keyset pagination: pass the previous page's cursorKey as `after`, never an offset */
export const browse = ({ connectionId, ...req }: Target & BrowseRequest) =>
  request<BrowseResponse>('POST', `/connections/${seg(connectionId)}/browse`, req);

/**
 * Update one column of one row, addressed by its unique-key values. The returned `value` is what
 * Postgres actually stored, which a domain or a trigger can change, so callers patch their cached
 * row with that rather than with what they sent.
 */
export const updateCell = ({
  connectionId,
  ...req
}: Target & {
  schema: string;
  name: string;
  key: Record<string, string | null>;
  column: string;
  value: string | null;
}) => request<{ rowCount: number; value: string | null }>('PATCH', `/connections/${seg(connectionId)}/rows`, req);

/**
 * Resolve the tables a query result came from, named only by the tableOid Postgres puts on each
 * result column. Read-only catalog access: it lets the grid offer an edit, and grants nothing -
 * updateCell re-derives the relation and its key server-side and refuses anything that disagrees.
 */
export const relationsByOid = ({ connectionId, oids }: Target & { oids: number[] }) =>
  request<RelationByOid[]>('POST', `/connections/${seg(connectionId)}/relations/by-oid`, { oids });

/** delete rows addressed by their unique-key values; refused when the relation has no key */
export const deleteRows = ({
  connectionId,
  ...req
}: Target & { schema: string; name: string; keys: Record<string, string | null>[] }) =>
  request<{ rowCount: number }>('DELETE', `/connections/${seg(connectionId)}/rows`, req);

/** insert one row; omitted columns fall back to their default, identity or NULL */
export const insertRow = ({
  connectionId,
  ...req
}: Target & { schema: string; name: string; values: Record<string, string | null> }) =>
  request<{ rowCount: number }>('POST', `/connections/${seg(connectionId)}/rows`, req);

// ponytail: EXPLAIN runs on the introspection pool, not the tab's pinned session, so it cannot see
// session-local temp tables or a SET search_path; route it through /sessions/:id/exec if that bites.
export const explain = ({ connectionId, ...req }: Target & ExplainRequest) =>
  request<ExplainResponse>('POST', `/connections/${seg(connectionId)}/explain`, req);

/* ----------------------------------- ddl ---------------------------------- */

/**
 * Clear a table. CREATE TABLE and the ALTER family are built in the browser (see lib/ddl) and run
 * through a query tab instead, so they are reviewable and land in a transaction the user controls.
 * Only these two run on their own, because a confirm dialog is the better gesture for them.
 */
export const truncateTable = ({
  connectionId,
  ...req
}: Target & { schema: string; name: string; restartIdentity?: boolean; cascade?: boolean }) =>
  request<{ rowCount: number }>('POST', `/connections/${seg(connectionId)}/truncate`, req);

export const dropTable = ({
  connectionId,
  ...req
}: Target & { schema: string; name: string; cascade?: boolean }) =>
  request<{ rowCount: number }>('POST', `/connections/${seg(connectionId)}/drop`, req);

/* ---------------------------- roles and rights ---------------------------- */

export const getRoles = ({ connectionId }: Target) =>
  request<RoleAttributes[]>('GET', `/connections/${seg(connectionId)}/roles`);

/** Omit `name` to ask about the schema itself rather than a relation in it. */
export const getPrivileges = ({ connectionId, schema, name }: Target & { schema: string; name?: string }) =>
  request<RelationAcl | SchemaAcl>('GET', `/connections/${seg(connectionId)}/privileges${qs({ schema, name })}`);

/**
 * Apply ONE privilege change now. The server builds the statement from the catalog; a change across
 * many objects goes through the editor instead, so it can be read as one script before it runs.
 */
export const applyPrivilege = ({ connectionId, ...req }: Target & AclChange) =>
  request<{ rowCount: number }>('POST', `/connections/${seg(connectionId)}/privileges`, req);

/* --------------------------------- history -------------------------------- */

export const getHistory = (connectionId?: string, limit?: number) =>
  request<HistoryEntry[]>('GET', `/history${qs({ connectionId, limit })}`);
export const clearHistory = (connectionId?: string) => request<void>('DELETE', `/history${qs({ connectionId })}`);

export const listSaved = () => request<SavedQuery[]>('GET', '/saved');
export const saveQuery = (body: { name: string; sql: string; connectionId?: string | null }) =>
  request<SavedQuery>('POST', '/saved', body);
export const updateSaved = (id: string, body: { name?: string; sql?: string; connectionId?: string | null }) =>
  request<SavedQuery>('PATCH', `/saved/${seg(id)}`, body);
export const deleteSaved = (id: string) => request<void>('DELETE', `/saved/${seg(id)}`);

/* --------------------------------- export --------------------------------- */

export type ExportRequest = Target & {
  format: 'csv' | 'tsv';
  /** a table plus optional predicate/order (server streams it with COPY)... */
  schema?: string;
  name?: string;
  where?: string;
  orderBy?: { column: string; desc: boolean }[];
  /** ...or raw SQL, if the caller has a statement instead of a table */
  sql?: string;
  filename?: string;
};

export const exportUrl = (connectionId: string) => `/api/connections/${seg(connectionId)}/export`;

/** fetch() cannot stream a response to the user's disk, so let the browser do the download: POST a
 *  throwaway form (one urlencoded `payload` field) and rely on Content-Disposition: attachment. */
export async function postExport(req: ExportRequest): Promise<void> {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = exportUrl(req.connectionId);
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'payload';
  field.value = JSON.stringify(req);
  form.append(field);
  document.body.append(form);
  form.submit();
  form.remove();
}

/* ------------------------------- query keys ------------------------------- */

/** constants for the no-argument resources, factories for the rest - components never write keys */
export const queryKeys = {
  authConfig: ['authConfig'] as const,
  me: ['me'] as const,
  users: ['users'] as const,
  connections: ['connections'] as const,
  sessions: ['sessions'] as const,
  saved: ['saved'] as const,
  roles: (connectionId: string) => ['roles', connectionId] as const,
  session: (sessionId: string) => ['session', sessionId] as const,
  history: (connectionId: string) => ['history', connectionId] as const,
  schemas: ({ connectionId }: Target) => ['schemas', connectionId] as const,
  relations: ({ connectionId, schema }: Target & { schema: string }) =>
    ['relations', connectionId, schema] as const,
  relationsByOid: (connectionId: string, oids: number[]) =>
    ['relationsByOid', connectionId, [...oids].sort((a, b) => a - b).join(',')] as const,
  relation: ({ connectionId, schema, name }: Target & { schema: string; name: string }) =>
    ['relation', connectionId, schema, name] as const,
  routines: ({ connectionId, schema }: Target & { schema: string }) =>
    ['routines', connectionId, schema] as const,
  completion: ({ connectionId }: Target) => ['completion', connectionId] as const,
  serverInfo: ({ connectionId }: Target) => ['serverInfo', connectionId] as const,
  browse: ({ connectionId, schema, name, where, orderBy }: Target & BrowseRequest) =>
    ['browse', connectionId, schema, name, where ?? null, orderBy ?? null] as const,
};
