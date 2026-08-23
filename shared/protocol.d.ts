/**
 * Wire contract between SqlMyPg server and web client.
 * TYPES ONLY - this file is imported with `import type` from both packages and is
 * never emitted, so it must contain no runtime values (no const / enum / function).
 */

/* ------------------------------- primitives ------------------------------- */

export type FieldMeta = {
  name: string;
  /** pg_type.oid */
  dataTypeId: number;
  /** resolved type name, e.g. "int8", "timestamptz" */
  typeName: string;
  tableOid: number;
  columnId: number;
};

/** Rows are arrays (pg rowMode 'array'): smaller payloads, duplicate column names survive. */
export type Row = (string | null)[];

export type QueryError = {
  message: string;
  code?: string;
  /** 1-based character offset into the statement text */
  position?: number;
  detail?: string;
  hint?: string;
  where?: string;
  /** offset of this statement inside the submitted script, for editor markers */
  scriptOffset?: number;
};

export type Notice = {
  severity: string;
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
};

export type TxStatus = 'idle' | 'in_transaction' | 'failed';

/* ------------------------------- execution -------------------------------- */

export type StatementKind = 'rows' | 'command';

export type StatementResult = {
  index: number;
  sql: string;
  /** character offset of this statement in the submitted script */
  offset: number;
  kind: StatementKind;
  /** pg command tag, e.g. "SELECT", "INSERT", "CREATE TABLE" */
  command: string | null;
  fields: FieldMeta[];
  rows: Row[];
  /** rows affected for commands; rows fetched so far for cursors */
  rowCount: number | null;
  /** true when more rows remain behind `cursorId` */
  truncated: boolean;
  /** open server-side cursor on the session's pinned connection (last row-returning statement only) */
  cursorId?: string;
  durationMs: number;
  notices: Notice[];
  error?: QueryError;
};

export type ExecRequest = {
  sql: string;
  /** max rows materialized per statement (default 1000) */
  maxRows?: number;
};

export type ExecResponse = {
  executionId: string;
  statements: StatementResult[];
  txStatus: TxStatus;
  totalDurationMs: number;
  /** true when execution stopped early because a statement failed */
  aborted: boolean;
};

export type FetchRequest = { count?: number };

export type FetchResponse = {
  rows: Row[];
  /** cursor exhausted; it has been closed server-side */
  done: boolean;
  /** total rows read through this cursor so far */
  totalFetched: number;
};

/* -------------------------------- sessions -------------------------------- */

export type SessionState = {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  /** true while a statement is running on the pinned connection */
  busy: boolean;
  txStatus: TxStatus;
  /** pg backend pid, used for cancel */
  backendPid: number;
  createdAt: string;
  lastUsedAt: string;
  hasOpenCursor: boolean;
  serverVersion: string;
};

export type CreateSessionRequest = {
  connectionId: string;
  /** ms; 0 disables. default from server config */
  statementTimeoutMs?: number;
};

/* ------------------------------ connections ------------------------------- */

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export type ConnectionInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  color: string | null;
  readOnly: boolean;
  createdAt: string;
};

export type ConnectionInput = {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** omitted on update = keep stored password */
  password?: string;
  sslMode?: SslMode;
  color?: string | null;
  readOnly?: boolean;
};

export type TestConnectionResult = {
  ok: boolean;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
};

/* ----------------------------- introspection ------------------------------ */

export type SchemaInfo = { name: string; owner: string; isSystem: boolean };

export type RelKind = 'table' | 'view' | 'matview' | 'partitioned' | 'foreign';

export type RelationInfo = {
  oid: number;
  schema: string;
  name: string;
  kind: RelKind;
  /** planner estimate - never COUNT(*) on a billion-row table */
  estimatedRows: number;
  totalBytes: number;
  comment: string | null;
};

export type ColumnInfo = {
  name: string;
  position: number;
  typeName: string;
  notNull: boolean;
  defaultExpr: string | null;
  isPrimaryKey: boolean;
  identity: boolean;
  generated: boolean;
  comment: string | null;
};

export type IndexInfo = {
  name: string;
  definition: string;
  isPrimary: boolean;
  isUnique: boolean;
  isValid: boolean;
  totalBytes: number;
};

export type ConstraintInfo = {
  name: string;
  kind: 'p' | 'f' | 'u' | 'c' | 'x' | 't';
  definition: string;
};

export type RelationDetail = {
  relation: RelationInfo;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  /** referencing tables (inbound FKs) */
  referencedBy: { schema: string; name: string; constraint: string }[];
};

export type RoutineInfo = {
  schema: string;
  name: string;
  kind: 'function' | 'procedure';
  args: string;
  returns: string;
};

/** payload for Monaco autocompletion - one flat blob per connection, cached client-side */
export type CompletionSnapshot = {
  schemas: string[];
  relations: { schema: string; name: string; kind: RelKind; columns: string[] }[];
  functions: string[];
  fetchedAt: string;
};

