import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnInfo } from '@shared/protocol';
import { cn } from '@/lib/format';
import { getRelation, insertRow, queryKeys } from '@/lib/api';
import { Button, Dialog, ErrorBanner, Field, Input, Spinner, toast } from '@/components/ui';

/**
 * A column Postgres cannot fill for you: NOT NULL, no default, no identity. Leaving one out is a
 * guaranteed NOT NULL violation, so it starts on VAL rather than DEF - the form should not default
 * to a shape that cannot succeed.
 */
const requiresValue = (c: ColumnInfo) => c.notNull && c.defaultExpr === null && !c.identity;

/** What Postgres fills in when a column is left out of the INSERT. */
function omittedAs(c: ColumnInfo): string {
  if (c.generated) return 'generated';
  if (c.identity) return 'auto (identity)';
  if (c.defaultExpr !== null) return `DEFAULT ${c.defaultExpr}`;
  return c.notNull ? 'required' : 'NULL';
}

export default function NewRowDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  name,
  onInserted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema: string;
  name: string;
  onInserted: () => void;
}) {
  /**
   * Three states per column, because an empty text box cannot mean three different things.
   *
   * `default` leaves the column out of the statement entirely, so its identity sequence or DEFAULT
   * applies. `value` sends exactly what is typed, the empty string included. `null` sends SQL NULL,
   * which is the only way to override a column default with nothing. Typing switches a field to
   * `value` on its own, so the common case still costs one gesture.
   */
  const [modes, setModes] = useState<Record<string, 'default' | 'value' | 'null'>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Effective mode: an explicit choice wins, otherwise required columns start ready to receive.
  const modeOf = (c: ColumnInfo) => modes[c.name] ?? (requiresValue(c) ? 'value' : 'default');

  const detail = useQuery({
    queryKey: queryKeys.relation({ connectionId, schema, name }),
    queryFn: () => getRelation({ connectionId, schema, name }),
    enabled: open,
  });

  // Generated columns cannot be written at all, so they are not offered.
  const columns = (detail.data?.columns ?? []).filter((c) => !c.generated);

  const close = () => {
    setValues({});
    setModes({});
    setError(null);
    onOpenChange(false);
  };

  const save = () => {
    const out: Record<string, string | null> = {};
    for (const c of columns) {
      const mode = modeOf(c);
      if (mode === 'default') continue;
      out[c.name] = mode === 'null' ? null : (values[c.name] ?? '');
    }
    setSaving(true);
    setError(null);
    insertRow({
      connectionId,
      schema,
      name,
      values: out,
    })
      .then(
        (r) => {
          toast(`Inserted ${r.rowCount} row`);
          onInserted();
          close();
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Insert into ${schema}.${name}`}
      description="DEF leaves a column out so its default or identity applies, VAL sends what you type, NUL sends SQL NULL."
      width={560}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button onClick={save} disabled={saving || detail.isPending}>
            {saving ? 'Inserting…' : 'Insert row'}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {detail.isPending ? (
        <Spinner />
      ) : detail.error ? (
        <ErrorBanner message={detail.error instanceof Error ? detail.error.message : 'Could not read columns'} />
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
          {columns.map((c) => (
            <Field
              key={c.name}
              htmlFor={`newrow-${c.name}`}
              label={
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono">{c.name}</span>
                  <span className="text-xs text-faint">{c.typeName}</span>
                  {c.isPrimaryKey ? <span className="text-xs text-faint">PK</span> : null}
                </span>
              }
              hint={
                modeOf(c) === 'default'
                  ? `left out → ${omittedAs(c)}`
                  : modeOf(c) === 'null'
                    ? 'sends SQL NULL, overriding any default'
                    : 'sends exactly what is typed, including an empty string'
              }
            >
              <div className="flex items-center gap-1.5">
                <Input
                  id={`newrow-${c.name}`}
                  className="font-mono"
                  value={values[c.name] ?? ''}
                  disabled={modeOf(c) === 'null'}
                  placeholder={omittedAs(c)}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [c.name]: e.target.value }));
                    // typing is the gesture that means "use this value"
                    setModes((m) => (m[c.name] === 'value' ? m : { ...m, [c.name]: 'value' }));
                  }}
                />
                {/* Three plates, the active one inverted: the state reads with colour removed. */}
                <span className="flex shrink-0" role="group" aria-label={`How to write ${c.name}`}>
                  {(
                    [
                      ['default', 'DEF', 'leave the column out of the statement'],
                      ['value', 'VAL', 'send the typed value, empty string included'],
                      ['null', 'NUL', 'send SQL NULL'],
                    ] as const
                  ).map(([mode, label, title]) => {
                    const active = modeOf(c) === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        title={title}
                        aria-pressed={active}
                        onClick={() => setModes((m) => ({ ...m, [c.name]: mode }))}
                        className={cn(
                          'border-y border-r border-line-strong px-1.5 text-xs font-medium first:border-l',
                          active ? 'bg-accent text-accent-fg' : 'text-faint hover:text-fg',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </span>
              </div>
            </Field>
          ))}
        </div>
      )}
    </Dialog>
  );
}
