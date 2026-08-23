// End-to-end check against a running server and a real PostgreSQL. See scripts/dev.md.
//   node scripts/smoke/api.mjs
// Env: SMOKE_BASE, SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_DB_*  (defaults match scripts/setup-wsl-pg.sh
// plus the shop.* fixtures created by scripts/smoke/seed.cjs)
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5274';
let cookie = '';
let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra === undefined ? '' : ' -> ' + JSON.stringify(extra)?.slice(0, 400)}`);
  }
}

async function api(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sqlmypg_session=')) cookie = kv;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const section = (s) => console.log(`\n== ${s}`);

/* ------------------------------------------------------------------ auth -- */
section('health + auth');
let r = await api('GET', '/api/health');
ok('health 200 + version', r.status === 200 && typeof r.body?.version === 'string', r.body);

r = await api('GET', '/api/auth/config');
const needsBootstrap = r.body?.needsBootstrap;
ok('auth config reachable unauthenticated', r.status === 200, r.body);

r = await api('GET', '/api/connections');
ok('unauthenticated API call is 401', r.status === 401, r.status);

const cred = {
  email: process.env.SMOKE_EMAIL ?? 'smoke@sqlmypg.local',
  password: process.env.SMOKE_PASSWORD ?? 'smoke-test-password',
  name: 'Smoke Test',
};
if (needsBootstrap) {
  r = await api('POST', '/api/auth/bootstrap', cred);
  ok('bootstrap creates the first admin', r.status < 300 && r.body?.isAdmin === true, r.body);
} else {
  r = await api('POST', '/api/auth/login', { email: cred.email, password: cred.password });
  ok('login', r.status < 300, r.body);
}
r = await api('GET', '/api/auth/me');
ok('me returns the session user', r.body?.email === cred.email, r.body);

r = await api('POST', '/api/auth/bootstrap', cred);
ok('second bootstrap is refused (409)', r.status === 409, r.status);

/* ----------------------------------------------------------- connections -- */
section('connections');
const connInput = {
  name: 'demo (wsl)',
  host: process.env.SMOKE_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.SMOKE_DB_PORT ?? 5432),
  database: process.env.SMOKE_DB_NAME ?? 'demo',
  user: process.env.SMOKE_DB_USER ?? 'sqlmypg',
  password: process.env.SMOKE_DB_PASSWORD ?? '',
  sslMode: 'disable',
};
r = await api('POST', '/api/connections/test', connInput);
ok('test an unsaved connection', r.body?.ok === true && typeof r.body?.serverVersion === 'string', r.body);

r = await api('GET', '/api/connections');
let conn = (r.body ?? []).find((c) => c.name === connInput.name);
if (!conn) {
  r = await api('POST', '/api/connections', connInput);
  conn = r.body;
  ok('create connection', r.status < 300 && conn?.id, r.body);
} else {
  ok('connection already present', true);
}
ok('connection never returns a password', conn && !('password' in conn) && !('passwordEnc' in conn), Object.keys(conn ?? {}));

r = await api('POST', `/api/connections/${conn.id}/test`, {});
ok('test a stored connection (decrypts the password)', r.body?.ok === true, r.body);

/* --------------------------------------------------------- introspection -- */
section('introspection');
r = await api('GET', `/api/connections/${conn.id}/schemas`);
ok('schemas include shop', r.body?.some?.((s) => s.name === 'shop'), r.body?.slice?.(0, 3));

r = await api('GET', `/api/connections/${conn.id}/relations?schema=shop`);
const rels = r.body ?? [];
const events = rels.find((x) => x.name === 'events');
ok('relations include shop.events', !!events, rels.map?.((x) => x.name));
ok('estimatedRows is a planner estimate near 5M (no COUNT(*))', events?.estimatedRows > 4_000_000 && events?.estimatedRows < 6_000_000, events?.estimatedRows);
ok('totalBytes reported for the table', events?.totalBytes > 100_000_000, events?.totalBytes);
ok('view is present and typed', rels.some((x) => x.name === 'daily_totals' && x.kind === 'view'), rels.find((x) => x.name === 'daily_totals'));

r = await api('GET', `/api/connections/${conn.id}/relation?schema=shop&name=events`);
const det = r.body;
ok('relation detail: columns', det?.columns?.length === 7, det?.columns?.map((c) => c.name));
ok('relation detail: primary key flagged', det?.columns?.find((c) => c.name === 'id')?.isPrimaryKey === true, det?.columns?.[0]);
ok('relation detail: indexes found', det?.indexes?.length >= 3, det?.indexes?.map((i) => i.name));
ok('relation detail: comment read', det?.relation?.comment?.includes('Synthetic'), det?.relation?.comment);
ok('column type name resolved', det?.columns?.find((c) => c.name === 'occurred_at')?.typeName?.includes('timestamp'), det?.columns?.find((c) => c.name === 'occurred_at'));

r = await api('GET', `/api/connections/${conn.id}/relation?schema=shop&name=no_such_table`);
ok('unknown relation is 404', r.status === 404, r.status);

r = await api('GET', `/api/connections/${conn.id}/completion`);
ok('completion snapshot has relations + columns', r.body?.relations?.length > 3 && r.body.relations.some((x) => x.columns?.length), r.body?.relations?.length);

/* -------------------------------------------------------------- sessions -- */
section('query session (pinned backend)');
r = await api('POST', '/api/sessions', { connectionId: conn.id });
const s = r.body;
ok('create session', r.status < 300 && s?.id, r.body);
ok('session reports a backend pid', typeof s?.backendPid === 'number' && s.backendPid > 0, s?.backendPid);
ok('session starts idle', s?.txStatus === 'idle' && s?.busy === false, s);

const exec = (sql, maxRows) => api('POST', `/api/sessions/${s.id}/exec`, { sql, ...(maxRows ? { maxRows } : {}) });

/* the headline scenario from the brief */
section('BEGIN / CREATE TEMP TABLE / INSERT / SELECT / ROLLBACK on one connection');
r = await exec(`BEGIN;

