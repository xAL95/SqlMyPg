import { Fragment, useState } from 'react';
import { createTable, type NewColumn } from '@/lib/ddl';
import { X } from 'lucide-react';
import { Button, Checkbox, Dialog, ErrorBanner, Field, Input } from '@/components/ui';

/** Suggestions only - the field takes any type expression, e.g. numeric(12,2) or text[]. */
const COMMON_TYPES = [
  'bigint', 'bigserial', 'boolean', 'bytea', 'date', 'double precision', 'integer', 'jsonb',
  'numeric', 'numeric(12,2)', 'real', 'serial', 'smallint', 'text', 'time', 'timestamptz', 'uuid',
];

/**
 * A new row starts empty. It used to prefill `text`, which read identically to this field's own
 * `text` placeholder - so a row you had set and a row you had not looked the same.
 */
const blank = (): NewColumn => ({ name: '', type: '' });

/**
 * Builds a CREATE TABLE and hands it to the editor rather than running it: a new table is worth
 * reading before it exists, and going through a query tab means it lands in the user's own
 * transaction and in query history like anything else they typed.
 */
export default function NewTableDialog({
  open,
  onOpenChange,
  schema,
  onEmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: string;
  onEmit: (sql: string) => void;
}) {
  const [name, setName] = useState('');
  const [ifNotExists, setIfNotExists] = useState(false);
  const [columns, setColumns] = useState<NewColumn[]>(() => [
    // the type field is emitted verbatim, so an identity clause belongs here and not in DEFAULT
    { name: 'id', type: 'bigint generated always as identity', primaryKey: true },
    blank(),
  ]);

  const set = (i: number, patch: Partial<NewColumn>) =>
    setColumns((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const close = () => {
    setName('');
    setColumns([blank()]);
    onOpenChange(false);
  };

  let sql = '';
  let error: string | null = null;
  try {
    sql = name.trim() === '' ? '' : createTable({ schema, name: name.trim(), ifNotExists }, columns);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // A wholly empty row is the waiting slot for the next column and is meant to be skipped. A row
  // with only one half filled is different: the builder drops it too, so without saying so here
  // a column you started would just be missing from the statement.
  const halfFilled = columns
    .map((c, i) => ({ n: i + 1, name: c.name.trim(), type: c.type.trim() }))
    .filter((c) => (c.name === '') !== (c.type === ''));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`New table in ${schema}`}
      description="Builds the statement and opens it in a query tab - nothing runs until you do."
      width={720}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            disabled={sql === ''}
            onClick={() => {
              onEmit(sql);
              close();
            }}
          >
            Open in editor
          </Button>
        </>
      }
    >
      <datalist id="pg-types">
        {COMMON_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <Field label="Table name" htmlFor="new-table-name" className="flex-1">
            <Input
              id="new-table-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="customers"
              className="font-mono"
            />
          </Field>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-muted">
            <Checkbox checked={ifNotExists} onChange={(e) => setIfNotExists(e.target.checked)} />
            IF NOT EXISTS
          </label>
        </div>

        <div className="flex flex-col gap-2">
          {/*
            One grid for the header and every row. They used to be separate grid containers sharing
            a template string, and `auto` sizes to each container's own content: the header's auto
            tracks were the words NN and PK plus an empty span, the rows' were two 12px checkboxes
            plus a remove button. Different totals meant the 1fr tracks were divided differently,
            so every label after "Column" sat right of the control it named. The control columns are
            now a fixed width both agree on, and one container computes the tracks once.
          */}
          <div className="grid grid-cols-[1fr_1fr_1.75rem_1.75rem_1fr_1.75rem] items-center gap-x-2 gap-y-1">
            <span className="placard">Column</span>
            <span className="placard">Type</span>
            <span className="placard text-center" title="NOT NULL">
              NN
            </span>
            <span className="placard text-center" title="PRIMARY KEY">
              PK
            </span>
            <span className="placard">Default</span>
            <span />
            {columns.map((c, i) => (
              <Fragment key={i}>
                <Input
                  value={c.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                  placeholder="name"
                  className="font-mono"
                  aria-label={`Column ${i + 1} name`}
                />
                <Input
                  list="pg-types"
                  value={c.type}
                  onChange={(e) => set(i, { type: e.target.value })}
                  placeholder="text"
                  className="font-mono"
                  aria-label={`Column ${i + 1} type`}
                />
                <Checkbox
                  checked={c.notNull ?? false}
                  onChange={(e) => set(i, { notNull: e.target.checked })}
                  aria-label={`Column ${i + 1} NOT NULL`}
                  className="justify-self-center"
                />
                <Checkbox
                  checked={c.primaryKey ?? false}
                  onChange={(e) => set(i, { primaryKey: e.target.checked })}
                  aria-label={`Column ${i + 1} primary key`}
                  className="justify-self-center"
                />
                <Input
                  value={c.defaultExpr ?? ''}
                  onChange={(e) => set(i, { defaultExpr: e.target.value })}
                  placeholder="now()"
                  className="font-mono"
                  aria-label={`Column ${i + 1} default`}
                />
                <Button
                  onClick={() => setColumns((prev) => prev.filter((_, j) => j !== i))}
                  disabled={columns.length === 1}
                  title="Remove column"
                  aria-label={`Remove column ${i + 1}`}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              </Fragment>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => setColumns((prev) => [...prev, blank()])}>+ Column</Button>
            {halfFilled.length > 0 ? (
              <span className="text-sm text-warn">
                {halfFilled.length === 1
                  ? `Row ${halfFilled[0]?.n} needs ${halfFilled[0]?.name === '' ? 'a name' : 'a type'}, so it is left out of the statement until then.`
                  : `Rows ${halfFilled.map((c) => c.n).join(', ')} each need a name and a type, so they are left out of the statement until then.`}
              </span>
            ) : null}
          </div>
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        <Field label="Statement">
          <pre className="max-h-48 overflow-auto bg-surface p-2 font-mono text-xs whitespace-pre-wrap">
            {sql || '(name the table to see the statement)'}
          </pre>
        </Field>
      </div>
    </Dialog>
  );
}