/* --------------------------------- browse --------------------------------- */

/** keyset (seek) pagination - OFFSET is O(n) and unusable at scale */
export type BrowseRequest = {
  schema: string;
  name: string;
  limit?: number;
  orderBy?: { column: string; desc: boolean }[];
  /** values of the last row's orderBy columns, to seek past */
  after?: (string | null)[];
  /** raw SQL predicate; the server parameterises nothing here, it is the user's own SQL */
  where?: string;
};

export type BrowseResponse = {
  fields: FieldMeta[];
  rows: Row[];
  /** the orderBy actually used (falls back to primary key, then ctid) */
  orderBy: { column: string; desc: boolean }[];
  cursorKey: (string | null)[] | null;
  done: boolean;
  estimatedRows: number;
  sql: string;
  /**
   * Columns of the relation's unique key (primary key, else narrowest unique index). Empty
   * when it has none - browsing then falls back to ctid, which is not stable enough to
   * address a row by, so editing and deleting are not offered.
   */
  keyColumns: string[];
};

/* --------------------------------- history -------------------------------- */

export type HistoryEntry = {
  id: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  durationMs: number | null;
  rowCount: number | null;
  error: string | null;
  ranAt: string;
};

export type SavedQuery = {
  id: string;
  name: string;
  sql: string;
  connectionId: string | null;
  updatedAt: string;
};

/* ---------------------------------- auth ---------------------------------- */

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  provider: 'local' | 'oidc';
};

export type AuthConfig = {
  /** true when no user exists yet: the first signup becomes admin */
  needsBootstrap: boolean;
  localEnabled: boolean;
  oidcEnabled: boolean;
  oidcLabel: string | null;
};

/* -------------------------------- websocket ------------------------------- */

export type ServerMessage =
  | { type: 'hello'; sessions: SessionState[] }
  | { type: 'session-state'; session: SessionState }
  | { type: 'session-closed'; sessionId: string; reason: string }
  | { type: 'notice'; sessionId: string; notice: Notice }
  | { type: 'exec-start'; sessionId: string; executionId: string; statementCount: number }
  | { type: 'stmt-start'; sessionId: string; executionId: string; index: number; sql: string }
  | {
      type: 'stmt-end';
      sessionId: string;
      executionId: string;
      index: number;
      durationMs: number;
      rowCount: number | null;
      command: string | null;
      error?: QueryError;
    }
  | { type: 'exec-end'; sessionId: string; executionId: string; txStatus: TxStatus; aborted: boolean }
  // Emitted once a history row has actually landed, so the panel refetches after the write and
  // not before it. Every path into query history goes through recordQuery, which is what makes one
  // hook enough for exec, grid writes, DDL and privilege changes alike.
  | { type: 'history'; connectionId: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'ping' };

/* ------------------------------ roles and acl ----------------------------- */

/** A cluster role and its attributes. The password hash is never sent, only whether one exists. */
export type RoleAttributes = {
  name: string;
  canLogin: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassrls: boolean;
  /** -1 means no limit */
  connectionLimit: number;
  validUntil: string | null;
  hasPassword: boolean;
  /** roles this one is a direct member of */
  memberOf: string[];
};

/**
 * What one role holds on one object.
 *
 * `direct` is what the object's own ACL grants it. `effective` is what it can actually exercise,
 * which also covers membership in another role and owning the object. A role with an empty `direct`
 * and a full `effective` inherited everything; the reverse never happens.
 */
export type RolePrivileges = {
  role: string;
  direct: string[];
  effective: string[];
  isOwner: boolean;
};

export type RelationAcl = {
  schema: string;
  name: string;
  kind: RelKind;
  owner: string;
  roles: RolePrivileges[];
};

export type SchemaAcl = {
  schema: string;
  owner: string;
  roles: RolePrivileges[];
};

/**
 * A relation named by a result field's `tableOid`, so an arbitrary query result can be written
 * back to the table its columns came from.
 *
 * Postgres reports `tableOid` and `columnId` (attnum) on a RowDescription only for output columns
 * that are a plain reference to a stored column, which is what makes this safe to ask for: an
 * expression, an aggregate or a set operation reports 0 and is therefore never editable.
 */
export type RelationByOid = {
  oid: number;
  schema: string;
  name: string;
  kind: RelKind;
  columns: { name: string; attnum: number }[];
  /** attnums of the best unique key: primary key, else narrowest unique non-partial index */
  keyAttnums: number[];
};

/** A privilege change the server builds itself; no SQL text crosses the wire. */
export type AclChange = {
  action: 'grant' | 'revoke';
  privileges: string[];
  /** a relation, or the schema itself */
  schema: string;
  name?: string;
  roles: string[];
  cascade?: boolean;
};