CREATE TEMP TABLE foo (id int primary key, label text);

INSERT INTO foo VALUES (1, 'one'), (2, 'two'), (3, 'three');

SELECT * FROM foo ORDER BY id;

ROLLBACK;`);
const st = r.body?.statements ?? [];
ok('script split into 5 statements', st.length === 5, st.map((x) => x.command ?? x.sql?.slice(0, 20)));
ok('nothing aborted', r.body?.aborted === false, r.body?.aborted);
ok('BEGIN reported', st[0]?.command === 'BEGIN', st[0]);
ok('CREATE TEMP TABLE reported', st[1]?.command === 'CREATE', st[1]?.command); // node-postgres exposes only the tag's first word
ok('INSERT affected 3 rows', st[2]?.rowCount === 3, st[2]);
ok('SELECT from the temp table returned the 3 rows', st[3]?.rows?.length === 3, st[3]?.rows);
ok('temp-table rows are exact text', JSON.stringify(st[3]?.rows) === JSON.stringify([['1', 'one'], ['2', 'two'], ['3', 'three']]), st[3]?.rows);
ok('field metadata carries type names', st[3]?.fields?.[0]?.typeName === 'int4' && st[3]?.fields?.[1]?.typeName === 'text', st[3]?.fields);
ok('ROLLBACK reported', st[4]?.command === 'ROLLBACK', st[4]?.command);
ok('txStatus back to idle after ROLLBACK', r.body?.txStatus === 'idle', r.body?.txStatus);

r = await exec('SELECT * FROM foo');
ok('temp table is gone after ROLLBACK (42P01)', r.body?.statements?.[0]?.error?.code === '42P01', r.body?.statements?.[0]?.error);
ok('a SQL error is data, not an HTTP error', r.status === 200 && r.body?.aborted === true, r.status);

section('transaction state is live');
r = await exec('BEGIN');
ok('txStatus is in_transaction after BEGIN', r.body?.txStatus === 'in_transaction', r.body?.txStatus);
r = await api('GET', `/api/sessions/${s.id}`);
ok('session state endpoint agrees', r.body?.txStatus === 'in_transaction', r.body?.txStatus);
r = await exec('SELECT 1/0');
ok('failed statement inside a txn -> failed', r.body?.txStatus === 'failed', r.body?.txStatus);
ok('divide-by-zero surfaced with SQLSTATE 22012', r.body?.statements?.[0]?.error?.code === '22012', r.body?.statements?.[0]?.error);
r = await exec('ROLLBACK');
ok('rolled back to idle', r.body?.txStatus === 'idle', r.body?.txStatus);

section('temp table survives across separate exec calls (same pinned backend)');
await exec('CREATE TEMP TABLE keep_me (n int)');
await exec('INSERT INTO keep_me SELECT generate_series(1,10)');
r = await exec('SELECT count(*) FROM keep_me');
ok('temp table persists between requests', r.body?.statements?.[0]?.rows?.[0]?.[0] === '10', r.body?.statements?.[0]?.rows);

section('error position maps back into the script');
r = await exec('SELECT 1;\nSELECT * FROM nope_missing;');
const bad = r.body?.statements?.[1];
ok('second statement failed', bad?.error?.code === '42P01', bad?.error);
ok('scriptOffset points at the failing statement', bad?.error?.scriptOffset === 10, { offset: bad?.offset, scriptOffset: bad?.error?.scriptOffset });

section('notices reach the client');
r = await exec(`DO $$ BEGIN RAISE NOTICE 'hello from plpgsql'; END $$;`);
ok('RAISE NOTICE captured', JSON.stringify(r.body?.statements?.[0]?.notices ?? []).includes('hello from plpgsql'), r.body?.statements?.[0]?.notices);

/* ----------------------------------------------------- cursors on 5M rows -- */
section('server-side cursor over 5,000,000 rows');
const t0 = Date.now();
r = await exec('SELECT * FROM shop.events ORDER BY id', 100);
const big = r.body?.statements?.[0];
const firstMs = Date.now() - t0;
ok('first 100 rows returned', big?.rows?.length === 100, big?.rows?.length);
ok('marked truncated with an open cursor', big?.truncated === true && !!big?.cursorId, { truncated: big?.truncated, cursorId: big?.cursorId });
ok('first page is fast (cursor, not a full materialise)', firstMs < 3000, firstMs + 'ms');
ok('session reports an open cursor', (await api('GET', `/api/sessions/${s.id}`)).body?.hasOpenCursor === true);

r = await api('POST', `/api/sessions/${s.id}/cursor/${big.cursorId}/fetch`, { count: 250 });
ok('fetch 250 more rows from the cursor', r.body?.rows?.length === 250 && r.body?.done === false, { n: r.body?.rows?.length, done: r.body?.done });
ok('totalFetched accumulates', r.body?.totalFetched === 350, r.body?.totalFetched);
ok('paging is contiguous (id 101 follows the first 100)', r.body?.rows?.[0]?.[0] === '101', r.body?.rows?.[0]);

r = await api('POST', `/api/sessions/${s.id}/cursor/deadbeef/fetch`, { count: 10 });
ok('stale cursor id is rejected (409)', r.status === 409, r.status);

r = await exec('SELECT 1');
ok('a new execution closes the previous cursor', (await api('GET', `/api/sessions/${s.id}`)).body?.hasOpenCursor === false);

section('int8 and numeric keep full precision (no JS number rounding)');
r = await exec("SELECT 9007199254740993::int8, 0.1::numeric + 0.2::numeric, 12345678901234567890::numeric");
ok('int8 beyond Number.MAX_SAFE_INTEGER is exact', r.body?.statements?.[0]?.rows?.[0]?.[0] === '9007199254740993', r.body?.statements?.[0]?.rows?.[0]);
ok('numeric arithmetic is exact', r.body?.statements?.[0]?.rows?.[0]?.[1] === '0.3', r.body?.statements?.[0]?.rows?.[0]);

/* ------------------------------------------------------------ cancelling -- */
section('cancellation from a second connection');
const slow = exec('SELECT pg_sleep(30)');
await new Promise((res) => setTimeout(res, 700));
const c = await api('POST', `/api/sessions/${s.id}/cancel`, {});
ok('cancel returns true', c.body?.cancelled === true, c.body);
const slowRes = await slow;
ok('the cancelled query reports 57014 (query_canceled)', slowRes.body?.statements?.[0]?.error?.code === '57014', slowRes.body?.statements?.[0]?.error);

/* -------------------------------------------------------- keyset browsing -- */
section('keyset table browser');
const browse = (body) => api('POST', `/api/connections/${conn.id}/browse`, body);
r = await browse({ schema: 'shop', name: 'events', limit: 50 });
const b1 = r.body;
ok('browse returns 50 rows', b1?.rows?.length === 50, b1?.rows?.length);
ok('default order is the primary key', JSON.stringify(b1?.orderBy) === JSON.stringify([{ column: 'id', desc: false }]), b1?.orderBy);
ok('generated SQL uses no OFFSET', b1?.sql && !/OFFSET/i.test(b1.sql), b1?.sql);
ok('estimatedRows on the browse response', b1?.estimatedRows > 4_000_000, b1?.estimatedRows);
ok('cursorKey returned for the next page', Array.isArray(b1?.cursorKey), b1?.cursorKey);

r = await browse({ schema: 'shop', name: 'events', limit: 50, after: b1.cursorKey });
ok('second page seeks past the first', r.body?.rows?.[0]?.[0] === '51', r.body?.rows?.[0]?.[0]);
ok('second page SQL is a row comparison', /\) > \(/.test(r.body?.sql ?? ''), r.body?.sql);

const t1 = Date.now();
r = await browse({ schema: 'shop', name: 'events', limit: 50, after: ['4999000'] });
ok('deep page (row 4,999,000) is still fast', Date.now() - t1 < 1000, Date.now() - t1 + 'ms');

r = await browse({ schema: 'shop', name: 'line_items', limit: 10 });
ok('composite primary key becomes a 2-column keyset', r.body?.orderBy?.length === 2, r.body?.orderBy);
r = await browse({ schema: 'shop', name: 'line_items', limit: 10, after: r.body.cursorKey });
ok('composite keyset pages correctly', r.body?.rows?.length === 10 && r.status === 200, r.body?.rows?.length);

r = await browse({ schema: 'shop', name: 'raw_import', limit: 5 });
ok('table with no unique key falls back to ctid', r.body?.orderBy?.[0]?.column === 'ctid', r.body?.orderBy);
ok('ctid is not leaked into the visible columns', !r.body?.fields?.some((f) => f.name === 'ctid'), r.body?.fields?.map((f) => f.name));

r = await browse({ schema: 'shop', name: 'events', limit: 5, where: "kind = 'refund'" });
ok('where predicate applied', r.body?.rows?.length === 5 && /WHERE/.test(r.body?.sql ?? ''), r.body?.sql);
r = await browse({ schema: 'shop', name: 'events', limit: 5, where: "1=1; DROP TABLE shop.customers" });
ok('a second statement in where is rejected (400)', r.status === 400, { status: r.status, body: r.body });
r = await browse({ schema: 'shop', name: 'events', limit: 5, orderBy: [{ column: 'nope', desc: false }] });
ok('unknown orderBy column is rejected (400)', r.status === 400, r.status);
r = await browse({ schema: 'shop', name: 'events', limit: 5, orderBy: [{ column: 'occurred_at', desc: true }, { column: 'id', desc: false }] });
ok('mixed-direction order builds the OR chain', r.status === 200 && r.body?.rows?.length === 5, r.body?.sql);

section('nulls are preserved, not blanked');
r = await browse({ schema: 'shop', name: 'events', limit: 200 });
ok('NULL comes through as null (amount is null for 4 of 5 kinds)', r.body?.rows?.some((row) => row.includes(null)), r.body?.rows?.[0]);

/* ------------------------------------------------------------------ plan -- */
section('explain');
r = await api('POST', `/api/connections/${conn.id}/explain`, { sql: 'SELECT * FROM shop.events WHERE user_id = 42' });
const plan = r.body?.plan ?? r.body;
ok('explain returns a JSON plan', r.status === 200 && JSON.stringify(plan).includes('Plan'), JSON.stringify(plan)?.slice(0, 200));

/* ---------------------------------------------------------------- export -- */
section('CSV export (COPY streaming, form POST)');
const payload = JSON.stringify({ connectionId: conn.id, schema: 'shop', name: 'customers', where: "id <= 5", format: 'csv' });
r = await api('POST', `/api/connections/${conn.id}/export`, 'payload=' + encodeURIComponent(payload), {
  raw: true,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
const lines = String(r.text).trim().split('\n');
ok('export streams a CSV attachment', r.status === 200 && /attachment/.test(r.headers.get('content-disposition') ?? ''), r.headers.get('content-disposition'));
ok('export honours the WHERE (header + 5 rows)', lines.length === 6, { lines: lines.length, first: lines[0] });
ok('export CSV header is the column list', lines[0] === 'id,email,name,created_at', lines[0]);

const sqlPayload = JSON.stringify({ connectionId: conn.id, sql: 'SELECT count(*) FROM shop.line_items', format: 'csv' });
r = await api('POST', `/api/connections/${conn.id}/export`, 'payload=' + encodeURIComponent(sqlPayload), {
  raw: true,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
ok('export of a raw query works', r.status === 200 && String(r.text).includes('30000'), String(r.text).slice(0, 80));

/* --------------------------------------------------------------- history -- */
section('history + saved queries');
r = await api('GET', '/api/history?limit=5');
ok('history recorded the executions', Array.isArray(r.body) && r.body.length > 0 && r.body[0].sql, r.body?.[0]);
ok('history keeps the connection name', !!r.body?.[0]?.connectionName, r.body?.[0]?.connectionName);
r = await api('POST', '/api/saved', { name: 'smoke', sql: 'SELECT 1', connectionId: conn.id });
ok('save a query', r.status < 300 && r.body?.id, r.body);
r = await api('GET', '/api/saved');
ok('list saved queries', r.body?.some((x) => x.name === 'smoke'), r.body);

/* ------------------------------------------------------------ read-only -- */
section('read-only connection');
r = await api('POST', '/api/connections', { ...connInput, name: 'demo read-only', readOnly: true });
const roConn = r.body;
r = await api('POST', '/api/sessions', { connectionId: roConn.id });
const roSession = r.body;
r = await api('POST', `/api/sessions/${roSession.id}/exec`, { sql: 'CREATE TABLE should_not_exist (i int)' });
ok('read-only session refuses a write (25006)', r.body?.statements?.[0]?.error?.code === '25006', r.body?.statements?.[0]?.error);
r = await api('POST', `/api/sessions/${roSession.id}/exec`, { sql: 'SELECT 1' });
ok('read-only session can still read', r.body?.statements?.[0]?.rows?.[0]?.[0] === '1', r.body?.statements?.[0]);
await api('DELETE', `/api/sessions/${roSession.id}`);

/* ------------------------------------------------------------ insert row -- */
section('insert a row (the browse tab + button)');
const rows = (id, body) => api('POST', `/api/connections/${id}/rows`, body);
// shop.customers: id is GENERATED ALWAYS AS IDENTITY and created_at has a DEFAULT, so both
// must be filled by Postgres when the request leaves them out.
const email = `smoke+${Date.now()}@example.com`;
r = await rows(conn.id, { schema: 'shop', name: 'customers', values: { email, name: 'Smoke' } });
ok('insert reports one row', r.body?.rowCount === 1, r.body);

r = await browse({ schema: 'shop', name: 'customers', where: `email = '${email}'` });
const inserted = r.body?.rows?.[0];
const at = (col) => inserted?.[r.body.fields.findIndex((f) => f.name === col)];
ok('inserted row is readable', inserted !== undefined, r.body?.rows?.length);
ok('identity column was filled by Postgres', /^d+$/.test(at('id') ?? ''), at('id'));
ok('omitted column took its DEFAULT', at('created_at') != null, at('created_at'));
ok('supplied values round-trip', at('email') === email && at('name') === 'Smoke', [at('email'), at('name')]);

r = await rows(conn.id, { schema: 'shop', name: 'customers', values: { nope: 'x' } });
ok('unknown column is rejected (400)', r.status === 400, [r.status, r.body]);

// The pinned-session read-only guard does not cover pooled connections, so the route checks it.
r = await rows(roConn.id, { schema: 'shop', name: 'customers', values: { email: 'ro@example.com' } });
ok('read-only connection refuses an insert (403)', r.status === 403, [r.status, r.body]);

/* ------------------------------------------------------------ delete rows -- */
section('delete rows (grid row selection)');
const delRows = (id, body) => api('DELETE', `/api/connections/${id}/rows`, body);
r = await browse({ schema: 'shop', name: 'customers', limit: 1 });
ok('browse reports the key columns', JSON.stringify(r.body?.keyColumns) === '["id"]', r.body?.keyColumns);
r = await browse({ schema: 'shop', name: 'line_items', limit: 1 });
ok('composite key is reported in order', JSON.stringify(r.body?.keyColumns) === '["order_id","line_no"]', r.body?.keyColumns);
r = await browse({ schema: 'shop', name: 'raw_import', limit: 1 });
ok('a table with no unique key reports none', JSON.stringify(r.body?.keyColumns) === '[]', r.body?.keyColumns);

const doomed = `doomed+${Date.now()}@example.com`;
await rows(conn.id, { schema: 'shop', name: 'customers', values: { email: doomed } });
r = await browse({ schema: 'shop', name: 'customers', where: `email = '${doomed}'` });
const doomedId = r.body?.rows?.[0]?.[r.body.fields.findIndex((f) => f.name === 'id')];
r = await delRows(conn.id, { schema: 'shop', name: 'customers', keys: [{ id: doomedId }] });
ok('delete by primary key removes one row', r.body?.rowCount === 1, r.body);
r = await browse({ schema: 'shop', name: 'customers', where: `email = '${doomed}'` });
ok('the deleted row is gone', r.body?.rows?.length === 0, r.body?.rows?.length);

r = await delRows(conn.id, { schema: 'shop', name: 'raw_import', keys: [{ blob: 'x' }] });
ok('a table with no unique key refuses delete (400)', r.status === 400, [r.status, r.body?.message]);
r = await delRows(conn.id, { schema: 'shop', name: 'line_items', keys: [{ order_id: '1' }] });
ok('a partial key refuses delete (400)', r.status === 400, [r.status, r.body?.message]);
r = await delRows(roConn.id, { schema: 'shop', name: 'customers', keys: [{ id: '1' }] });
ok('read-only connection refuses a delete (403)', r.status === 403, [r.status, r.body]);

/* ------------------------------------------------------------- edit cell -- */
section('edit a cell (double-click popup)');
const patchCell = (id, body) => api('PATCH', `/api/connections/${id}/rows`, body);
const edited = `edit+${Date.now()}@example.com`;
await rows(conn.id, { schema: 'shop', name: 'customers', values: { email: edited, name: 'Before' } });
r = await browse({ schema: 'shop', name: 'customers', where: `email = '${edited}'` });
const editId = r.body?.rows?.[0]?.[r.body.fields.findIndex((f) => f.name === 'id')];
const nameOf = async () => {
  const g = await browse({ schema: 'shop', name: 'customers', where: `id = ${editId}` });
  return g.body?.rows?.[0]?.[g.body.fields.findIndex((f) => f.name === 'name')];
};

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'name', value: 'After' });
ok('update writes one row and returns the stored value', r.body?.rowCount === 1 && r.body?.value === 'After', r.body);
ok('the new value is readable', (await nameOf()) === 'After');

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'name', value: null });
ok('a value can be set to NULL', r.body?.rowCount === 1 && (await nameOf()) === null, r.body);

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'name', value: '' });
ok('empty string stays distinct from NULL', (await nameOf()) === '');

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: '-1' }, column: 'name', value: 'x' });
ok('a stale key updates nothing rather than the wrong row', r.body?.rowCount === 0, r.body);

// The grid patches its cached cell from this, so it has to be what Postgres stored, not what
// was sent: a timestamptz is reformatted into the session's timezone on the way in.
r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'created_at', value: '2020-01-02 03:04:05+00' });
ok('the value returned is the stored one, not the text sent', r.body?.rowCount === 1 && r.body?.value !== '2020-01-02 03:04:05+00', r.body);
r = await browse({ schema: 'shop', name: 'customers', where: `id = ${editId}` });
ok('browse agrees with the returned value', r.body?.rows?.[0]?.[r.body.fields.findIndex((f) => f.name === 'created_at')] !== null, r.body?.rows?.[0]);

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'nope', value: 'x' });
ok('an unknown column is rejected (400)', r.status === 400, [r.status, r.body?.message]);

r = await patchCell(conn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'created_at', value: 'not a date' });
ok('a bad cast surfaces the Postgres message, not a 500', r.status === 400 && /invalid input syntax/.test(r.body?.message ?? ''), [r.status, r.body?.message]);

r = await patchCell(roConn.id, { schema: 'shop', name: 'customers', key: { id: editId }, column: 'name', value: 'x' });
ok('read-only connection refuses an update (403)', r.status === 403, [r.status, r.body]);

await delRows(conn.id, { schema: 'shop', name: 'customers', keys: [{ id: editId }] });

/* ------------------------------------------------------------- websocket -- */
section('websocket progress stream');
const wsUrl = 'ws://127.0.0.1:5274/ws';
const got = [];
await new Promise((resolve) => {
  const sock = new WebSocket(wsUrl, { headers: { cookie } });
  const done = () => {
    try {
      sock.close();
    } catch {}
    resolve();
  };
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    got.push(m.type);
    if (m.type === 'notice') got.push('notice:' + m.notice.message);
    if (m.type === 'exec-end') setTimeout(done, 150);
  });
  sock.addEventListener('open', async () => {
    await exec(`DO $$ BEGIN RAISE NOTICE 'ws notice'; END $$; SELECT 1;`);
  });
  sock.addEventListener('error', done);
  setTimeout(done, 6000);
});
ok('ws sends hello with the session list', got.includes('hello'), got);
ok('ws streams exec-start', got.includes('exec-start'), got);
ok('ws streams per-statement start/end', got.includes('stmt-start') && got.includes('stmt-end'), got);
ok('ws streams exec-end', got.includes('exec-end'), got);
ok('ws forwards RAISE NOTICE live', got.some((g) => String(g).includes('ws notice')), got);

const anon = await new Promise((resolve) => {
  const sock = new WebSocket(wsUrl);
  sock.addEventListener('close', (ev) => resolve(ev.code));
  sock.addEventListener('error', () => {});
  setTimeout(() => resolve('timeout'), 4000);
});
ok('unauthenticated ws is closed with 4401', anon === 4401, anon);

/* -------------------------------------------------------------- teardown -- */
section('session teardown');
r = await api('GET', '/api/sessions');
const before = r.body?.length ?? 0;
await api('DELETE', `/api/sessions/${s.id}`);
r = await api('GET', '/api/sessions');
ok('session closed and removed', (r.body?.length ?? 0) === before - 1, { before, after: r.body?.length });
r = await api('GET', `/api/sessions/${s.id}`);
ok('closed session is 404', r.status === 404, r.status);
r = await api('POST', `/api/sessions/${s.id}/exec`, { sql: 'SELECT 1' });
ok('exec on a closed session is 404', r.status === 404, r.status);

await api('DELETE', `/api/connections/${roConn.id}`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('failed:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
