import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash'),
  provider: text('provider').notNull().default('local'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: createdAt(),
});

export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(5432),
    database: text('database').notNull(),
    dbUser: text('db_user').notNull(),
    passwordEnc: text('password_enc'),
    sslMode: text('ssl_mode').notNull().default('prefer'),
    color: text('color'),
    readOnly: boolean('read_only').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('connections_owner_id_name_unique').on(t.ownerId, t.name)],
);

export const queryHistory = pgTable(
  'query_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** deliberately not a FK: history outlives the connection it ran on */
    connectionId: text('connection_id'),
    connectionName: text('connection_name').notNull(),
    sql: text('sql').notNull(),
    durationMs: integer('duration_ms'),
    rowCount: bigint('row_count', { mode: 'number' }),
    error: text('error'),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('query_history_user_id_ran_at_idx').on(t.userId, t.ranAt.desc())],
);

export const savedQueries = pgTable(
  'saved_queries',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sql: text('sql').notNull(),
    connectionId: text('connection_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('saved_queries_owner_id_name_unique').on(t.ownerId, t.name)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type QueryHistoryRow = typeof queryHistory.$inferSelect;
export type NewQueryHistory = typeof queryHistory.$inferInsert;
export type SavedQueryRow = typeof savedQueries.$inferSelect;
export type NewSavedQuery = typeof savedQueries.$inferInsert;
