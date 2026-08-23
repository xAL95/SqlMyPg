import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRelation, queryKeys } from '@/lib/api';
import {
  addColumn,
  addConstraint,
  createIndex,
  defaultConstraintName,
  defaultIndexName,
  dropColumn,
  dropConstraint,
  dropIndex,
  renameColumn,
  renameTable,
  setColumnType,
  setDefault,
  setNotNull,
  type ConstraintSpec,
} from '@/lib/ddl';
import { Button, Checkbox, Dialog, ErrorBanner, Field, Input, Select, Spinner } from '@/components/ui';

type Op =
  | 'addColumn'
  | 'renameColumn'
  | 'dropColumn'
  | 'renameTable'
  | 'setType'
  | 'setNotNull'
  | 'setDefault'
  | 'addConstraint'
  | 'dropConstraint'
  | 'createIndex'
  | 'dropIndex';

const OPS: { value: Op; label: string }[] = [
  { value: 'addColumn', label: 'Add column' },
  { value: 'renameColumn', label: 'Rename column' },
  { value: 'dropColumn', label: 'Drop column' },
  { value: 'setType', label: 'Change column type' },
  { value: 'setNotNull', label: 'Set / drop NOT NULL' },
  { value: 'setDefault', label: 'Set / drop DEFAULT' },
  { value: 'renameTable', label: 'Rename table' },
  { value: 'addConstraint', label: 'Add constraint' },
  { value: 'dropConstraint', label: 'Drop constraint' },
  { value: 'createIndex', label: 'Create index' },
  { value: 'dropIndex', label: 'Drop index' },
];

const KINDS: { value: ConstraintSpec['kind']; label: string }[] = [
  { value: 'primaryKey', label: 'PRIMARY KEY' },
  { value: 'unique', label: 'UNIQUE' },
  { value: 'foreignKey', label: 'FOREIGN KEY' },
  { value: 'check', label: 'CHECK' },
];

const FK_ACTIONS = ['', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION'];

/** Every ALTER goes to the editor: a schema change is worth reading, and some cannot be undone. */
export default function AlterTableDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  name,
  onEmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema: string;
  name: string;
  onEmit: (sql: string) => void;
}) {
  const t = { schema, name };
  const [op, setOp] = useState<Op>('addColumn');
  const [column, setColumn] = useState('');
  const [newName, setNewName] = useState('');
  const [type, setType] = useState('text');
  const [using, setUsing] = useState('');
  const [notNull, setNotNullFlag] = useState(false);
  const [defaultExpr, setDefaultExpr] = useState('');
  const [cascade, setCascade] = useState(false);
  const [kind, setKind] = useState<ConstraintSpec['kind']>('unique');
  const [cname, setCname] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [checkExpr, setCheckExpr] = useState('');
  const [refTable, setRefTable] = useState('');
  const [refColumns, setRefColumns] = useState('');
  const [onDelete, setOnDelete] = useState('');
  const [onUpdate, setOnUpdate] = useState('');
  const [target, setTarget] = useState('');
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState('');
  const [where, setWhere] = useState('');

  const detail = useQuery({
    queryKey: queryKeys.relation({ connectionId, schema, name }),
    queryFn: () => getRelation({ connectionId, schema, name }),
    enabled: open,
  });
  const columns = detail.data?.columns ?? [];
  const constraints = detail.data?.constraints ?? [];
  const indexes = detail.data?.indexes ?? [];

  // the pickers need a value the moment the catalog data lands, not only after a click
  const col = column || columns[0]?.name || '';
  const selected = columns.find((c) => c.name === col);
  const suggestedName =
    op === 'createIndex' ? defaultIndexName(name, cols) : defaultConstraintName(name, kind, cols);
  const effectiveName = cname.trim() === '' ? suggestedName : cname.trim();

  const { sql, problem } = useMemo((): { sql: string; problem: string | null } => {
    const need = (ok: boolean, msg: string) => (ok ? null : msg);
    try {
      switch (op) {
        case 'addColumn': {
          const p = need(newName.trim() !== '' && type.trim() !== '', 'Give the new column a name and a type.');
          return { sql: p ? '' : addColumn(t, { name: newName.trim(), type, notNull, defaultExpr }), problem: p };
        }
        case 'renameColumn': {
          const p = need(col !== '' && newName.trim() !== '', 'Pick a column and give it a new name.');
          return { sql: p ? '' : renameColumn(t, col, newName.trim()), problem: p };
        }
        case 'dropColumn': {
          const p = need(col !== '', 'Pick a column.');
          return { sql: p ? '' : dropColumn(t, col, cascade), problem: p };
        }
        case 'renameTable': {
          const p = need(newName.trim() !== '', 'Give the table a new name.');
          return { sql: p ? '' : renameTable(t, newName.trim()), problem: p };
        }
        case 'setType': {
          const p = need(col !== '' && type.trim() !== '', 'Pick a column and a new type.');
          return { sql: p ? '' : setColumnType(t, col, type, using), problem: p };
        }
        case 'setNotNull': {
          const p = need(col !== '', 'Pick a column.');
          return { sql: p ? '' : setNotNull(t, col, notNull), problem: p };
        }
        case 'setDefault': {
          const p = need(col !== '', 'Pick a column.');
          return { sql: p ? '' : setDefault(t, col, defaultExpr), problem: p };
        }
        case 'addConstraint': {
          if (kind === 'check') {
            const p = need(checkExpr.trim() !== '', 'Write the CHECK expression.');
            return {
              sql: p ? '' : addConstraint(t, { kind: 'check', name: effectiveName, expression: checkExpr }),
              problem: p,
            };
          }
          if (kind === 'foreignKey') {
            const refs = refColumns
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '');
            const p = need(
              cols.length > 0 && refTable.trim() !== '' && refs.length > 0,
              'Pick the local columns, and name the referenced table and its columns.',
            );
            return {
              sql: p
                ? ''
                : addConstraint(t, {
                    kind: 'foreignKey',
                    name: effectiveName,
                    columns: cols,
                    refSchema: schema,
                    refTable: refTable.trim(),
                    refColumns: refs,
                    onDelete: onDelete || undefined,
                    onUpdate: onUpdate || undefined,
                  }),
              problem: p,
            };
          }
          const p = need(cols.length > 0, 'Pick at least one column.');
          return { sql: p ? '' : addConstraint(t, { kind, name: effectiveName, columns: cols }), problem: p };
        }
        case 'dropConstraint': {
          const pick = target || constraints[0]?.name || '';
          const p = need(pick !== '', 'This table has no constraints to drop.');
          return { sql: p ? '' : dropConstraint(t, pick, cascade), problem: p };
        }
        case 'createIndex': {
          const p = need(cols.length > 0, 'Pick at least one column.');
          return {
            sql: p ? '' : createIndex(t, { name: effectiveName, columns: cols, unique, method, where }),
            problem: p,
          };
        }
        case 'dropIndex': {
          const pick = target || indexes[0]?.name || '';
          const p = need(pick !== '', 'This table has no indexes to drop.');
          return { sql: p ? '' : dropIndex(schema, pick, cascade), problem: p };
        }
      }
    } catch (e) {
      return { sql: '', problem: e instanceof Error ? e.message : String(e) };
    }
  }, [
    op,
    schema,
    name,
    col,
    newName,
    type,
    using,
    notNull,
    defaultExpr,
    cascade,
    kind,
    effectiveName,
    cols,
    checkExpr,
    refTable,
    refColumns,
    onDelete,
    onUpdate,
    target,
    unique,
    method,
    where,
    constraints,
    indexes,
  ]);

  const columnPicker = (
    <Field label="Column" htmlFor="alter-col">
      <Select id="alter-col" value={col} onChange={(e) => setColumn(e.target.value)} className="font-mono">
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} : {c.typeName}
          </option>
        ))}
      </Select>
    </Field>
  );

  const multiColumnPicker = (
    <Field label="Columns" hint="Ctrl+click for more than one - the order you pick is the order used">
      <Select
        multiple
        value={cols}
        onChange={(e) => setCols([...e.target.selectedOptions].map((o) => o.value))}
        className="h-28 font-mono"
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </Select>
    </Field>
  );

  const cascadeBox = (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <Checkbox checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
      CASCADE - also drop whatever depends on it
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Alter ${schema}.${name}`}
      description="Builds the statement and opens it in a query tab - nothing runs until you do."
      width={640}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={sql === ''}
            onClick={() => {
              onEmit(sql);
              onOpenChange(false);
            }}
          >
            Open in editor
          </Button>
        </>
      }
    >
      {detail.isPending ? (
        <Spinner />
      ) : detail.error ? (
        <ErrorBanner message={detail.error instanceof Error ? detail.error.message : 'Could not read the table'} />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Operation" htmlFor="alter-op">
            <Select id="alter-op" value={op} onChange={(e) => setOp(e.target.value as Op)}>
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {op === 'addColumn' ? (
            <>
              <Field label="Name" htmlFor="alter-new">
                <Input
                  id="alter-new"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Type">
                <Input value={type} onChange={(e) => setType(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Default" hint="raw SQL, not a literal: now() and 0 both work as typed">
                <Input value={defaultExpr} onChange={(e) => setDefaultExpr(e.target.value)} className="font-mono" />
              </Field>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <Checkbox checked={notNull} onChange={(e) => setNotNullFlag(e.target.checked)} />
                NOT NULL - needs a default, or an empty table
              </label>
            </>
          ) : null}

          {op === 'renameColumn' ? (
            <>
              {columnPicker}
              <Field label="New name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" />
              </Field>
            </>
          ) : null}

          {op === 'dropColumn' ? (
            <>
              {columnPicker}
              {cascadeBox}
            </>
          ) : null}

          {op === 'renameTable' ? (
            <Field label="New table name">
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" />
            </Field>
          ) : null}

          {op === 'setType' ? (
            <>
              {columnPicker}
              <Field label="New type">
                <Input value={type} onChange={(e) => setType(e.target.value)} className="font-mono" />
              </Field>
              <Field
                label="USING"
                hint="left empty, the column is cast to the new type; override it when that cast will not do"
              >
                <Input value={using} onChange={(e) => setUsing(e.target.value)} className="font-mono" />
              </Field>
              {selected?.defaultExpr ? (
                <p className="text-xs text-warn">
                  This column defaults to <code className="font-mono">{selected.defaultExpr}</code>. Postgres refuses a
                  type change while a default it cannot cast is attached, so drop the default first with
                  &ldquo;Set / drop DEFAULT&rdquo;. It is not dropped for you - the default is yours to keep or replace.
                </p>
              ) : null}
            </>
          ) : null}

          {op === 'setNotNull' ? (
            <>
              {columnPicker}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <Checkbox checked={notNull} onChange={(e) => setNotNullFlag(e.target.checked)} />
                NOT NULL {notNull ? '(SET)' : '(DROP)'}
              </label>
            </>
          ) : null}

          {op === 'setDefault' ? (
            <>
              {columnPicker}
              <Field label="Default" hint="empty drops the default rather than setting it to nothing">
                <Input value={defaultExpr} onChange={(e) => setDefaultExpr(e.target.value)} className="font-mono" />
              </Field>
            </>
          ) : null}

          {op === 'addConstraint' ? (
            <>
              <Field label="Kind" htmlFor="alter-kind">
                <Select
                  id="alter-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ConstraintSpec['kind'])}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Constraint name" hint={`empty uses ${suggestedName}`}>
                <Input
                  value={cname}
                  onChange={(e) => setCname(e.target.value)}
                  placeholder={suggestedName}
                  className="font-mono"
                />
              </Field>
              {kind === 'check' ? (
                <Field label="Expression" hint="the text that goes inside CHECK ( ... )">
                  <Input
                    value={checkExpr}
                    onChange={(e) => setCheckExpr(e.target.value)}
                    placeholder="qty > 0"
                    className="font-mono"
                  />
                </Field>
              ) : (
                multiColumnPicker
              )}
              {kind === 'foreignKey' ? (
                <>
                  <Field label="References table" hint={`in schema ${schema}`}>
                    <Input value={refTable} onChange={(e) => setRefTable(e.target.value)} className="font-mono" />
                  </Field>
                  <Field label="References columns" hint="comma-separated, in the same order as above">
                    <Input
                      value={refColumns}
                      onChange={(e) => setRefColumns(e.target.value)}
                      placeholder="id"
                      className="font-mono"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Field label="ON DELETE" className="flex-1">
                      <Select value={onDelete} onChange={(e) => setOnDelete(e.target.value)}>
                        {FK_ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a || '(default)'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="ON UPDATE" className="flex-1">
                      <Select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)}>
                        {FK_ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a || '(default)'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {op === 'dropConstraint' ? (
            <>
              <Field label="Constraint" htmlFor="alter-target">
                <Select
                  id="alter-target"
                  value={target || constraints[0]?.name || ''}
                  onChange={(e) => setTarget(e.target.value)}
                  className="font-mono"
                >
                  {constraints.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} - {c.definition}
                    </option>
                  ))}
                </Select>
              </Field>
              {cascadeBox}
            </>
          ) : null}

          {op === 'createIndex' ? (
            <>
              {multiColumnPicker}
              <Field label="Index name" hint={`empty uses ${suggestedName}`}>
                <Input
                  value={cname}
                  onChange={(e) => setCname(e.target.value)}
                  placeholder={suggestedName}
                  className="font-mono"
                />
              </Field>
              <div className="flex gap-2">
                <Field label="Method" hint="empty means btree" className="flex-1">
                  <Input
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    placeholder="btree"
                    className="font-mono"
                  />
                </Field>
                <Field label="WHERE" hint="makes it a partial index" className="flex-1">
                  <Input value={where} onChange={(e) => setWhere(e.target.value)} className="font-mono" />
                </Field>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <Checkbox checked={unique} onChange={(e) => setUnique(e.target.checked)} />
                UNIQUE
              </label>
            </>
          ) : null}

          {op === 'dropIndex' ? (
            <>
              <Field label="Index" htmlFor="alter-target">
                <Select
                  id="alter-target"
                  value={target || indexes[0]?.name || ''}
                  onChange={(e) => setTarget(e.target.value)}
                  className="font-mono"
                >
                  {indexes.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name}
                      {i.isPrimary ? ' (primary key)' : i.isUnique ? ' (unique)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              {cascadeBox}
            </>
          ) : null}

          <Field label="Statement" error={problem}>
            <pre className="max-h-40 overflow-auto bg-surface p-2 font-mono text-xs whitespace-pre-wrap">
              {sql || '(fill the fields above)'}
            </pre>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
